/**
 * Agent fixture。warmup 阶段创建两个 long-lived agent:
 *   - `MINIMAL_AGENT_PARAMS`(无工具)—— 给协议探测 / event schema / latency 基线用
 *   - `MINIMAL_PROBE_AGENT_PARAMS`(带 agent_toolset_20260401)—— 给 vault / memory /
 *     perf 用例用,这些场景需要让 agent 跑 bash/file/curl 等工具
 *
 * 两个 agent id 都缓存到 `.warmup.json`,测试代码通过 `getSharedAgentId()` /
 * `getProbeAgentId()` 拿 id,不重复创建。
 *
 * Phase 0 review M3 修复:之前只有一个 minimal agent,vault/memory/perf 用例
 * 依赖工具但 minimal agent 无 toolset,导致 Phase 1+ 用例无法跑。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, tagWithRunId } from "../client.ts";

const __filename = fileURLToPath(import.meta.url);
const WARMUP_FILE = resolve(dirname(__filename), "../../.warmup.json");

export interface WarmupCache {
  agent_id?: string;
  probe_agent_id?: string;
  environment_id?: string;
  agent_created_at?: string;
  probe_agent_created_at?: string;
  environment_created_at?: string;
  endpoint_description?: string;
}

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];
type AgentTool = NonNullable<AgentCreateParams["tools"]>[number];

/**
 * 无工具的 minimal agent。给协议探测 / latency 基线 / event schema 校验用。
 * **不要**给这个 agent 发"跑 bash"的请求——它没工具,会 reject 或纯文本回答。
 */
export const MINIMAL_AGENT_PARAMS: AgentCreateParams = {
  name: "cma-test-agent",
  model: "claude-haiku-4-5",
  system:
    "你是一个用于自动化测试的最小 agent。简洁回答,不展开。除非测试代码明确要求,否则不使用工具。",
  description: "Long-lived test agent (no tools). Do not manually delete.",
};

/**
 * Probe agent:带 agent_toolset_20260401(bash / file ops / shell),
 * 给 vault / memory / perf 用例用。Phase 1+ 启用。
 *
 * 工具集详见 30-vault-credentials.md §30.1 / 40-multi-agent-memory-outcomes.md §40.2 /
 * 50-performance.md §50.2 的具体用例。
 */
const PROBE_TOOLSET: AgentTool = {
  type: "agent_toolset_20260401",
} as AgentTool;

export const MINIMAL_PROBE_AGENT_PARAMS: AgentCreateParams = {
  name: "cma-test-probe-agent",
  model: "claude-haiku-4-5",
  system:
    "你是一个用于自动化测试的探针 agent,会被要求跑特定 shell 命令 / 读写 memory 文件 / 调 MCP 工具。简洁执行,不展开。",
  description: "Long-lived probe agent (with toolset). Do not manually delete.",
  tools: [PROBE_TOOLSET],
};

export async function loadWarmupCache(): Promise<WarmupCache> {
  if (!existsSync(WARMUP_FILE)) return {};
  const raw = await readFile(WARMUP_FILE, "utf8");
  return JSON.parse(raw) as WarmupCache;
}

export async function getSharedAgentId(): Promise<string> {
  const cache = await loadWarmupCache();
  if (!cache.agent_id) {
    throw new Error(
      "No test agent id cached. Run `npm run warmup` first to create the shared agent.",
    );
  }
  return cache.agent_id;
}

/**
 * 拿 probe agent id(带工具,Phase 1+ vault/memory/perf 用例用)。
 * 若 warmup 没建 probe agent(老 .warmup.json),抛错提示重跑 warmup。
 */
export async function getProbeAgentId(): Promise<string> {
  const cache = await loadWarmupCache();
  if (!cache.probe_agent_id) {
    throw new Error(
      "No probe agent id cached. Run `npm run warmup` to create both agents (`--force` if old cache lacks probe_agent_id).",
    );
  }
  return cache.probe_agent_id;
}

/**
 * 创建一个 ephemeral agent(测试需要全新 agent 时用)。
 * metadata 自动打 test_run_id,cleanup 时一并 archive。
 */
export async function createEphemeralAgent(overrides: Partial<AgentCreateParams> = {}) {
  const client = getClient();
  return await client.beta.agents.create({
    ...MINIMAL_AGENT_PARAMS,
    ...overrides,
    metadata: tagWithRunId(),
  });
}
