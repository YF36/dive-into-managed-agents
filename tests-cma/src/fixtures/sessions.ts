/**
 * Session fixture。每个 test 创建新 session,test 结束后 archive。
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, tagWithRunId } from "../client.ts";
import { getSharedAgentId } from "./agents.ts";
import { getSharedEnvironmentId } from "./environments.ts";

type SessionCreateParams = Parameters<AnthropicAws["beta"]["sessions"]["create"]>[0];

export interface CreateTestSessionOptions {
  agentId?: string;
  environmentId?: string;
  vaultIds?: SessionCreateParams["vault_ids"];
  title?: string;
  resources?: SessionCreateParams["resources"];
}

export async function createTestSession(options: CreateTestSessionOptions = {}) {
  const client = getClient();
  const agentId = options.agentId ?? (await getSharedAgentId());
  const environmentId = options.environmentId ?? (await getSharedEnvironmentId());

  return await client.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    title: options.title ?? "cma-test-session",
    vault_ids: options.vaultIds,
    resources: options.resources,
    metadata: tagWithRunId(),
  });
}

export async function archiveSession(sessionId: string): Promise<void> {
  const client = getClient();
  await client.beta.sessions.archive(sessionId);
}

/**
 * Test helper:test 结束后 archive。失败不阻塞 cleanup(吞错)。
 */
export async function safeArchive(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    await archiveSession(sessionId);
  } catch (err) {
    console.warn(`[fixture] archive session ${sessionId} failed:`, err);
  }
}
