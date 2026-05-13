/**
 * Infrastructure smoke for `src/utils/three-layer-collector.ts`
 * (Phase 2 §20.0.C 验收)。
 *
 * 验证:
 *   - State-machine API:openStream / send / listSnapshot / consume / finalize
 *   - L0 三 source 分别记录(stream / list / send-response)
 *   - L1 跨 source dedupe via (id, processed_at, payloadHash) + 保留 ack transitions
 *   - L2 按 id consolidate + ack 字段 update
 *   - payloadHash 不依赖 id / created_at / processed_at(同 logical event 不同
 *     observation → 相同 hash)
 *
 * 流程:
 *   1. create session
 *   2. openStream
 *   3. listSnapshot(ack 前 — turn 未开始,session 默认 events 可能为空)
 *   4. send(user.message)
 *   5. listSnapshot(ack 中 — 介于 send 和 turn 结束)
 *   6. consume until idle
 *   7. listSnapshot(turn 后)
 *   8. finalize → assert L0 / L1 / L2 计数关系符合预期
 *
 * 此 smoke 通过即 20.0.C 验收。
 */

import { describe, expect, it } from "vitest";
import { getClient, resetClientCache } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector, computePayloadHash } from "../../src/utils/three-layer-collector.ts";
import { safeArchive } from "../../src/fixtures/sessions.ts";

describe("three-layer-collector smoke (Phase 2 §20.0.C 验收)", () => {
  it("payloadHash 一致性:同 logical event 不同 observation → 相同 hash", () => {
    const eventStream = {
      id: "sevt_111",
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
      created_at: "2026-05-13T10:00:00.000Z",
      processed_at: null,
    };
    const eventListAfterAck = {
      id: "sevt_111",
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
      created_at: "2026-05-13T10:00:00.000Z",
      processed_at: "2026-05-13T10:00:00.500Z",
      _request_id: "req_xxx",
    };
    expect(computePayloadHash(eventStream)).toBe(computePayloadHash(eventListAfterAck));
  });

  it("payloadHash 区分性:不同 content → 不同 hash", () => {
    const a = { id: "sevt_1", type: "user.message", content: [{ type: "text", text: "A" }] };
    const b = { id: "sevt_2", type: "user.message", content: [{ type: "text", text: "B" }] };
    expect(computePayloadHash(a)).not.toBe(computePayloadHash(b));
  });

  it("端到端:stream + multi-list + send-response 三 source → L0/L1/L2", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "three-layer smoke",
    });

    try {
      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: ["session.status_idle", "session.error", "session.status_terminated"],
        defaultMaxWaitMs: 30_000,
      });

      // 1. open stream(quickstart race condition)
      await collector.openStream();

      // 2. list snapshot pre-send(turn 前)
      await collector.listSnapshot();

      // 3. send user.message
      await collector.send({
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
      });

      // 4. list snapshot 立即(ack 中)
      await collector.listSnapshot();

      // 5. consume stream until idle
      await collector.consume();

      // 6. list snapshot 完结后(turn 后)
      await collector.listSnapshot();

      const snap = await collector.finalize();

      // ✓ L0 三 source 都有数据
      expect(snap.stats.l0StreamCount).toBeGreaterThan(0);
      expect(snap.stats.l0ListSnapshotCount).toBe(3);
      expect(snap.stats.l0SendCallCount).toBe(1);

      // ✓ L1 dedup后不会比 stream 单 source 少(stream 是 superset of new events)
      expect(snap.stats.l1Count).toBeGreaterThanOrEqual(snap.stats.l0StreamCount);

      // ✓ L1 真的 dedupe 了 — L1 严格小于 total observations(防回归:之前
      //   `_source` / `_observedAt` 等 collector 注入字段进 hash,导致 L1
      //   完全不 dedupe;修复后 L1 应 ≪ total)
      const totalObs =
        snap.stats.l0StreamCount + snap.stats.l0ListEventTotal + snap.stats.l0SendEventTotal;
      expect(snap.stats.l1Count).toBeLessThan(totalObs);

      // ✓ L2 <= L1(L2 进一步按 id consolidate)
      expect(snap.stats.l2Count).toBeLessThanOrEqual(snap.stats.l1Count);

      // ✓ 至少看到 session.status_idle 来收尾
      const sawIdle = snap.L2.some((e) => e.type === "session.status_idle");
      expect(sawIdle).toBe(true);

      // 打印 debug — 这些是 §20.3 真测时要看的关键数据
      console.log("[3-layer smoke] L0 stream events:", snap.stats.l0StreamCount);
      console.log("[3-layer smoke] L0 list snapshots:", snap.stats.l0ListSnapshotCount, "events total:", snap.stats.l0ListEventTotal);
      console.log("[3-layer smoke] L0 send calls:", snap.stats.l0SendCallCount, "events total:", snap.stats.l0SendEventTotal);
      console.log("[3-layer smoke] L1 count:", snap.stats.l1Count);
      console.log("[3-layer smoke] L2 count:", snap.stats.l2Count);
      console.log("[3-layer smoke] L1 - L2 difference(ack transitions 数):", snap.stats.l1Count - snap.stats.l2Count);

      // §20.3 预演:同 id 在 L1 出现几次 = ack transition 数
      const idCountsInL1: Record<string, number> = {};
      for (const e of snap.L1) {
        const id = typeof e.id === "string" ? e.id : "<no-id>";
        idCountsInL1[id] = (idCountsInL1[id] ?? 0) + 1;
      }
      const idsWithMultiOccurrence = Object.entries(idCountsInL1).filter(([, n]) => n > 1);
      console.log("[3-layer smoke] §20.3 信号:L1 内同 id 多次 occurrence 个数:", idsWithMultiOccurrence.length);
      if (idsWithMultiOccurrence.length > 0) {
        console.log("[3-layer smoke] §20.3 信号:具体 id + 出现次数:", idsWithMultiOccurrence.slice(0, 5));
      }

      // 检查 user.message 在 L1 多 source 命中情况
      const userMsg = snap.L1.filter((e) => e.type === "user.message");
      const userMsgSources = userMsg.map((e) => e._source);
      console.log("[3-layer smoke] §20.3 信号:user.message 在 L1 的 source 分布:", userMsgSources);

      // DEBUG:为什么 L1 没 dedupe?dump 同 id 的 stream vs list event 字段差异
      const firstStreamEvent = snap.L0.stream[0];
      if (firstStreamEvent) {
        const sameIdInList = snap.L0.listSnapshots.flatMap((s) => s.events).find((e) => e.id === firstStreamEvent.id);
        if (sameIdInList) {
          const streamKeys = Object.keys(firstStreamEvent).filter((k) => !k.startsWith("_") || k === "_payloadHash");
          const listKeys = Object.keys(sameIdInList).filter((k) => !k.startsWith("_") || k === "_payloadHash");
          console.log("[3-layer DEBUG] stream event id:", firstStreamEvent.id);
          console.log("[3-layer DEBUG] stream keys:", streamKeys);
          console.log("[3-layer DEBUG] list keys:", listKeys);
          console.log("[3-layer DEBUG] stream-only keys:", streamKeys.filter((k) => !listKeys.includes(k)));
          console.log("[3-layer DEBUG] list-only keys:", listKeys.filter((k) => !streamKeys.includes(k)));
          console.log("[3-layer DEBUG] stream hash:", firstStreamEvent._payloadHash);
          console.log("[3-layer DEBUG] list hash:", sameIdInList._payloadHash);
        }
      }
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);
});
