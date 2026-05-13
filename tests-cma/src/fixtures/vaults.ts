/**
 * Vault + Credential fixture。Phase 3 vault test 启用前为 stub。
 */

import { getClient, tagWithRunId } from "../client.ts";

export interface CreateTestVaultOptions {
  displayName?: string;
}

export async function createTestVault(options: CreateTestVaultOptions = {}): Promise<{
  id: string;
}> {
  const client = getClient();
  return await (client as unknown as {
    beta: {
      vaults: {
        create: (params: Record<string, unknown>) => Promise<{ id: string }>;
      };
    };
  }).beta.vaults.create({
    display_name: options.displayName ?? "cma-test-vault",
    metadata: tagWithRunId(undefined),
  });
}

export async function archiveVault(vaultId: string): Promise<void> {
  const client = getClient();
  await (client as unknown as {
    beta: { vaults: { archive: (id: string) => Promise<void> } };
  }).beta.vaults.archive(vaultId);
}

export async function safeArchiveVault(vaultId: string | undefined): Promise<void> {
  if (!vaultId) return;
  try {
    await archiveVault(vaultId);
  } catch (err) {
    console.warn(`[fixture] archive vault ${vaultId} failed:`, err);
  }
}
