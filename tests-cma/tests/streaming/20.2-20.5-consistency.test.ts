/**
 * Phase 2.5 Batch F — §20.2B.2 event id 唯一性 + §20.5.8 session.status 一致性。
 */

import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";

describe("20.2/20.5 consistency(Phase 2.5 Batch F)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 20.2B.2 event id 跨 session 唯一性 */
  it("20.2B.2 event id cross-session uniqueness", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session1 = await client.beta.sessions.create({ agent: agentId, environment_id: envId, metadata: tagWithRunId() });
    cleanup.push(async () => { await client.beta.sessions.archive(session1.id); });
    const session2 = await client.beta.sessions.create({ agent: agentId, environment_id: envId, metadata: tagWithRunId() });
    cleanup.push(async () => { await client.beta.sessions.archive(session2.id); });

    // 并行跑 turn
    await Promise.all([
      client.beta.sessions.events.send(session1.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok1'." }] }],
      }),
      client.beta.sessions.events.send(session2.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok2'." }] }],
      }),
    ]);
    await new Promise((r) => setTimeout(r, 8000));

    const ids1: string[] = [];
    for await (const e of client.beta.sessions.events.list(session1.id, { limit: 50 })) {
      if ((e as { id?: string }).id) ids1.push((e as { id: string }).id);
    }
    const ids2: string[] = [];
    for await (const e of client.beta.sessions.events.list(session2.id, { limit: 50 })) {
      if ((e as { id?: string }).id) ids2.push((e as { id: string }).id);
    }

    console.log("[20.2B.2] session1 events:", ids1.length);
    console.log("[20.2B.2] session2 events:", ids2.length);

    // 跨 session 是否有任何 id 重叠?
    const set1 = new Set(ids1);
    const intersection = ids2.filter((id) => set1.has(id));
    console.log("[20.2B.2] cross-session id intersection:", intersection.length);

    expect(intersection.length).toBe(0);

    // 也校验 session 内 id 唯一
    expect(new Set(ids1).size).toBe(ids1.length);
    expect(new Set(ids2).size).toBe(ids2.length);

    // event id prefix 一致(都是 sevt_)
    const prefixes1 = new Set(ids1.map((id) => id.split("_")[0]));
    const prefixes2 = new Set(ids2.map((id) => id.split("_")[0]));
    console.log("[20.2B.2] session1 id prefixes:", [...prefixes1]);
    console.log("[20.2B.2] session2 id prefixes:", [...prefixes2]);
    expect(prefixes1).toEqual(new Set(["sevt"]));
    expect(prefixes2).toEqual(new Set(["sevt"]));
  }, 60_000);

  /** 20.5.8 session.status field vs stream session.status_* event 一致性 */
  it("20.5.8 session.status field vs stream session.status_* event 一致", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // Initial state via retrieve
    const init = await client.beta.sessions.retrieve(session.id);
    console.log("[20.5.8] initial status:", init.status);
    expect(init.status).toBe("idle");

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: ["session.status_idle", "session.error", "session.status_terminated"],
      defaultMaxWaitMs: 30_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
    });

    // 等 running event 出现,然后立刻 retrieve 看 status
    await collector.consume({ stopTypes: ["session.status_running"], maxWaitMs: 8000 });
    const midRunning = await client.beta.sessions.retrieve(session.id);
    console.log("[20.5.8] retrieve.status after stream status_running:", midRunning.status);
    // 期望:retrieve 显示 'running'(stream + object 一致)

    // Consume rest to idle
    await collector.consume();
    const final = await client.beta.sessions.retrieve(session.id);
    console.log("[20.5.8] retrieve.status after stream status_idle:", final.status);
    expect(final.status).toBe("idle");

    const snap = await collector.finalize();
    const statusEvents = snap.L0.stream.filter((e) => typeof e.type === "string" && (e.type as string).startsWith("session.status_"));
    console.log("[20.5.8] stream session.status_* events:", statusEvents.map((e) => e.type));

    // 最后一个 session.status_* 应该 match retrieve.status
    const lastStatusEvent = statusEvents[statusEvents.length - 1];
    const lastStatusFromStream = lastStatusEvent ? (lastStatusEvent.type as string).replace("session.status_", "") : null;
    console.log("[20.5.8] last stream status:", lastStatusFromStream, "vs retrieve:", final.status);

    // 一致性
    if (lastStatusFromStream) {
      expect(final.status).toBe(lastStatusFromStream);
    }
  }, 60_000);
});
