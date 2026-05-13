/**
 * 10.3 Session CRUD(Phase 1)
 *
 * 13 条 case 覆盖 sessions.create / list / retrieve / archive / delete + 关键不变量:
 *   - Session.agent 是 snapshot(agent 后续 update 不影响已有 session)
 *   - archive vs delete 二元行为(archive 只翻 metadata flag,delete 物理移除)
 *   - 跨 lifecycle 状态(idle / running / archived / deleted)的 mutation 错误码
 *   - 边界资源 ref(invalid agent_id / env_id)
 *
 * 用户决策(本次):
 *   - 10.3.8 delete-running race-prone case → **跑**,实测能否复现 409
 *   - 10.3.11 cross-workspace → **skip**(AWS 测试环境只 provision 一个 workspace)
 *   - resources(memory_store / github_repo)→ **skip**,Phase 3 / research preview 启用后再补
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import {
  getClient,
  resetClientCache,
  tagWithRunId,
} from "../../src/client.ts";
import { createRecorder, type RecorderHandle } from "../../src/utils/recorder.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { runTurnAndCollect } from "../../src/utils/stream.ts";

type SessionCreateParams = Parameters<AnthropicAws["beta"]["sessions"]["create"]>[0];

describe("10.3 Session CRUD", () => {
  let recorder: RecorderHandle | undefined;
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.warn("[cleanup] failed:", err);
      }
    }
    cleanup.length = 0;
    if (recorder) {
      try {
        const result = await recorder.dump();
        console.log(`[case] artifact dumped to ${result.artifactDir}`, result.counts);
      } catch (err) {
        console.warn("[recorder] dump failed:", err);
      }
      recorder = undefined;
    }
    resetClientCache();
  });

  function trackSessionArchive(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.sessions.archive(id);
    });
  }

  function trackAgentArchive(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.agents.archive(id);
    });
  }

  /** 10.3.1 create with minimal(agent string + environment_id) */
  it("10.3.1 create with minimal (agent string + environment_id)", async () => {
    recorder = createRecorder({ caseId: "10.3.1/session-create-minimal" });
    recorder.addNote("目的:验证 sessions.create 接受 agent string + environment_id 最小参数,返回 sess_* + status idle/running");
    recorder.addNote("不变量:session.agent 是 snapshot(返回里应包含 agent 完整字段而非仅 id)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    trackSessionArchive(session.id, client);

    // 实测 CMA session id 前缀是 `sesn_` 而非文档/SDK 类型隐含的 `sess_*`(F-NNNN 候选)
    expect(session.id).toMatch(/^se(ss|sn)_/);
    expect(["idle", "running"]).toContain(session.status);
    expect(session.agent).toBeDefined();
    recorder.addMetadata("session_id", session.id);
    recorder.addMetadata("session_id_prefix", session.id.split("_")[0]);
    recorder.addMetadata("session_status", session.status);
    recorder.addNote(`结果:session.id=${session.id} status=${session.status}`);
    if (!session.id.startsWith("sess_")) {
      recorder.addNote(`⚠ FINDING 候选:session.id 前缀=${session.id.split("_")[0]}_(非 sess_,跟文档/SDK shape 不一致)`);
    }

    const agentSnapshot = session.agent as { id?: string; version?: number } | undefined;
    if (agentSnapshot?.id) {
      expect(agentSnapshot.id).toBe(agentId);
      recorder.addNote(`agent snapshot:id=${agentSnapshot.id} version=${agentSnapshot.version}`);
    } else {
      recorder.addNote(`⚠ FINDING 候选:session.agent 返回 shape 不含 id(实际 shape=${JSON.stringify(session.agent).slice(0, 200)}...)`);
    }
  });

  /** 10.3.2 create with pinned agent version({type:"agent", id, version}) */
  it("10.3.2 create with pinned agent version", async () => {
    recorder = createRecorder({ caseId: "10.3.2/session-pin-agent-version" });
    recorder.addNote("目的:验证 session 可以 pin 到具体 agent version,而非 floating 跟 latest");
    recorder.addNote("做法:create agent → update bump 到 v2 → create session pin v1 → retrieve session 看 agent.version");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // 用 ephemeral agent 而非 shared agent(shared 不能 bump version 干扰其他 case)
    const agent = await client.beta.agents.create({
      name: `cma-test-pin-${Date.now()}`,
      model: "claude-haiku-4-5",
      system: "test agent for 10.3.2 pin",
      description: "10.3.2 v1",
      metadata: tagWithRunId(),
    });
    trackAgentArchive(agent.id, client);
    expect(agent.version).toBe(1);

    const v2 = await client.beta.agents.update(agent.id, {
      version: agent.version,
      description: "10.3.2 v2",
    });
    expect(v2.version).toBe(2);

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: 1 } as SessionCreateParams["agent"],
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    trackSessionArchive(session.id, client);

    const agentSnap = session.agent as { id?: string; version?: number; description?: string };
    recorder.addMetadata("pinned_version", 1);
    recorder.addMetadata("session_agent_version", agentSnap.version);
    recorder.addMetadata("session_agent_description", agentSnap.description);
    recorder.addNote(`实测:pinned v1,session.agent.version=${agentSnap.version},description=${agentSnap.description}`);

    if (agentSnap.version === 1) {
      recorder.addNote("✓ session pin to v1 verified,session.agent 是 snapshot 不跟 latest");
    } else {
      recorder.addNote(`⚠ FINDING 候选:pin=1 但 session.agent.version=${agentSnap.version}`);
    }
    expect(agentSnap.version).toBe(1);
  });

  /** 10.3.3 create with title + metadata(verify optional fields accepted) */
  it("10.3.3 create with title + metadata", async () => {
    recorder = createRecorder({ caseId: "10.3.3/session-create-with-title-metadata" });
    recorder.addNote("目的:验证 sessions.create 接受可选字段(title / metadata)且 echo back");
    recorder.addNote("skip:vault_ids 待 10.4 vault CRUD 落地后联测;resources(memory_store/github)Phase 3 research preview 启用后补");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "10.3.3 session title",
      metadata: tagWithRunId({ purpose: "10.3.3-fields" }),
    });
    trackSessionArchive(session.id, client);

    expect(session.title).toBe("10.3.3 session title");
    expect(session.metadata?.["purpose"]).toBe("10.3.3-fields");
    recorder.addNote(`结果:title=${session.title} metadata.purpose=${session.metadata?.["purpose"]}`);
  });

  /** 10.3.4 list + filter by status */
  it("10.3.4 list + filter by status=idle", async () => {
    recorder = createRecorder({ caseId: "10.3.4/session-list-filter-status" });
    recorder.addNote("目的:验证 sessions.list 支持 status filter,返回的 session 都满足该 status");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    // 先 create 一个 idle session,确保 filter 能命中至少一条本 run 创建的
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "10.3.4 filter probe",
      metadata: tagWithRunId(),
    });
    trackSessionArchive(session.id, client);

    let seenIdle = 0;
    let seenNonIdle = 0;
    let total = 0;
    for await (const s of client.beta.sessions.list({ statuses: ["idle"], limit: 20 })) {
      total++;
      if (s.status === "idle") seenIdle++;
      else {
        seenNonIdle++;
        recorder!.addNote(`⚠ FINDING 候选:filter status=idle 返回 status=${s.status} (sess=${s.id})`);
      }
      if (total >= 20) break;
    }
    recorder.addMetadata("total_seen", total);
    recorder.addMetadata("seen_idle", seenIdle);
    recorder.addMetadata("seen_non_idle", seenNonIdle);
    recorder.addNote(`结果:list status=idle 拿到 ${total} 条,${seenIdle} idle,${seenNonIdle} 非 idle`);
    expect(seenIdle).toBeGreaterThan(0);
    expect(seenNonIdle).toBe(0);
  });

  /** 10.3.5 retrieve 包含 stats / usage 字段 */
  it("10.3.5 retrieve includes stats / usage", async () => {
    recorder = createRecorder({ caseId: "10.3.5/session-retrieve-stats-usage" });
    recorder.addNote("目的:验证 sessions.retrieve 返回 stats / usage 字段(跑一个最小 turn 后,这些字段应该非空)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    trackSessionArchive(session.id, client);

    // 跑一个最小 turn(单 word 回复,token 消耗低)
    const events = await runTurnAndCollect(
      session.id,
      { events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }] },
      { stopTypes: ["session.status_idle", "session.error"], maxWaitMs: 30_000 },
    );
    recorder.addMetadata("turn_events", events.length);

    const retrieved = await client.beta.sessions.retrieve(session.id);
    // stats / usage 字段名可能跟 SDK 类型不一致,松弛断言
    const obj = retrieved as unknown as { stats?: unknown; usage?: unknown };
    recorder.addMetadata("stats", obj.stats ?? null);
    recorder.addMetadata("usage", obj.usage ?? null);
    recorder.addNote(`实测:retrieve 返回 stats=${JSON.stringify(obj.stats).slice(0, 200)} usage=${JSON.stringify(obj.usage).slice(0, 200)}`);

    if (obj.stats || obj.usage) {
      recorder.addNote("✓ stats / usage 至少一个非空,跑过 turn 后服务端 populate 该字段");
    } else {
      recorder.addNote("⚠ FINDING 候选:跑过 turn 后 stats 和 usage 都空,服务端未在 retrieve 中暴露统计字段");
    }
  }, 60_000);

  /** 10.3.6 archive(status 不变,只 metadata flag) */
  it("10.3.6 archive → archived_at non-null, status 不变", async () => {
    recorder = createRecorder({ caseId: "10.3.6/session-archive" });
    recorder.addNote("目的:验证 archive 只翻 archived_at 字段;status(idle/running)不被 archive 直接改写");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    const statusBefore = session.status;
    expect(session.archived_at).toBeNull();

    const archived = await client.beta.sessions.archive(session.id);
    expect(archived.archived_at).toBeTruthy();
    recorder.addNote(`结果:archived_at=${archived.archived_at} status before=${statusBefore} after=${archived.status}`);
    recorder.addMetadata("status_before", statusBefore);
    recorder.addMetadata("status_after_archive", archived.status);

    if (archived.status === statusBefore) {
      recorder.addNote("✓ archive 不改 status,只 set archived_at");
    } else {
      recorder.addNote(`⚠ FINDING 候选:archive 同时改了 status(${statusBefore} → ${archived.status})`);
    }
    // 不 track:已 archive
  });

  /** 10.3.7 archive 后再发 user event 的 status code */
  it("10.3.7 events.send to archived session → error status", async () => {
    recorder = createRecorder({ caseId: "10.3.7/archived-session-rejects-send" });
    recorder.addNote("目的:archive session 后,events.send 返回什么错误码?(预测 400 / 404 / 409)");
    recorder.addNote("对照 10.2.6:archived env reject session.create;此处看 archived session reject send 的具体行为");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    await client.beta.sessions.archive(session.id);

    let errorStatus: number | undefined;
    let errorType: string | undefined;
    let errorMessage: string | undefined;
    try {
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: "to archived session" }] }],
      });
      recorder.addNote("⚠ FINDING 候选:archived session 仍接受 events.send(预期应 reject)");
    } catch (err) {
      const e = err as {
        status?: number;
        error?: { error?: { type?: string; message?: string }; type?: string };
      } | null;
      errorStatus = e?.status;
      errorType = e?.error?.error?.type ?? e?.error?.type;
      errorMessage = e?.error?.error?.message;
      recorder.addNote(`实测:archived session reject send,status=${errorStatus} type=${errorType} message=${errorMessage}`);
    }
    recorder.addMetadata("error_status", errorStatus);
    recorder.addMetadata("error_type", errorType);
    recorder.addMetadata("error_message", errorMessage);
    expect(errorStatus).toBeDefined();
  });

  /** 10.3.8 delete running session → 期望 409 */
  it("10.3.8 delete running session → expect 409", async () => {
    recorder = createRecorder({ caseId: "10.3.8/delete-running-session" });
    recorder.addNote("目的:验证 delete 在 session 正在 running 时被 reject(409);仅当过早或过晚才 200");
    recorder.addNote("难点:turn 触发后 session 立刻 idle→running 异步,需要在 running 窗口 fire delete。**race-prone**,记录实测结果(409/200 都是有价值的数据点)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });

    // 先 open stream 防止 race(看到 status_running 再 fire delete)
    const stream = await client.beta.sessions.events.stream(session.id);

    // 发 user event(异步触发 running)
    const sendPromise = client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
    });

    // 等 status_running event 出现(最多 5s)
    let sawRunning = false;
    const iter = (stream as AsyncIterable<{ type?: string }>)[Symbol.asyncIterator]();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining));
      const result = await Promise.race([iter.next(), timer]);
      if (result === "timeout") break;
      if (result.done) break;
      if (result.value?.type === "session.status_running") {
        sawRunning = true;
        break;
      }
    }
    recorder.addMetadata("saw_running_before_delete", sawRunning);
    recorder.addNote(`实测:delete 前 saw_running=${sawRunning}`);

    let deleteStatus: number | undefined;
    let deleteOutcome: "200" | "409" | "404" | "other_error" | "no_delete_api" = "other_error";
    try {
      const sessionsAny = client.beta.sessions as unknown as { delete?: (id: string) => Promise<unknown> };
      if (typeof sessionsAny.delete !== "function") {
        deleteOutcome = "no_delete_api";
        recorder.addNote("⚠ FINDING 候选:SDK beta.sessions 无 delete 方法,只能 archive(待文档/types 二次确认)");
      } else {
        await sessionsAny.delete(session.id);
        deleteStatus = 200;
        deleteOutcome = "200";
        recorder.addNote("实测:delete 200(可能 race 过去 — 等到 idle 才到达 server)");
      }
    } catch (err) {
      const e = err as { status?: number } | null;
      deleteStatus = e?.status;
      if (e?.status === 409) deleteOutcome = "409";
      else if (e?.status === 404) deleteOutcome = "404";
      recorder.addNote(`实测:delete reject,status=${deleteStatus}`);
    }

    // 关流 + 等 send 落地(不 throw cleanup 错)
    try {
      await iter.return?.();
    } catch {
      // ignore
    }
    try {
      await sendPromise;
    } catch {
      // session 可能已被 delete,send race 失败可忽略
    }

    recorder.addMetadata("delete_status", deleteStatus);
    recorder.addMetadata("delete_outcome", deleteOutcome);
    recorder.addNote(`**FINDING 候选**:delete running session outcome = ${deleteOutcome}`);

    // 兜底 cleanup(session 可能仍在,archive 失败吞)
    cleanup.push(async () => {
      try {
        await client.beta.sessions.archive(session.id);
      } catch {
        // 已 delete 是正常的
      }
    });
  }, 30_000);

  /** 10.3.9 delete idle session → 200 */
  it("10.3.9 delete idle session → 200", async () => {
    recorder = createRecorder({ caseId: "10.3.9/delete-idle-session" });
    recorder.addNote("目的:idle 状态下 delete 成功(200);后续 retrieve 应 404");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    expect(session.status).toBe("idle");

    const sessionsAny = client.beta.sessions as unknown as { delete?: (id: string) => Promise<unknown> };
    if (typeof sessionsAny.delete !== "function") {
      recorder.addNote("⚠ FINDING 候选:SDK beta.sessions.delete 不存在");
      cleanup.push(async () => { await client.beta.sessions.archive(session.id); });
      return;
    }

    await sessionsAny.delete(session.id);
    recorder.addNote(`✓ delete idle session.id=${session.id} → 200`);

    // 后续 retrieve 应 404
    let retrieveStatus: number | undefined;
    try {
      await client.beta.sessions.retrieve(session.id);
      recorder.addNote("⚠ FINDING 候选:delete 后 retrieve 仍 200(物理 delete 应该 404)");
    } catch (err) {
      retrieveStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`✓ delete 后 retrieve status=${retrieveStatus}`);
    }
    recorder.addMetadata("retrieve_after_delete_status", retrieveStatus);
    expect(retrieveStatus).toBe(404);
  });

  /** 10.3.10 delete archived session */
  it("10.3.10 delete archived session", async () => {
    recorder = createRecorder({ caseId: "10.3.10/delete-archived-session" });
    recorder.addNote("目的:验证 archived session 是否可以 delete(预期:可以,archive 不阻碍物理 delete)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    await client.beta.sessions.archive(session.id);

    const sessionsAny = client.beta.sessions as unknown as { delete?: (id: string) => Promise<unknown> };
    if (typeof sessionsAny.delete !== "function") {
      recorder.addNote("⚠ FINDING 候选:SDK beta.sessions.delete 不存在");
      return;
    }

    let deleteStatus: number | undefined;
    let deleteOk = false;
    try {
      await sessionsAny.delete(session.id);
      deleteStatus = 200;
      deleteOk = true;
      recorder.addNote("✓ archived session delete → 200");
    } catch (err) {
      deleteStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`实测:archived session delete reject,status=${deleteStatus}`);
    }
    recorder.addMetadata("delete_status", deleteStatus);
    recorder.addMetadata("delete_ok", deleteOk);
  });

  /** 10.3.11 跨 workspace 引用 — SKIP(测试环境只有一个 workspace) */
  it.skip("10.3.11 cross-workspace ref → expect 4xx (skip: single workspace test env)", async () => {
    // SKIP:AWS 测试环境目前只 provision 一个 workspace,无法跨 workspace 测引用 reject。
    // Phase 1+ 若拿到第二个 workspace 凭证,补这个 case。
    // 预测:跨 workspace 引用 vault_id / env_id / agent_id 应该 403 或 404。
  });

  /** 10.3.12 Session.agent snapshot 验证 */
  it("10.3.12 session.agent snapshot (agent update after session create 不影响)", async () => {
    recorder = createRecorder({ caseId: "10.3.12/session-agent-snapshot" });
    recorder.addNote("目的:验证不变量 — session 创建时 agent 已 frozen,后续 agent.update 不污染 session.agent");
    recorder.addNote("AgentMatrix RFC §8.6 AgentSpec immutability 的实证对照点");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // 创建专属 agent(避免影响 shared agent)
    const agent = await client.beta.agents.create({
      name: `cma-test-snapshot-${Date.now()}`,
      model: "claude-haiku-4-5",
      system: "snapshot test agent",
      description: "10.3.12 v1 — before session created",
      metadata: tagWithRunId(),
    });
    trackAgentArchive(agent.id, client);

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id,
      environment_id: envId,
      metadata: tagWithRunId(),
    });
    trackSessionArchive(session.id, client);

    const beforeSnap = session.agent as { version?: number; description?: string };
    recorder.addMetadata("session_agent_before", { version: beforeSnap.version, description: beforeSnap.description });
    recorder.addNote(`create 时:session.agent.version=${beforeSnap.version} description=${beforeSnap.description}`);

    // bump agent 到 v2
    const v2 = await client.beta.agents.update(agent.id, {
      version: agent.version,
      description: "10.3.12 v2 — should NOT leak into existing session",
    });
    expect(v2.version).toBe(2);

    // retrieve session,看 agent snapshot
    const retrieved = await client.beta.sessions.retrieve(session.id);
    const afterSnap = retrieved.agent as { version?: number; description?: string };
    recorder.addMetadata("session_agent_after", { version: afterSnap.version, description: afterSnap.description });
    recorder.addNote(`update 后 retrieve:session.agent.version=${afterSnap.version} description=${afterSnap.description}`);

    if (afterSnap.version === beforeSnap.version && afterSnap.description === beforeSnap.description) {
      recorder.addNote("✓ Session.agent 是 snapshot,agent.update 不影响 session.agent — F-NNNN 候选");
    } else {
      recorder.addNote(`⚠ FINDING 候选:session.agent 随 agent.update 变化!(version ${beforeSnap.version}→${afterSnap.version},description 改变)`);
    }
    expect(afterSnap.version).toBe(beforeSnap.version);
    expect(afterSnap.description).toBe(beforeSnap.description);
  });

  /** 10.3.13 invalid agent_id / environment_id */
  it("10.3.13 invalid agent_id / environment_id → 4xx", async () => {
    recorder = createRecorder({ caseId: "10.3.13/invalid-resource-refs" });
    recorder.addNote("目的:验证不存在的 agent_id / environment_id 触发的错误码(预测 404 / 400)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const envId = await getSharedEnvironmentId();
    const agentId = await getSharedAgentId();

    // case A:invalid agent_id
    let agentErrStatus: number | undefined;
    let agentErrType: string | undefined;
    try {
      await client.beta.sessions.create({
        agent: "agent_invalidnonexistent000000000000",
        environment_id: envId,
        metadata: tagWithRunId(),
      });
      recorder.addNote("⚠ FINDING 候选:invalid agent_id 仍创建 session 成功");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string } } } | null;
      agentErrStatus = e?.status;
      agentErrType = e?.error?.error?.type;
      recorder.addNote(`✓ invalid agent_id:status=${agentErrStatus} type=${agentErrType}`);
    }

    // case B:invalid environment_id
    let envErrStatus: number | undefined;
    let envErrType: string | undefined;
    try {
      await client.beta.sessions.create({
        agent: agentId,
        environment_id: "env_invalidnonexistent00000000000",
        metadata: tagWithRunId(),
      });
      recorder.addNote("⚠ FINDING 候选:invalid environment_id 仍创建 session 成功");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string } } } | null;
      envErrStatus = e?.status;
      envErrType = e?.error?.error?.type;
      recorder.addNote(`✓ invalid env_id:status=${envErrStatus} type=${envErrType}`);
    }

    recorder.addMetadata("agent_err_status", agentErrStatus);
    recorder.addMetadata("agent_err_type", agentErrType);
    recorder.addMetadata("env_err_status", envErrStatus);
    recorder.addMetadata("env_err_type", envErrType);
    expect(agentErrStatus).toBeDefined();
    expect(envErrStatus).toBeDefined();
  });
});
