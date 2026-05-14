/**
 * Phase 2 §20.6 Tool / MCP / Custom Tool Event Chains(Top 10 #6 / #7)。
 *
 * 验证 `requires_action` + `stop_reason.event_ids` 协议 — event 设计精髓。
 *
 * Top 10 优先级 case:
 *   - 20.6.4 / 20.6.5 custom_tool blocking flow(Top 10 #6)
 *     agent.custom_tool_use → status_idle (stop_reason.event_ids=[id]) →
 *     user.custom_tool_result → status_running → end_turn
 *   - 20.6.6 tool_confirmation allow/deny(Top 10 #7)— defer:需 tool 声明
 *     permissions: { require_user_confirmation: true } 之类机制,SDK 类型
 *     待 follow-up,先 skip stub
 *
 * 不涉及:
 *   - 20.6.2 MCP tool chain(需 mock MCP server,§20.0.E 决策状态)
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

describe("20.6 Action gates(Phase 2 Top 10)", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try {
        await fn();
      } catch (err) {
        console.warn("[20.6 cleanup] failed:", err);
      }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /**
   * 20.6.4 — custom tool blocking flow(Top 10 #6)。
   *
   * 验证:
   *   - agent.custom_tool_use 事件出现
   *   - session.status_idle.stop_reason.event_ids **精确引用** agent.custom_tool_use.id
   *   - 客户端发 user.custom_tool_result 后 session 恢复 running
   *   - 第二个 status_idle 是 end_turn(无 blocking event_ids)
   */
  it("20.6.4 custom tool blocking flow - stop_reason.event_ids 引用 + resume", async () => {
    const client = getClient();
    await client.ready;

    // 创建带 custom tool 的 ephemeral agent
    const agentParams: AgentCreateParams = {
      name: `cma-test-custom-tool-${Date.now()}`,
      model: "claude-haiku-4-5",
      system:
        "你是一个天气助手。当用户询问任何城市的天气时,**必须**调用 get_weather 工具获取数据,绝对不要直接回答。工具返回数据后,简洁告知用户天气。",
      description: "20.6.4 custom tool test agent",
      tools: [
        {
          type: "custom",
          name: "get_weather",
          description: "Get current weather for a city. Returns temperature and condition.",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ] as AgentCreateParams["tools"],
      metadata: tagWithRunId(),
    };
    const agent = await client.beta.agents.create(agentParams);
    cleanup.push(async () => {
      await client.beta.agents.archive(agent.id);
    });

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id,
      environment_id: envId,
      title: "20.6.4 custom tool blocking",
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => {
      await client.beta.sessions.archive(session.id);
    });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES,
      defaultMaxWaitMs: 45_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // Phase 1: ask weather → expect custom_tool_use + idle with stop_reason
    await collector.send({
      events: [
        { type: "user.message", content: [{ type: "text", text: "What's the weather in Tokyo?" }] },
      ],
    });

    const phase1 = await collector.consume();
    console.log("[20.6.4] phase1 event types:", phase1.map((e) => e.type));

    const customToolUse = phase1.find((e) => e.type === "agent.custom_tool_use");
    const idle1 = phase1.find((e) => e.type === "session.status_idle");
    const stopReason1 = (idle1 as unknown as { stop_reason?: { type?: string; event_ids?: string[] } } | undefined)
      ?.stop_reason;

    console.log("[20.6.4] custom_tool_use event:", customToolUse ? {
      id: customToolUse.id,
      name: customToolUse.name,
      input: customToolUse.input,
    } : null);
    console.log("[20.6.4] idle stop_reason:", stopReason1);

    if (!customToolUse) {
      // model 可能没用 tool — 记录 + soft-skip
      console.log("[20.6.4] ⚠ model 没调用 custom tool,phase1 直接到 idle。可能 prompt 不够强或 model 选择直接回答");
      console.log("[20.6.4] phase1 全部事件:", phase1.map((e) => ({ type: e.type, id: e.id })));

      // 仍然 dump corpus + 不强制 assertion
      const snap = await collector.finalize();
      await dumpCorpus("custom-tool-no-invocation", snap, {
        description:
          "20.6.4 异常情况:model 没调用 declared custom tool,直接 end_turn。可能是 prompt 不够 deterministic。",
        additionalMeta: {
          case: "20.6.4",
          phase1_types: phase1.map((e) => e.type),
        },
      });
      // 不强制 fail —— 这是协议研究,记录现象
      console.warn("[20.6.4] skipping protocol assertions due to model non-invocation");
      return;
    }

    // 关键断言:stop_reason.event_ids 引用 custom_tool_use.id
    expect(stopReason1?.type).toBe("requires_action");
    expect(stopReason1?.event_ids).toBeDefined();
    expect(stopReason1?.event_ids).toContain(customToolUse.id);

    // Phase 2: send user.custom_tool_result → expect resume → final idle
    const toolUseId = customToolUse.id as string;
    await collector.send({
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: toolUseId,
          content: [
            { type: "text", text: '{"temp_celsius": 22, "condition": "sunny", "city": "Tokyo"}' },
          ],
        },
      ] as Parameters<typeof collector.send>[0]["events"],
    });

    const phase2 = await collector.consume();
    console.log("[20.6.4] phase2 event types:", phase2.map((e) => e.type));

    const idle2 = phase2.find((e) => e.type === "session.status_idle");
    const stopReason2 = (idle2 as unknown as { stop_reason?: { type?: string; event_ids?: string[] } } | undefined)
      ?.stop_reason;
    console.log("[20.6.4] final idle stop_reason:", stopReason2);

    // 关键断言:第二个 idle 是 end_turn(非 requires_action)
    expect(stopReason2?.type).toBe("end_turn");

    const snapshot = await collector.finalize();

    const dump = await dumpCorpus("custom-tool-blocking-flow", snapshot, {
      description:
        "Top 10 #6 / §20.6.4 — custom tool blocking flow:agent.custom_tool_use → status_idle (stop_reason.type=requires_action, event_ids=[X]) → user.custom_tool_result → status_running → status_idle (end_turn)。验证 protocol-level cause_event_id 雏形:stop_reason.event_ids 精确引用 blocking event.id。",
      additionalMeta: {
        case: "20.6.4",
        top10: "#6",
        agent_id: agent.id,
        custom_tool_use_id: toolUseId,
        stop_reason1: stopReason1,
        stop_reason2: stopReason2,
        phase1_event_types: phase1.map((e) => e.type),
        phase2_event_types: phase2.map((e) => e.type),
      },
    });
    console.log("[20.6.4] corpus:", dump.corpusDir);
  }, 120_000);

  /**
   * 20.6.6 — tool_confirmation allow path — Top 10 #7。
   *
   * 触发机制(2026-05-14 SDK 类型详查找到):
   *   agent_toolset_20260401 的 default_config.permission_policy = "always_ask"
   *   → server emit agent.tool_use with evaluated_permission='ask'
   *   → session.status_idle.stop_reason.event_ids = [tool_use.id]
   *   → client send user.tool_confirmation { result, tool_use_id, deny_message? }
   *   → resume
   */
  it("20.6.6a tool_confirmation allow path - 'ask' policy + client allow → resume", async () => {
    const client = getClient();
    await client.ready;

    const agentParams: AgentCreateParams = {
      name: `cma-test-tool-conf-allow-${Date.now()}`,
      model: "claude-haiku-4-5",
      system:
        "你是一个 shell 助手。当用户让你执行 shell 命令时,**必须**调用 bash 工具。简洁执行,不解释。",
      description: "20.6.6a tool_confirmation allow agent",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_ask" },
          },
        },
      ] as AgentCreateParams["tools"],
      metadata: tagWithRunId(),
    };
    const agent = await client.beta.agents.create(agentParams);
    cleanup.push(async () => {
      await client.beta.agents.archive(agent.id);
    });

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id,
      environment_id: envId,
      title: "20.6.6a confirmation allow",
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => {
      await client.beta.sessions.archive(session.id);
    });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES,
      defaultMaxWaitMs: 45_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    // Phase 1:prompt for bash use → expect ask gate
    await collector.send({
      events: [
        { type: "user.message", content: [{ type: "text", text: "Please run: echo hello-world" }] },
      ],
    });
    const phase1 = await collector.consume();
    console.log("[20.6.6a] phase1 event types:", phase1.map((e) => e.type));

    const toolUse = phase1.find((e) => e.type === "agent.tool_use");
    const idle1 = phase1.find((e) => e.type === "session.status_idle");
    const stopReason1 = (idle1 as unknown as { stop_reason?: { type?: string; event_ids?: string[] } } | undefined)?.stop_reason;
    const evaluatedPermission = (toolUse as unknown as { evaluated_permission?: string } | undefined)?.evaluated_permission;

    console.log("[20.6.6a] tool_use event:", toolUse ? {
      id: toolUse.id,
      name: toolUse.name,
      evaluated_permission: evaluatedPermission,
    } : null);
    console.log("[20.6.6a] idle stop_reason:", stopReason1);

    if (!toolUse) {
      console.log("[20.6.6a] ⚠ model 没调用 tool,跳过 protocol assertions");
      const snap = await collector.finalize();
      await dumpCorpus("tool-confirmation-allow-no-tool-call", snap, {
        description: "20.6.6a allow 模式但 model 没调 bash;corpus 用于 debug",
        additionalMeta: { case: "20.6.6a", phase1_types: phase1.map((e) => e.type) },
      });
      return;
    }

    // 关键断言:tool_use 携 evaluated_permission='ask'
    expect(evaluatedPermission).toBe("ask");
    expect(stopReason1?.type).toBe("requires_action");
    expect(stopReason1?.event_ids).toContain(toolUse.id);

    // Phase 2:client allow → resume
    const toolUseId = toolUse.id as string;
    await collector.send({
      events: [
        { type: "user.tool_confirmation", tool_use_id: toolUseId, result: "allow" },
      ] as Parameters<typeof collector.send>[0]["events"],
    });
    const phase2 = await collector.consume();
    console.log("[20.6.6a] phase2 event types:", phase2.map((e) => e.type));

    const idle2 = phase2.find((e) => e.type === "session.status_idle");
    const stopReason2 = (idle2 as unknown as { stop_reason?: { type?: string } } | undefined)?.stop_reason;
    console.log("[20.6.6a] final stop_reason:", stopReason2);

    // tool_result 应在 phase2 出现(allow 后 server 执行 bash)
    const toolResult = phase2.find((e) => e.type === "agent.tool_result");
    console.log("[20.6.6a] saw agent.tool_result?", !!toolResult);

    expect(stopReason2?.type).toBe("end_turn");

    const snapshot = await collector.finalize();
    const dump = await dumpCorpus("tool-confirmation-allow", snapshot, {
      description:
        "Top 10 #7 / §20.6.6a — tool_confirmation allow path:agent_toolset_20260401 + permission_policy=always_ask → agent.tool_use{evaluated_permission:'ask'} → status_idle{requires_action, event_ids:[X]} → user.tool_confirmation{result:'allow'} → server 执行 tool → tool_result → end_turn",
      additionalMeta: {
        case: "20.6.6a",
        top10: "#7",
        tool_use_id: toolUseId,
        evaluated_permission: evaluatedPermission,
        stop_reason1: stopReason1,
        stop_reason2: stopReason2,
        saw_tool_result: !!toolResult,
      },
    });
    console.log("[20.6.6a] corpus:", dump.corpusDir);
  }, 120_000);

  /**
   * 20.6.6b tool_confirmation deny path — 客户端拒绝,agent 应优雅终止 turn。
   */
  it("20.6.6b tool_confirmation deny path - 'ask' policy + client deny → agent reacts", async () => {
    const client = getClient();
    await client.ready;

    const agent = await client.beta.agents.create({
      name: `cma-test-tool-conf-deny-${Date.now()}`,
      model: "claude-haiku-4-5",
      system:
        "你是一个 shell 助手。当用户让你执行 shell 命令时,**必须**调用 bash 工具。简洁执行,不解释。",
      description: "20.6.6b tool_confirmation deny agent",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_ask" },
          },
        },
      ] as AgentCreateParams["tools"],
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => {
      await client.beta.agents.archive(agent.id);
    });

    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agent.id,
      environment_id: envId,
      title: "20.6.6b confirmation deny",
      metadata: tagWithRunId(),
    });
    cleanup.push(async () => {
      await client.beta.sessions.archive(session.id);
    });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES,
      defaultMaxWaitMs: 45_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [
        { type: "user.message", content: [{ type: "text", text: "Please run: echo hello-world" }] },
      ],
    });
    const phase1 = await collector.consume();
    const toolUse = phase1.find((e) => e.type === "agent.tool_use");
    if (!toolUse) {
      console.log("[20.6.6b] ⚠ model 没调用 tool,skip");
      await collector.finalize();
      return;
    }

    // Deny
    const toolUseId = toolUse.id as string;
    await collector.send({
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: toolUseId,
          result: "deny",
          deny_message: "用户取消了该操作,不要再尝试。",
        },
      ] as Parameters<typeof collector.send>[0]["events"],
    });
    const phase2 = await collector.consume();
    console.log("[20.6.6b] phase2 event types:", phase2.map((e) => e.type));

    const idle2 = phase2.find((e) => e.type === "session.status_idle");
    const stopReason2 = (idle2 as unknown as { stop_reason?: { type?: string } } | undefined)?.stop_reason;
    console.log("[20.6.6b] final stop_reason:", stopReason2);

    const toolResult = phase2.find((e) => e.type === "agent.tool_result");
    console.log("[20.6.6b] saw agent.tool_result(应该 NO 因为 denied)?", !!toolResult);

    const agentReply = phase2.find((e) => e.type === "agent.message");
    console.log("[20.6.6b] saw agent.message after deny?", !!agentReply);

    // turn 应 end(可能 end_turn,可能 agent 再调一次 tool — 取决于 system prompt)
    expect(stopReason2).toBeDefined();

    const snapshot = await collector.finalize();
    const dump = await dumpCorpus("tool-confirmation-deny", snapshot, {
      description:
        "Top 10 #7 / §20.6.6b — tool_confirmation deny path:client send user.tool_confirmation{result:'deny', deny_message}。验证 agent 如何反应(优雅 end_turn / 重试 / abort)。",
      additionalMeta: {
        case: "20.6.6b",
        top10: "#7",
        tool_use_id: toolUseId,
        stop_reason2: stopReason2,
        saw_tool_result_after_deny: !!toolResult,
        saw_agent_message_after_deny: !!agentReply,
      },
    });
    console.log("[20.6.6b] corpus:", dump.corpusDir);
  }, 120_000);
});
