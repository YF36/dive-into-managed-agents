/**
 * Phase 4 Batch 1 — §40.3 Outcomes residual Top 3.
 *
 *   40.3.6 矛盾 rubric → 'failed' verdict 触发条件
 *   40.3.7 user.interrupt 中途 → 'interrupted' verdict
 *   40.3.12 并发 outcome → reject(409/400)
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type EventSendParams = Parameters<AnthropicAws["beta"]["sessions"]["events"]["send"]>[1];

describe("§40.3 Outcomes residual Top 3(Phase 4 Batch 1)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.3.6 矛盾 rubric → 'failed' verdict */
  it("40.3.6 contradictory rubric → 'failed' or 'needs_revision'", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // description 要求做 X;rubric 要求 Y(Y 跟 X 矛盾)
    await collector.send({
      events: [{
        type: "user.define_outcome",
        description: "用一句话写'白色'",
        rubric: { type: "text", content: "deliverable 必须是数学证明 — 证明费马大定理。rubric 的判断标准跟 description 的任务无关。" },
        max_iterations: 1,
      }] as EventSendParams["events"],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const endEvts = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "span.outcome_evaluation_end") as Array<{ result?: string; explanation?: string }>;
    endEvts.forEach((e, i) => console.log(`[40.3.6] end[${i}] result:`, e.result, "exp:", (e.explanation ?? "").slice(0, 300)));
    console.log("[40.3.6] final verdict:", endEvts[endEvts.length - 1]?.result);
  }, 180_000);

  /** 40.3.7 user.interrupt 中途 → 'interrupted' verdict */
  it("40.3.7 user.interrupt during outcome → 'interrupted' verdict", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // 启动一个 max=3 的 outcome,让 agent 写较长 deliverable
    await collector.send({
      events: [{
        type: "user.define_outcome",
        description: "写一篇 2000 字以上的论文 — 题目是关于全球气候变化对北极生态系统的影响,要详细。",
        rubric: { type: "text", content: "必须 ≥ 2000 字,含至少 8 个具体科学事实 + 3 个独立来源引用。" },
        max_iterations: 3,
      }] as EventSendParams["events"],
    });

    // 等待 agent 开始工作(看到第一个 model_request_start)
    await collector.consume({ stopTypes: ["span.model_request_start"], maxWaitMs: 30_000 });
    console.log("[40.3.7] saw model_request_start, sending interrupt in 3s");
    await new Promise((r) => setTimeout(r, 3000));

    // Send interrupt
    try {
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.interrupt" }] as EventSendParams["events"],
      });
      console.log("[40.3.7] interrupt sent");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.3.7] interrupt send error:", e.status, e.message?.slice(0, 200));
    }

    // 等 session idle
    await collector.consume();
    const snap = await collector.finalize();
    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const types = stream.map((e) => e.type as string).filter((t): t is string => typeof t === "string");
    const uniq = [...new Set(types)];
    console.log("[40.3.7] unique event types:", uniq);

    const endEvts = stream.filter((e) => (e.type as string) === "span.outcome_evaluation_end") as Array<{ result?: string; explanation?: string; iteration?: number }>;
    endEvts.forEach((e, i) => console.log(`[40.3.7] end[${i}] iter:`, e.iteration, "result:", e.result, "exp:", (e.explanation ?? "").slice(0, 250)));

    const interruptEcho = stream.filter((e) => (e.type as string) === "user.interrupt");
    console.log("[40.3.7] user.interrupt echo in stream:", interruptEcho.length);
  }, 240_000);

  /** 40.3.12 并发 outcome → reject */
  it("40.3.12 concurrent define_outcome before first completes → reject", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // First outcome
    await collector.send({
      events: [{
        type: "user.define_outcome",
        description: "写 10 行散文",
        rubric: { type: "text", content: "10 行散文,语言流畅。" },
        max_iterations: 3,
      }] as EventSendParams["events"],
    });
    console.log("[40.3.12] first outcome sent");

    // 等 1s 让 first outcome 真启动
    await new Promise((r) => setTimeout(r, 1500));

    // Send second outcome immediately (while first 还 evaluating)
    try {
      const r = await client.beta.sessions.events.send(session.id, {
        events: [{
          type: "user.define_outcome",
          description: "写诗",
          rubric: { type: "text", content: "5 行诗。" },
          max_iterations: 1,
        }] as EventSendParams["events"],
      });
      console.log("[40.3.12] second outcome UNEXPECTED accepted:", JSON.stringify(r).slice(0, 300));
    } catch (err) {
      const e = err as { status?: number; message?: string; error?: { error?: { type?: string } } };
      console.log("[40.3.12] second outcome reject status:", e.status, "type:", e.error?.error?.type, "msg:", e.message?.slice(0, 300));
    }

    // Let first outcome finish for cleanup
    await collector.consume();
    await collector.finalize();
  }, 240_000);
});
