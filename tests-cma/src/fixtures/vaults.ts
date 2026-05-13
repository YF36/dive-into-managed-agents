/**
 * Vault + Credential fixture。Phase 3 vault test 启用前为最小骨架。
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, tagWithRunId } from "../client.ts";

type VaultCreateParams = Parameters<AnthropicAws["beta"]["vaults"]["create"]>[0];

export interface CreateTestVaultOptions {
  displayName?: string;
}

export async function createTestVault(options: CreateTestVaultOptions = {}) {
  const client = getClient();
  const params: VaultCreateParams = {
    display_name: options.displayName ?? "cma-test-vault",
    metadata: tagWithRunId(),
  };
  return await client.beta.vaults.create(params);
}

export async function archiveVault(vaultId: string): Promise<void> {
  const client = getClient();
  await client.beta.vaults.archive(vaultId);
}

export async function safeArchiveVault(vaultId: string | undefined): Promise<void> {
  if (!vaultId) return;
  try {
    await archiveVault(vaultId);
  } catch (err) {
    console.warn(`[fixture] archive vault ${vaultId} failed:`, err);
  }
}
