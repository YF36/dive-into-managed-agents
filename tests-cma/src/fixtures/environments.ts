/**
 * Environment fixture。warmup 阶段创建一个 long-lived test-environment。
 */

import type AnthropicAws from "@anthropic-ai/aws-sdk";
import { getClient, tagWithRunId } from "../client.ts";
import { loadWarmupCache } from "./agents.ts";

type EnvironmentCreateParams = Parameters<
  AnthropicAws["beta"]["environments"]["create"]
>[0];

export const MINIMAL_ENVIRONMENT_PARAMS: EnvironmentCreateParams = {
  name: "cma-test-environment",
  description: "Long-lived test environment. Do not manually delete.",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
    packages: {},
  },
};

export async function getSharedEnvironmentId(): Promise<string> {
  const cache = await loadWarmupCache();
  if (!cache.environment_id) {
    throw new Error("No test environment id cached. Run `npm run warmup` first.");
  }
  return cache.environment_id;
}

export async function createEphemeralEnvironment(
  overrides: Partial<EnvironmentCreateParams> = {},
) {
  const client = getClient();
  return await client.beta.environments.create({
    ...MINIMAL_ENVIRONMENT_PARAMS,
    ...overrides,
    metadata: tagWithRunId(),
  });
}
