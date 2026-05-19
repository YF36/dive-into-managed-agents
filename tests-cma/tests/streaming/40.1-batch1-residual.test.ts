/**
 * Phase 4 Batch 1 — §40.1 Multi-agent residual Top 3.
 *
 *   40.1.6 共享 fs 并发写(2 sub-agent 同时写同一文件)
 *   40.1.7 coordinator interrupt(发 user.interrupt 时所有 thread 行为)
 *   40.1.12 child idle 后 coord 再 message 同 child(thread reuse 或 new thread?)
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];
type EventSendParams = Parameters<AnthropicAws["beta"]["sessions"]["events"]["send"]>[1];

const MINIMAL = {
  model: "claude-haiku-4-5" as const,
  description: "Phase 4 multi-agent residual",
};

async function setupCoord(
  client: ReturnType<typeof getClient>,
  cleanup: Array<() => Promise<void>>,
  childCount = 1,
): Promise<{ coord: { id: string }; children: Array<{ id: string; name?: string }> }> {
  const children: Array<{ id: string; name?: string }> = [];
  for (let i = 0; i < childCount; i++) {
    const c = await client.beta.agents.create({
      ...MINIMAL,
      name: `p4-worker-${Date.now()}-${i}`,
      system: `你是 worker-${i}。被 coordinator 调用时按指令做事,简洁回复。`,
      metadata: tagWithRunId(),
    });
    children.push(c);
    cleanup.push(async () => { await client.beta.agents.archive(c.id); });
  }
  const coord = await client.beta.agents.create({
    ...MINIMAL,
    name: `p4-coord-${Date.now()}`,
    system: "你是 coordinator,严格按 user 指令分派任务给 worker。",
    multiagent: {
      type: "coordinator",
      agents: children.map((c) => c.id),
    } as unknown as AgentCreateParams["multiagent"],
    metadata: tagWithRunId(),
  });
  cleanup.push(async () => { await client.beta.agents.archive(coord.id); });
  return { coord, children };
}

describe("§40.1 Multi-agent residual Top 3(Phase 4 Batch 1)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.1.6 共享 fs 并发写 */
  it("40.1.6 two workers concurrent write same file — lock vs race", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();
    const { coord } = await setupCoord(client, cleanup, 2);

    const session = await client.beta.sessions.create({
      agent: coord.id, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 180_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{
        type: "user.message",
        content: [{
          type: "text",
          text: "同时给两个 worker 分派任务:让 worker-0 把字符串 'AAAAAAAA' 写到 /work/race.txt;让 worker-1 把字符串 'BBBBBBBB' 写到同一个 /work/race.txt。要求两个 worker **同时**开始(并行 send 两个 thread message,不要先后)。两个完成后,你 cat /work/race.txt 把内容原样返回给我。",
        }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const stream = snap.L0.stream as Array<Record<string, unknown>>;

    const sentEvts = stream.filter((e) => (e.type as string) === "agent.thread_message_sent");
    const recvEvts = stream.filter((e) => (e.type as string) === "agent.thread_message_received");
    const threadCreated = stream.filter((e) => (e.type as string) === "session.thread_created");
    console.log("[40.1.6] thread_message_sent:", sentEvts.length, "received:", recvEvts.length, "threads_created:", threadCreated.length);

    sentEvts.forEach((e, i) => {
      const tid = (e as { to_session_thread_id?: string }).to_session_thread_id;
      const proc = (e as { processed_at?: string }).processed_at;
      console.log(`[40.1.6] sent[${i}] to_thread:`, tid, "at:", proc);
    });
    recvEvts.forEach((e, i) => {
      const tid = (e as { from_session_thread_id?: string }).from_session_thread_id;
      const proc = (e as { processed_at?: string }).processed_at;
      console.log(`[40.1.6] recv[${i}] from_thread:`, tid, "at:", proc);
    });

    const agentMsgs = stream.filter((e) => (e.type as string) === "agent.message" && !((e as { session_thread_id?: string }).session_thread_id));
    agentMsgs.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[40.1.6] coord msg[${i}]:`, text.slice(0, 400));
    });
  }, 300_000);

  /** 40.1.7 coordinator interrupt — 所有非 archived thread 行为 */
  it("40.1.7 user.interrupt during coord+worker turn", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();
    const { coord } = await setupCoord(client, cleanup, 1);

    const session = await client.beta.sessions.create({
      agent: coord.id, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 180_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "让 worker 写一段 1000 字的随机内容,然后你转给我。不要简化任务。" }],
      }],
    });

    // 等 worker thread running 出现
    await collector.consume({ stopTypes: ["session.thread_status_running", "agent.thread_message_sent"], maxWaitMs: 60_000 });
    console.log("[40.1.7] saw thread started, send interrupt in 2s");
    await new Promise((r) => setTimeout(r, 2000));

    try {
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.interrupt" }] as EventSendParams["events"],
      });
      console.log("[40.1.7] interrupt sent (no thread_id - 应当 interrupt all non-archived)");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.1.7] interrupt error:", e.status, e.message?.slice(0, 200));
    }

    await collector.consume();
    const snap = await collector.finalize();
    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const threadStatusEvts = stream.filter((e) => typeof e.type === "string" && (e.type as string).startsWith("session.thread_status_"));
    threadStatusEvts.forEach((e, i) => {
      const tid = (e as { session_thread_id?: string }).session_thread_id;
      console.log(`[40.1.7] thread_status[${i}]`, e.type, "thread:", tid, "at:", (e as { processed_at?: string }).processed_at);
    });
    const interrupt = stream.filter((e) => (e.type as string) === "user.interrupt");
    console.log("[40.1.7] user.interrupt echo in stream:", interrupt.length);
    const finalStatus = await client.beta.sessions.retrieve(session.id);
    console.log("[40.1.7] final session.status:", finalStatus.status);
  }, 240_000);

  /** 40.1.12 child idle 后 coord 再 message — thread reuse 还是 new */
  it("40.1.12 coord sends 2nd message after child idle — same thread or new?", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();
    const { coord } = await setupCoord(client, cleanup, 1);

    const session = await client.beta.sessions.create({
      agent: coord.id, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 180_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // Turn 1: coord delegates to worker once
    await collector.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "让 worker 报告当前时间(让它编一个,3 句话即可)。然后告诉我 worker 的原话。" }],
      }],
    });
    await collector.consume();

    const snap1 = await collector.finalize();
    const stream1 = snap1.L0.stream as Array<Record<string, unknown>>;
    const sent1 = stream1.filter((e) => (e.type as string) === "agent.thread_message_sent");
    const threadCreated1 = stream1.filter((e) => (e.type as string) === "session.thread_created");
    const threadIdsTurn1 = new Set<string>();
    for (const e of [...sent1, ...threadCreated1]) {
      const tid = (e as { to_session_thread_id?: string; session_thread_id?: string }).to_session_thread_id ?? (e as { session_thread_id?: string }).session_thread_id;
      if (typeof tid === "string") threadIdsTurn1.add(tid);
    }
    console.log("[40.1.12] turn 1 thread_ids:", [...threadIdsTurn1]);

    // Re-open stream for turn 2(stream was closed by finalize)
    const collector2 = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 180_000,
    });
    await collector2.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // Turn 2: coord delegates again
    await collector2.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "再让 worker 写一首五言绝句(随便编)。然后告诉我原话。" }],
      }],
    });
    await collector2.consume();
    const snap2 = await collector2.finalize();
    const stream2 = snap2.L0.stream as Array<Record<string, unknown>>;
    const sent2 = stream2.filter((e) => (e.type as string) === "agent.thread_message_sent");
    const threadCreated2 = stream2.filter((e) => (e.type as string) === "session.thread_created");
    const threadIdsTurn2 = new Set<string>();
    for (const e of [...sent2, ...threadCreated2]) {
      const tid = (e as { to_session_thread_id?: string; session_thread_id?: string }).to_session_thread_id ?? (e as { session_thread_id?: string }).session_thread_id;
      if (typeof tid === "string") threadIdsTurn2.add(tid);
    }
    console.log("[40.1.12] turn 2 thread_ids:", [...threadIdsTurn2]);
    console.log("[40.1.12] turn 2 thread_created count:", threadCreated2.length);

    // 关键观察:turn 2 用的 thread 是 turn 1 同 thread_id 还是 new?
    const reused = [...threadIdsTurn2].some((t) => threadIdsTurn1.has(t));
    const newOnes = [...threadIdsTurn2].filter((t) => !threadIdsTurn1.has(t));
    console.log("[40.1.12] thread reused:", reused, "new in turn 2:", newOnes);
  }, 360_000);
});
