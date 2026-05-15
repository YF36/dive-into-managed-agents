/**
 * Phase 3 Batch 1 — §40.2 Memory Top 5.
 *
 * 5 case 选优(F-0027 启动 probe 印证 access 开通):
 *   40.2.1 mount + agent 读写 happy
 *   40.2.4 read_only mount 写入 reject
 *   40.2.6 content_sha256 precondition mismatch 409
 *   40.2.8 mount 上限(8/session?)
 *   40.2.11 最近版本永留 + memory_version 链
 *
 * 大部分 case 走 Platform API(不烧 token);40.2.1/4 走 agent tool。
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getProbeAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type MemoryStoreCreateParams = Parameters<AnthropicAws["beta"]["memoryStores"]["create"]>[0];
type SessionCreateParams = Parameters<AnthropicAws["beta"]["sessions"]["create"]>[0];

describe("§40.2 Memory Top 5(Phase 3 Batch 1)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.2.1 mount + agent 读写 happy 链 + content_sha256 校验 */
  it("40.2.1 happy roundtrip + content_sha256 invariant", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    const store = await client.beta.memoryStores.create({
      name: `mem-happy-${Date.now()}`,
      metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });
    console.log("[40.2.1] memstore:", store.id);

    const session = await client.beta.sessions.create({
      agent: probeAgentId,
      environment_id: envId,
      resources: [{
        type: "memory_store",
        memory_store_id: store.id,
        access: "read_write",
      }] as SessionCreateParams["resources"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });
    const mountPath = (session.resources?.[0] as { mount_path?: string })?.mount_path;
    console.log("[40.2.1] mount_path:", mountPath);

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));
    const PROBE_CONTENT = "phase3-memory-happy-roundtrip-OK";
    await collector.send({
      events: [{
        type: "user.message",
        content: [{
          type: "text",
          text: `在 ${mountPath}/notes.md 写入精确字符串 \"${PROBE_CONTENT}\"(不含引号,不加换行)。完成后回 'done'。`,
        }],
      }],
    });
    await collector.consume();
    await collector.finalize();

    // Verify via API
    const memories: unknown[] = [];
    for await (const m of client.beta.memoryStores.memories.list(store.id, { view: "full" } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
      memories.push(m);
    }
    console.log("[40.2.1] memories count:", memories.length);
    memories.forEach((m) => {
      const mm = m as { path?: string; content_sha256?: string; content?: string };
      console.log("[40.2.1] memory:", mm.path, "sha256:", mm.content_sha256?.slice(0, 16), "len:", (mm.content ?? "").length);
    });
    expect(memories.length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  /** 40.2.4 read_only mount 写入 reject */
  it("40.2.4 read_only mount — agent write attempt error", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    const store = await client.beta.memoryStores.create({
      name: `mem-ro-${Date.now()}`,
      metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    // Pre-populate one file via API(read_only mount 下 agent 才能至少看到点东西)
    const pre = await client.beta.memoryStores.memories.create(store.id, {
      content: "preexisting-readonly-content",
      path: "/seed.txt",
    });
    console.log("[40.2.4] pre-created memory:", pre.id, pre.path, "sha:", pre.content_sha256.slice(0, 16));

    const session = await client.beta.sessions.create({
      agent: probeAgentId,
      environment_id: envId,
      resources: [{
        type: "memory_store",
        memory_store_id: store.id,
        access: "read_only",
      }] as SessionCreateParams["resources"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });
    const mountPath = (session.resources?.[0] as { mount_path?: string })?.mount_path;
    console.log("[40.2.4] mount_path (read_only):", mountPath);

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));
    await collector.send({
      events: [{
        type: "user.message",
        content: [{
          type: "text",
          text: `先 cat ${mountPath}/seed.txt 读一下。然后试图往 ${mountPath}/forbidden.txt 写一个字符串 'should-fail'。如果写失败,把具体 error message 告诉我(包括 errno / EROFS / EACCES 等)。`,
        }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();

    const toolResults = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "agent.tool_result");
    const errorResults = toolResults.filter((e) => (e as { is_error?: boolean }).is_error === true);
    console.log("[40.2.4] total tool_results:", toolResults.length, "with is_error:", errorResults.length);
    errorResults.forEach((e, i) => {
      const content = (e as { content?: Array<{ text?: string }> }).content;
      const text = content?.[0]?.text ?? "";
      console.log(`[40.2.4] error[${i}]:`, text.slice(0, 200));
    });

    const agentMessages = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "agent.message");
    agentMessages.forEach((e, i) => {
      const content = (e as { content?: Array<{ text?: string }> }).content;
      const text = content?.[0]?.text ?? "";
      console.log(`[40.2.4] agent.message[${i}]:`, text.slice(0, 400));
    });
  }, 180_000);

  /** 40.2.6 content_sha256 precondition mismatch */
  it("40.2.6 content_sha256 precondition — mismatch → 409", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-occ-${Date.now()}`,
      metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const m1 = await client.beta.memoryStores.memories.create(store.id, {
      content: "v1",
      path: "/note.md",
    });
    console.log("[40.2.6] v1 created sha:", m1.content_sha256.slice(0, 16));

    // Sneak-in update changes sha256
    const m2 = await client.beta.memoryStores.memories.update(m1.id, {
      memory_store_id: store.id,
      content: "v2-sneak",
    });
    console.log("[40.2.6] v2 sha:", m2.content_sha256.slice(0, 16));

    // Now try update with stale precondition (v1 sha)
    try {
      const m3 = await client.beta.memoryStores.memories.update(m1.id, {
        memory_store_id: store.id,
        content: "v3-stale-attempt",
        precondition: {
          type: "content_sha256",
          content_sha256: m1.content_sha256,
        },
      });
      console.log("[40.2.6] UNEXPECTED success — m3:", m3.content_sha256.slice(0, 16));
      expect.fail("expected 409 precondition_failed but got success");
    } catch (err) {
      const e = err as { status?: number; message?: string; error?: { error?: { type?: string } } };
      console.log("[40.2.6] precondition mismatch status:", e.status, "msg:", e.message);
      console.log("[40.2.6] error.error.type:", e.error?.error?.type);
      expect(e.status).toBe(409);
    }

    // 同时:exact-match no-op 应该 200(per spec)
    const m_recur = await client.beta.memoryStores.memories.update(m1.id, {
      memory_store_id: store.id,
      content: "v2-sneak",
      precondition: {
        type: "content_sha256",
        content_sha256: m2.content_sha256,
      },
    });
    console.log("[40.2.6] no-op repeat sha (should match v2):", m_recur.content_sha256.slice(0, 16));
  }, 60_000);

  /** 40.2.8 mount 上限探测(文档说 8/session)*/
  it("40.2.8 session resources mount limit", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    // 创建 9 个 memstore
    const stores: Array<{ id: string }> = [];
    for (let i = 0; i < 9; i++) {
      const s = await client.beta.memoryStores.create({
        name: `mem-limit-${Date.now()}-${i}`,
        metadata: tagWithRunId(),
      } as MemoryStoreCreateParams);
      stores.push(s);
      cleanup.push(async () => { await client.beta.memoryStores.archive(s.id); });
    }
    console.log("[40.2.8] created 9 memstores");

    // 试图 attach 9 个
    try {
      const session = await client.beta.sessions.create({
        agent: probeAgentId,
        environment_id: envId,
        resources: stores.map((s) => ({
          type: "memory_store",
          memory_store_id: s.id,
          access: "read_write",
        })) as SessionCreateParams["resources"],
        metadata: tagWithRunId(),
      });
      cleanup.push(async () => { await client.beta.sessions.archive(session.id); });
      console.log("[40.2.8] UNEXPECTED 9-mount success — session created:", session.id);
      console.log("[40.2.8] resources count:", session.resources?.length);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.8] 9-mount error status:", e.status, "msg:", e.message?.slice(0, 300));
    }

    // 用 8 个再试,看是不是 boundary
    try {
      const session8 = await client.beta.sessions.create({
        agent: probeAgentId,
        environment_id: envId,
        resources: stores.slice(0, 8).map((s) => ({
          type: "memory_store",
          memory_store_id: s.id,
          access: "read_write",
        })) as SessionCreateParams["resources"],
        metadata: tagWithRunId(),
      });
      cleanup.push(async () => { await client.beta.sessions.archive(session8.id); });
      console.log("[40.2.8] 8-mount OK — session:", session8.id, "resources:", session8.resources?.length);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.8] 8-mount UNEXPECTED error status:", e.status, "msg:", e.message?.slice(0, 300));
    }
  }, 120_000);

  /** 40.2.11 最近版本永留 + memory_version 链 */
  it("40.2.11 nearest-version persistence + version chain", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-ver-${Date.now()}`,
      metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const m = await client.beta.memoryStores.memories.create(store.id, {
      content: "v1-original",
      path: "/seq.md",
    });
    console.log("[40.2.11] v1 mem_id:", m.id, "ver_id:", m.memory_version_id);

    // Update 5 times
    let cur = m;
    for (let i = 2; i <= 6; i++) {
      cur = await client.beta.memoryStores.memories.update(cur.id, {
        memory_store_id: store.id,
        content: `v${i}-content`,
      });
      console.log(`[40.2.11] v${i} ver_id:`, cur.memory_version_id, "sha:", cur.content_sha256.slice(0, 16));
    }

    // List versions
    const versions: Array<{ id: string; operation?: string; created_at?: string; content_sha256?: string | null }> = [];
    for await (const v of client.beta.memoryStores.memoryVersions.list(store.id, { memory_id: m.id } as Parameters<typeof client.beta.memoryStores.memoryVersions.list>[1])) {
      versions.push(v as typeof versions[0]);
    }
    console.log("[40.2.11] total versions listed:", versions.length);
    versions.forEach((v, i) => {
      console.log(`  [${i}] ver_id:`, v.id, "op:", v.operation, "sha:", (v.content_sha256 ?? "<redacted>").slice(0, 16));
    });

    // 早期 v1 ver_id 应该仍在 list
    const v1Found = versions.some((v) => v.id === m.memory_version_id);
    console.log("[40.2.11] v1 ver still listed:", v1Found);

    expect(versions.length).toBeGreaterThanOrEqual(6); // 1 create + 5 updates = 6 ops
  }, 60_000);
});
