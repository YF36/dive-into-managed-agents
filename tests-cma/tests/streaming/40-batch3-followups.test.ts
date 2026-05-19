/**
 * Phase 4 Batch 3 follow-ups — 5 focused case 处理 Batch 2 close-out 留的 follow-up:
 *
 *   B3.1 Files API list scope query schema(F-0036 follow-up — SDK 类型 scope_id
 *        被 server reject;探正确 wire 形态)
 *   B3.2 40.3.2 rubric=file 完整流程(file upload + reference)
 *   B3.3 session.update allow-list probe(F-0035 §40.2.13 follow-up:除了
 *        resources,还有哪些字段被 reject;metadata / title 是否允许)
 *   B3.4 40.1.9 thread tool isolation — agent with explicit tools[] 在
 *        multi-agent context 是否被 shadowed(F-0034 extension)
 *   B3.5 coord runtime create_agent → lifecycle(F-0034 follow-up:dynamic
 *        agent session 结束后状态)
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getProbeAgentId, getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { writeFile, mkdtemp } from "node:fs/promises";
import { File as NodeFile } from "node:buffer";
// Node 18 polyfill for SDK file uploads
if (typeof (globalThis as { File?: unknown }).File === "undefined") {
  (globalThis as { File?: unknown }).File = NodeFile;
}
import { tmpdir } from "node:os";
import { join } from "node:path";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];
type EventSendParams = Parameters<AnthropicAws["beta"]["sessions"]["events"]["send"]>[1];

describe("Phase 4 Batch 3 follow-ups", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** B3.1 Files API list scope query schema */
  it("B3.1 Files API list scope query schema probe", async () => {
    const client = getClient();
    await client.ready;

    // Variant A: no params
    try {
      const files: Array<{ id: string; scope?: { id?: string; type?: string }; filename?: string }> = [];
      for await (const f of client.beta.files.list()) {
        files.push(f as typeof files[0]);
        if (files.length >= 5) break;
      }
      console.log("[B3.1] no params: workspace-wide files count(cap 5):", files.length);
      files.forEach((f) => console.log("  ", f.id, "filename:", f.filename, "scope:", JSON.stringify(f.scope)));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[B3.1] no params error:", e.status, e.message?.slice(0, 250));
    }

    // Variant B: SDK type scope_id(已知 reject — 复现 F-0036)
    try {
      const files: Array<unknown> = [];
      for await (const f of client.beta.files.list({ scope_id: "sesn_dummy" } as Parameters<typeof client.beta.files.list>[0])) {
        files.push(f);
        break;
      }
      console.log("[B3.1] scope_id variant UNEXPECTED accepted, count:", files.length);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string; message?: string } } };
      console.log("[B3.1] scope_id variant reject:", e.status, "msg:", e.error?.error?.message?.slice(0, 200));
    }
  }, 60_000);

  /** B3.2 rubric=file 完整流程 */
  it("B3.2 outcome with rubric=file (upload + reference)", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    // 1) Upload a rubric file
    const tmpDir = await mkdtemp(join(tmpdir(), "p4b3-rubric-"));
    const rubricPath = join(tmpDir, "rubric.txt");
    const RUBRIC_TEXT = "deliverable 必须在 /mnt/session/outputs/test.txt 文件存在,内容含字符串 'P4B3_RUBRIC_FILE_MARKER_qq8'。";
    await writeFile(rubricPath, RUBRIC_TEXT, "utf8");
    const { createReadStream } = await import("node:fs");
    let rubricFileId = "";
    try {
      const uploadResp = await client.beta.files.upload({ file: createReadStream(rubricPath) } as Parameters<typeof client.beta.files.upload>[0]);
      rubricFileId = uploadResp.id;
      console.log("[B3.2] uploaded rubric file:", rubricFileId, "filename:", uploadResp.filename, "size:", uploadResp.size_bytes, "scope:", JSON.stringify(uploadResp.scope));
      cleanup.push(async () => { await client.beta.files.delete(rubricFileId); });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[B3.2] file upload error:", e.status, e.message?.slice(0, 250));
      throw err;
    }

    // 2) create session + send user.define_outcome with rubric.type='file'
    const session = await client.beta.sessions.create({
      agent: probeAgentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 240_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{
        type: "user.define_outcome",
        description: "按照 rubric 文件里的要求,创建相应的 deliverable file。",
        rubric: { type: "file", file_id: rubricFileId },
        max_iterations: 2,
      }] as EventSendParams["events"],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const endEvts = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "span.outcome_evaluation_end") as Array<{ result?: string; explanation?: string; iteration?: number }>;
    endEvts.forEach((e, i) => console.log(`[B3.2] end[${i}] iter:`, e.iteration, "result:", e.result, "exp:", (e.explanation ?? "").slice(0, 300)));
  }, 360_000);

  /** B3.3 session.update field allow-list probe */
  it("B3.3 session.update allow-list — probe accepted fields", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // Try metadata
    try {
      const r = await client.beta.sessions.update(session.id, { metadata: { ...tagWithRunId(), b3_update: "yes" } } as Parameters<typeof client.beta.sessions.update>[1]);
      console.log("[B3.3] metadata update OK; resp metadata:", JSON.stringify(r.metadata));
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { message?: string } } };
      console.log("[B3.3] metadata reject:", e.status, e.error?.error?.message);
    }

    // Try title
    try {
      const r = await client.beta.sessions.update(session.id, { title: "updated-title-B3" } as unknown as Parameters<typeof client.beta.sessions.update>[1]);
      console.log("[B3.3] title update OK; resp title:", (r as { title?: string }).title);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { message?: string } } };
      console.log("[B3.3] title reject:", e.status, e.error?.error?.message);
    }

    // Try description / system / model 等(全部应当 reject)
    for (const [field, value] of [
      ["description", "new desc"],
      ["agent", "agent_dummy"],
      ["environment_id", "env_dummy"],
    ] as const) {
      try {
        await client.beta.sessions.update(session.id, { [field]: value } as unknown as Parameters<typeof client.beta.sessions.update>[1]);
        console.log(`[B3.3] ${field} UNEXPECTED accepted`);
      } catch (err) {
        const e = err as { status?: number; error?: { error?: { message?: string } } };
        console.log(`[B3.3] ${field} reject:`, e.status, (e.error?.error?.message ?? "").slice(0, 150));
      }
    }
  }, 60_000);

  /** B3.4 thread tool isolation — agent with explicit tools[] 在 multi-agent context */
  it("B3.4 multi-agent shadowing — worker with explicit tools 是否生效", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();

    const PROBE_TOOLSET = { type: "agent_toolset_20260401" } as unknown as NonNullable<AgentCreateParams["tools"]>[number];
    // Worker with explicit agent_toolset_20260401(probe agent fixture 的同款)
    const worker = await client.beta.agents.create({
      model: "claude-haiku-4-5",
      name: `p4b3-toolworker-${Date.now()}`,
      description: "worker with explicit toolset(bash/file/...)",
      system: "你是一个有工具的 worker。被询问可用工具时,**列出**你实际能用的所有工具名。",
      tools: [PROBE_TOOLSET],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(worker.id); });

    // Coordinator with worker as child
    const coord = await client.beta.agents.create({
      model: "claude-haiku-4-5",
      name: `p4b3-coord-${Date.now()}`,
      description: "coord",
      system: "你是 coordinator。让 worker 报告它实际有的工具(让 worker 在 message 里列出所有可用工具名)。然后转给我。",
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
        content: [{ type: "text", text: "让 worker 详细列出它能调用的所有工具名(包括 bash / file ops / send_to_parent 等任何工具),然后转给我完整列表。" }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();

    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const recvMsgs = stream.filter((e) => (e.type as string) === "agent.thread_message_received");
    recvMsgs.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[B3.4] worker reply[${i}]:`, text.slice(0, 600));
    });
    const coordMsgs = stream.filter((e) => (e.type as string) === "agent.message" && !((e as { session_thread_id?: string }).session_thread_id));
    coordMsgs.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[B3.4] coord msg[${i}]:`, text.slice(0, 600));
    });

    // Tool name observation
    const allText = [...recvMsgs, ...coordMsgs].map((e) => ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "").join("\n");
    const hasBash = /\b(bash|shell|exec_shell)\b/i.test(allText);
    const hasFileTools = /\b(read_file|write_file|edit_file|create_file|file_ops)\b/i.test(allText);
    const hasSendToParent = /\bsend_to_parent\b/i.test(allText);
    console.log("[B3.4] worker has bash tool name:", hasBash, "has file tool names:", hasFileTools, "has send_to_parent:", hasSendToParent);
  }, 240_000);

  /** B3.5 coord runtime create_agent → lifecycle */
  it("B3.5 coord runtime create_agent — dynamic agent lifecycle", async () => {
    const client = getClient();
    await client.ready;
    const envId = await getSharedEnvironmentId();

    // Spec 1 dummy child (min count required); then test runtime spawn IN ADDITION
    const dummyChild = await client.beta.agents.create({
      model: "claude-haiku-4-5",
      name: `p4b3-dummy-${Date.now()}`,
      description: "dummy spec'd child",
      system: "placeholder worker",
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(dummyChild.id); });

    const coord = await client.beta.agents.create({
      model: "claude-haiku-4-5",
      name: `p4b3-coord-dyn-${Date.now()}`,
      description: "coord, spawns dynamic agents",
      system: "你是 coordinator。**不**用已 spec 的 dummy child。用 create_agent 工具 runtime 创建一个**新** worker(自定义 name),问它一个简单问题(eg '你今天好吗?'),把它的回复转给我。完成后告诉我创建的 worker name + 它的回复。",
      multiagent: { type: "coordinator", agents: [dummyChild.id] } as unknown as AgentCreateParams["multiagent"],
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
        content: [{ type: "text", text: "按 system prompt 指令 spawn 一个 worker + 转回它的回复。" }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();

    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const threadCreated = stream.filter((e) => (e.type as string) === "session.thread_created");
    console.log("[B3.5] threads_created count:", threadCreated.length);
    threadCreated.forEach((e, i) => {
      console.log(`[B3.5] thread_created[${i}]:`, JSON.stringify(e).slice(0, 400));
    });

    // 等 5s 让 dynamic agent 在 backend 可能 archived(若它 ephemeral)
    await new Promise((r) => setTimeout(r, 3000));

    // List agents 看 dynamic 创建的 agent 是否 archived / persist
    const agents: Array<{ id: string; name?: string; archived?: boolean; created_at?: string }> = [];
    try {
      for await (const a of client.beta.agents.list({ limit: 50 } as Parameters<typeof client.beta.agents.list>[0])) {
        const ag = a as typeof agents[0];
        if (ag.name?.startsWith("p4b3-") || ag.created_at && ag.created_at > new Date(Date.now() - 600_000).toISOString()) {
          agents.push(ag);
        }
        if (agents.length >= 20) break;
      }
      console.log("[B3.5] recent p4b3-* agents:", agents.length);
      agents.forEach((a) => console.log("  ", a.id, a.name, "archived:", a.archived, "created:", a.created_at?.slice(0, 19)));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[B3.5] agents.list error:", e.status, e.message?.slice(0, 200));
    }
  }, 240_000);
});
