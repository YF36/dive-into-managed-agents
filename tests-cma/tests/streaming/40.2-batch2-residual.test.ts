/**
 * Phase 4 Batch 2 — §40.2 Memory residual cluster(5 case).
 *
 *   40.2.13 running session attach 新 memstore → 行为?
 *   40.2.10 list_versions cursor stability(quiescent 字节级)
 *   40.2.16 memory_path_conflict 触发(同 path duplicate create)
 *   40.2.18 view=basic vs full;view=full + limit > 20 行为
 *   40.2.15 description 是否注入 agent system prompt
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getProbeAgentId, getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type MemoryStoreCreateParams = Parameters<AnthropicAws["beta"]["memoryStores"]["create"]>[0];
type SessionCreateParams = Parameters<AnthropicAws["beta"]["sessions"]["create"]>[0];

describe("§40.2 Memory Batch 2 residual(Phase 4 Batch 2)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.2.13 running session 不能 attach 新 memstore */
  it("40.2.13 cannot attach memstore to existing session", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const store = await client.beta.memoryStores.create({
      name: `mem-attach-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    // Create session WITHOUT memstore first
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });
    console.log("[40.2.13] session created without memstore:", session.id, "resources:", (session.resources ?? []).length);

    // Try update / attach via session.update
    try {
      const updated = await client.beta.sessions.update(session.id, {
        resources: [{ type: "memory_store", memory_store_id: store.id, access: "read_write" }] as SessionCreateParams["resources"],
      } as Parameters<typeof client.beta.sessions.update>[1]);
      console.log("[40.2.13] session.update with resources UNEXPECTED accepted; resources after:", updated.resources?.length);
    } catch (err) {
      const e = err as { status?: number; message?: string; error?: { error?: { type?: string; message?: string } } };
      console.log("[40.2.13] session.update reject status:", e.status, "type:", e.error?.error?.type, "msg:", (e.error?.error?.message ?? e.message)?.slice(0, 300));
    }

    // After update, retrieve session 再看 resources
    const after = await client.beta.sessions.retrieve(session.id);
    console.log("[40.2.13] session.resources after attempted update:", JSON.stringify(after.resources));
  }, 60_000);

  /** 40.2.10 list_versions cursor stability — quiescent 字节级稳定 */
  it("40.2.10 list_versions cursor stability", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-vercursor-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const m = await client.beta.memoryStores.memories.create(store.id, { content: "v1", path: "/note.md" });
    let cur = m;
    for (let i = 2; i <= 5; i++) {
      cur = await client.beta.memoryStores.memories.update(cur.id, { memory_store_id: store.id, content: `v${i}` });
    }

    // First list
    const list1: string[] = [];
    for await (const v of client.beta.memoryStores.memoryVersions.list(store.id, { memory_id: m.id } as Parameters<typeof client.beta.memoryStores.memoryVersions.list>[1])) {
      list1.push((v as { id: string }).id);
    }
    // Second list (immediate)
    const list2: string[] = [];
    for await (const v of client.beta.memoryStores.memoryVersions.list(store.id, { memory_id: m.id } as Parameters<typeof client.beta.memoryStores.memoryVersions.list>[1])) {
      list2.push((v as { id: string }).id);
    }
    console.log("[40.2.10] list1:", list1);
    console.log("[40.2.10] list2:", list2);
    expect(list2).toEqual(list1);
    console.log("[40.2.10] cursor stable across 2 quiescent list calls");
  }, 60_000);

  /** 40.2.16 memory_path_conflict — duplicate path create */
  it("40.2.16 duplicate path create → memory_path_conflict_error", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-conflict-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const m1 = await client.beta.memoryStores.memories.create(store.id, { content: "first", path: "/duplicate.txt" });
    console.log("[40.2.16] m1 created:", m1.id);

    try {
      const m2 = await client.beta.memoryStores.memories.create(store.id, { content: "second", path: "/duplicate.txt" });
      console.log("[40.2.16] m2 UNEXPECTED success — id:", m2.id, "(同 path 居然能创建?)");
    } catch (err) {
      const e = err as { status?: number; message?: string; error?: { error?: { type?: string; message?: string; conflicting_memory_id?: string; conflicting_path?: string } } };
      console.log("[40.2.16] duplicate path reject status:", e.status);
      console.log("[40.2.16] error.type:", e.error?.error?.type);
      console.log("[40.2.16] error.message:", e.error?.error?.message);
      console.log("[40.2.16] conflicting_memory_id:", e.error?.error?.conflicting_memory_id);
      console.log("[40.2.16] conflicting_path:", e.error?.error?.conflicting_path);
    }
  }, 60_000);

  /** 40.2.18 view=basic vs full + limit cap @ view=full */
  it("40.2.18 view basic vs full + limit cap behavior", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-view-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    // create 22 memories(超过 view=full 上限 20)
    for (let i = 0; i < 22; i++) {
      await client.beta.memoryStores.memories.create(store.id, { content: `v${i}`, path: `/m${i.toString().padStart(2, "0")}.txt` });
    }
    console.log("[40.2.18] created 22 memories");

    // basic view
    const basicSample: Array<{ content?: string | null; content_size_bytes?: number }> = [];
    for await (const m of client.beta.memoryStores.memories.list(store.id, { view: "basic", limit: 50 } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
      basicSample.push(m as typeof basicSample[0]);
      if (basicSample.length >= 5) break;
    }
    basicSample.forEach((m, i) => console.log(`[40.2.18] basic[${i}] content:`, m.content, "size:", m.content_size_bytes));

    // full view + limit=25(over cap 20)
    try {
      const fullSample: Array<{ content?: string | null }> = [];
      for await (const m of client.beta.memoryStores.memories.list(store.id, { view: "full", limit: 25 } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
        fullSample.push(m as typeof fullSample[0]);
        if (fullSample.length >= 30) break;
      }
      console.log("[40.2.18] view=full limit=25 fetched count:", fullSample.length);
      fullSample.slice(0, 3).forEach((m, i) => console.log(`[40.2.18] full[${i}] content:`, m.content?.slice(0, 30)));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.18] view=full limit=25 error:", e.status, e.message?.slice(0, 250));
    }

    // full view + limit=20(at cap)
    try {
      const fullCap: Array<{ content?: string | null }> = [];
      for await (const m of client.beta.memoryStores.memories.list(store.id, { view: "full", limit: 20 } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
        fullCap.push(m as typeof fullCap[0]);
        if (fullCap.length >= 25) break;
      }
      console.log("[40.2.18] view=full limit=20 fetched count:", fullCap.length);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.18] view=full limit=20 error:", e.status, e.message?.slice(0, 250));
    }
  }, 120_000);

  /** 40.2.15 description 字段是否注入 agent system prompt */
  it("40.2.15 memstore description injected in agent system prompt?", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    const UNIQUE_DESC = "UNIQUE_DESC_MARKER_Zk9xQ7_this_is_a_long_distinctive_description_about_purple_unicorns";
    const store = await client.beta.memoryStores.create({
      name: `mem-desc-${Date.now()}`,
      description: UNIQUE_DESC,
      metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });
    console.log("[40.2.15] memstore with description created:", store.id);

    const session = await client.beta.sessions.create({
      agent: probeAgentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: store.id, access: "read_write" }] as SessionCreateParams["resources"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // 问 agent 它的 system prompt 是否含描述
    await collector.send({
      events: [{
        type: "user.message",
        content: [{ type: "text", text: "我想测试一下你的 system prompt / 上下文。请精确回答:你的 system prompt 或 instructions 里有提到 'UNIQUE_DESC_MARKER_Zk9xQ7' 这个字符串或 'purple unicorns' 吗?如果有,把含这些字符串的完整段落原样复述给我。如果没有,直接说'no marker present'。" }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const agentMessages = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "agent.message");
    agentMessages.forEach((e, i) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      console.log(`[40.2.15] agent.message[${i}]:`, text.slice(0, 800));
    });
    const sawMarker = agentMessages.some((e) => {
      const text = ((e as { content?: Array<{ text?: string }> }).content ?? [{}])[0]?.text ?? "";
      return text.includes("UNIQUE_DESC_MARKER_Zk9xQ7") || text.toLowerCase().includes("purple unicorn");
    });
    console.log("[40.2.15] description marker visible to agent:", sawMarker);
  }, 120_000);
});
