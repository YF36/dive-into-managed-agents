/**
 * Session fixture。每个 test 创建新 session,test 结束后 archive。
 */

import { getClient, tagWithRunId } from "../client.ts";
import { getSharedAgentId } from "./agents.ts";
import { getSharedEnvironmentId } from "./environments.ts";

export interface CreateTestSessionOptions {
  agentId?: string;
  environmentId?: string;
  vaultIds?: string[];
  title?: string;
  resources?: Array<Record<string, unknown>>;
}

export async function createTestSession(
  options: CreateTestSessionOptions = {},
): Promise<{ id: string; status: string }> {
  const client = getClient();
  const agentId = options.agentId ?? (await getSharedAgentId());
  const environmentId = options.environmentId ?? (await getSharedEnvironmentId());

  return await (client as unknown as {
    beta: {
      sessions: {
        create: (
          params: Record<string, unknown>,
        ) => Promise<{ id: string; status: string }>;
      };
    };
  }).beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    title: options.title ?? "cma-test-session",
    vault_ids: options.vaultIds,
    resources: options.resources,
    metadata: tagWithRunId(undefined),
  });
}

export async function archiveSession(sessionId: string): Promise<void> {
  const client = getClient();
  await (client as unknown as {
    beta: {
      sessions: { archive: (id: string) => Promise<void> };
    };
  }).beta.sessions.archive(sessionId);
}

/**
 * Test helper:beforeEach 创建 session,afterEach archive。
 * 失败的 archive 不阻塞 cleanup(吞错)。
 */
export async function safeArchive(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    await archiveSession(sessionId);
  } catch (err) {
    console.warn(`[fixture] archive session ${sessionId} failed:`, err);
  }
}
