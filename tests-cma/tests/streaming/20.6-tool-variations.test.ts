/**
 * Phase 2.5 Batch B — §20.6 tool variations(20.6.1 / 20.6.5 / 20.6.7 / 20.6.8)。
 *
 * - 20.6.1 built-in tool always_allow happy chain — 跟 20.6.6a always_ask 对比
 * - 20.6.5 partial resolve — agent w/ 2 custom tools,prompt for both,只 resolve 1
 * - 20.6.7 stale tool_use_id — turn 结束后 send confirmation,error 码
 * - 20.6.8 bogus custom_tool_use_id — 完全错的 id,error 码
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

const STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
];

describe("20.6 tool variations(Phase 2.5 Batch B)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 20.6.1 built-in tool always_allow happy chain(对比 F-0020 always_ask)*/
  it("20.6.1 built-in tool always_allow happy - 无 gate,直接执行", async () => {
    const client = getClient();
    await client.ready;

    const agent = await client.beta.agents.create({
      name: `cma-test-bash-allow-${Date.now()}`,
      model: "claude-haiku-4-5",
      system: "你是 shell 助手,当用户让你跑命令时**必须**用 bash 工具。",
      description: "20.6.1 always_allow",
      tools: [{
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
      }] as AgentCreateParams["tools"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(agent.id); });

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id, environment_id: envId, title: "20.6.1", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES, defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{ type: "user.message", content: [{ type: "text", text: "Please run: echo allow-path-test" }] }],
    });
    const events = await collector.consume();
    const snapshot = await collector.finalize();

    const toolUse = events.find((e) => e.type === "agent.tool_use");
    const toolResult = events.find((e) => e.type === "agent.tool_result");
    const idleEvents = events.filter((e) => e.type === "session.status_idle");
    const stopReasons = idleEvents.map((e) => (e as unknown as { stop_reason?: { type?: string } }).stop_reason);
    const evaluatedPermission = (toolUse as unknown as { evaluated_permission?: string } | undefined)?.evaluated_permission;

    console.log("[20.6.1] event types:", events.map((e) => e.type));
    console.log("[20.6.1] tool_use evaluated_permission:", evaluatedPermission);
    console.log("[20.6.1] tool_result present:", !!toolResult);
    console.log("[20.6.1] stop_reasons:", stopReasons);

    expect(toolUse).toBeDefined();
    expect(evaluatedPermission).toBe("allow");
    expect(toolResult).toBeDefined();
    // 关键:无中间 requires_action idle — 一气呵成 end_turn
    const requiresActionCount = stopReasons.filter((sr) => sr?.type === "requires_action").length;
    expect(requiresActionCount).toBe(0);
    expect(stopReasons.some((sr) => sr?.type === "end_turn")).toBe(true);

    await dumpCorpus("tool-always-allow-happy", snapshot, {
      description: "Batch B / §20.6.1 — built-in tool always_allow 无 gate happy chain;evaluated_permission='allow',无 requires_action idle",
      additionalMeta: { case: "20.6.1", evaluated_permission: evaluatedPermission, requires_action_idle_count: requiresActionCount, end_turn: stopReasons.some((sr) => sr?.type === "end_turn") },
    });
  }, 90_000);

  /** 20.6.5 partial resolve — 2 custom tools 同 turn,只 resolve 1 */
  it("20.6.5 partial resolve - agent 同 turn 调 2 custom tools,只回复 1 个", async () => {
    const client = getClient();
    await client.ready;

    const agent = await client.beta.agents.create({
      name: `cma-test-partial-${Date.now()}`,
      model: "claude-haiku-4-5",
      system: "你是查询助手。当用户同时问天气和时间时,**必须**调用 get_weather 和 get_time 两个工具并行查询。",
      description: "20.6.5 partial resolve",
      tools: [
        {
          type: "custom",
          name: "get_weather",
          description: "查城市天气",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
        {
          type: "custom",
          name: "get_time",
          description: "查城市当前时间",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ] as AgentCreateParams["tools"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(agent.id); });

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id, environment_id: envId, title: "20.6.5", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES, defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{ type: "user.message", content: [{ type: "text", text: "请告诉我东京的天气和时间。" }] }],
    });
    const phase1 = await collector.consume();
    console.log("[20.6.5] phase1 event types:", phase1.map((e) => e.type));

    const customToolUses = phase1.filter((e) => e.type === "agent.custom_tool_use");
    console.log("[20.6.5] 同 turn 调用的 custom tool 数:", customToolUses.length);
    if (customToolUses.length < 2) {
      console.log("[20.6.5] ⚠ model 没并行调 2 个 tools,partial resolve 不可测;skip");
      const snap = await collector.finalize();
      await dumpCorpus("partial-resolve-no-multi-tool", snap, {
        description: "Batch B / §20.6.5 — model 没并行调用 2 个 custom tools(只调 1 个或 sequential),partial resolve 协议本 case 不可测",
        additionalMeta: { case: "20.6.5", custom_tool_uses_count: customToolUses.length },
      });
      return;
    }

    const idle1 = phase1.find((e) => e.type === "session.status_idle");
    const stopReason1 = (idle1 as unknown as { stop_reason?: { type?: string; event_ids?: string[] } } | undefined)?.stop_reason;
    console.log("[20.6.5] phase1 idle stop_reason:", stopReason1);
    console.log("[20.6.5] event_ids length:", stopReason1?.event_ids?.length);

    expect(stopReason1?.type).toBe("requires_action");
    expect(stopReason1?.event_ids?.length).toBeGreaterThanOrEqual(2);

    // Partial resolve:只回复第一个 tool
    const firstToolUseId = customToolUses[0]!.id as string;
    const secondToolUseId = customToolUses[1]!.id as string;
    await collector.send({
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: firstToolUseId,
        content: [{ type: "text", text: '{"answer":"first tool result"}' }],
      }] as Parameters<typeof collector.send>[0]["events"],
    });

    // Consume:期望 session 仍 idle,等剩余 tool_use_id
    const phase2 = await collector.consume({ maxWaitMs: 8000 });
    console.log("[20.6.5] phase2 event types:", phase2.map((e) => e.type));

    const idle2 = phase2.find((e) => e.type === "session.status_idle");
    const stopReason2 = (idle2 as unknown as { stop_reason?: { type?: string; event_ids?: string[] } } | undefined)?.stop_reason;
    console.log("[20.6.5] phase2 idle stop_reason:", stopReason2);

    // 现在补 resolve 第二个
    await collector.send({
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: secondToolUseId,
        content: [{ type: "text", text: '{"answer":"second tool result"}' }],
      }] as Parameters<typeof collector.send>[0]["events"],
    });

    const phase3 = await collector.consume({ maxWaitMs: 30000 });
    console.log("[20.6.5] phase3 event types:", phase3.map((e) => e.type));

    const idle3 = phase3.find((e) => e.type === "session.status_idle");
    const stopReason3 = (idle3 as unknown as { stop_reason?: { type?: string } } | undefined)?.stop_reason;
    console.log("[20.6.5] phase3 final stop_reason:", stopReason3);

    const snapshot = await collector.finalize();
    await dumpCorpus("partial-resolve-2-custom-tools", snapshot, {
      description: "Batch B / §20.6.5 — partial resolve:agent 同 turn 调 2 custom_tools,client 先 resolve 第一个,观察 server 是否保持 idle 等第二个;再 resolve 第二个,期望 end_turn",
      additionalMeta: {
        case: "20.6.5",
        custom_tool_uses_count: customToolUses.length,
        stop_reason1: stopReason1,
        stop_reason2: stopReason2,
        stop_reason3: stopReason3,
      },
    });
  }, 180_000);

  /** 20.6.7 stale tool_use_id — turn 结束后 send confirmation */
  it("20.6.7 stale tool_use_id - turn done 后送 user.custom_tool_result 错误码", async () => {
    const client = getClient();
    await client.ready;

    const agent = await client.beta.agents.create({
      name: `cma-test-stale-${Date.now()}`,
      model: "claude-haiku-4-5",
      system: "查天气工具助手。",
      description: "20.6.7 stale id",
      tools: [{
        type: "custom",
        name: "get_weather",
        description: "...",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      }] as AgentCreateParams["tools"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.agents.archive(agent.id); });

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id, environment_id: envId, title: "20.6.7", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES, defaultMaxWaitMs: 30_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{ type: "user.message", content: [{ type: "text", text: "查 Tokyo 天气" }] }],
    });
    const phase1 = await collector.consume();
    const toolUse = phase1.find((e) => e.type === "agent.custom_tool_use");
    if (!toolUse) {
      console.log("[20.6.7] ⚠ 没调用 tool,skip");
      await collector.finalize();
      return;
    }

    // 正常 resolve 完成 turn
    const toolUseId = toolUse.id as string;
    await collector.send({
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseId,
        content: [{ type: "text", text: '{"temp": 22}' }],
      }] as Parameters<typeof collector.send>[0]["events"],
    });
    await collector.consume();

    // Now turn 已 end_turn;再 send 同 tool_use_id 应 reject
    let errStatus: number | undefined;
    let errType: string | undefined;
    let errMessage: string | undefined;
    try {
      await collector.send({
        events: [{
          type: "user.custom_tool_result",
          custom_tool_use_id: toolUseId,
          content: [{ type: "text", text: '{"temp": 25}' }],
        }] as Parameters<typeof collector.send>[0]["events"],
      });
      console.log("[20.6.7] ⚠ FINDING:stale tool_use_id 仍接受!");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string; message?: string } } } | null;
      errStatus = e?.status;
      errType = e?.error?.error?.type;
      errMessage = e?.error?.error?.message;
      console.log("[20.6.7] stale id reject:", "status=", errStatus, "type=", errType, "msg=", errMessage);
    }

    const snapshot = await collector.finalize();
    await dumpCorpus("stale-tool-use-id", snapshot, {
      description: "Batch B / §20.6.7 — turn end 后 send user.custom_tool_result with 过期 tool_use_id,期望错误码",
      additionalMeta: { case: "20.6.7", error_status: errStatus, error_type: errType, error_message: errMessage },
    });
  }, 90_000);

  /** 20.6.8 bogus custom_tool_use_id — 完全错的 id */
  it("20.6.8 bogus custom_tool_use_id - 完全不存在的 id 错误码", async () => {
    const client = getClient();
    await client.ready;

    const envId = await getSharedEnvironmentId();
    // Reuse shared agent(no tool 需要,只测 reject)
    const { getSharedAgentId } = await import("../../src/fixtures/agents.ts");
    const agentId = await getSharedAgentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, title: "20.6.8", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // 直接发 user.custom_tool_result with bogus id
    let errStatus: number | undefined;
    let errType: string | undefined;
    let errMessage: string | undefined;
    try {
      await client.beta.sessions.events.send(session.id, {
        events: [{
          type: "user.custom_tool_result",
          custom_tool_use_id: "sevt_bogusneverexisted000000",
          content: [{ type: "text", text: '{"answer": "x"}' }],
        }] as Parameters<typeof client.beta.sessions.events.send>[1]["events"],
      });
      console.log("[20.6.8] ⚠ FINDING:bogus tool_use_id 接受");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string; message?: string } } } | null;
      errStatus = e?.status;
      errType = e?.error?.error?.type;
      errMessage = e?.error?.error?.message;
      console.log("[20.6.8] bogus id reject:", "status=", errStatus, "type=", errType, "msg=", errMessage);
    }
    expect(errStatus).toBeDefined();
  }, 60_000);
});
