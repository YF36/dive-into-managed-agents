/**
 * 共享不变量断言。所有 test file 应通过这些 helper 而非散落的 expect。
 *
 * 不依赖 vitest——纯函数,抛 AssertionError。test 文件里再用 expect 包一层。
 */

import type { CollectedEvent } from "./stream.ts";

export class InvariantViolation extends Error {
  constructor(rule: string, detail: string) {
    super(`[invariant] ${rule}: ${detail}`);
    this.name = "InvariantViolation";
  }
}

/**
 * 同 session 内的 event:id 唯一 + created_at 单调不降。
 */
export function assertEventLogAppendOnly(events: CollectedEvent[]): void {
  const seen = new Set<string>();
  let lastAt: number | undefined;
  for (const e of events) {
    if (!e.id) throw new InvariantViolation("event_id_required", JSON.stringify(e));
    if (seen.has(e.id)) {
      throw new InvariantViolation("event_id_unique", `duplicate id ${e.id}`);
    }
    seen.add(e.id);
    if (e.created_at) {
      const ts = Date.parse(e.created_at);
      if (Number.isNaN(ts)) {
        throw new InvariantViolation("created_at_parseable", `unparseable: ${e.created_at}`);
      }
      if (lastAt !== undefined && ts < lastAt) {
        throw new InvariantViolation(
          "created_at_monotonic",
          `event ${e.id} created_at ${e.created_at} < previous`,
        );
      }
      lastAt = ts;
    }
  }
}

/**
 * 多次拉同一 event 时,processed_at 单调:null → timestamp,且 timestamp 不变。
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
 * SSE 拉到的 events 集合应 ⊆ list 拉到的 events 集合(list 是 source of truth)。
 * 反过来 list 可能含 SSE 开流之前的旧 event,所以是子集关系而非等价。
 */
export function assertSseListConsistency(
  streamEvents: CollectedEvent[],
  listEvents: CollectedEvent[],
): void {
  const listIds = new Set(listEvents.map((e) => e.id));
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
