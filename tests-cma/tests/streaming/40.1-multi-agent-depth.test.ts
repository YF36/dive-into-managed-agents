/**
 * Phase 3 Batch 3 — §40.1 Multi-agent 深度 Top 4。
 *
 * F-0021 baseline:23-event coordinator+1 worker thread chain。这里深探:
 *   40.1.4 thread message lineage 字段 schema(from/to session_thread_id)
 *   40.1.7 per-thread events.list / stream endpoint(F-0027 看 404 follow-up)
 *   40.1.5 coordinator 拿到的是 summary 还是 detail(对照 child 实发)
 *   40.1.11 session.status 是否 thread 状态的 OR 聚合
 *
 * Token 预算 ~300k(coordinator+child 每 run ~50-100k Haiku 4.5)。
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

const MINIMAL_PARAMS = {
  model: "claude-haiku-4-5" as const,
  description: "Phase 3 §40.1 multi-agent test",
};

async function createCoordinatorWithChild(
  client: ReturnType<typeof getClient>,
  cleanup: Array<() => Promise<void>>,
  childCount = 1,
) {
  const children: Array<{ id: string; name?: string }> = [];
  for (let i = 0; i < childCount; i++) {
    const c = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: `p3-worker-${Date.now()}-${i}`,
      system: `你是 worker ${i}。被 coordinator 调用时简洁回答,只回 'worker ${i}: <短答>'。`,
      metadata: tagWithRunId(),
    });
    children.push(c);
    cleanup.push(async () => { await client.beta.agents.archive(c.id); });
  }
  const coordParams: AgentCreateParams = {
    ...MINIMAL_PARAMS,
    name: `p3-coord-${Date.now()}`,
    system: "你是 coordinator,可以委派任务给 worker。",
    multiagent: {
      type: "coordinator",
      agents: children.map((c) => c.id),
    } as unknown as AgentCreateParams["multiagent"],
    metadata: tagWithRunId(),
  };
  const coordinator = await client.beta.agents.create(coordParams);
  cleanup.push(async () => { await client.beta.agents.archive(coordinator.id); });
  return { coordinator, children };
}

describe("§40.1 Multi-agent 深度 Top 4(Phase 3 Batch 3)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.1.4 + 40.1.5 + 40.1.7 — 共享一次 delegation run */
  it("40.1.4/5/7 thread message lineage + summary 对照 + endpoint probe", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();

    const { coordinator, children } = await createCoordinatorWithChild(client, cleanup, 1);
    const session = await client.beta.sessions.create({
      agent: coordinator.id, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });
    console.log("[40.1] session:", session.id, "coord:", coordinator.id, "worker:", children[0]?.id);

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));
    await collector.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "请委派 worker,让 ta 报告今天天气(让 worker 编一个简短答案就行)。把 worker 的完整原话和你的总结一起返回给我。" }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();

    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const types = stream.map((e) => (typeof e.type === "string" ? e.type : "<undef>"));
    const typeCounts: Record<string, number> = {};
    for (const t of types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    console.log("[40.1] event type counts:", JSON.stringify(typeCounts));

    // 40.1.4 thread message lineage schema
    const sentEvts = stream.filter((e) => (e.type as string) === "agent.thread_message_sent");
    const recvEvts = stream.filter((e) => (e.type as string) === "agent.thread_message_received");
    console.log("[40.1.4] thread_message_sent count:", sentEvts.length, "received count:", recvEvts.length);
    if (sentEvts.length > 0) {
      console.log("[40.1.4] sent[0] full payload:", JSON.stringify(sentEvts[0], null, 2).slice(0, 1500));
    }
    if (recvEvts.length > 0) {
      console.log("[40.1.4] received[0] full payload:", JSON.stringify(recvEvts[0], null, 2).slice(0, 1500));
    }

    // 40.1.5 coordinator 拿到的 vs child 实发 — 通过 child 的 agent.message + 显式 reply
    const allMessages = stream.filter((e) => (e.type as string) === "agent.message");
    console.log("[40.1.5] total agent.message in primary stream:", allMessages.length);
    allMessages.forEach((m, i) => {
      const text = ((m as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      const stid = (m as { session_thread_id?: string | null }).session_thread_id;
      const agName = (m as { agent_name?: string }).agent_name;
      console.log(`[40.1.5] msg[${i}] agent_name:`, agName, "thread_id:", stid, "text:", text.slice(0, 200));
    });

    // 40.1.7 per-thread endpoint probe — 用 received event 里的 session_thread_id 试 raw HTTP
    const allWithThreadId = stream.filter((e) => typeof (e as { session_thread_id?: unknown }).session_thread_id === "string");
    const threadIds = new Set(allWithThreadId.map((e) => (e as { session_thread_id: string }).session_thread_id));
    console.log("[40.1.7] distinct session_thread_ids in stream:", [...threadIds]);
    for (const tid of threadIds) {
      // a) SDK threads.retrieve
      try {
        const t = await client.beta.sessions.threads.retrieve(tid, { session_id: session.id });
        console.log("[40.1.7] threads.retrieve(", tid, ") OK:", JSON.stringify(t).slice(0, 400));
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.log("[40.1.7] threads.retrieve error:", e.status, e.message?.slice(0, 200));
      }
      // b) SDK threads.events.list
      try {
        const evs: unknown[] = [];
        for await (const ev of client.beta.sessions.threads.events.list(tid, { session_id: session.id, limit: 10 } as Parameters<typeof client.beta.sessions.threads.events.list>[1])) {
          evs.push(ev);
          if (evs.length >= 10) break;
        }
        console.log("[40.1.7] threads.events.list(", tid, ") count:", evs.length);
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.log("[40.1.7] threads.events.list error:", e.status, e.message?.slice(0, 200));
      }
    }
  }, 240_000);

  /** 40.1.11 session.status 跟 thread 状态的关系 */
  it("40.1.11 session.status during child thread running", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();

    const { coordinator } = await createCoordinatorWithChild(client, cleanup, 1);
    const session = await client.beta.sessions.create({
      agent: coordinator.id, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // 发请求后立刻 retrieve status,观察过程中状态
    await collector.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "委派 worker 做一件耗时的事:数到 10 并解释每个数字的趣味事实。然后把它的回答转给我。" }],
      }],
    });
    // Poll status during turn
    const statusSamples: Array<{ ts: number; status: string }> = [];
    const startTs = Date.now();
    const pollInterval = setInterval(async () => {
      try {
        const s = await client.beta.sessions.retrieve(session.id);
        statusSamples.push({ ts: Date.now() - startTs, status: s.status });
      } catch { /* ignore */ }
    }, 500);

    await collector.consume();
    clearInterval(pollInterval);
    const snap = await collector.finalize();
    console.log("[40.1.11] status samples during turn:");
    statusSamples.forEach((s) => console.log(`  +${s.ts}ms:`, s.status));

    // 找出 thread_status_* event 时序
    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const threadStatusEvts = stream.filter((e) => typeof e.type === "string" && (e.type as string).startsWith("session.thread_status_"));
    console.log("[40.1.11] thread_status_* events in primary stream:");
    threadStatusEvts.forEach((e, i) => {
      const stid = (e as { session_thread_id?: string }).session_thread_id;
      console.log(`  [${i}]`, e.type, "thread_id:", stid, "at:", (e as { processed_at?: string }).processed_at);
    });

    // session.status 终态
    const final = await client.beta.sessions.retrieve(session.id);
    console.log("[40.1.11] final session.status:", final.status);
    expect(final.status).toBe("idle");
  }, 240_000);
});
