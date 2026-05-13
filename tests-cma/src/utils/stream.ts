/**
 * Stream / Events 收集 helper。
 *
 * Phase 0 review 修复了三个 bug:
 *   - H1 stream-first 顺序:`runTurnAndCollect()` 强制"先 open stream,再 send",
 *     避免 CMA 官方文档明示的 race(stream 不回放开流前的事件)
 *   - H2 idle timeout:用 Promise.race(iter.next, setTimeout)让 stream 空闲时
 *     `maxWaitMs` 也能触发,不会卡到 vitest test timeout
 *   - M1 occurrence-preserving:**默认不按 event_id 去重**,保留 queued+processed
 *     双相 occurrence(协议层关键语义,需保留信号)。需要 UI
 *     consolidation 模式时显式传 `{ dedupeByEventId: true }`
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient } from "../client.ts";

export interface CollectedEvent {
  id: string;
  type: string;
  created_at?: string;
  processed_at?: string | null;
  // payload 字段保持松弛——按 type 在 invariants.ts 里校验
  [key: string]: unknown;
}

export interface CollectUntilOptions {
  /** 命中即停的 event type 集合(默认 session.status_idle / session.error / session.status_terminated / session.deleted) */
  stopTypes?: string[];
  /** 最长等待 ms,**含空闲时间**(防卡死)。默认 60s */
  maxWaitMs?: number;
  /**
   * 按 event_id 去重(UI consolidation 模式)。
   *
   * **默认 false**——保留同一 event_id 的多次 occurrence(M1 修复:
   * CMA 的 user.* 事件**可能**以 queued + processed 形式出现两次(协议层双相
   * occurrence 语义),默认去重会吞掉这个信号)。
   *
   * 仅在测试明确模拟 UI 端"按 event_id 合并卡片"时设为 true。
   */
  dedupeByEventId?: boolean;
}

const DEFAULT_STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
  "session.deleted",
];

const DEFAULT_MAX_WAIT_MS = 60_000;

type EventsStream = Awaited<
  ReturnType<AnthropicAws["beta"]["sessions"]["events"]["stream"]>
>;

type SessionsEventsSendBody = Parameters<
  AnthropicAws["beta"]["sessions"]["events"]["send"]
>[1];

const TIMEOUT_SENTINEL = Symbol("stream-idle-timeout");

/**
 * 从一个**已开**的 stream 消费 event,直到命中 stop type 或累计 wall-clock
 * 超过 `maxWaitMs`(含空闲时间)。
 *
 * 这是底层函数,通常通过 `collectUntil` / `runTurnAndCollect` 调用。
 */
async function consumeStream(
  stream: EventsStream,
  options: CollectUntilOptions = {},
): Promise<CollectedEvent[]> {
  const stopTypes = new Set(options.stopTypes ?? DEFAULT_STOP_TYPES);
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const dedupeByEventId = options.dedupeByEventId ?? false;
  const deadline = Date.now() + maxWaitMs;

  const collected: CollectedEvent[] = [];
  const seenIds = dedupeByEventId ? new Set<string>() : null;
  const iter = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      // H2 修复:Promise.race iter.next vs idle timer。
      // 空闲时不会卡死,deadline 到了就 break。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timerPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(TIMEOUT_SENTINEL), remaining);
        (timer as { unref?: () => void }).unref?.();
      });

      const result: IteratorResult<unknown> | typeof TIMEOUT_SENTINEL = await Promise.race([
        iter.next(),
        timerPromise,
      ]);

      if (timer) clearTimeout(timer);
      if (result === TIMEOUT_SENTINEL) break;
      if (result.done) break;

      const event = result.value as CollectedEvent;
      if (!event || typeof event !== "object") continue;

      if (seenIds && event.id) {
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
      }

      collected.push(event);
      if (stopTypes.has(event.type)) break;
    }
  } finally {
    // 优雅释放 stream(让 SDK 关掉底层 SSE 连接,避免泄漏)
    try {
      await iter.return?.();
    } catch {
      // ignore
    }
  }
  return collected;
}

/**
 * 老 API:open stream + consume,**不**自动 send。
 *
 * 注意 H1:这条 path 仍有 race —— send 必须发生在 `await client.beta.sessions.events.stream(...)`
 * **返回之后**。若 caller 需要 send + consume 配对,**优先用 `runTurnAndCollect`**。
 *
 * 此函数留给"session 已经在跑,我只想接上看后续事件"等无 send 配对的场景。
 */
export async function collectUntil(
  sessionId: string,
  options: CollectUntilOptions = {},
): Promise<CollectedEvent[]> {
  const client = getClient();
  const stream = await client.beta.sessions.events.stream(sessionId);
  return await consumeStream(stream, options);
}

/**
 * H1 修复:正确的 stream-first 顺序。
 *
 * CMA 官方文档明示 race condition:**"Only events emitted after the stream is
 * opened are delivered, so open the stream before sending events to avoid a
 * race condition."** 任何 send-then-stream 顺序都会丢早期事件(尤其是
 * `session.status_running` 这种瞬态)。
 *
 * 三步:
 *   1. `await client.beta.sessions.events.stream(sessionId)` —— SSE 连接建立,
 *      服务端到客户端的事件 channel 已开,后续事件 buffer 在 stream 里
 *   2. `await client.beta.sessions.events.send(...)` —— 触发服务端处理(POST
 *      返回 200 即可,真实事件处理是异步)
 *   3. `consumeStream(stream, options)` —— 从 buffer 消费,带 idle timeout 兜底
 *
 * 用法:
 *   const events = await runTurnAndCollect(sessionId, {
 *     events: [{ type: "user.message", content: [{ type: "text", text: "..." }] }],
 *   });
 */
export async function runTurnAndCollect(
  sessionId: string,
  sendBody: SessionsEventsSendBody,
  options: CollectUntilOptions = {},
): Promise<CollectedEvent[]> {
  const client = getClient();

  // 1. 先开 stream(SSE 连接建立完才返回)
  const stream = await client.beta.sessions.events.stream(sessionId);

  // 2. 发 user event(stream 已经在 buffer)
  //
  // Phase 0 review M1 修复:send 抛错时,stream 还开着,要显式关掉避免 SSE
  // 连接泄漏(后续 negative API tests 可能挂住)。consumeStream 内部有 finally
  // 关 stream,但只在成功进入 consume 时才执行 — send 失败这条路绕过它。
  try {
    await client.beta.sessions.events.send(sessionId, sendBody);
  } catch (err) {
    try {
      const iter = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await iter.return?.();
    } catch {
      // 关 stream 失败吞错,优先 rethrow 原 send error
    }
    throw err;
  }

  // 3. 消费 buffer + 后续事件,带 idle timeout 兜底(consumeStream 内部 finally 关 stream)
  return await consumeStream(stream, options);
}

/**
 * Phase 2 扩展用:同时拉 list history,跟 stream 合并去重。
 *
 * 调用顺序应是:
 * 1. open stream(buffer 起)
 * 2. list events from origin(seed seenIds)
 * 3. 消费 stream,按 id 去重(这才是 CMA reconnect 模式应有的去重场景)
 *
 * Phase 0 仅 stub,Phase 2 实装。
 */
export async function streamWithHistory(
  _sessionId: string,
  _options: CollectUntilOptions = {},
): Promise<CollectedEvent[]> {
  throw new Error("streamWithHistory: Phase 2 实装");
}
