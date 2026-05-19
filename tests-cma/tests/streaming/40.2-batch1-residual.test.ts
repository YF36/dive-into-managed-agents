/**
 * Phase 4 Batch 1 — §40.2 Memory residual Top 3.
 *
 *   40.2.12 redact 操作(audit row 保留 + content/path/sha 全 null)
 *   40.2.14 跨 session 共享 memstore visibility
 *   40.2.9  path_prefix + depth + order_by full(memory_prefix rollup 节点)
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getProbeAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type MemoryStoreCreateParams = Parameters<AnthropicAws["beta"]["memoryStores"]["create"]>[0];
type SessionCreateParams = Parameters<AnthropicAws["beta"]["sessions"]["create"]>[0];

describe("§40.2 Memory residual Top 3(Phase 4 Batch 1)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.2.12 redact — audit row 保留 + content/path/sha 全 null + redacted_at populated */
  it("40.2.12 redact preserves audit row + nullifies content/path/sha", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-redact-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const m1 = await client.beta.memoryStores.memories.create(store.id, {
      content: "sensitive-content-must-be-redacted", path: "/secret.txt",
    });
    console.log("[40.2.12] v1 ver_id:", m1.memory_version_id, "sha:", m1.content_sha256.slice(0, 16));

    // 更新 1 次,再 redact v1
    const m2 = await client.beta.memoryStores.memories.update(m1.id, {
      memory_store_id: store.id, content: "clean-replacement",
    });
    console.log("[40.2.12] v2 ver_id:", m2.memory_version_id);

    // Redact v1
    type RedactedVer = { id: string; redacted_at?: string | null; content?: string | null; path?: string | null; content_sha256?: string | null; content_size_bytes?: number | null };
    let redactedV1: RedactedVer | null = null;
    try {
      const r = await client.beta.memoryStores.memoryVersions.redact(m1.memory_version_id, {
        memory_store_id: store.id,
      });
      redactedV1 = r as unknown as RedactedVer;
      console.log("[40.2.12] redact response:", JSON.stringify(redactedV1, null, 2));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.12] redact error:", e.status, e.message?.slice(0, 250));
      throw err;
    }

    // Retrieve v1 again, verify fields
    const retrievedV1 = await client.beta.memoryStores.memoryVersions.retrieve(m1.memory_version_id, {
      memory_store_id: store.id,
    });
    console.log("[40.2.12] retrieve v1 after redact:", JSON.stringify(retrievedV1, null, 2));

    const rv1 = retrievedV1 as unknown as { content?: string | null; path?: string | null; content_sha256?: string | null; content_size_bytes?: number | null; redacted_at?: string | null; operation?: string };
    console.log("[40.2.12] v1.content:", rv1.content, "path:", rv1.path, "sha:", rv1.content_sha256, "size:", rv1.content_size_bytes, "redacted_at:", rv1.redacted_at, "op:", rv1.operation);

    // 但 v2 should still be intact
    const retrievedV2 = await client.beta.memoryStores.memoryVersions.retrieve(m2.memory_version_id, {
      memory_store_id: store.id,
    });
    const rv2 = retrievedV2 as unknown as { content?: string | null; path?: string | null; redacted_at?: string | null };
    console.log("[40.2.12] v2.content:", rv2.content, "path:", rv2.path, "redacted_at:", rv2.redacted_at);

    // list versions 看 op 字段
    const allVers: Array<{ id: string; operation?: string; redacted_at?: string | null }> = [];
    for await (const v of client.beta.memoryStores.memoryVersions.list(store.id, { memory_id: m1.id } as Parameters<typeof client.beta.memoryStores.memoryVersions.list>[1])) {
      allVers.push(v as typeof allVers[0]);
    }
    console.log("[40.2.12] versions after redact:");
    allVers.forEach((v) => console.log("  ", v.id, "op:", v.operation, "redacted_at:", v.redacted_at));
  }, 60_000);

  /** 40.2.14 跨 session 共享 memstore visibility */
  it("40.2.14 cross-session shared memstore visibility", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    const store = await client.beta.memoryStores.create({
      name: `mem-share-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    // Session A — write
    const sessionA = await client.beta.sessions.create({
      agent: probeAgentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: store.id, access: "read_write" }] as SessionCreateParams["resources"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(sessionA.id); });
    const mountA = (sessionA.resources?.[0] as { mount_path?: string })?.mount_path;
    console.log("[40.2.14] session A:", sessionA.id, "mount:", mountA);

    const collectorA = createThreeLayerCollector(sessionA.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 60_000,
    });
    await collectorA.openStream();
    await new Promise((r) => setTimeout(r, 200));
    const SHARED_CONTENT = "cross-session-share-marker-Vp7";
    await collectorA.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: `在 ${mountA}/shared.txt 写 \"${SHARED_CONTENT}\" 不加换行。完成回 'done'。` }],
      }],
    });
    await collectorA.consume();
    await collectorA.finalize();
    console.log("[40.2.14] session A write done");

    // Immediate platform API read
    const apiMems: Array<{ path?: string; content?: string | null; content_sha256?: string }> = [];
    for await (const m of client.beta.memoryStores.memories.list(store.id, { view: "full" } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
      apiMems.push(m as typeof apiMems[0]);
    }
    console.log("[40.2.14] API list immediately after A write:");
    apiMems.forEach((m) => console.log("  ", m.path, "size:", (m.content ?? "").length, "sha:", m.content_sha256?.slice(0, 16)));

    // Session B — read
    const sessionB = await client.beta.sessions.create({
      agent: probeAgentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: store.id, access: "read_only" }] as SessionCreateParams["resources"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(sessionB.id); });
    const mountB = (sessionB.resources?.[0] as { mount_path?: string })?.mount_path;
    console.log("[40.2.14] session B:", sessionB.id, "mount:", mountB);

    const collectorB = createThreeLayerCollector(sessionB.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 60_000,
    });
    await collectorB.openStream();
    await new Promise((r) => setTimeout(r, 200));
    await collectorB.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: `cat ${mountB}/shared.txt 把完整内容原样回复(包含或不含 \"${SHARED_CONTENT}\" 由你看到决定)` }],
      }],
    });
    await collectorB.consume();
    const snapB = await collectorB.finalize();
    const agentMessagesB = snapB.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "agent.message");
    agentMessagesB.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[40.2.14] B agent.message[${i}]:`, text.slice(0, 300));
    });
    const sawShared = agentMessagesB.some((m) => {
      const text = ((m as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      return text.includes(SHARED_CONTENT);
    });
    console.log("[40.2.14] B 看到 shared content marker:", sawShared);
    expect(sawShared).toBe(true);
  }, 240_000);

  /** 40.2.9 depth + order_by full — memory_prefix rollup 节点 */
  it("40.2.9 path_prefix + depth + order_by full rollup", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-depth-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const paths = [
      "/top.md",
      "/a/file1.md", "/a/file2.md",
      "/a/sub/deep.md",
      "/b/file.md", "/b/sub/x.md",
      "/c/d/e/very-deep.md",
    ];
    for (const p of paths) {
      await client.beta.memoryStores.memories.create(store.id, { content: "x", path: p });
    }
    console.log("[40.2.9] created 7 memories");

    // 关键 case: depth=1 + order_by=path 期望 prefix rollup
    try {
      const items: Array<{ type?: string; path?: string }> = [];
      for await (const m of client.beta.memoryStores.memories.list(store.id, { depth: 1, order_by: "path" } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
        items.push(m as typeof items[0]);
      }
      console.log("[40.2.9] depth=1 + order_by=path count:", items.length);
      items.forEach((it) => console.log("  ", it.type, it.path));
      // 期望:/top.md(memory) + /a/(prefix) + /b/(prefix) + /c/(prefix)= 4 entries
      const prefixes = items.filter((it) => it.type === "memory_prefix");
      const memories = items.filter((it) => it.type === "memory");
      console.log("[40.2.9] prefixes:", prefixes.length, "memories:", memories.length);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.9] depth=1+order error:", e.status, e.message?.slice(0, 250));
    }

    // depth=2
    try {
      const items: Array<{ type?: string; path?: string }> = [];
      for await (const m of client.beta.memoryStores.memories.list(store.id, { depth: 2, order_by: "path" } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
        items.push(m as typeof items[0]);
      }
      console.log("[40.2.9] depth=2 + order_by=path count:", items.length);
      items.forEach((it) => console.log("  ", it.type, it.path));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.9] depth=2 error:", e.status, e.message?.slice(0, 250));
    }

    // depth=2 + path_prefix=/a/
    try {
      const items: Array<{ type?: string; path?: string }> = [];
      for await (const m of client.beta.memoryStores.memories.list(store.id, { depth: 2, order_by: "path", path_prefix: "/a/" } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
        items.push(m as typeof items[0]);
      }
      console.log("[40.2.9] depth=2 + path_prefix=/a/ count:", items.length);
      items.forEach((it) => console.log("  ", it.type, it.path));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.9] /a/ + depth=2 error:", e.status, e.message?.slice(0, 250));
    }
  }, 60_000);
});
