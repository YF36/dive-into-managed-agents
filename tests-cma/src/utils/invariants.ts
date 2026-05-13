/**
 * 共享不变量断言。所有 test file 应通过这些 helper 而非散落的 expect。
 *
 * 不依赖 vitest——纯函数,抛 InvariantViolation。test 文件里再用 expect 包一层。
 *
 * Phase 0 review M1 修复:把"id 唯一"和"created_at 单调"拆成两个不变量。
 * CMA 的 user.* event 会以 queued + processed 形式出现两次 occurrence,
 * **同一 event_id 出现多次是合法的**,所以 append-only 只校验时间单调。
 * 显式要 id 唯一时(如纯 agent.* 流)用 `assertEventIdsUnique`。
 */

import type { CollectedEvent } from "./stream.ts";

export class InvariantViolation extends Error {
  constructor(rule: string, detail: string) {
    super(`[invariant] ${rule}: ${detail}`);
    this.name = "InvariantViolation";
  }
}

/**
 * Append-only:`created_at` 单调不降。
 *
 * **不**校验 id 唯一——CMA 同一 user.* event_id 会有 queued + processed
 * 两次 occurrence,这是合法的(EV §1.3.2)。需要校验 id 唯一时用
 * `assertEventIdsUnique`(明确知道是单 occurrence 集合时)。
 */
export function assertEventLogAppendOnly(events: CollectedEvent[]): void {
  let lastAt: number | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (!e.id) throw new InvariantViolation("event_id_required", `events[${i}] missing id`);
    if (e.created_at) {
      const ts = Date.parse(e.created_at);
      if (Number.isNaN(ts)) {
        throw new InvariantViolation("created_at_parseable", `unparseable: ${e.created_at}`);
      }
      if (lastAt !== undefined && ts < lastAt) {
        throw new InvariantViolation(
          "created_at_monotonic",
          `events[${i}] id=${e.id} created_at=${e.created_at} < previous (${new Date(lastAt).toISOString()})`,
        );
      }
      lastAt = ts;
    }
  }
}

/**
 * 校验 event 数组里每个 event_id 唯一(显式单 occurrence 场景)。
 *
 * 用例:
 *   - 纯 agent.* / session.* / span.* event 流(服务端发起,单 occurrence)
 *   - 用 `{ dedupeByEventId: true }` 跑过 collectUntil 后,期望严格无 dup
 */
export function assertEventIdsUnique(events: CollectedEvent[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e?.id) continue;
    if (seen.has(e.id)) {
      throw new InvariantViolation("event_id_unique", `events[${i}] duplicate id ${e.id}`);
    }
    seen.add(e.id);
  }
}

/**
 * 把 events 按 event_id 分组,返回 `Map<id, occurrences[]>`。
 *
 * 给 `assertProcessedAtMonotonicInStream` / UI consolidation 等场景用。
 */
export function groupByEventId(events: CollectedEvent[]): Map<string, CollectedEvent[]> {
  const groups = new Map<string, CollectedEvent[]>();
  for (const e of events) {
    if (!e?.id) continue;
    const existing = groups.get(e.id) ?? [];
    existing.push(e);
    groups.set(e.id, existing);
  }
  return groups;
}

/**
 * 同 event_id 的多个 snapshot,`processed_at` 单向:null → timestamp,且 timestamp
 * 一旦定值不再变。
 *
 * 用例:同一 user.message 通过 `events.list` 多次拉取,看 processed_at 演变。
 * 也可单独喂给一组从 stream 收的 occurrence。
 *
 * @param snapshots 同一 event_id 在多个时间点的形态
 */
export function assertProcessedAtMonotonic(snapshots: CollectedEvent[]): void {
  if (snapshots.length === 0) return;
  const id = snapshots[0]?.id;
  if (!id) throw new InvariantViolation("snapshot_has_id", "first snapshot missing id");

  let firstTimestamp: string | undefined;
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (!snap) continue;
    if (snap.id !== id) {
      throw new InvariantViolation(
        "snapshot_same_id",
        `snapshot[${i}].id ${snap.id} !== ${id}`,
      );
    }
    if (snap.processed_at != null) {
      if (firstTimestamp === undefined) {
        firstTimestamp = snap.processed_at;
      } else if (snap.processed_at !== firstTimestamp) {
        throw new InvariantViolation(
          "processed_at_immutable_once_set",
          `${firstTimestamp} != ${snap.processed_at}`,
        );
      }
    }
  }
}

/**
 * 从一个混合 event 流(可能多 event_id,可能含同 id 多 occurrence)整体校验:
 * 每个 event_id 的 occurrence 子序列上 `processed_at` 单向 null → timestamp。
 *
 * 内部 groupByEventId 后逐组调 `assertProcessedAtMonotonic`。
 *
 * 用例:smoke / streaming test 收完整 turn,**一次性校验**所有 user.* event
 * 的双相 occurrence 都符合规则。
 */
export function assertProcessedAtMonotonicInStream(events: CollectedEvent[]): void {
  const groups = groupByEventId(events);
  for (const [id, snapshots] of groups) {
    if (snapshots.length < 2) continue; // 单 occurrence 无可校验
    try {
      assertProcessedAtMonotonic(snapshots);
    } catch (err) {
      if (err instanceof InvariantViolation) {
        throw new InvariantViolation(
          "processed_at_monotonic_in_stream",
          `event_id=${id}: ${err.message}`,
        );
      }
      throw err;
    }
  }
}

/**
 * SSE 拉到的 events 集合应 ⊆ list 拉到的 events 集合(list 是 source of truth)。
 * 反过来 list 可能含 SSE 开流之前的旧 event,所以是子集关系而非等价。
 */
export function assertSseListConsistency(
  streamEvents: CollectedEvent[],
  listEvents: CollectedEvent[],
): void {
  const listIds = new Set(listEvents.map((e) => e.id).filter((id): id is string => !!id));
  for (const s of streamEvents) {
    if (!s.id) continue;
    if (!listIds.has(s.id)) {
      throw new InvariantViolation(
        "stream_subset_of_list",
        `stream event ${s.id} (${s.type}) not in list response`,
      );
    }
  }
}

/**
 * Phase 2 扩展:按 event type 校验 payload 必填字段。Phase 0 仅 stub。
 */
export function assertSchemaForType(_event: CollectedEvent): void {
  // Phase 2 实装:按 §20.3 30 种 event type 的 schema 校验
}

/**
 * 检查 text 不含 plaintext secret。string-equality 检测(不做 fuzz match,避免误报)。
 */
export function assertNoSecretLeak(
  text: string,
  knownSecrets: readonly string[],
): void {
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 8) continue; // 短串误报率高
    if (text.includes(secret)) {
      throw new InvariantViolation(
        "no_secret_leak",
        `text contains plaintext secret (${secret.slice(0, 4)}...${secret.slice(-2)})`,
      );
    }
  }
}
