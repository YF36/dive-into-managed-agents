#!/usr/bin/env tsx
/**
 * cleanup:archive 本次测试期间创建的所有 ephemeral 资源。
 *
 * 资源 metadata 应带 `test_run_id`(由 `tagWithRunId` 自动打)。
 * cleanup 列出所有当前 run_id 的资源,统一 archive。
 *
 * 不动 long-lived 资源(test-agent / test-environment)——它们留给下一轮跑复用。
 */

import { getClient, getConfig, describeCurrentMode } from "../src/client.ts";

interface Resource {
  id: string;
  status?: string;
  archived_at?: string | null;
  metadata?: Record<string, unknown>;
}

async function listByRunId(
  listFn: () => AsyncIterable<Resource>,
  runId: string,
): Promise<Resource[]> {
  const matched: Resource[] = [];
  for await (const r of listFn()) {
    if (r.archived_at) continue;
    if ((r.metadata?.["test_run_id"] as string | undefined) === runId) {
      matched.push(r);
    }
  }
  return matched;
}

async function main(): Promise<void> {
  const config = getConfig();
  const client = getClient();
  console.log(`[cleanup] mode=${describeCurrentMode()} run_id=${config.testRunId}`);

  const beta = (client as unknown as {
    beta: {
      sessions: {
        list: () => AsyncIterable<Resource>;
        archive: (id: string) => Promise<void>;
      };
      vaults: {
        list: () => AsyncIterable<Resource>;
        archive: (id: string) => Promise<void>;
      };
    };
  }).beta;

  console.log("[cleanup] scanning sessions ...");
  const sessions = await listByRunId(() => beta.sessions.list(), config.testRunId);
  for (const s of sessions) {
    try {
      await beta.sessions.archive(s.id);
      console.log(`  archived session ${s.id}`);
    } catch (err) {
      console.warn(`  archive session ${s.id} failed:`, err);
    }
  }

  console.log("[cleanup] scanning vaults ...");
  const vaults = await listByRunId(() => beta.vaults.list(), config.testRunId);
  for (const v of vaults) {
    try {
      await beta.vaults.archive(v.id);
      console.log(`  archived vault ${v.id}`);
    } catch (err) {
      console.warn(`  archive vault ${v.id} failed:`, err);
    }
  }

  console.log(`[cleanup] done. archived ${sessions.length} sessions, ${vaults.length} vaults.`);
}

main().catch((err) => {
  console.error("[cleanup] failed:", err);
  process.exit(1);
});
