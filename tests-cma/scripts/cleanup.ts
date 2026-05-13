#!/usr/bin/env tsx
/**
 * cleanup:archive 本次测试期间创建的所有 ephemeral 资源。
 *
 * 资源 metadata 应带 `test_run_id`(由 `tagWithRunId` 自动打)。
 * cleanup 列出所有当前 run_id 的资源,统一 archive。
 *
 * 不动 long-lived 资源(test-agent / test-environment)——它们留给下一轮跑复用。
 *
 * Phase 0 review H1 修复:**只有全部成功才 clearRunFile()**。否则保留 .run.json
 * 让下次 `npm run cleanup` 仍能扫到失败的资源重试,exit non-zero 让 CI / 用户感知。
 *
 * Phase 0 边界(M2 配套):当前只清 session + vault。Phase 1+ 用例创建 ephemeral
 * agents / environments / memory_stores / files / credentials 时,需要扩展 cleanup。
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

async function archiveAll<T extends ArchivableResource>(
  resources: T[],
  label: string,
  archiveFn: (id: string) => Promise<unknown>,
): Promise<{ archived: number; failed: number }> {
  let archived = 0;
  let failed = 0;
  for (const r of resources) {
    try {
      await archiveFn(r.id);
      archived++;
      console.log(`  archived ${label} ${r.id}`);
    } catch (err) {
      failed++;
      console.warn(`  archive ${label} ${r.id} failed:`, err);
    }
  }
  return { archived, failed };
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
  const sessionStats = await archiveAll(sessions, "session", (id) =>
    client.beta.sessions.archive(id),
  );

  console.log("[cleanup] scanning vaults ...");
  const vaults = await listMatching(
    client.beta.vaults.list() as unknown as AsyncIterable<ArchivableResource>,
    config.testRunId,
  );
  const vaultStats = await archiveAll(vaults, "vault", (id) =>
    client.beta.vaults.archive(id),
  );

  const totalArchived = sessionStats.archived + vaultStats.archived;
  const totalFailed = sessionStats.failed + vaultStats.failed;

  console.log(
    `[cleanup] done. archived ${totalArchived} resources (sessions ${sessionStats.archived}/${sessions.length}, vaults ${vaultStats.archived}/${vaults.length}); ${totalFailed} failed.`,
  );

  // H1 修复:只有全部成功才 clear .run.json;否则保留让下次 cleanup 仍能扫到。
  if (totalFailed === 0) {
    clearRunFile();
    console.log(
      `[cleanup] cleared ${getRunFilePath()} — next \`npm run test\` will start a fresh run`,
    );
  } else {
    console.error(
      `[cleanup] ${totalFailed} archive failure(s); preserving ${getRunFilePath()} for retry. Re-run \`npm run cleanup\` after fixing the root cause.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[cleanup] failed:", err);
  process.exit(1);
});
