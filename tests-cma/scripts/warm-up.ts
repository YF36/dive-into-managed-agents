#!/usr/bin/env tsx
/**
 * warm-up:创建 long-lived test-agent / test-environment,id 缓存到 .warmup.json。
 *
 * 已存在 .warmup.json 时 skip(除非显式 --force)。
 */

import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getClient, describeClient } from "../src/client.ts";
import { MINIMAL_AGENT_PARAMS } from "../src/fixtures/agents.ts";
import { MINIMAL_ENVIRONMENT_PARAMS } from "../src/fixtures/environments.ts";

const __filename = fileURLToPath(import.meta.url);
const WARMUP_FILE = resolve(dirname(__filename), "../.warmup.json");

interface WarmupCache {
  agent_id?: string;
  environment_id?: string;
  agent_created_at?: string;
  environment_created_at?: string;
  endpoint_description?: string;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  let cache: WarmupCache = {};

  if (existsSync(WARMUP_FILE) && !force) {
    cache = JSON.parse(await readFile(WARMUP_FILE, "utf8")) as WarmupCache;
    if (cache.agent_id && cache.environment_id) {
      console.log(`[warmup] cache already populated (endpoint=${cache.endpoint_description}):`);
      console.log(`  agent_id       = ${cache.agent_id}`);
      console.log(`  environment_id = ${cache.environment_id}`);
      console.log(`  re-run with --force to recreate`);
      return;
    }
  }

  const client = getClient();
  await client.ready;
  console.log(`[warmup] endpoint=${describeClient()}`);

  if (!cache.agent_id) {
    console.log("[warmup] creating shared test-agent ...");
    const agent = await client.beta.agents.create({ ...MINIMAL_AGENT_PARAMS });
    cache.agent_id = agent.id;
    cache.agent_created_at = agent.created_at;
    console.log(`  agent_id = ${agent.id}`);
  }

  if (!cache.environment_id) {
    console.log("[warmup] creating shared test-environment ...");
    const env = await client.beta.environments.create({ ...MINIMAL_ENVIRONMENT_PARAMS });
    cache.environment_id = env.id;
    cache.environment_created_at = env.created_at;
    console.log(`  environment_id = ${env.id}`);
  }

  cache.endpoint_description = describeClient();
  await writeFile(WARMUP_FILE, JSON.stringify(cache, null, 2), "utf8");
  console.log(`[warmup] cached to ${WARMUP_FILE}`);
}

main().catch((err) => {
  console.error("[warmup] failed:", err);
  process.exit(1);
});
