/**
 * Agent fixture。warmup 阶段创建一个 long-lived test-agent,id 写入 .warmup.json。
 * 测试代码通过 getSharedAgentId() 拿 id,不重复创建。
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
  environment_id?: string;
  agent_created_at?: string;
  environment_created_at?: string;
}

type AgentCreateParams = Parameters<AnthropicAws["beta"]["agents"]["create"]>[0];

export const MINIMAL_AGENT_PARAMS: AgentCreateParams = {
  name: "cma-test-agent",
  model: "claude-haiku-4-5",
  system:
    "你是一个用于自动化测试的最小 agent。简洁回答,不展开。除非测试代码明确要求,否则不使用工具。",
  description: "Long-lived test agent. Do not manually delete.",
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
