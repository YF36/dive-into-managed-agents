/**
 * 10.1 Agent CRUD(Phase 1)
 *
 * 13 条 case 覆盖 agents.create / list / retrieve / update / archive + 边界 + 错误。
 * 每个 case 用 Recorder 包,artifact 落 sibling notes repo;ephemeral agents
 * afterEach 显式 archive,resetClientCache 释放 fetch-hooked client。
 *
 * 用户决策(本次):
 * - 10.1.11 / 10.1.12 上限测试 → **跑**(高价值 finding 机会)
 * - 10.1.7 stale version → **试水**(实测 CMA 是否实现 OCC)
 * - 10.1.13 multiagent depth > 1 → skip(需 research preview access)
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import {
  describeClient,
  getClient,
  resetClientCache,
  tagWithRunId,
} from "../../src/client.ts";
import { createRecorder, type RecorderHandle } from "../../src/utils/recorder.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

const MINIMAL_PARAMS = {
  model: "claude-haiku-4-5" as const,
  system: "test agent. 简短回答。",
  description: "ephemeral test agent. afterEach 会 archive。",
};

describe("10.1 Agent CRUD", () => {
  let recorder: RecorderHandle | undefined;
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.warn("[cleanup] archive failed:", err);
      }
    }
    cleanup.length = 0;
    if (recorder) {
      try {
        const result = await recorder.dump();
        console.log(`[${recorder ? "case" : "unknown"}] artifact dumped to ${result.artifactDir}`, result.counts);
      } catch (err) {
        console.warn("[recorder] dump failed:", err);
      }
      recorder = undefined;
    }
    resetClientCache();
  });

  function trackAgent(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.agents.archive(id);
    });
  }

  function genName(suffix: string): string {
    return `cma-test-${suffix}-${Date.now()}`;
  }

  /** 10.1.1 create with minimal fields(`model` + `name`)*/
  it("10.1.1 create with minimal fields", async () => {
    recorder = createRecorder({ caseId: "10.1.1/agent-create-minimal" });
    recorder.addNote("目的:验证 agents.create 只传 model + name 即可,返回 version=1 + archived_at=null");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-1"),
      metadata: tagWithRunId(),
    });
    trackAgent(agent.id, client);

    expect(agent.id).toMatch(/^agent_/);
    expect(agent.version).toBe(1);
    expect(agent.archived_at).toBeNull();
    expect(agent.created_at).toBeTruthy();
    recorder.addMetadata("agent_id", agent.id);
    recorder.addNote(`结果:agent.id=${agent.id} version=${agent.version}`);
  });

  /** 10.1.2 create with extended fields(system / tools 简单子集) */
  it("10.1.2 create with extended fields (system + tools)", async () => {
    recorder = createRecorder({ caseId: "10.1.2/agent-create-extended" });
    recorder.addNote("目的:验证 agents.create 接受 system / tools(简单 native_tool)等扩展字段");
    recorder.addNote("skip 字段:mcp_servers(需独立 URL),skills(需 skill_id 资源),multiagent(需 research preview)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const params: AgentCreateParams = {
      name: genName("10-1-2"),
      model: "claude-haiku-4-5",
      system: "你是一个测试 agent,需要时可以用 bash 工具。",
      description: "10.1.2 extended-fields case",
      tools: [
        { type: "agent_toolset_20260401" },
      ] as AgentCreateParams["tools"],
      metadata: tagWithRunId({ purpose: "10.1.2-extended" }),
    };
    const agent = await client.beta.agents.create(params);
    trackAgent(agent.id, client);

    expect(agent.id).toMatch(/^agent_/);
    expect(agent.version).toBe(1);
    expect(agent.system).toBeTruthy();
    expect(agent.tools).toBeDefined();
    recorder.addMetadata("agent_id", agent.id);
    recorder.addNote(`结果:tools 长度 ${agent.tools?.length ?? 0}`);
  });

  /** 10.1.3 list + pagination cursor */
  it("10.1.3 list + pagination cursor", async () => {
    recorder = createRecorder({ caseId: "10.1.3/agent-list-pagination" });
    recorder.addNote("目的:验证 agents.list 返回分页结构(SDK 自动分页) + cursor 字段存在");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    let firstPage: unknown;
    let count = 0;
    for await (const agent of client.beta.agents.list({ limit: 5 })) {
      count++;
      if (count === 1) firstPage = agent;
      if (count >= 5) break; // 不需要拉全部,验证 list 工作即可
    }

    expect(count).toBeGreaterThan(0);
    expect(firstPage).toBeTruthy();
    recorder.addMetadata("agents_seen", count);
    recorder.addNote(`结果:list 第一页拉到 ${count} 个 agent(可能 capped at limit)`);
  });

  /** 10.1.4 retrieve specific version(query `?version=N`)*/
  it("10.1.4 retrieve specific version", async () => {
    recorder = createRecorder({ caseId: "10.1.4/agent-retrieve-version" });
    recorder.addNote("目的:验证 create → update → retrieve(version=1) 返回旧 version body,retrieve(latest) 返回新");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const v1 = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-4"),
      metadata: tagWithRunId(),
    });
    trackAgent(v1.id, client);
    expect(v1.version).toBe(1);

    const v2 = await client.beta.agents.update(v1.id, {
      description: "10.1.4 v2 description",
    });
    expect(v2.version).toBe(2);

    const retrievedV1 = await client.beta.agents.retrieve(v1.id, { version: 1 });
    const retrievedLatest = await client.beta.agents.retrieve(v1.id);

    expect(retrievedV1.version).toBe(1);
    expect(retrievedLatest.version).toBe(2);
    expect(retrievedV1.description).not.toBe(retrievedLatest.description);
    recorder.addNote(`结果:v1.description=${retrievedV1.description}, v2.description=${retrievedLatest.description}`);
  });

  /** 10.1.5 update body → version +1 */
  it("10.1.5 update body → version +1", async () => {
    recorder = createRecorder({ caseId: "10.1.5/agent-update-version-bump" });
    recorder.addNote("目的:验证有意义的 update(改 description)使 version 严格 +1");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-5"),
      metadata: tagWithRunId(),
    });
    trackAgent(agent.id, client);

    const updated = await client.beta.agents.update(agent.id, {
      description: `10.1.5 updated at ${new Date().toISOString()}`,
    });

    expect(updated.version).toBe(agent.version + 1);
    expect(updated.id).toBe(agent.id);
    recorder.addNote(`结果:create version=${agent.version},update 后 version=${updated.version}`);
  });

  /** 10.1.6 no-op update → version 不变 */
  it("10.1.6 no-op update → version 不变", async () => {
    recorder = createRecorder({ caseId: "10.1.6/agent-update-noop" });
    recorder.addNote("目的:验证 no-op update(payload 等同于现状)不导致 version bump");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-6"),
      description: "10.1.6 fixed description",
      metadata: tagWithRunId(),
    });
    trackAgent(agent.id, client);

    // 完全相同的 description → no-op
    const updated = await client.beta.agents.update(agent.id, {
      description: "10.1.6 fixed description",
    });

    recorder.addNote(`实测:no-op update 后 version=${updated.version}(create 时 ${agent.version})`);
    // 期望 version 不变,但 CMA 实际行为待实测
    if (updated.version === agent.version) {
      recorder.addNote("✓ 符合预期:no-op update 不增 version");
    } else {
      recorder.addNote(`⚠ FINDING 候选:no-op update 仍 bump version(${agent.version} → ${updated.version}),与文档承诺不符`);
    }
    expect(updated.version).toBeGreaterThanOrEqual(agent.version);
  });

  /** 10.1.7 update with stale version → 试水 OCC */
  it("10.1.7 update with stale version (OCC probe)", async () => {
    recorder = createRecorder({ caseId: "10.1.7/agent-update-stale-version" });
    recorder.addNote("目的:试水 CMA 是否实现 OCC(Optimistic Concurrency Control)");
    recorder.addNote("方法:bump 到 v2,然后用 v1 的(可能存在的)expected_version 参数 update,看响应");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const v1 = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-7"),
      metadata: tagWithRunId(),
    });
    trackAgent(v1.id, client);

    const v2 = await client.beta.agents.update(v1.id, { description: "bumped to v2" });
    expect(v2.version).toBe(2);

    // 试水:用 (假设的)expected_version 参数指 v1 来 update。SDK 类型可能不接受这个字段,
    // 这本身就是 finding —— 说明 CMA 不暴露 OCC。我们用 type assertion 强行传。
    let occOutcome: "supported_409" | "supported_412" | "not_implemented_200" | "rejected_400" | "unknown" = "unknown";
    let errorStatus: number | undefined;
    try {
      const result = await (client.beta.agents.update as unknown as (
        id: string,
        body: Record<string, unknown>,
      ) => Promise<{ version: number }>)(v1.id, {
        description: "stale update",
        expected_version: 1,
      });
      // 若 SDK / CMA 接受并 200 返回,说明 OCC 不 enforce
      occOutcome = "not_implemented_200";
      recorder.addNote(`实测:CMA 接受 stale expected_version,返回 200(version=${result.version}) → CMA 不实现 OCC`);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      errorStatus = status;
      if (status === 409) occOutcome = "supported_409";
      else if (status === 412) occOutcome = "supported_412";
      else if (status === 400) occOutcome = "rejected_400";
      recorder.addNote(`实测:CMA 拒绝 stale update,status=${status} → ${occOutcome}`);
    }

    recorder.addMetadata("occ_outcome", occOutcome);
    recorder.addMetadata("error_status", errorStatus);
    recorder.addNote(`FINDING 候选:OCC 行为 = ${occOutcome}`);
    // 不强 expect 特定结果 — 这条 case 主要产 finding 不产 pass/fail
    expect(occOutcome).not.toBe("unknown");
  });

  /** 10.1.8 archive → archived_at 非 null */
  it("10.1.8 archive → archived_at 非 null", async () => {
    recorder = createRecorder({ caseId: "10.1.8/agent-archive" });
    recorder.addNote("目的:验证 archive endpoint:archived_at 从 null 变 timestamp,且不可逆");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-8"),
      metadata: tagWithRunId(),
    });
    expect(agent.archived_at).toBeNull();

    const archived = await client.beta.agents.archive(agent.id);
    expect(archived.archived_at).toBeTruthy();
    expect(archived.id).toBe(agent.id);

    // verify retrieve 也 reflect archived
    const retrieved = await client.beta.agents.retrieve(agent.id);
    expect(retrieved.archived_at).toBeTruthy();
    recorder.addNote(`结果:archived_at=${archived.archived_at}`);
    // 注:不 trackAgent(),因为已 archive
  });

  /** 10.1.9 archived agent 不能创建新 session */
  it("10.1.9 archived agent rejects new session", async () => {
    recorder = createRecorder({ caseId: "10.1.9/archived-agent-rejects-session" });
    recorder.addNote("目的:验证 archived agent 不能被 sessions.create 引用,具体错误码");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const agent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-9"),
      metadata: tagWithRunId(),
    });
    await client.beta.agents.archive(agent.id);

    // load env id from warmup
    const { getSharedEnvironmentId } = await import("../../src/fixtures/environments.ts");
    const envId = await getSharedEnvironmentId();

    let errorStatus: number | undefined;
    let errorType: string | undefined;
    try {
      await client.beta.sessions.create({
        agent: agent.id,
        environment_id: envId,
        metadata: tagWithRunId(),
      });
      recorder.addNote("⚠ FINDING 候选:archived agent 仍能创建 session(预期应 reject)");
    } catch (err) {
      const e = err as { status?: number; error?: { type?: string }; type?: string } | null;
      errorStatus = e?.status;
      errorType = e?.error?.type ?? e?.type;
      recorder.addNote(`实测:archived agent reject session.create,status=${errorStatus} type=${errorType}`);
    }

    recorder.addMetadata("error_status", errorStatus);
    recorder.addMetadata("error_type", errorType);
    expect(errorStatus).toBeDefined(); // 至少要 reject
  });

  /** 10.1.10 metadata 上限边界(16 keys / 64 char key / 512 char value)*/
  it("10.1.10 metadata 上限边界", async () => {
    recorder = createRecorder({ caseId: "10.1.10/metadata-limits" });
    recorder.addNote("目的:验证 metadata 上限文档承诺(16 keys / 64 char key / 512 char value)是否在 CMA 端实测生效");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // case A:正好 16 keys + 64 char key + 512 char value → 预期 200
    const okMeta: Record<string, string> = { test_run_id: tagWithRunId()["test_run_id"]! };
    for (let i = 1; i < 16; i++) {
      okMeta[`k${i}`.padEnd(64, "x")] = "v".padEnd(512, "y");
    }
    const okAgent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-10-ok"),
      metadata: okMeta,
    });
    trackAgent(okAgent.id, client);
    expect(okAgent.id).toMatch(/^agent_/);
    recorder.addNote(`✓ ok case:16 keys / 64 char key / 512 char value → 200`);

    // case B:超 16 keys(17 个)→ 预期 reject
    let overflowStatus: number | undefined;
    const overflowMeta: Record<string, string> = { test_run_id: tagWithRunId()["test_run_id"]! };
    for (let i = 1; i < 17; i++) overflowMeta[`k${i}`] = `v${i}`;
    try {
      const overflowAgent = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: genName("10-1-10-overflow"),
        metadata: overflowMeta,
      });
      trackAgent(overflowAgent.id, client);
      recorder.addNote("⚠ FINDING 候选:17 keys metadata 仍接受(超出文档承诺 16)");
    } catch (err) {
      overflowStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`✓ overflow case:17 keys 被 reject,status=${overflowStatus}`);
    }
    recorder.addMetadata("overflow_status", overflowStatus);
  });

  /** 10.1.11 mcp_servers 上限 20 边界 */
  it("10.1.11 mcp_servers 上限 20 边界", async () => {
    recorder = createRecorder({ caseId: "10.1.11/mcp-servers-limit" });
    recorder.addNote("目的:验证 mcp_servers 数量 20 是否硬上限");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // 用占位 URL(不实际 connect)填到 20
    const okMcp: AgentCreateParams["mcp_servers"] = Array.from({ length: 20 }, (_, i) => ({
      type: "url",
      name: `probe-${i}`,
      url: `https://example.invalid/probe-${i}`,
    })) as AgentCreateParams["mcp_servers"];

    const okAgent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-11-ok"),
      mcp_servers: okMcp,
      metadata: tagWithRunId(),
    });
    trackAgent(okAgent.id, client);
    recorder.addNote(`✓ ok case:20 mcp_servers → 200,agent.id=${okAgent.id}`);

    // 21 → 预期 reject
    let overflowStatus: number | undefined;
    const overflowMcp: AgentCreateParams["mcp_servers"] = Array.from({ length: 21 }, (_, i) => ({
      type: "url",
      name: `probe-${i}`,
      url: `https://example.invalid/probe-${i}`,
    })) as AgentCreateParams["mcp_servers"];
    try {
      const overflowAgent = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: genName("10-1-11-overflow"),
        mcp_servers: overflowMcp,
        metadata: tagWithRunId(),
      });
      trackAgent(overflowAgent.id, client);
      recorder.addNote("⚠ FINDING 候选:21 mcp_servers 仍接受(超出文档承诺 20)");
    } catch (err) {
      overflowStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`✓ overflow case:21 mcp_servers 被 reject,status=${overflowStatus}`);
    }
    recorder.addMetadata("overflow_status", overflowStatus);
  });

  /** 10.1.12 tools 上限 128 边界 */
  it("10.1.12 tools 上限 128 边界", async () => {
    recorder = createRecorder({ caseId: "10.1.12/tools-limit" });
    recorder.addNote("目的:验证 tools 数量 128 是否硬上限");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // 用 custom tool 占位填到 128
    const okTools: AgentCreateParams["tools"] = Array.from({ length: 128 }, (_, i) => ({
      type: "custom",
      name: `probe_tool_${i}`,
      description: `probe ${i}`,
      input_schema: { type: "object", properties: {} },
    })) as AgentCreateParams["tools"];

    const okAgent = await client.beta.agents.create({
      ...MINIMAL_PARAMS,
      name: genName("10-1-12-ok"),
      tools: okTools,
      metadata: tagWithRunId(),
    });
    trackAgent(okAgent.id, client);
    recorder.addNote(`✓ ok case:128 tools → 200`);

    // 129 → 预期 reject
    let overflowStatus: number | undefined;
    const overflowTools: AgentCreateParams["tools"] = Array.from({ length: 129 }, (_, i) => ({
      type: "custom",
      name: `probe_tool_${i}`,
      description: `probe ${i}`,
      input_schema: { type: "object", properties: {} },
    })) as AgentCreateParams["tools"];
    try {
      const overflowAgent = await client.beta.agents.create({
        ...MINIMAL_PARAMS,
        name: genName("10-1-12-overflow"),
        tools: overflowTools,
        metadata: tagWithRunId(),
      });
      trackAgent(overflowAgent.id, client);
      recorder.addNote("⚠ FINDING 候选:129 tools 仍接受(超出文档承诺 128)");
    } catch (err) {
      overflowStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`✓ overflow case:129 tools 被 reject,status=${overflowStatus}`);
    }
    recorder.addMetadata("overflow_status", overflowStatus);
  });

  /** 10.1.13 multiagent depth > 1 行为 — skip(需 research preview access)*/
  it.skip("10.1.13 multiagent depth > 1 (research preview)", async () => {
    // SKIP:multiagent 需要 research preview access。Phase 3 启用后再实施。
    // 期望验证:sub-agent 内声明 callable_agents → CMA reject 还是 silently drop
  });
});
