/**
 * Phase 3 启动 probe — 检查 Memory + Outcomes preview access + sessions.threads endpoint。
 *
 * 类似 F-0021 multi-agent probe 的做法:minimal 触碰每个 feature 的 API surface,
 * 看是 403/preview gated 还是开通。
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getProbeAgentId, getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

type MemoryStoreCreateParams = Parameters<AnthropicAws["beta"]["memoryStores"]["create"]>[0];
type SessionCreateParams = Parameters<AnthropicAws["beta"]["sessions"]["create"]>[0];
type EventSendParams = Parameters<AnthropicAws["beta"]["sessions"]["events"]["send"]>[1];

describe("Phase 3 preview probe", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** P3.A Memory preview probe */
  it("P3.A memory_stores API surface + session attach", async () => {
    const client = getClient();
    await client.ready;
    const probeAgentId = await getProbeAgentId();
    const envId = await getSharedEnvironmentId();

    const createParams: MemoryStoreCreateParams = {
      name: `p3-probe-${Date.now()}`,
      metadata: tagWithRunId(),
    } as MemoryStoreCreateParams;

    let storeId = "";
    try {
      const result = await client.beta.memoryStores.create(createParams);
      storeId = result.id;
      console.log("[P3.A] memory_store created:", storeId, "name:", (result as { name?: string }).name);
      console.log("[P3.A] full memory_store:", JSON.stringify(result, null, 2));
      cleanup.push(async () => { await client.beta.memoryStores.archive(storeId); });
    } catch (err) {
      const e = err as { message?: string; status?: number };
      console.log("[P3.A] memory_store.create error status:", e.status, "msg:", e.message);
      throw err;
    }

    // List endpoint
    try {
      const stores: unknown[] = [];
      for await (const s of client.beta.memoryStores.list()) {
        stores.push(s);
        if (stores.length >= 5) break;
      }
      console.log("[P3.A] memory_stores.list count (capped 5):", stores.length);
    } catch (err) {
      const e = err as { message?: string; status?: number };
      console.log("[P3.A] memory_stores.list error:", e.status, e.message);
    }

    // Session with memory mount
    const sessionParams: SessionCreateParams = {
      agent: probeAgentId,
      environment_id: envId,
      resources: [
        { type: "memory_store", memory_store_id: storeId, access: "read_write" },
      ] as SessionCreateParams["resources"],
      metadata: tagWithRunId(),
    };

    let sessionId = "";
    try {
      const session = await client.beta.sessions.create(sessionParams);
      sessionId = session.id;
      console.log("[P3.A] session with memory mount created:", sessionId);
      console.log("[P3.A] session.resources:", JSON.stringify(session.resources));
      cleanup.push(async () => { await client.beta.sessions.archive(sessionId); });
    } catch (err) {
      const e = err as { message?: string; status?: number };
      console.log("[P3.A] session.create error status:", e.status, "msg:", e.message);
      throw err;
    }

    const collector = createThreeLayerCollector(sessionId, {
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
          text: `列一下 /mnt/memory/ 下能写的目录(只有一个 memstore 子目录),进去写一个 hello.txt 内容是 'phase3-memory-probe-ok',然后 cat 验证,回 'done'。`,
        }],
      }],
    });
    await collector.consume();
    const snap = await collector.finalize();
    const types = snap.L0.stream
      .map((e) => (typeof e.type === "string" ? e.type : null))
      .filter((t): t is string => t !== null);
    console.log("[P3.A] event type set:", [...new Set(types)]);
    console.log("[P3.A] total events:", types.length);
    const toolUses = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string) === "agent.tool_use");
    console.log("[P3.A] agent.tool_use count:", toolUses.length);

    expect(storeId).toMatch(/^memstore_/);
  }, 180_000);

  /** P3.B Outcomes preview probe */
  it("P3.B user.define_outcome + span.outcome_evaluation_* events", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    const sessionId = session.id;
    console.log("[P3.B] session created:", sessionId);
    cleanup.push(async () => { await client.beta.sessions.archive(sessionId); });

    const collector = createThreeLayerCollector(sessionId, {
      defaultStopTypes: ["session.status_idle", "session.error"],
      defaultMaxWaitMs: 90_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    try {
      await collector.send({
        events: [{
          type: "user.define_outcome",
          description: "回答:1+1 等于几?",
          rubric: { type: "text", content: "答案必须明确写出 1+1=2。" },
          max_iterations: 1,
        }] as EventSendParams["events"],
      });
      console.log("[P3.B] user.define_outcome sent");
    } catch (err) {
      const e = err as { message?: string; status?: number };
      console.log("[P3.B] send define_outcome error status:", e.status, "msg:", e.message);
      throw err;
    }

    await collector.consume();
    const snap = await collector.finalize();
    const types = snap.L0.stream
      .map((e) => (typeof e.type === "string" ? e.type : null))
      .filter((t): t is string => t !== null);
    const uniq = [...new Set(types)];
    console.log("[P3.B] event type set:", uniq);
    console.log("[P3.B] total events:", types.length);
    const outcomeEvents = snap.L0.stream.filter((e) => {
      const t = typeof e.type === "string" ? e.type : "";
      return t.startsWith("span.outcome_evaluation") || t === "user.define_outcome";
    });
    console.log("[P3.B] outcome-related events:", outcomeEvents.length);
    outcomeEvents.forEach((e, i) => console.log(`  [${i}]`, e.type, "id:", (e as { id?: string }).id));

    const hasDefineEcho = uniq.includes("user.define_outcome");
    const hasOutcomeStart = uniq.includes("span.outcome_evaluation_start");
    const hasOutcomeEnd = uniq.includes("span.outcome_evaluation_end");
    console.log("[P3.B] echo:", hasDefineEcho, "start:", hasOutcomeStart, "end:", hasOutcomeEnd);
  }, 180_000);

  /** P3.C sessions.threads endpoint path probe — F-0021 follow-up */
  it("P3.C sessions.threads.list/retrieve probe", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    const sessionId = session.id;
    console.log("[P3.C] session created (no multi-agent):", sessionId);
    cleanup.push(async () => { await client.beta.sessions.archive(sessionId); });

    try {
      const threads: unknown[] = [];
      for await (const t of client.beta.sessions.threads.list(sessionId)) {
        threads.push(t);
        if (threads.length >= 10) break;
      }
      console.log("[P3.C] threads.list count:", threads.length, "(non-multiagent session)");
    } catch (err) {
      const e = err as { message?: string; status?: number };
      console.log("[P3.C] threads.list error status:", e.status, "msg:", e.message);
    }

    try {
      await client.beta.sessions.threads.retrieve("thrd_does_not_exist_0", { session_id: sessionId });
    } catch (err) {
      const e = err as { message?: string; status?: number };
      console.log("[P3.C] threads.retrieve(bogus) status:", e.status, "msg:", e.message);
    }
  }, 60_000);
});
