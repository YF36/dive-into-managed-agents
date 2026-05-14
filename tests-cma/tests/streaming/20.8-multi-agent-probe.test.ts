/**
 * Phase 2.5 §20.8 Multi-agent probe(Top 10 #10 + research preview probe)。
 *
 * 先 probe research preview access — 创建 coordinator agent with multiagent
 * config。若 accepted → 跑 20.8.1-3 子 case;若 rejected with feature-gated
 * 错误 → 文档化 gate 行为,留 Phase 3 拿到 access 后再做。
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { rawSseStream } from "../../src/utils/raw-sse.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

const STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
];

const MINIMAL_PARAMS = {
  model: "claude-haiku-4-5" as const,
  description: "20.8 multi-agent test agent",
};

describe("20.8 Multi-agent probe(Phase 2.5)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /**
   * 20.8.0 — research preview gate probe + 若 accept 则 cross-post / thread
   * stream / session_thread_id 路由观察。
   */
  it("20.8.0/1/3 multi-agent coordinator probe + thread events 观察", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();

    // 1) 先创建 1 个 child agent(简单 worker)
    let childAgent: Awaited<ReturnType<typeof client.beta.agents.create>>;
    try {
      childAgent = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: `cma-test-child-${Date.now()}`,
        system: "你是一个简单的 worker agent。被 coordinator 调用时简洁回答。",
        metadata: tagWithRunId(),
      });
      cleanup.push(async () => { await client.beta.agents.archive(childAgent.id); });
      console.log("[20.8] child agent created:", childAgent.id);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { message?: string } } } | null;
      console.log("[20.8] child agent create failed:", e?.status, e?.error?.error?.message);
      throw err;
    }

    // 2) 试创建 coordinator agent with multiagent.agents = [child.id]
    let coordinator: Awaited<ReturnType<typeof client.beta.agents.create>>;
    let gateRejection: { status?: number; message?: string; type?: string } | undefined;
    try {
      const coordParams: AgentCreateParams = {
        ...MINIMAL_PARAMS,
        name: `cma-test-coordinator-${Date.now()}`,
        system: "你是 coordinator,可以委派任务给 worker。",
        multiagent: {
          type: "coordinator",
          agents: [childAgent.id],
        } as unknown as AgentCreateParams["multiagent"],
        metadata: tagWithRunId(),
      };
      coordinator = await client.beta.agents.create(coordParams);
      cleanup.push(async () => { await client.beta.agents.archive(coordinator.id); });
      console.log("[20.8] **coordinator agent created (preview access OK):**", coordinator.id);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { message?: string; type?: string } } } | null;
      gateRejection = {
        status: e?.status,
        message: e?.error?.error?.message,
        type: e?.error?.error?.type,
      };
      console.log("[20.8] **coordinator REJECTED — research preview likely not enabled:**");
      console.log("  status:", gateRejection.status);
      console.log("  type:", gateRejection.type);
      console.log("  message:", gateRejection.message);

      // dump probe corpus 记录 gate 行为(没 session,只有 reject)
      const stubSnap = {
        baseline: 0,
        L0: { stream: [], listSnapshots: [], sendCalls: [] },
        L1: [], L2: [],
        stats: { l0StreamCount: 0, l0ListSnapshotCount: 0, l0ListEventTotal: 0, l0SendCallCount: 0, l0SendEventTotal: 0, l1Count: 0, l2Count: 0 },
      };
      await dumpCorpus("multi-agent-preview-gate", stubSnap, {
        description: "§20.8 research preview gate probe:agent.create with multiagent.coordinator + child_id 被 reject。记录 gate 行为以备 Phase 3 拿到 access 后对照。",
        additionalMeta: {
          case: "20.8.0",
          probe: "research-preview-multiagent",
          gate_rejection: gateRejection,
        },
      });
      // 不抛 — probe 成功(确认 gated)
      return;
    }

    // 3) Preview access OK — 创建 session + run turn 看 thread events
    const session = await client.beta.sessions.create({
      agent: coordinator.id,
      environment_id: envId,
      title: "20.8 multi-agent session",
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // 同时开 raw-sse(primary stream)+ 3-layer collector
    const rawSsePromise = rawSseStream(session.id, {
      maxWaitMs: 60_000,
      stopTypes: STOP_TYPES,
    });
    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES,
      defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // Send user.message 让 coordinator 委派 child
    await collector.send({
      events: [
        { type: "user.message", content: [{ type: "text", text: "请让 worker 简短地回复 'ok'。" }] },
      ],
    });
    const events = await collector.consume();
    const rawSse = await rawSsePromise;
    const snapshot = await collector.finalize();

    const eventTypes = events.map((e) => e.type);
    console.log("[20.8] primary stream event types:", eventTypes);
    console.log("[20.8] L0 stream count:", snapshot.stats.l0StreamCount);

    // 观察:thread_* events
    const threadEvents = events.filter((e) => {
      const t = e.type;
      return typeof t === "string" && (t.startsWith("session.thread_") || t.startsWith("agent.thread_"));
    });
    console.log("[20.8] thread events count:", threadEvents.length);
    console.log("[20.8] thread event types:", threadEvents.map((e) => e.type));

    // 观察 undefined type event 数(SDK 异常或新 event type 未识别)
    const undefinedTypeCount = events.filter((e) => typeof e.type !== "string").length;
    console.log("[20.8] events with type=undefined:", undefinedTypeCount);
    if (undefinedTypeCount > 0) {
      const undef = events.find((e) => typeof e.type !== "string");
      console.log("[20.8] undefined event sample:", JSON.stringify(undef).slice(0, 300));
    }

    // 观察:有无 session_thread_id 字段
    const eventsWithThreadId = events.filter((e) =>
      typeof (e as unknown as { session_thread_id?: unknown }).session_thread_id === "string"
    );
    console.log("[20.8] events with session_thread_id 字段:", eventsWithThreadId.length);

    // primary 与 raw-sse 对照
    console.log("[20.8] raw-sse total events:", rawSse.events.length);

    // 试拉 session threads
    try {
      const threads: unknown[] = [];
      const sessionsAny = client.beta.sessions as unknown as {
        threads?: { list?: (id: string) => AsyncIterable<unknown> };
      };
      if (typeof sessionsAny.threads?.list === "function") {
        for await (const t of sessionsAny.threads.list(session.id)) {
          threads.push(t);
        }
        console.log("[20.8] session.threads.list() count:", threads.length);
      } else {
        console.log("[20.8] session.threads.list 不可用");
      }
    } catch (err) {
      console.log("[20.8] threads.list 抛错:", (err as Error).message);
    }

    const dump = await dumpCorpus("multi-agent-coordinator", snapshot, {
      description:
        "Top 10 #10 / §20.8.0/1/3 — coordinator agent + 1 child agent;send user.message 让 coordinator 委派 → 观察 primary stream 是否含 thread events(cross-post)+ session_thread_id 字段;尝试 session.threads.list 拉 thread roster。",
      rawSse,
      additionalMeta: {
        case: "20.8.0/1/3",
        top10: "#10",
        coordinator_agent_id: coordinator.id,
        child_agent_id: childAgent.id,
        thread_event_count: threadEvents.length,
        events_with_thread_id_count: eventsWithThreadId.length,
        primary_stream_event_types: eventTypes,
      },
    });
    console.log("[20.8] corpus:", dump.corpusDir);

    // 软断言:至少看到 idle 收尾
    expect(events.some((e) => e.type === "session.status_idle")).toBe(true);
  }, 180_000);
});
