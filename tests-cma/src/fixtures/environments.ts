/**
 * Environment fixture。warmup 阶段创建一个 long-lived test-environment。
 */

import { getClient, tagWithRunId } from "../client.ts";
import { loadWarmupCache } from "./agents.ts";

export const MINIMAL_ENVIRONMENT_PARAMS = {
  name: "cma-test-environment",
  description: "Long-lived test environment. Do not manually delete.",
  config: {
    type: "cloud" as const,
    networking: { type: "unrestricted" as const },
    packages: {},
  },
} as const;

export async function getSharedEnvironmentId(): Promise<string> {
  const cache = await loadWarmupCache();
  if (!cache.environment_id) {
    throw new Error(
      "No test environment id cached. Run `npm run warmup` first.",
    );
  }
  return cache.environment_id;
}

export async function createEphemeralEnvironment(
  overrides: Partial<typeof MINIMAL_ENVIRONMENT_PARAMS> = {},
) {
  const client = getClient();
  return await (client as unknown as {
    beta: {
      environments: {
        create: (params: Record<string, unknown>) => Promise<{ id: string }>;
      };
    };
  }).beta.environments.create({
    ...MINIMAL_ENVIRONMENT_PARAMS,
    ...overrides,
    metadata: tagWithRunId(undefined),
  });
}
