import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";
import { ulid } from "ulid";

loadDotenv();

export type CmaMode = "direct" | "aws-platform";

export interface CmaConfig {
  mode: CmaMode;
  betaHeader: string;
  region: string;
  testRunId: string;
  researchPreview: boolean;
}

let cachedClient: Anthropic | undefined;
let cachedConfig: CmaConfig | undefined;

export function getConfig(): CmaConfig {
  if (cachedConfig) return cachedConfig;

  const mode = (process.env.CMA_MODE ?? "direct") as CmaMode;
  if (mode !== "direct" && mode !== "aws-platform") {
    throw new Error(`Invalid CMA_MODE: ${mode}. Must be "direct" or "aws-platform".`);
  }

  cachedConfig = {
    mode,
    betaHeader: process.env.ANTHROPIC_BETA_HEADER ?? "managed-agents-2026-04-01",
    region: process.env.CMA_TEST_REGION ?? "us-west-2",
    testRunId: process.env.CMA_TEST_RUN_ID ?? ulid(),
    researchPreview: process.env.CMA_RESEARCH_PREVIEW === "true",
  };
  return cachedConfig;
}

export function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const config = getConfig();

  const defaultHeaders: Record<string, string> = {
    "anthropic-beta": config.betaHeader,
  };

  if (config.mode === "aws-platform") {
    const baseURL = process.env.AWS_ANTHROPIC_BASE_URL;
    if (!baseURL) {
      throw new Error("AWS_ANTHROPIC_BASE_URL required when CMA_MODE=aws-platform");
    }
    const apiKey = process.env.AWS_ANTHROPIC_API_KEY;
    const wifToken = process.env.AWS_ANTHROPIC_WIF_TOKEN;
    if (!apiKey && !wifToken) {
      throw new Error(
        "AWS_ANTHROPIC_API_KEY or AWS_ANTHROPIC_WIF_TOKEN required when CMA_MODE=aws-platform",
      );
    }
    if (wifToken) {
      defaultHeaders["Authorization"] = `Bearer ${wifToken}`;
    }
    cachedClient = new Anthropic({
      baseURL,
      apiKey: apiKey ?? "wif-placeholder",
      defaultHeaders,
    });
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY required when CMA_MODE=direct");
    }
    cachedClient = new Anthropic({
      apiKey,
      defaultHeaders,
    });
  }

  return cachedClient;
}

export function resetClientCache(): void {
  cachedClient = undefined;
  cachedConfig = undefined;
}

export function describeCurrentMode(): string {
  const config = getConfig();
  return config.mode === "aws-platform"
    ? `aws-platform(${process.env.AWS_ANTHROPIC_BASE_URL})`
    : "direct(api.anthropic.com)";
}

export function tagWithRunId<T extends Record<string, unknown>>(
  metadata: T | undefined,
): Record<string, string> {
  const config = getConfig();
  return {
    ...(metadata as Record<string, string> | undefined),
    test_run_id: config.testRunId,
  };
}
