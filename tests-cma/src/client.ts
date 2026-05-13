/**
 * SDK 工厂。
 *
 * 实测决策(2026-05-13):用 `@anthropic-ai/aws-sdk` 单一路径,**不再有 dual-mode**。
 *
 * 理由:`AnthropicAws extends Anthropic`,自动继承完整 `beta.*` CMA surface(agents /
 * environments / sessions / sessions.events / vaults / vaults.credentials / skills /
 * memoryStores / files / models / webhooks 等)。AWS Platform 上 endpoint 自动指向
 * `aws-external-anthropic.{region}.api.aws`,beta header(`managed-agents-2026-04-01`)
 * 由 SDK 自动注入,不需要手动设置。
 *
 * 凭据来自系统环境变量,**不读 .env**(避免把 API key 落到磁盘):
 *   - ANTHROPIC_AWS_API_KEY      auth(配在 .bash_profile,SDK 走 x-api-key)
 *   - ANTHROPIC_AWS_WORKSPACE_ID 必填,SDK 构造时强制 assert
 *   - AWS_REGION                 决定 base URL 的 region(也可用 awsRegion 参数显式覆盖)
 *
 * SSH 非交互式 session 不读 .bash_profile,所以远程跑测试时要确保:
 *   - 用交互式 shell(`ssh my-aws -t bash -lc '...'`),或
 *   - 通过 systemd / launchd / 显式 source 注入 env
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import AnthropicAws, { type AwsClientOptions } from "@anthropic-ai/aws-sdk";
import { ulid } from "ulid";

const REQUIRED_ENV_VARS = [
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "AWS_REGION",
] as const;

const __filename = fileURLToPath(import.meta.url);
const TESTS_CMA_ROOT = resolve(dirname(__filename), "..");
const RUN_FILE = resolve(TESTS_CMA_ROOT, ".run.json");

export interface CmaConfig {
  workspaceId: string;
  awsRegion: string;
  testRunId: string;
  researchPreview: boolean;
}

let cachedClient: AnthropicAws | undefined;
let cachedConfig: CmaConfig | undefined;

export function assertRequiredEnv(): void {
  const missing: string[] = [];
  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}.\n` +
        `These must be set in the system environment (typically in ~/.bash_profile on AWS host).\n` +
        `Note: SSH non-interactive sessions don't read ~/.bash_profile—use \`ssh -t … bash -lc\` or systemd.`,
    );
  }
}

/**
 * 返回当次 run 的 test_run_id。解析顺序:
 *
 *   1. `CMA_TEST_RUN_ID` env(显式覆盖,用于 CI / 跨进程共享)
 *   2. `tests-cma/.run.json` 持久化文件(让 `npm run test` + `npm run cleanup`
 *      两个独立进程读到同一个 run_id,这是 H3 修复的核心)
 *   3. 新建 ULID + 写入 `.run.json`(第一次跑时自动建)
 *
 * `.run.json` 在 cleanup 跑完后删(下次 test 自动新建一个 run id)。
 * 也可手动 `rm tests-cma/.run.json` 来开启全新 run。
 */
function resolveTestRunId(): string {
  const envId = process.env["CMA_TEST_RUN_ID"];
  if (envId) return envId;

  if (existsSync(RUN_FILE)) {
    try {
      const raw = readFileSync(RUN_FILE, "utf8");
      const parsed = JSON.parse(raw) as { run_id?: string };
      if (parsed.run_id) return parsed.run_id;
    } catch {
      // 文件损坏,fall through 重建
    }
  }

  const id = ulid();
  writeFileSync(
    RUN_FILE,
    JSON.stringify({ run_id: id, created_at: new Date().toISOString() }, null, 2),
  );
  return id;
}

/** 返回 `.run.json` 的绝对路径(给 cleanup 跑完后删用)。 */
export function getRunFilePath(): string {
  return RUN_FILE;
}

/** Cleanup 收尾:删 `.run.json`,让下次 test 启动新 run。失败吞错。 */
export function clearRunFile(): void {
  if (existsSync(RUN_FILE)) {
    try {
      unlinkSync(RUN_FILE);
    } catch {
      // ignore
    }
  }
}

export function getConfig(): CmaConfig {
  if (cachedConfig) return cachedConfig;
  assertRequiredEnv();
  cachedConfig = {
    workspaceId: process.env["ANTHROPIC_AWS_WORKSPACE_ID"]!,
    awsRegion: process.env["AWS_REGION"]!,
    testRunId: resolveTestRunId(),
    researchPreview: process.env["CMA_RESEARCH_PREVIEW"] === "true",
  };
  return cachedConfig;
}

/**
 * 返回一个 cached AnthropicAws client。
 *
 * 用法:
 *   const client = getClient();
 *   await client.ready;  // 推荐:让 region 异步解析失败提前暴露
 *   await client.beta.agents.list();
 *
 * 覆盖默认行为(测试场景需要):
 *   getClient({ awsRegion: "us-west-2", workspaceId: "wrkspc_..." });
 */
export function getClient(overrides: Partial<AwsClientOptions> = {}): AnthropicAws {
  if (cachedClient && Object.keys(overrides).length === 0) return cachedClient;
  assertRequiredEnv();
  const client = new AnthropicAws(overrides);
  if (Object.keys(overrides).length === 0) cachedClient = client;
  return client;
}

export function resetClientCache(): void {
  cachedClient = undefined;
  cachedConfig = undefined;
}

export function describeClient(): string {
  const config = getConfig();
  return `aws-platform region=${config.awsRegion} workspace=${config.workspaceId} run=${config.testRunId}`;
}

/**
 * 给 metadata 自动打 test_run_id 标签,用于 cleanup 时筛选本次跑创建的资源。
 */
export function tagWithRunId<T extends Record<string, unknown>>(
  metadata?: T,
): Record<string, string> {
  const config = getConfig();
  const base = (metadata ?? {}) as Record<string, string>;
  return { ...base, test_run_id: config.testRunId };
}
