/**
 * Phase 4 Batch 2 — §40.3 Outcomes residual cluster(3 case).
 *
 *   40.3.14 rubric.content 262144 chars 上限
 *   40.3.10 outcome → Files API deliverable download
 *   40.3.11 同 session 串行跑两个 outcome(outcome_id 不同 + state cross-pollution?)
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getProbeAgentId, getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type EventSendParams = Parameters<AnthropicAws["beta"]["sessions"]["events"]["send"]>[1];

describe("§40.3 Outcomes Batch 2 residual(Phase 4 Batch 2)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.3.14 rubric.content 262144 chars boundary */
  it("40.3.14 rubric.content 262144 chars boundary", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // 262145 chars(over 1)
    const overContent = "a".repeat(262145);
    try {
      await client.beta.sessions.events.send(session.id, {
        events: [{
          type: "user.define_outcome",
          description: "trivial",
          rubric: { type: "text", content: overContent },
          max_iterations: 1,
        }] as EventSendParams["events"],
      });
      console.log("[40.3.14] 262145 UNEXPECTED accepted");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string; message?: string } } };
      console.log("[40.3.14] 262145 reject status:", e.status, "type:", e.error?.error?.type, "msg:", e.error?.error?.message?.slice(0, 250));
    }

    // 262143 (at limit minus 1)
    const okContent = "a".repeat(262143);
    try {
      const r = await client.beta.sessions.events.send(session.id, {
        events: [{
          type: "user.define_outcome",
          description: "trivial",
          rubric: { type: "text", content: okContent },
          max_iterations: 1,
        }] as EventSendParams["events"],
      });
      console.log("[40.3.14] 262143 accepted, response events count:", (r as { events?: unknown[] }).events?.length ?? 0);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { message?: string } } };
      console.log("[40.3.14] 262143 UNEXPECTED reject:", e.status, e.error?.error?.message?.slice(0, 200));
    }
  }, 60_000);

  /** 40.3.10 outcome → Files API deliverable download */
  it("40.3.10 outcome deliverable via Files API", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: probeAgentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 180_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    const UNIQUE_MARK = "DELIVERABLE_MARK_yT9_phase4";
    await collector.send({
      events: [{
        type: "user.define_outcome",
        description: `在 /mnt/session/outputs/answer.txt 写入精确字符串 '${UNIQUE_MARK}' (不加换行不加引号),用 file write tool。完成后简短报告 done。`,
        rubric: { type: "text", content: `必须在 /mnt/session/outputs/answer.txt 文件存在 + 含字符串 '${UNIQUE_MARK}'。` },
        max_iterations: 2,
      }] as EventSendParams["events"],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const endEvts = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "span.outcome_evaluation_end") as Array<{ result?: string; explanation?: string; iteration?: number }>;
    endEvts.forEach((e, i) => console.log(`[40.3.10] end[${i}] iter:`, e.iteration, "result:", e.result, "exp:", (e.explanation ?? "").slice(0, 250)));

    // 列 session-scoped files
    const files: Array<{ id: string; filename?: string; size_bytes?: number; created_at?: string }> = [];
    try {
      for await (const f of client.beta.files.list({ scope_id: session.id, scope_type: "session" } as Parameters<typeof client.beta.files.list>[0])) {
        files.push(f as typeof files[0]);
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.3.10] files.list error:", e.status, e.message?.slice(0, 250));
    }
    console.log("[40.3.10] session-scoped files count:", files.length);
    files.forEach((f) => console.log("  ", f.id, f.filename, "size:", f.size_bytes, "created:", f.created_at));

    if (files.length > 0) {
      try {
        const downloadResp = await client.beta.files.download(files[0]!.id);
        const blob = await downloadResp.blob();
        const text = await blob.text();
        console.log("[40.3.10] downloaded content length:", text.length, "contains marker:", text.includes(UNIQUE_MARK));
        console.log("[40.3.10] content head:", text.slice(0, 200));
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.log("[40.3.10] download error:", e.status, e.message?.slice(0, 200));
      }
    }
  }, 300_000);

  /** 40.3.11 串行 2 个 outcome — outcome_id 不同 + cross-pollution? */
  it("40.3.11 sequential 2 outcomes — distinct outcome_id + no cross-pollution", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // Outcome 1
    const collector1 = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector1.openStream();
    await new Promise((r) => setTimeout(r, 200));
    await collector1.send({
      events: [{
        type: "user.define_outcome",
        description: "回答:1+1",
        rubric: { type: "text", content: "答案含 '2'。" },
        max_iterations: 1,
      }] as EventSendParams["events"],
    });
    await collector1.consume();
    const snap1 = await collector1.finalize();
    const o1Events = snap1.L0.stream.filter((e) => typeof e.type === "string" && ((e.type as string) === "user.define_outcome" || (e.type as string).startsWith("span.outcome_evaluation")));
    const o1Ids = new Set<string>();
    o1Events.forEach((e) => {
      const oid = (e as { outcome_id?: string }).outcome_id;
      if (typeof oid === "string") o1Ids.add(oid);
    });
    console.log("[40.3.11] outcome 1 outcome_ids:", [...o1Ids], "events:", o1Events.length);

    // Outcome 2 (after o1 idle)
    const collector2 = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 120_000,
    });
    await collector2.openStream();
    await new Promise((r) => setTimeout(r, 200));
    await collector2.send({
      events: [{
        type: "user.define_outcome",
        description: "回答:2+2",
        rubric: { type: "text", content: "答案含 '4'。" },
        max_iterations: 1,
      }] as EventSendParams["events"],
    });
    await collector2.consume();
    const snap2 = await collector2.finalize();
    const o2Events = snap2.L0.stream.filter((e) => typeof e.type === "string" && ((e.type as string) === "user.define_outcome" || (e.type as string).startsWith("span.outcome_evaluation")));
    const o2Ids = new Set<string>();
    o2Events.forEach((e) => {
      const oid = (e as { outcome_id?: string }).outcome_id;
      if (typeof oid === "string") o2Ids.add(oid);
    });
    console.log("[40.3.11] outcome 2 outcome_ids:", [...o2Ids], "events:", o2Events.length);

    // 验证 outcome_id 不同
    const intersection = [...o1Ids].filter((id) => o2Ids.has(id));
    console.log("[40.3.11] outcome_id overlap:", intersection);
    expect(intersection.length).toBe(0);

    // session.retrieve 看 outcome_evaluations[]
    const final = await client.beta.sessions.retrieve(session.id) as unknown as { outcome_evaluations?: Array<{ outcome_id?: string; result?: string }> };
    console.log("[40.3.11] retrieve.outcome_evaluations count:", final.outcome_evaluations?.length);
    final.outcome_evaluations?.forEach((oe, i) => console.log(`  [${i}] outc_id:`, oe.outcome_id, "result:", oe.result));
  }, 360_000);
});
