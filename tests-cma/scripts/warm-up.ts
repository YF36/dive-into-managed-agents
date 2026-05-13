#!/usr/bin/env tsx
/**
 * warm-up:创建 long-lived 共享资源,id 缓存到 .warmup.json。
 *
 *   - `test-agent`(无工具)—— 协议 / event schema / latency 基线
 *   - `test-probe-agent`(带 agent_toolset_20260401)—— vault / memory / perf
 *   - `test-environment`(共享 cloud env)
 *
 * 已存在 .warmup.json 时 skip,除非:
 *   - 显式 `--force` —— **先尝试 archive 旧资源,再 create 新**(L1 修复:
 *     之前直接覆盖 .warmup.json,旧资源永远漂在 workspace 里没人管)
 *   - 旧 cache 缺字段(例如老 cache 没 probe_agent_id)—— 增量补齐缺的
 */

import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, describeClient } from "../src/client.ts";
import {
  MINIMAL_AGENT_PARAMS,
  MINIMAL_PROBE_AGENT_PARAMS,
  type WarmupCache,
} from "../src/fixtures/agents.ts";
import { MINIMAL_ENVIRONMENT_PARAMS } from "../src/fixtures/environments.ts";

const __filename = fileURLToPath(import.meta.url);
const WARMUP_FILE = resolve(dirname(__filename), "../.warmup.json");

async function tryArchiveAgent(
  client: AnthropicAws,
  id: string | undefined,
  label: string,
): Promise<void> {
  if (!id) return;
  try {
    await client.beta.agents.archive(id);
    console.log(`  archived old ${label} ${id}`);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) {
      console.log(`  old ${label} ${id} already gone (404)`);
    } else {
      console.warn(`  archive old ${label} ${id} failed (status=${status}):`, err);
    }
  }
}

async function tryArchiveEnvironment(
  client: AnthropicAws,
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  try {
    await client.beta.environments.archive(id);
    console.log(`  archived old environment ${id}`);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) {
      console.log(`  old environment ${id} already gone (404)`);
    } else {
      console.warn(`  archive old environment ${id} failed (status=${status}):`, err);
    }
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  let cache: WarmupCache = {};

  if (existsSync(WARMUP_FILE)) {
    cache = JSON.parse(await readFile(WARMUP_FILE, "utf8")) as WarmupCache;
  }

  // L1 修复:--force 时先 archive 旧资源,再清 cache 重新 create。
  // 失败吞错(旧资源可能已被手动 archive / 跨 workspace 等)。
  if (force && (cache.agent_id || cache.probe_agent_id || cache.environment_id)) {
    console.log("[warmup] --force: archiving old resources before recreate ...");
    const client = getClient();
    await client.ready;
    await tryArchiveAgent(client, cache.agent_id, "test-agent");
    await tryArchiveAgent(client, cache.probe_agent_id, "test-probe-agent");
    await tryArchiveEnvironment(client, cache.environment_id);
    cache = {};
  }

  // 完整 cache 命中:skip
  const complete =
    !!cache.agent_id && !!cache.probe_agent_id && !!cache.environment_id;
  if (complete && !force) {
    console.log(`[warmup] cache already populated (endpoint=${cache.endpoint_description}):`);
    console.log(`  agent_id        = ${cache.agent_id}`);
    console.log(`  probe_agent_id  = ${cache.probe_agent_id}`);
    console.log(`  environment_id  = ${cache.environment_id}`);
    console.log(`  re-run with --force to archive+recreate`);
    return;
  }

  const client = getClient();
  await client.ready;
  console.log(`[warmup] endpoint=${describeClient()}`);

  if (!cache.agent_id) {
    console.log("[warmup] creating shared test-agent (no tools) ...");
    const agent = await client.beta.agents.create({ ...MINIMAL_AGENT_PARAMS });
    cache.agent_id = agent.id;
    cache.agent_created_at = agent.created_at;
    console.log(`  agent_id        = ${agent.id}`);
  }

  if (!cache.probe_agent_id) {
    console.log("[warmup] creating shared test-probe-agent (with toolset) ...");
    const probe = await client.beta.agents.create({ ...MINIMAL_PROBE_AGENT_PARAMS });
    cache.probe_agent_id = probe.id;
    cache.probe_agent_created_at = probe.created_at;
    console.log(`  probe_agent_id  = ${probe.id}`);
  }

  if (!cache.environment_id) {
    console.log("[warmup] creating shared test-environment ...");
    const env = await client.beta.environments.create({ ...MINIMAL_ENVIRONMENT_PARAMS });
    cache.environment_id = env.id;
    cache.environment_created_at = env.created_at;
    console.log(`  environment_id  = ${env.id}`);
  }

  cache.endpoint_description = describeClient();
  await writeFile(WARMUP_FILE, JSON.stringify(cache, null, 2), "utf8");
  console.log(`[warmup] cached to ${WARMUP_FILE}`);
}

main().catch((err) => {
  console.error("[warmup] failed:", err);
  process.exit(1);
});
