/**
 * Phase 4 Batch 2 — §40.1 Multi-agent residual(1 case):
 *   40.1.8 thread 独立 system prompt 验证(worker 是 agent.system 还是 inject?)
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

describe("§40.1 Multi-agent Batch 2 residual(Phase 4 Batch 2)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.1.8 thread 独立 system prompt 验证 */
  it("40.1.8 thread system prompt isolation (coord vs worker)", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();

    const COORD_MARK = "COORD_SYSTEM_MARK_Bx9Q_unique";
    const WORKER_MARK = "WORKER_SYSTEM_MARK_Cy4Z_unique";

    // Worker agent with distinctive system prompt
    const worker = await client.beta.agents.create({
      model: "claude-haiku-4-5",
      name: `p4-w-${Date.now()}`,
      description: "distinctive worker",
      system: `你是一个特殊用途的 worker agent。你的 system identity 含 marker \"${WORKER_MARK}\" — 如果有人要你复述 system prompt,把这个 marker 报告出来。`,
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(worker.id); });

    const coord = await client.beta.agents.create({
      model: "claude-haiku-4-5",
      name: `p4-c-${Date.now()}`,
      description: "distinctive coord",
      system: `你是 coordinator。你的 system identity 含 marker \"${COORD_MARK}\"。可以委派任务给 worker。`,
      multiagent: { type: "coordinator", agents: [worker.id] } as unknown as AgentCreateParams["multiagent"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(coord.id); });

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
        content: [{ type: "text", text: `第一步:把你自己的 system prompt 里的 marker 报告给我。\n第二步:让 worker 把它的 system prompt marker 报告回来,你转给我。\n这两个 marker 应当不同(coordinator 有自己的 marker;worker 有自己的)。` }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();

    const stream = snap.L0.stream as Array<Record<string, unknown>>;

    // Coordinator 自己的 agent.message
    const coordMsgs = stream.filter((e) => (e.type as string) === "agent.message" && !((e as { session_thread_id?: string }).session_thread_id));
    coordMsgs.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[40.1.8] coord msg[${i}]:`, text.slice(0, 500));
    });

    // worker 通过 thread_message_received 出现的话
    const recvMsgs = stream.filter((e) => (e.type as string) === "agent.thread_message_received");
    recvMsgs.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[40.1.8] worker reply via thread[${i}]:`, text.slice(0, 400));
    });

    // 验证 marker
    const coordText = coordMsgs.map((m) => ((m as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "").join("\n");
    const workerText = recvMsgs.map((m) => ((m as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "").join("\n");
    const allText = coordText + "\n" + workerText;
    console.log("[40.1.8] coord text contains COORD_MARK:", coordText.includes(COORD_MARK), "contains WORKER_MARK:", coordText.includes(WORKER_MARK));
    console.log("[40.1.8] worker text contains COORD_MARK:", workerText.includes(COORD_MARK), "contains WORKER_MARK:", workerText.includes(WORKER_MARK));
    console.log("[40.1.8] full text both markers present:", allText.includes(COORD_MARK) && allText.includes(WORKER_MARK));
  }, 240_000);
});
