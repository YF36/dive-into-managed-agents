#!/usr/bin/env tsx
/**
 * cleanup:archive 本次测试期间创建的所有 ephemeral 资源。
 *
 * 资源 metadata 应带 `test_run_id`(由 `tagWithRunId` 自动打)。
 * cleanup 列出所有当前 run_id 的资源,统一 archive。
 *
 * 不动 long-lived 资源(test-agent / test-environment)——它们留给下一轮跑复用。
 */

import { getClient, getConfig, describeClient, clearRunFile, getRunFilePath } from "../src/client.ts";

interface ArchivableResource {
  id: string;
  archived_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

async function listMatching(
  iterable: AsyncIterable<ArchivableResource>,
  runId: string,
): Promise<ArchivableResource[]> {
  const matched: ArchivableResource[] = [];
  for await (const r of iterable) {
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
  await client.ready;
  console.log(`[cleanup] endpoint=${describeClient()} run_id=${config.testRunId}`);

  console.log("[cleanup] scanning sessions ...");
  const sessions = await listMatching(
    client.beta.sessions.list() as unknown as AsyncIterable<ArchivableResource>,
    config.testRunId,
  );
  for (const s of sessions) {
    try {
      await client.beta.sessions.archive(s.id);
      console.log(`  archived session ${s.id}`);
    } catch (err) {
      console.warn(`  archive session ${s.id} failed:`, err);
    }
  }

  console.log("[cleanup] scanning vaults ...");
  const vaults = await listMatching(
    client.beta.vaults.list() as unknown as AsyncIterable<ArchivableResource>,
    config.testRunId,
  );
  for (const v of vaults) {
    try {
      await client.beta.vaults.archive(v.id);
      console.log(`  archived vault ${v.id}`);
    } catch (err) {
      console.warn(`  archive vault ${v.id} failed:`, err);
    }
  }

  console.log(
    `[cleanup] done. archived ${sessions.length} sessions, ${vaults.length} vaults.`,
  );

  // H3 修复:删 .run.json,下次 `npm run test` 自动启动新 run_id。
  // 也可手动 `rm tests-cma/.run.json` 提前重置。
  clearRunFile();
  console.log(`[cleanup] cleared ${getRunFilePath()} — next \`npm run test\` will start a fresh run`);
}

main().catch((err) => {
  console.error("[cleanup] failed:", err);
  process.exit(1);
});
