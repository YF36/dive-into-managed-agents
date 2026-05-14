/**
 * Three-layer event collector(Phase 2 §20.0.C / §20.4)。
 *
 * 实现 plan §20.4 三层模型,给 §20.3 / §20.4 case 用:
 *   - **L0 Raw observations**:每 source(stream / list / send-response)各自
 *     原始观察序列,完全不跨 source 合并 — 这是真实"看到了什么"
 *   - **L1 Recovered feed**:跨 source dedupe via `(id, processed_at,
 *     payloadHash)` 三元组,**保留 null→timestamp ack transition** — 这是
 *     "已发生事件流"的最佳重建
 *   - **L2 UI consolidated**:按 `id` 合并,ack transitions 算字段 update —
 *     UI 端展示用
 *
 * State-machine API:caller 显式触发 openStream / send / listSnapshot /
 * consume / finalize,给 §20.3.4 多次 list + §20.4 race / reconnect 类 case
 * 留出 timing 控制空间。
 *
 * 这个 collector 默认走 SDK iterator(不走 raw-sse)。raw-sse 单独经
 * [`raw-sse.ts`](./raw-sse.ts) 给 §20.1 用,两条 path 不混。
 */

import { createHash } from "node:crypto";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient } from "../client.ts";
import type { CollectedEvent } from "./stream.ts";

type EventsStream = Awaited<
  ReturnType<AnthropicAws["beta"]["sessions"]["events"]["stream"]>
>;
type SessionsEventsSendBody = Parameters<
  AnthropicAws["beta"]["sessions"]["events"]["send"]
>[1];

const TIMEOUT_SENTINEL = Symbol("collector-idle-timeout");

/**
 * Excluded fields from payloadHash(observation/source/read-model 元数据)。
 *
 * 除显式列表外,**所有以 `_` 开头的字段都排除**(SDK metadata + collector
 * 自己注入的 `_source` / `_observedAt` 等都符合此约定)。
 */
const PAYLOAD_HASH_EXCLUDED_FIELDS = new Set<string>([
  // observation / source metadata
  "id",
  "created_at",
  "updated_at",
  "processed_at",
  // read-model derived
  "status",
  "archived_at",
]);

function isExcludedField(key: string): boolean {
  return PAYLOAD_HASH_EXCLUDED_FIELDS.has(key) || key.startsWith("_");
}

/**
 * payloadHash canonicalization(详见 plan §20.0.C):
 *
 *   - 覆盖:type + business payload + stable routing(session_thread_id 等)
 *   - 排除:`PAYLOAD_HASH_EXCLUDED_FIELDS` 列出的所有 observation/source 字段
 *   - canonicalization:递归 sort keys 字典序 → JSON.stringify
 *     (近似 RFC 8785 JCS,数组保持原顺序,undefined → 字段省略,null 保留)
 *   - hash:SHA-256,取 hex 前 16 字符
 *
 * 规则改动 → hash 不向后兼容,需重跑历史 corpus。
 */
export function computePayloadHash(event: Record<string, unknown> | unknown): string {
  if (!event || typeof event !== "object") {
    // 退化:hash 整个 stringified value
    return sha256Hex16(JSON.stringify(event));
  }
  const filtered = filterAndCanonicalize(event as Record<string, unknown>);
  return sha256Hex16(JSON.stringify(filtered));
}

function filterAndCanonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(filterAndCanonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj)
    .filter((k) => !isExcludedField(k))
    .filter((k) => obj[k] !== undefined)
    .sort();
  for (const k of keys) sorted[k] = filterAndCanonicalize(obj[k]);
  return sorted;
}

function sha256Hex16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── Snapshot 数据类型 ─────────────────────────────────────────────────────

export interface SourcedEvent extends CollectedEvent {
  /** 哪个 source 看到的(L0 -> L1 合并时保留)*/
  _source?: "stream" | "list" | "send-response";
  /** 第几次 list 看到(只 list 源有)*/
  _listSnapshotIndex?: number;
  /** 第几次 send 的 response 包含此 event(只 send-response 有)*/
  _sendCallIndex?: number;
  /** 第几个 stream connection 看到(只 stream 源有;reconnect 时跨多 connection)*/
  _streamConnectionIndex?: number;
  /** Wall clock(ms relative to collector start)*/
  _observedAt?: number;
  /** computed payload hash(L1 计算时附加)*/
  _payloadHash?: string;
}

export interface ListSnapshot {
  /** 第几次 list(0-indexed)*/
  index: number;
  /** Wall clock at start of pagination */
  startedAt: number;
  /** Wall clock at end */
  endedAt: number;
  /** Events 拉到的全集(按 list 自然顺序)*/
  events: SourcedEvent[];
}

export interface SendCall {
  /** 第几次 send(0-indexed)*/
  index: number;
  /** Wall clock when send was issued */
  issuedAt: number;
  /** Wall clock when response arrived */
  respondedAt: number;
  /** Request body */
  request: SessionsEventsSendBody;
  /** Response body's events array(echo) */
  events: SourcedEvent[];
  /** Raw response object(unredacted — caller responsible)*/
  rawResponse: unknown;
}

export interface ThreeLayerSnapshot {
  /** Wall clock collector start(perf.now baseline)*/
  baseline: number;
  /** L0 raw observations - 3 sources */
  L0: {
    stream: SourcedEvent[];
    listSnapshots: ListSnapshot[];
    sendCalls: SendCall[];
  };
  /**
   * L1 recovered feed - 跨 source dedupe via (id, processed_at, payloadHash)
   * 保留 ack transitions(同 id 不同 processed_at = 2 条 entry)
   * 顺序:按 first-observation _observedAt
   */
  L1: SourcedEvent[];
  /**
   * L2 UI consolidated - 按 id 合并,最新 processed_at 覆盖 null
   * 顺序:按 id first-observation
   */
  L2: SourcedEvent[];
  /** Stats for quick inspection */
  stats: {
    l0StreamCount: number;
    l0ListSnapshotCount: number;
    l0ListEventTotal: number;
    l0SendCallCount: number;
    l0SendEventTotal: number;
    l1Count: number;
    l2Count: number;
  };
}

// ─── Collector State Machine ──────────────────────────────────────────────

export interface ThreeLayerCollectorOptions {
  /** 默认 consumeUntil 的 stop types */
  defaultStopTypes?: string[];
  /** 默认 consumeUntil 的 maxWaitMs */
  defaultMaxWaitMs?: number;
  /** list 拉取的 limit per page(SDK auto-paginates;默认 100)*/
  listPageLimit?: number;
}

export interface ConsumeOptions {
  stopTypes?: string[];
  maxWaitMs?: number;
}

export interface ThreeLayerCollector {
  /** 打开 SSE stream(必须在 send/consume 之前调用,quickstart race condition)*/
  openStream(): Promise<void>;
  /** POST /events;response.events 进 L0.sendCalls */
  send(body: SessionsEventsSendBody): Promise<SendCall>;
  /** 拉一次 events.list 全集快照;进 L0.listSnapshots */
  listSnapshot(): Promise<ListSnapshot>;
  /** 从已 open stream 消费 events 直到 stopType 或 timeout */
  consume(opts?: ConsumeOptions): Promise<SourcedEvent[]>;
  /** 关闭 stream(可选,finalize 会自动调用)*/
  closeStream(): Promise<void>;
  /**
   * **§20.4.3/4 reconnect 用** — 关掉当前 stream connection,重新开一个。
   * L0.stream 会跨多 connection 累积(每个 event 通过 _observedAt + 内部
   * `_streamConnectionIndex` 区分)。
   */
  reopenStream(): Promise<void>;
  /** 计算 L1 + L2 + stats,返回完整 snapshot */
  finalize(): Promise<ThreeLayerSnapshot>;
}

export function createThreeLayerCollector(
  sessionId: string,
  options: ThreeLayerCollectorOptions = {},
): ThreeLayerCollector {
  const baseline = performance.now();
  const defaultStopTypes = options.defaultStopTypes ?? [
    "session.status_idle",
    "session.error",
    "session.status_terminated",
    "session.deleted",
  ];
  const defaultMaxWaitMs = options.defaultMaxWaitMs ?? 60_000;
  const listPageLimit = options.listPageLimit ?? 100;

  const L0_stream: SourcedEvent[] = [];
  const L0_listSnapshots: ListSnapshot[] = [];
  const L0_sendCalls: SendCall[] = [];

  let stream: EventsStream | undefined;
  let iter: AsyncIterator<unknown> | undefined;
  let streamClosed = false;
  /** 当前是第几个 stream connection(reconnect 时 +1)*/
  let streamConnectionIndex = -1;

  const now = () => performance.now() - baseline;

  async function openStream(): Promise<void> {
    if (stream) throw new Error("Stream already opened — use reopenStream() after closeStream()");
    const client = getClient();
    stream = await client.beta.sessions.events.stream(sessionId);
    iter = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    streamConnectionIndex += 1;
  }

  async function reopenStream(): Promise<void> {
    // §20.4.3 reconnect:关掉当前 stream + reset state + 重 open
    if (!streamClosed) {
      // close 当前
      try {
        await iter?.return?.();
      } catch {
        // ignore
      }
    }
    stream = undefined;
    iter = undefined;
    streamClosed = false;
    await openStream();
  }

  async function send(body: SessionsEventsSendBody): Promise<SendCall> {
    const client = getClient();
    const issuedAt = now();
    const response = await client.beta.sessions.events.send(sessionId, body);
    const respondedAt = now();
    const index = L0_sendCalls.length;
    const rawEvents = (response as { events?: unknown[] }).events ?? [];
    const events: SourcedEvent[] = rawEvents.map((e) => ({
      ...(e as CollectedEvent),
      _source: "send-response",
      _sendCallIndex: index,
      _observedAt: respondedAt,
    }));
    const call: SendCall = {
      index,
      issuedAt,
      respondedAt,
      request: body,
      events,
      rawResponse: response,
    };
    L0_sendCalls.push(call);
    return call;
  }

  async function listSnapshot(): Promise<ListSnapshot> {
    const client = getClient();
    const startedAt = now();
    const index = L0_listSnapshots.length;
    const events: SourcedEvent[] = [];
    let counter = 0;
    for await (const e of client.beta.sessions.events.list(sessionId, {
      limit: listPageLimit,
    })) {
      events.push({
        ...(e as unknown as CollectedEvent),
        _source: "list",
        _listSnapshotIndex: index,
        _observedAt: now(),
      });
      counter++;
      // Hard cap to avoid runaway pagination during long-lived sessions
      if (counter > 10_000) break;
    }
    const endedAt = now();
    const snapshot: ListSnapshot = { index, startedAt, endedAt, events };
    L0_listSnapshots.push(snapshot);
    return snapshot;
  }

  async function consume(opts: ConsumeOptions = {}): Promise<SourcedEvent[]> {
    if (!stream || !iter) throw new Error("Stream not opened; call openStream() first");
    if (streamClosed) throw new Error("Stream already closed");

    const stopTypes = new Set(opts.stopTypes ?? defaultStopTypes);
    const maxWaitMs = opts.maxWaitMs ?? defaultMaxWaitMs;
    const deadline = Date.now() + maxWaitMs;
    const collected: SourcedEvent[] = [];

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timerPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), remaining);
        (timer as { unref?: () => void }).unref?.();
      });
      const result: IteratorResult<unknown> | typeof TIMEOUT_SENTINEL = await Promise.race([
        iter.next(),
        timerPromise,
      ]);
      if (timer) clearTimeout(timer);
      if (result === TIMEOUT_SENTINEL) break;
      if (result.done) break;
      const ev = result.value as CollectedEvent;
      if (!ev || typeof ev !== "object") continue;
      const sourced: SourcedEvent = {
        ...ev,
        _source: "stream",
        _observedAt: now(),
        _streamConnectionIndex: streamConnectionIndex,
      };
      L0_stream.push(sourced);
      collected.push(sourced);
      if (typeof ev.type === "string" && stopTypes.has(ev.type)) break;
    }
    return collected;
  }

  async function closeStream(): Promise<void> {
    if (streamClosed) return;
    streamClosed = true;
    // 防御性超时:某些 SDK / server 状态下 iter.return() 会 hang(eg
    // 流刚被 reopen 但 server 没数据可发,或 session 已 delete 时 server 不
    // 主动 close 连接,见 F-0016)。2s 超时让 finalize 总能完成。
    try {
      await Promise.race([
        iter?.return?.() ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // ignore
    }
  }

  async function finalize(): Promise<ThreeLayerSnapshot> {
    await closeStream();

    // ─── L1 build ─────────────────────────────────────────────────────
    // Key: id + processed_at + payloadHash
    // 顺序:按 first-observation _observedAt
    const allObservations: SourcedEvent[] = [
      ...L0_stream,
      ...L0_listSnapshots.flatMap((s) => s.events),
      ...L0_sendCalls.flatMap((c) => c.events),
    ];
    // compute hash for each
    for (const e of allObservations) {
      if (e._payloadHash === undefined) e._payloadHash = computePayloadHash(e);
    }
    // sort by first-observation _observedAt(stable across sources)
    const sortedObs = [...allObservations].sort((a, b) => (a._observedAt ?? 0) - (b._observedAt ?? 0));
    const l1Map = new Map<string, SourcedEvent>();
    for (const e of sortedObs) {
      const id = typeof e.id === "string" ? e.id : "<no-id>";
      const procAt = typeof e.processed_at === "string" ? e.processed_at : "<null>";
      const h = e._payloadHash ?? "<no-hash>";
      const k = `${id}|${procAt}|${h}`;
      if (!l1Map.has(k)) l1Map.set(k, e);
    }
    const L1 = Array.from(l1Map.values());

    // ─── L2 build ─────────────────────────────────────────────────────
    // Key: id only;ack 用最新 processed_at(non-null > null)
    const l2Map = new Map<string, SourcedEvent>();
    for (const e of sortedObs) {
      const id = typeof e.id === "string" ? e.id : `<no-id-${l2Map.size}>`;
      const existing = l2Map.get(id);
      if (!existing) {
        l2Map.set(id, e);
        continue;
      }
      // Merge ack:若新观察 processed_at 不为 null 而旧的为 null,更新
      const existingProc = existing.processed_at;
      const incomingProc = e.processed_at;
      if (existingProc === null && incomingProc !== null && incomingProc !== undefined) {
        l2Map.set(id, { ...existing, processed_at: incomingProc, _observedAt: e._observedAt });
      }
      // 否则保留 existing(first-seen wins for other fields)
    }
    const L2 = Array.from(l2Map.values());

    return {
      baseline,
      L0: {
        stream: L0_stream,
        listSnapshots: L0_listSnapshots,
        sendCalls: L0_sendCalls,
      },
      L1,
      L2,
      stats: {
        l0StreamCount: L0_stream.length,
        l0ListSnapshotCount: L0_listSnapshots.length,
        l0ListEventTotal: L0_listSnapshots.reduce((sum, s) => sum + s.events.length, 0),
        l0SendCallCount: L0_sendCalls.length,
        l0SendEventTotal: L0_sendCalls.reduce((sum, c) => sum + c.events.length, 0),
        l1Count: L1.length,
        l2Count: L2.length,
      },
    };
  }

  return {
    openStream,
    send,
    listSnapshot,
    consume,
    closeStream,
    reopenStream,
    finalize,
  };
}
