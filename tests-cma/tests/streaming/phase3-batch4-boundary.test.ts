/**
 * Phase 3 Batch 4 — post-insight boundary case Top 5。
 *
 * Batches 1-3 (F-0028~F-0030) 涌出来的 boundary case 追型:
 *   40.2.7 single memory 100kB content 上限
 *   40.2.2/3 path_prefix list + depth rollup
 *   40.3.5 max_iterations=1 "one final acknowledgment turn" 边界
 *   40.1.2 sub-agent declare callable_agents — depth > 1 行为
 *   40.1.3 coordinator children 数量上限(plan 说 25 thread)
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];
type MemoryStoreCreateParams = Parameters<AnthropicAws["beta"]["memoryStores"]["create"]>[0];
type EventSendParams = Parameters<AnthropicAws["beta"]["sessions"]["events"]["send"]>[1];

const MINIMAL_PARAMS = {
  model: "claude-haiku-4-5" as const,
  description: "Phase 3 Batch 4 boundary probe",
};

describe("Phase 3 Batch 4 post-insight boundary cases", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 40.2.7 — single memory 100kB content 上限 */
  it("40.2.7 memory content 100kB boundary", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-100k-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    // exactly 102_400 bytes
    const content100k = "a".repeat(102400);
    let okMem: { id: string; content_size_bytes?: number } | null = null;
    try {
      okMem = await client.beta.memoryStores.memories.create(store.id, {
        content: content100k, path: "/100k.txt",
      });
      console.log("[40.2.7] 102400 bytes accepted — content_size_bytes:", okMem.content_size_bytes);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.7] 102400 UNEXPECTED reject:", e.status, e.message?.slice(0, 200));
    }

    // 102_401 bytes — 1 byte over
    try {
      await client.beta.memoryStores.memories.create(store.id, {
        content: "a".repeat(102401), path: "/100k-plus-1.txt",
      });
      console.log("[40.2.7] 102401 UNEXPECTED accepted");
    } catch (err) {
      const e = err as { status?: number; message?: string; error?: { error?: { type?: string; message?: string } } };
      console.log("[40.2.7] 102401 reject status:", e.status, "type:", e.error?.error?.type, "msg:", (e.error?.error?.message ?? e.message)?.slice(0, 250));
    }
  }, 60_000);

  /** 40.2.2/3 — path_prefix list + depth rollup */
  it("40.2.2/3 path_prefix + depth rollup", async () => {
    const client = getClient();
    await client.ready;

    const store = await client.beta.memoryStores.create({
      name: `mem-prefix-${Date.now()}`, metadata: tagWithRunId(),
    } as MemoryStoreCreateParams);
    cleanup.push(async () => { await client.beta.memoryStores.archive(store.id); });

    const paths = [
      "/top.md",
      "/a/file1.md", "/a/file2.md",
      "/b/sub/deep1.md", "/b/sub/deep2.md",
      "/c/d/e/very-deep.md",
    ];
    for (const p of paths) {
      await client.beta.memoryStores.memories.create(store.id, {
        content: "x", path: p,
      });
    }
    console.log("[40.2.2/3] created 6 memories at varied depths");

    const allList: Array<{ type?: string; path?: string }> = [];
    for await (const m of client.beta.memoryStores.memories.list(store.id)) {
      allList.push(m as typeof allList[0]);
    }
    console.log("[40.2.2/3] full list count:", allList.length, "types:", allList.map((m) => m.type).join(","));
    allList.forEach((m) => console.log("  ", m.type, m.path));

    // path_prefix /a/
    const aList: Array<{ type?: string; path?: string }> = [];
    for await (const m of client.beta.memoryStores.memories.list(store.id, { path_prefix: "/a/" } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
      aList.push(m as typeof aList[0]);
    }
    console.log("[40.2.2/3] path_prefix=/a/ count:", aList.length);
    aList.forEach((m) => console.log("  ", m.type, m.path));

    // depth=1 from root — expect prefix rollups at top + top.md
    try {
      const dList: Array<{ type?: string; path?: string }> = [];
      for await (const m of client.beta.memoryStores.memories.list(store.id, { depth: 1 } as Parameters<typeof client.beta.memoryStores.memories.list>[1])) {
        dList.push(m as typeof dList[0]);
      }
      console.log("[40.2.2/3] depth=1 count:", dList.length);
      dList.forEach((m) => console.log("  ", m.type, m.path));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.2.2/3] depth=1 reject:", e.status, e.message?.slice(0, 200));
    }
  }, 60_000);

  /** 40.3.5 max_iterations=1 "one final acknowledgment turn" 边界 */
  it("40.3.5 max=1 final acknowledgment turn", async () => {
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
    await collector.send({
      events: [{
        type: "user.define_outcome",
        description: "用一句话回答:1+1 是多少?",
        rubric: { type: "text", content: "答案必须含字符串 'XXXX_UNREACHABLE_RND_8j2k' verbatim。" },
        max_iterations: 1,
      }] as EventSendParams["events"],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const stream = snap.L0.stream as Array<Record<string, unknown>>;
    const timeline = stream.map((e, i) => ({
      i, type: e.type as string, ts: (e.processed_at as string) ?? "",
    }));
    console.log("[40.3.5] event timeline:");
    timeline.forEach((t) => console.log("  [" + String(t.i).padStart(2) + "]", t.type, t.ts.slice(11, 19)));

    // 找 max_iterations_reached 后是否还有 agent.message / span.model_request_* events
    const evalEndIdx = stream.findIndex((e) => e.type === "span.outcome_evaluation_end" && (e as { result?: string }).result === "max_iterations_reached");
    if (evalEndIdx >= 0) {
      const after = stream.slice(evalEndIdx + 1);
      const afterTypes = after.map((e) => e.type).filter((t): t is string => typeof t === "string");
      console.log("[40.3.5] events AFTER max_iterations_reached:", afterTypes);
      const hasAgentTurn = after.some((e) => (e.type as string).startsWith("agent.") || (e.type as string).startsWith("span.model_request_"));
      console.log("[40.3.5] has agent acknowledgment turn after max_reached:", hasAgentTurn);
    } else {
      console.log("[40.3.5] no max_iterations_reached observed — verdict was:", stream.filter((e) => e.type === "span.outcome_evaluation_end").map((e) => (e as { result?: string }).result));
    }
  }, 180_000);

  /** 40.1.2 sub-agent declaring callable_agents — depth > 1 行为 */
  it("40.1.2 sub-agent declare callable_agents (nested coordinator)", async () => {
    const client = getClient();
    await client.ready;

    // Create grandchild
    const grandchild = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: `p3-grandchild-${Date.now()}`,
      system: "我是 grandchild,只回 'gc-ok'。",
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(grandchild.id); });

    // Try create child that itself declares callable_agents = [grandchild]
    try {
      const subCoord = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: `p3-subcoord-${Date.now()}`,
        system: "我是 sub-coordinator(本应不允许嵌套)。",
        multiagent: {
          type: "coordinator",
          agents: [grandchild.id],
        } as unknown as AgentCreateParams["multiagent"],
        metadata: tagWithRunId(),
      });
      cleanup.push(async () => { await client.beta.agents.archive(subCoord.id); });
      console.log("[40.1.2] sub-coordinator agent created OK(嵌套定义自身被接受):", subCoord.id);

      // 试图把 sub-coord 当 child 挂到 top coordinator
      try {
        const topCoord = await client.beta.agents.create({
          ...MINIMAL_PARAMS,
          name: `p3-topcoord-${Date.now()}`,
          system: "我是 top-coordinator,直接挂一个 sub-coordinator 做 child。",
          multiagent: {
            type: "coordinator",
            agents: [subCoord.id],
          } as unknown as AgentCreateParams["multiagent"],
          metadata: tagWithRunId(),
        });
        cleanup.push(async () => { await client.beta.agents.archive(topCoord.id); });
        console.log("[40.1.2] top-coordinator with sub-coord child OK:", topCoord.id);
        console.log("[40.1.2] → depth >1 在 agent.create 阶段不被检测;运行时可能仍 ignore");
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.log("[40.1.2] top-coordinator with sub-coord child REJECT:", e.status, e.message?.slice(0, 250));
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.1.2] sub-coordinator create REJECT:", e.status, e.message?.slice(0, 250));
    }
  }, 60_000);

  /** 40.1.3 coordinator children 数量上限 */
  it("40.1.3 coordinator children count limit", async () => {
    const client = getClient();
    await client.ready;

    // Create 26 child agents
    const children: Array<{ id: string }> = [];
    for (let i = 0; i < 26; i++) {
      const c = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: `p3-26child-${Date.now()}-${i}`,
        system: `worker ${i}`,
        metadata: tagWithRunId(),
      });
      children.push(c);
      cleanup.push(async () => { await client.beta.agents.archive(c.id); });
    }
    console.log("[40.1.3] created 26 child agents");

    // 试 26 children
    try {
      const coord26 = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: `p3-coord26-${Date.now()}`,
        system: "coordinator with 26 children",
        multiagent: {
          type: "coordinator",
          agents: children.map((c) => c.id),
        } as unknown as AgentCreateParams["multiagent"],
        metadata: tagWithRunId(),
      });
      cleanup.push(async () => { await client.beta.agents.archive(coord26.id); });
      console.log("[40.1.3] 26-child coordinator created OK:", coord26.id);
    } catch (err) {
      const e = err as { status?: number; message?: string; error?: { error?: { type?: string; message?: string } } };
      console.log("[40.1.3] 26-child reject status:", e.status, "type:", e.error?.error?.type, "msg:", (e.error?.error?.message ?? e.message)?.slice(0, 300));
    }

    // 试 25
    try {
      const coord25 = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: `p3-coord25-${Date.now()}`,
        system: "coordinator with 25 children",
        multiagent: {
          type: "coordinator",
          agents: children.slice(0, 25).map((c) => c.id),
        } as unknown as AgentCreateParams["multiagent"],
        metadata: tagWithRunId(),
      });
      cleanup.push(async () => { await client.beta.agents.archive(coord25.id); });
      console.log("[40.1.3] 25-child coordinator OK:", coord25.id);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log("[40.1.3] 25-child UNEXPECTED reject:", e.status, e.message?.slice(0, 250));
    }
  }, 180_000);
});
