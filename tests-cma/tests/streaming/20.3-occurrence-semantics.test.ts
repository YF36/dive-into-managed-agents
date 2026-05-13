/**
 * Phase 2 §20.3 processed_at & occurrence semantics(Top 10 #3 / #4)。
 *
 * 这是 Phase 2 协议研究计划核心 — `processed_at` 决定 event 协议是单相还是
 * 双相;Phase 1 F-0001 在 L2 collector 下只看到 "single occurrence",Phase 2
 * 必须用 L0(完全不 dedupe)+ L1(保留 ack transitions)复验。
 *
 * Top 10 优先级 case:
 *   - 20.3.1 / 20.3.2 / 20.3.3:user.message 三路对比 — stream / list /
 *     send-response 各看到几次,processed_at 形态如何
 *   - 20.3.4:同一 event 多次 list — 哪些字段稳定,哪些变化
 *
 * 注:旧 baseline 已显示 user.message 不进 stream,send response 不 echo events,
 * 仅在 list 出现 — Phase 2 实测确认这条 stronger 结论。
 */

import { describe, expect, it } from "vitest";
import { getClient, resetClientCache } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";
import { safeArchive } from "../../src/fixtures/sessions.ts";

const STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
  "session.deleted",
];

describe("20.3 processed_at & occurrence semantics(Phase 2 Top 10)", () => {
  /**
   * 20.3.1 / 20.3.2 / 20.3.3 — user.message three-path 对比。
   *
   * 流程:open stream + listSnapshot(pre) + send + 立即 listSnapshot(mid)+
   * consume(turn 中)+ 再 listSnapshot(turn 完) → dump corpus → 比较
   * user.message 在三路的字段。
   */
  it("20.3.1/2/3 user.message three-path 对比 (stream / list / send-response)", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.3.1-3 three-path",
    });

    try {
      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: STOP_TYPES,
        defaultMaxWaitMs: 30_000,
      });
      await collector.openStream();
      await new Promise((r) => setTimeout(r, 100));

      // pre-send list:期望 user.message 还不存在
      const preList = await collector.listSnapshot();

      // send + capture response
      const sendCall = await collector.send({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Reply with the single word 'ok'." }],
          },
        ],
      });

      // 立即 list(尽量 ack-in-flight)
      const midList = await collector.listSnapshot();

      // consume
      await collector.consume();

      // post-turn list
      const postList = await collector.listSnapshot();

      const snapshot = await collector.finalize();

      const dump = await dumpCorpus("user-message-processed-at-three-path", snapshot, {
        description:
          "Top 10 #3 / §20.3.1-3 — user.message three-path 对比:stream (SDK) / list (multiple) / send-response 三路同时观察,看 user.message 在各路的字段差异 + processed_at 形态。",
        additionalMeta: { case: "20.3.1-3", top10: "#3" },
      });

      // ─── 断言:三路覆盖 ─────────────────────────────────────────────
      expect(snapshot.stats.l0SendCallCount).toBe(1);
      expect(snapshot.stats.l0ListSnapshotCount).toBe(3);

      // ─── 核心观察:user.message 在三路的存在 ──────────────────────────
      const userInStream = snapshot.L0.stream.filter((e) => e.type === "user.message");
      const userInSendResp = sendCall.events.filter((e) => e.type === "user.message");
      const userInPreList = preList.events.filter((e) => e.type === "user.message");
      const userInMidList = midList.events.filter((e) => e.type === "user.message");
      const userInPostList = postList.events.filter((e) => e.type === "user.message");

      console.log("[20.3.1-3] user.message presence in 3 paths:");
      console.log("  stream:", userInStream.length, "(events)");
      console.log("  send-response:", userInSendResp.length, "(events)");
      console.log("  list pre-send:", userInPreList.length);
      console.log("  list mid-turn:", userInMidList.length);
      console.log("  list post-turn:", userInPostList.length);

      // ─── 核心观察:user.message processed_at 演变 ─────────────────────
      const procAtTimeline: Array<{ source: string; processed_at: unknown }> = [];
      if (userInSendResp[0]) procAtTimeline.push({ source: "send-resp", processed_at: userInSendResp[0].processed_at });
      if (userInPreList[0]) procAtTimeline.push({ source: "list pre", processed_at: userInPreList[0].processed_at });
      if (userInMidList[0]) procAtTimeline.push({ source: "list mid", processed_at: userInMidList[0].processed_at });
      if (userInStream[0]) procAtTimeline.push({ source: "stream", processed_at: userInStream[0].processed_at });
      if (userInPostList[0]) procAtTimeline.push({ source: "list post", processed_at: userInPostList[0].processed_at });
      console.log("[20.3.1-3] user.message processed_at across paths:", procAtTimeline);

      // ─── 核心观察:user.message 字段全集 across paths ─────────────────
      if (userInPostList[0]) {
        const keys = Object.keys(userInPostList[0]).filter((k) => !k.startsWith("_"));
        console.log("[20.3.1-3] user.message keys in list:", keys);
      }
      if (userInStream[0]) {
        const keys = Object.keys(userInStream[0]).filter((k) => !k.startsWith("_"));
        console.log("[20.3.1-3] user.message keys in stream:", keys);
      }
      if (userInSendResp[0]) {
        const keys = Object.keys(userInSendResp[0]).filter((k) => !k.startsWith("_"));
        console.log("[20.3.1-3] user.message keys in send-resp:", keys);
      }

      // ─── send-response 整体形态 ─────────────────────────────────────
      console.log("[20.3.1-3] send-response keys:", Object.keys(sendCall.rawResponse as object));
      console.log("[20.3.1-3] send-response events count:", sendCall.events.length);
      console.log("[20.3.1-3] corpus:", dump.corpusDir);
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);

  /**
   * 20.3.4 — list snapshot 多次对比:同一 event 跨多次 list 字段稳定性。
   *
   * 流程:跑一次 turn → 等 idle → list 3 次(quiescent state)→ 逐 event id
   * 比较跨 snapshot 字段一致性。
   */
  it("20.3.4 list snapshot stability - 多次 list 字段稳定性", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.3.4 list stability",
    });

    try {
      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: STOP_TYPES,
        defaultMaxWaitMs: 30_000,
      });
      await collector.openStream();
      await new Promise((r) => setTimeout(r, 100));
      await collector.send({
        events: [
          { type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] },
        ],
      });
      // wait for turn to finish
      await collector.consume();

      // quiescent 状态下连拉 3 次 list(每次间隔 200ms)
      const snapA = await collector.listSnapshot();
      await new Promise((r) => setTimeout(r, 200));
      const snapB = await collector.listSnapshot();
      await new Promise((r) => setTimeout(r, 200));
      const snapC = await collector.listSnapshot();

      const snapshot = await collector.finalize();

      const dump = await dumpCorpus("list-stability-quiescent", snapshot, {
        description:
          "Top 10 #4 / §20.3.4 — list snapshot 多次对比:turn 完成后 quiescent 状态下,连拉 3 次 list 各间隔 200ms。看同一 event id 跨快照字段是否稳定 / 是否有任何字段变化。",
        additionalMeta: { case: "20.3.4", top10: "#4" },
      });

      // ─── 断言:同 id 跨快照 business 字段稳定 ────────────────────────
      // 把每次 snapshot 按 id 索引
      const indexById = (events: readonly typeof snapA.events[number][]) => {
        const m = new Map<string, typeof events[number]>();
        for (const e of events) {
          if (typeof e.id === "string") m.set(e.id, e);
        }
        return m;
      };
      const a = indexById(snapA.events);
      const b = indexById(snapB.events);
      const c = indexById(snapC.events);

      const allIds = new Set([...a.keys(), ...b.keys(), ...c.keys()]);
      const idCount = allIds.size;
      console.log("[20.3.4] snapshot sizes (a/b/c):", snapA.events.length, snapB.events.length, snapC.events.length);
      console.log("[20.3.4] unique ids across snapshots:", idCount);

      // ─── 逐 id 比较跨 snapshot 的字段差异 ─────────────────────────────
      const STABLE_FIELDS = ["id", "type", "content", "session_thread_id"];
      const ALL_FIELDS = new Set<string>();
      for (const m of [a, b, c]) {
        for (const e of m.values()) {
          for (const k of Object.keys(e)) {
            if (!k.startsWith("_")) ALL_FIELDS.add(k);
          }
        }
      }
      console.log("[20.3.4] all observed fields across snapshots:", [...ALL_FIELDS]);

      // 找跨 snapshot 字段变化的 event id
      const driftingFields: Record<string, Set<string>> = {};
      for (const id of allIds) {
        const ea = a.get(id);
        const eb = b.get(id);
        const ec = c.get(id);
        const present = [ea, eb, ec].filter((x): x is NonNullable<typeof ea> => !!x);
        if (present.length < 2) continue;
        for (const field of ALL_FIELDS) {
          const values = present.map((p) => JSON.stringify((p as Record<string, unknown>)[field]));
          const uniqueValues = new Set(values);
          if (uniqueValues.size > 1) {
            if (!driftingFields[field]) driftingFields[field] = new Set();
            driftingFields[field].add(id);
          }
        }
      }
      console.log(
        "[20.3.4] fields that drift across snapshots (field → unique ids count):",
        Object.fromEntries(Object.entries(driftingFields).map(([f, ids]) => [f, ids.size])),
      );

      // 业务字段必须稳定
      for (const stable of STABLE_FIELDS) {
        expect(driftingFields[stable]).toBeUndefined();
      }
      console.log("[20.3.4] corpus:", dump.corpusDir);
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);
});
