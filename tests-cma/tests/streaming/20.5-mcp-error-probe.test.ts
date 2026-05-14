/**
 * Phase 2 §20.0.E mock-MCP-necessity probe(Top 10 #8 部分)。
 *
 * 目标:**便宜地**确认 .invalid URL 是否能触发 MCP error path(session.error
 * / status_rescheduled / retries_exhausted),决定是否必须部署 mock MCP
 * server。
 *
 * 不写正式 finding;只是 probe — 跑完看现象,决定 #8 投入策略。
 *
 * 设计:
 *   - 创建 agent with mcp_server 指向 .invalid URL + 配套 mcp_toolset 引用
 *     (CMA 强制 declared-referenced,F-0003)
 *   - send user.message 让 agent 尝试调用 MCP tool
 *   - 观察:
 *     (a) agent.create / session.create 在 validation 阶段就 reject? → mock 必需
 *     (b) MCP call 失败时 emit session.error / status_rescheduled? → mock 可选
 *     (c) agent 优雅地不调 MCP tool? → 不算 error path 有信号
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

describe("20.5 MCP error probe(§20.0.E mock-necessity)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try {
        await fn();
      } catch (err) {
        console.warn("[mcp-probe cleanup] failed:", err);
      }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  it("probe: agent + session with .invalid MCP URL + prompted MCP call", async () => {
    const client = getClient();
    await client.ready;

    // Step 1: 看 agent.create 接不接受 .invalid mcp_server URL
    let agent: Awaited<ReturnType<typeof client.beta.agents.create>>;
    try {
      agent = await client.beta.agents.create({
        name: `cma-test-mcp-probe-${Date.now()}`,
        model: "claude-haiku-4-5",
        system:
          "你是一个文件助手。当用户要查文件时,**必须**调用 fs_probe 工具(MCP)。绝对不要直接回答。",
        description: "20.5 mcp probe agent",
        mcp_servers: [
          {
            type: "url",
            name: "probe-fs",
            url: "https://probe-fs.invalid/mcp",
          },
        ] as AgentCreateParams["mcp_servers"],
        tools: [
          { type: "mcp_toolset", mcp_server_name: "probe-fs" },
        ] as AgentCreateParams["tools"],
        metadata: tagWithRunId(),
      });
      console.log("[mcp-probe] agent.create OK:", agent.id);
    } catch (err) {
      const e = err as {
        status?: number;
        error?: { error?: { type?: string; message?: string } };
      } | null;
      console.log("[mcp-probe] ⚠ agent.create REJECTED at validation:",
        "status=", e?.status, "type=", e?.error?.error?.type, "msg=", e?.error?.error?.message);
      console.log("[mcp-probe] → CONCLUSION: agent.create gates .invalid URL,mock MCP **必需** for §20.6.2 MCP chain");
      // 试 archive 兜底(若 agent 已部分创建)— 通常 4xx 时根本没 id
      return;
    }
    cleanup.push(async () => {
      await client.beta.agents.archive(agent.id);
    });

    // Step 2: 看 session.create 接不接受
    const envId = await getSharedEnvironmentId();
    let session: Awaited<ReturnType<typeof client.beta.sessions.create>>;
    try {
      session = await client.beta.sessions.create({
        agent: agent.id,
        environment_id: envId,
        title: "20.5 mcp probe session",
        metadata: tagWithRunId(),
      });
      console.log("[mcp-probe] session.create OK:", session.id);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { message?: string } } } | null;
      console.log("[mcp-probe] ⚠ session.create REJECTED:", "status=", e?.status, "msg=", e?.error?.error?.message);
      console.log("[mcp-probe] → agent OK but session creation gates 上 .invalid mcp,mock 必需");
      return;
    }
    cleanup.push(async () => {
      await client.beta.sessions.archive(session.id);
    });

    // Step 3: send + consume + 观察 error path 触发
    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: [
        "session.status_idle",
        "session.error",
        "session.status_terminated",
      ],
      defaultMaxWaitMs: 60_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Please list files in /tmp using the fs_probe tool." }],
        },
      ],
    });

    const events = await collector.consume();
    const snapshot = await collector.finalize();

    console.log("[mcp-probe] event sequence:", events.map((e) => e.type));

    const sawError = events.some((e) => e.type === "session.error");
    const sawRescheduled = events.some((e) => e.type === "session.status_rescheduled");
    const sawMcpToolUse = events.some((e) => e.type === "agent.mcp_tool_use");
    const sawMcpToolResult = events.some((e) => e.type === "agent.mcp_tool_result");
    const finalIdle = events.find((e) => e.type === "session.status_idle");
    const stopReason = (finalIdle as unknown as { stop_reason?: unknown } | undefined)?.stop_reason;

    console.log("[mcp-probe] sawError:", sawError);
    console.log("[mcp-probe] sawRescheduled:", sawRescheduled);
    console.log("[mcp-probe] sawMcpToolUse:", sawMcpToolUse);
    console.log("[mcp-probe] sawMcpToolResult:", sawMcpToolResult);
    console.log("[mcp-probe] final stop_reason:", JSON.stringify(stopReason));

    // 结论性 logging — 给 §20.0.E mock-MCP 必要性决策用
    if (sawError) {
      console.log("[mcp-probe] **结论 A**:session.error 自然触发(MCP unreachable 走 error path)— mock MCP **可选** for §20.5.6");
    } else if (sawRescheduled) {
      console.log("[mcp-probe] **结论 B**:status_rescheduled 自然触发 — mock MCP **可选** for §20.5.4");
    } else if (sawMcpToolUse && !sawMcpToolResult) {
      console.log("[mcp-probe] **结论 C**:agent 调用 MCP tool 但无 tool_result(hang?error 在内部?)— 需要更详细看 raw 数据");
    } else if (!sawMcpToolUse) {
      console.log("[mcp-probe] **结论 D**:agent 完全没尝试 MCP tool(可能因为 server unreachable 而 silently fall back)— 不在 protocol level expose 错误,mock **必需** for §20.5.6/4 真正测 error path");
    } else {
      console.log("[mcp-probe] **结论 E**:意外路径,需要进 corpus 详查");
    }

    await dumpCorpus("mcp-error-probe-invalid-url", snapshot, {
      description:
        "§20.0.E mock-MCP-necessity probe — .invalid URL 是否能触发 MCP error path(session.error / status_rescheduled)。结论决定是否必须投入 mock MCP server 部署。",
      additionalMeta: {
        case: "20.5/20.6 probe",
        sawError,
        sawRescheduled,
        sawMcpToolUse,
        sawMcpToolResult,
        final_stop_reason: stopReason,
        event_sequence: events.map((e) => e.type),
      },
    });

    // 不强制 assertion — probe 是探测,结果都有价值
    expect(events.length).toBeGreaterThan(0);
  }, 120_000);
});
