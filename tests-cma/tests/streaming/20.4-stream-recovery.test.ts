/**
 * Phase 2 §20.4 Stream + List Recovery(Top 10 #1 / #2 / #5)。
 *
 * Top 10 优先级 case:
 *   - 20.4.1 stream-first happy path(3 source corpus baseline)
 *   - 20.4.2 send-then-stream race(明知错的顺序,漏哪些事件)
 *   - 20.4.3 reconnect mid-turn(close stream + list seed + reopen)
 *   - 20.4.5 三层 collector L0/L1/L2 量化(嵌进 20.4.1 / 20.4.3,
 *     直接用 corpus 分析)
 *
 * 每个 case → 1 个 corpus scenario(plan §20.2 推荐目录命名)。
 */

import { describe, expect, it } from "vitest";
import { getClient, resetClientCache } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { rawSseStream } from "../../src/utils/raw-sse.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";
import { safeArchive } from "../../src/fixtures/sessions.ts";

const STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
  "session.deleted",
];

describe("20.4 Stream + List Recovery(Phase 2 Top 10)", () => {
  /**
   * 20.4.1 — stream-first happy path 三 source baseline。
   *
   * 流程:**先**开 raw-sse + 3-layer collector(两条 path 并行) → 三次
   * listSnapshot(pre / mid / post)→ send user.message → consume until
   * idle → dumpCorpus("happy-path-end-turn")。
   *
   * Corpus 是 Phase 2 后续多个 case 的 baseline 参照物。
   */
  it("20.4.1 stream-first happy path - 3 source corpus baseline", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.4.1 happy path",
    });

    try {
      // 1. 并行启 raw-sse + 3-layer collector(两条 path 独立 HTTP)
      const rawSsePromise = rawSseStream(session.id, {
        maxWaitMs: 30_000,
        stopTypes: STOP_TYPES,
      });

      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: STOP_TYPES,
        defaultMaxWaitMs: 30_000,
      });
      await collector.openStream();

      // 2. 给两条 stream 200ms 建连(避免 send 在 stream open 前发出 race)
      await new Promise((r) => setTimeout(r, 200));

      // 3. pre-send list snapshot — 期望:此时 session 为 fresh,events 为空
      await collector.listSnapshot();

      // 4. send user.message(用 collector.send,自动记录到 L0.sendCalls)
      await collector.send({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Reply with the single word 'ok'." }],
          },
        ],
      });

      // 5. mid-turn list snapshot — 立刻拉,大概率 turn 还在跑
      await collector.listSnapshot();

      // 6. consume until idle(blocking 直到 stopType 或 timeout)
      await collector.consume();

      // 7. post-turn list snapshot — turn 结束后全集
      await collector.listSnapshot();

      // 8. wait for raw-sse to finish too(它独立 consume,应该跟 collector 同步 stop)
      const rawSse = await rawSsePromise;

      const snapshot = await collector.finalize();

      // ─── corpus dump ─────────────────────────────────────────────
      const dump = await dumpCorpus("happy-path-end-turn", snapshot, {
        description:
          "Top 10 #1 / §20.4.1 — stream-first happy path:open both raw-sse + 3-layer collector → 3 lists (pre/mid/post) → send user.message(reply 'ok')→ consume until idle。Phase 2 后续多 case 的 baseline 参照。",
        rawSse,
        additionalMeta: {
          case: "20.4.1",
          top10: "#1",
        },
      });

      // ─── 断言 ────────────────────────────────────────────────────
      // L0 三 source 都有数据
      expect(snapshot.stats.l0StreamCount).toBeGreaterThan(0);
      expect(snapshot.stats.l0ListSnapshotCount).toBe(3);
      expect(snapshot.stats.l0SendCallCount).toBe(1);
      // raw-sse 也有数据
      expect(rawSse.lines.length).toBeGreaterThan(0);
      expect(rawSse.meta.httpStatus).toBe(200);
      expect(rawSse.meta.requestId).toBeTruthy();
      expect(rawSse.meta.amznRequestId).toBeTruthy();

      // session.status_idle 在 L2(收尾事件)
      const sawIdle = snapshot.L2.some((e) => e.type === "session.status_idle");
      expect(sawIdle).toBe(true);

      // ─── §20.4 / §20.3 / §20.1 信号打印(给 finding 阶段用) ───────
      console.log("[20.4.1] corpus:", dump.corpusDir);
      console.log("[20.4.1] L0 stream/list-events/send-events:", snapshot.stats.l0StreamCount, snapshot.stats.l0ListEventTotal, snapshot.stats.l0SendEventTotal);
      console.log("[20.4.1] L1:", snapshot.stats.l1Count, "L2:", snapshot.stats.l2Count);
      console.log("[20.4.1] raw-sse lines:", rawSse.lines.length, "events:", rawSse.events.length);

      // §20.1 信号:wire-level frame field 分布
      const fieldTypeCounts: Record<string, number> = {};
      for (const ln of rawSse.lines) {
        fieldTypeCounts[ln.fieldType] = (fieldTypeCounts[ln.fieldType] ?? 0) + 1;
      }
      console.log("[20.4.1 / §20.1] frame field types:", fieldTypeCounts);

      // §20.3 信号:user.message 在 L1 的 source 分布(应只在 list,印证 user.* 不进 stream)
      const userMsgInL1 = snapshot.L1.filter((e) => e.type === "user.message");
      console.log("[20.4.1 / §20.3] user.message sources in L1:", userMsgInL1.map((e) => e._source));

      // §20.3 信号:每次 list snapshot 的 event count(看 ack timing)
      console.log("[20.4.1 / §20.3] list snapshot sizes:", snapshot.L0.listSnapshots.map((s) => s.events.length));

      // §20.2 信号:每条 event 在 L1 occurrence 次数 — Phase 1 F-0001 说 single,
      //   3-layer collector 的 L1 dedupe by (id, processed_at, payloadHash) 应该
      //   把跨 source 的同一观察合并成 1 条;若 >1 表示同 id 有多次 ack transition
      const idCountsInL1: Record<string, number> = {};
      for (const e of snapshot.L1) {
        const id = typeof e.id === "string" ? e.id : "<no-id>";
        idCountsInL1[id] = (idCountsInL1[id] ?? 0) + 1;
      }
      const multiOccurrence = Object.entries(idCountsInL1).filter(([, n]) => n > 1);
      console.log("[20.4.1 / §20.3] L1 multi-occurrence id count:", multiOccurrence.length);
      if (multiOccurrence.length > 0) {
        console.log("[20.4.1 / §20.3] L1 multi-occurrence detail:", multiOccurrence.slice(0, 5));
      }

      // §20.5 信号:lifecycle events 序列
      const lifecycleEvents = snapshot.L2.filter((e) =>
        (e.type as string).startsWith("session.status_") || e.type === "session.error" || e.type === "session.deleted",
      ).map((e) => e.type);
      console.log("[20.4.1 / §20.5] lifecycle events sequence:", lifecycleEvents);
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);

  /**
   * 20.4.2 — send-then-stream race(明知错的 quickstart 反例)。
   *
   * 流程:create session → **直接 send**(stream 还没开)→ 才开 stream +
   * raw-sse → consume → 看漏了什么事件。
   *
   * 预期:漏掉 status_running 的早期事件,可能漏掉 user.message ack。
   * 跟 20.4.1 baseline 对比量化丢失。
   */
  it("20.4.2 send-then-stream race - 明知错的顺序漏哪些事件", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.4.2 race",
    });

    try {
      // 1. 错的顺序:**先** send,然后才开 stream
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Reply with the single word 'ok'." }],
          },
        ],
      });

      // 2. 给 server 一点时间已经开始发 events 了
      await new Promise((r) => setTimeout(r, 100));

      // 3. 才开 stream + raw-sse(漏掉之前发出的所有事件)
      const rawSsePromise = rawSseStream(session.id, {
        maxWaitMs: 30_000,
        stopTypes: STOP_TYPES,
      });
      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: STOP_TYPES,
        defaultMaxWaitMs: 30_000,
      });
      await collector.openStream();

      // 4. 拉一次 list 看完整事件(list 是 always 全集 — 能看到 stream 漏掉的)
      await collector.listSnapshot();

      // 5. consume stream until idle(只能拿到 stream-open 之后的事件)
      await collector.consume();

      // 6. 再拉一次 list 看 turn 结束后的完整状态
      await collector.listSnapshot();

      const rawSse = await rawSsePromise;
      const snapshot = await collector.finalize();

      const dump = await dumpCorpus("send-then-stream-race", snapshot, {
        description:
          "Top 10 #2 / §20.4.2 — send-then-stream race:违反 quickstart 推荐顺序,先 send 再 open stream。预期漏掉 status_running 早期事件。跟 happy-path-end-turn baseline 对比量化丢失。",
        rawSse,
        additionalMeta: { case: "20.4.2", top10: "#2" },
      });

      // ─── 断言 ────────────────────────────────────────────────────
      // Stream 应该收到一些事件(至少 status_idle 收尾),但比 20.4.1 少
      expect(snapshot.stats.l0StreamCount).toBeGreaterThan(0);
      // list 应该完整(全集)
      expect(snapshot.stats.l0ListSnapshotCount).toBe(2);
      // post-turn list 应该有完整事件
      const postList = snapshot.L0.listSnapshots[1];
      expect(postList).toBeDefined();
      expect(postList!.events.length).toBeGreaterThanOrEqual(snapshot.stats.l0StreamCount);

      // ─── 信号打印 ──────────────────────────────────────────────────
      console.log("[20.4.2] corpus:", dump.corpusDir);
      console.log("[20.4.2] L0 stream count:", snapshot.stats.l0StreamCount);
      console.log("[20.4.2] list post-turn count:", postList!.events.length);
      console.log("[20.4.2] race 漏失估算 (list - stream):", postList!.events.length - snapshot.stats.l0StreamCount);

      // 看 stream 收到的事件类型 → 看是否有 status_running(early event,容易漏)
      const streamTypes = snapshot.L0.stream.map((e) => e.type);
      console.log("[20.4.2] stream types:", streamTypes);

      const listTypes = postList!.events.map((e) => e.type);
      const listOnlyTypes = listTypes.filter((t) => !streamTypes.includes(t));
      console.log("[20.4.2] list-only types(stream 漏掉的 unique types):", [...new Set(listOnlyTypes)]);
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);

  /**
   * 20.4.3 — reconnect mid-turn(Top 10 #5)。
   *
   * 流程:open stream → send user.message → 收到 status_running 就关 stream
   * → wait 2s(server 继续 emit events 但无 subscriber)→ list seed →
   * reopen stream → consume rest → finalize → 检查 L1 是否完整恢复。
   *
   * 反推:Stream-then-list reconnect 协议是否能 0-loss 恢复;若 L1 缺失某
   * 事件,说明 list 也漏(可能服务端尚未 flush)或我们的算法有 bug。
   */
  it("20.4.3 reconnect mid-turn - L1 recovered feed 完整性", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.4.3 reconnect",
    });

    try {
      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: STOP_TYPES,
        defaultMaxWaitMs: 30_000,
      });
      await collector.openStream();
      await new Promise((r) => setTimeout(r, 200));

      await collector.send({
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
      });

      // 早停在 session.status_running — 这是 turn 早期事件,容易抓
      const earlyEvents = await collector.consume({
        stopTypes: ["session.status_running"],
        maxWaitMs: 5_000,
      });
      console.log("[20.4.3] early consume (stop at status_running) got:", earlyEvents.map((e) => e.type));

      // 关 stream(模拟中断)
      await collector.closeStream();
      const closeTimestamp = performance.now();

      // wait 2s — server 继续 emit events 给"空气"
      await new Promise((r) => setTimeout(r, 2000));

      // list seed —— 此时 turn 应该接近完成或已完成
      const seed = await collector.listSnapshot();
      console.log("[20.4.3] list seed count:", seed.events.length);

      // reopen stream —— 这个 stream 不会 replay,只会接收 reopen 之后新事件
      await collector.reopenStream();

      // consume rest 直到 idle(maxWaitMs 5s — 若 turn 已结束,可能 timeout 但无所谓)
      const lateEvents = await collector.consume({ maxWaitMs: 8_000 });
      console.log("[20.4.3] late consume (after reopen) got:", lateEvents.map((e) => e.type));

      const snapshot = await collector.finalize();

      const dump = await dumpCorpus("reconnect-mid-turn", snapshot, {
        description:
          "Top 10 #5 / §20.4.3 — open stream → send → consume until status_running → close stream → wait 2s → list seed → reopen → consume rest。反推:L1 (id, processed_at, payloadHash) recovered feed 是否覆盖完整 turn(stream 漏掉的部分由 list seed 补)。",
        additionalMeta: {
          case: "20.4.3",
          top10: "#5",
          early_event_count: earlyEvents.length,
          early_event_types: earlyEvents.map((e) => e.type),
          close_timestamp_ms: closeTimestamp,
          list_seed_count: seed.events.length,
          late_event_count: lateEvents.length,
          late_event_types: lateEvents.map((e) => e.type),
        },
      });

      // ── 信号:L1 完整性 ────────────────────────────────────────────
      const expectedTurnTypes = [
        "session.status_running",
        "session.thread_status_running",
        "user.message",
        "span.model_request_start",
        "agent.message",
        "span.model_request_end",
        "session.thread_status_idle",
        "session.status_idle",
      ];
      const l1Types = new Set(snapshot.L1.map((e) => e.type));
      const missingFromL1 = expectedTurnTypes.filter((t) => !l1Types.has(t));
      console.log("[20.4.3] L1 type set size:", l1Types.size);
      console.log("[20.4.3] **L1 missing types(expected but not in L1)**:", missingFromL1);

      // 看每个 event 是从哪条 path 进入 L1 — Stream connection 0 / 1 / list
      const sourceBreakdown: Record<string, number> = {};
      for (const e of snapshot.L1) {
        const key =
          e._source === "stream"
            ? `stream(conn${e._streamConnectionIndex})`
            : (e._source ?? "unknown");
        sourceBreakdown[key] = (sourceBreakdown[key] ?? 0) + 1;
      }
      console.log("[20.4.3] L1 source breakdown:", sourceBreakdown);

      // 哪些 type 只通过 list seed 进 L1(stream 都漏 — 关流期间发出的事件)?
      const typesOnlyViaList: string[] = [];
      for (const e of snapshot.L1) {
        const sameTypeViaStream = snapshot.L1.some(
          (x) => x.id === e.id && x._source === "stream",
        );
        if (e._source === "list" && !sameTypeViaStream) {
          typesOnlyViaList.push(String(e.type));
        }
      }
      console.log("[20.4.3] **types only recovered via list seed**:", typesOnlyViaList);

      // 断言:至少 status_idle 在 L1(turn 收尾)— 不严格断言 zero-loss,
      // 因为 list seed timing 可能错过最后几个 event
      expect(l1Types.has("session.status_idle")).toBe(true);
      console.log("[20.4.3] corpus:", dump.corpusDir);
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);
});
