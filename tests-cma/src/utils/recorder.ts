/**
 * Recorder utility:把测试跑过的 raw 数据落盘成 artifact。
 *
 * 这是产出物模型(详见 `docs/PRODUCTS.md`)的核心基础设施。
 * 测试代码默认丢掉 assert 之外的所有信号(stream events / HTTP traffic / timing),
 * Recorder 把这些 capture 下来,落到 `tests-cma/artifacts/<date>/<run_id>/<case-id>/`,
 * 后续团队成员可以反复参考、提炼 finding、回写到 AgentMatrix RFC。
 *
 * 工作流:
 *   const recorder = createRecorder({ caseId: "smoke/basic-turn" });
 *   const client = getClient({ fetch: recorder.fetch });   // 注入 HTTP capture
 *   recorder.mark("session.create.start");
 *   const session = await client.beta.sessions.create({...});
 *   recorder.mark("session.create.end");
 *   const events = await runTurnAndCollect(sessionId, ...);
 *   recorder.recordEvents(events);
 *   const result = await recorder.dump();
 *   // result.artifactDir = ".../artifacts/2026-05-13/01HXX.../smoke--basic-turn/"
 *
 * Phase 0 边界:
 *   - 捕获 HTTP request headers + URL + method;**不**捕获 request/response body(body 信息走 events)
 *   - SSE response 是 stream,跳过 body capture
 *   - Redaction 基于 string-equal 替换(已知 secret),Phase 1+ 可加 regex / 字段级 schema 化 redact
 */

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getConfig } from "../client.ts";

const __filename = fileURLToPath(import.meta.url);
const TESTS_CMA_ROOT = resolve(dirname(__filename), "../..");

/**
 * Artifact 落盘根目录解析(优先级从高到低):
 *
 *   1. `CMA_ARTIFACT_ROOT` env 显式覆盖
 *   2. 自动探测 sibling repo `<dive-into>/../agentmatrix-notes/research/managed-agents/artifacts/`
 *      —— 这是 raw 数据的**长期归宿**(agentmatrix-notes commit,跟 finding 同 repo,
 *      AWS 环境回收也不丢)
 *   3. fallback 到本地 `tests-cma/artifacts/`(gitignored,仅在 agentmatrix-notes 不存在
 *      时兜底,例如新 dev 还没 clone notes repo)
 *
 * 探测依据是 `agentmatrix-notes/research/managed-agents/` 目录是否存在,而非顶层
 * agentmatrix-notes/ —— 后者可能存在但内部结构异常。
 */
function detectDefaultArtifactRoot(): string {
  const env = process.env["CMA_ARTIFACT_ROOT"];
  if (env) return resolve(env);
  const sibling = resolve(
    TESTS_CMA_ROOT,
    "../../agentmatrix-notes/research/managed-agents/artifacts",
  );
  const siblingParent = dirname(sibling); // .../agentmatrix-notes/research/managed-agents
  if (existsSync(siblingParent)) return sibling;
  return resolve(TESTS_CMA_ROOT, "artifacts");
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "x-amz-security-token",
  "cookie",
  "set-cookie",
]);

export interface RecorderOptions {
  /** case id,用于 artifact 路径命名,e.g. "smoke/end-to-end-basic-turn" */
  caseId: string;
  /** 额外要 redact 的 secret 字符串(API key 等 ANTHROPIC_AWS_* env 自动加入) */
  redactedSecrets?: readonly string[];
  /** 自定义 artifact 根目录(默认 tests-cma/artifacts/) */
  rootDir?: string;
}

export interface HttpPair {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /** SSE / stream 响应不 capture body(无法 tee) */
    isStream: boolean;
  };
  timing: {
    startedAt: number;
    endedAt: number;
    latencyMs: number;
  };
}

export interface Marker {
  label: string;
  /** performance.now() 相对值,毫秒 */
  timestamp: number;
}

export interface RecordedMetadata {
  caseId: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  endpoint: {
    workspaceId: string;
    awsRegion: string;
  };
  additional: Record<string, unknown>;
}

export interface DumpResult {
  artifactDir: string;
  counts: {
    events: number;
    http_pairs: number;
    markers: number;
  };
}

export interface RecorderHandle {
  /** 注入到 AnthropicAws 构造时的 fetch 实现,自动 capture 所有 HTTP traffic */
  readonly fetch: typeof fetch;
  /** 显式记录一个 stream event(stream events 不经 fetch hook) */
  recordEvent(event: unknown): void;
  /** 批量记录(给 collectUntil 返回值用) */
  recordEvents(events: readonly unknown[]): void;
  /** 加 timing mark */
  mark(label: string): void;
  /** 加自定义 metadata key/value */
  addMetadata(key: string, value: unknown): void;
  /** 收尾:落盘所有 artifact,返回路径 + 统计 */
  dump(): Promise<DumpResult>;
}

function sanitizeCaseId(caseId: string): string {
  // / → --,空格 → _,其他 path-unsafe 字符 → _
  return caseId
    .replace(/\//g, "--")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._\-]/g, "_");
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function gatherSecretsFromEnv(): string[] {
  const collected: string[] = [];
  for (const key of ["ANTHROPIC_AWS_API_KEY"]) {
    const val = process.env[key];
    if (val && val.length >= 8) collected.push(val);
  }
  return collected;
}

function redactString(s: string, secrets: readonly string[]): string {
  let result = s;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    if (result.includes(secret)) {
      const tag = `<redacted:${secret.slice(0, 4)}...${secret.slice(-2)}>`;
      result = result.split(secret).join(tag);
    }
  }
  return result;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = redactValue(v, secrets);
    }
    return result;
  }
  return value;
}

function redactHeaders(
  headers: Headers | Record<string, string> | undefined,
  secrets: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Iterable<[string, string]> =
    headers instanceof Headers
      ? (headers as Headers).entries()
      : (Object.entries(headers as Record<string, string>) as Iterable<[string, string]>);
  for (const [k, v] of entries) {
    const lowerK = k.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lowerK)) {
      out[k] = "<redacted:sensitive-header>";
    } else {
      out[k] = redactString(String(v), secrets);
    }
  }
  return out;
}

export function createRecorder(options: RecorderOptions): RecorderHandle {
  const config = getConfig();
  const allSecrets: string[] = [
    ...gatherSecretsFromEnv(),
    ...(options.redactedSecrets ?? []),
  ];
  const events: unknown[] = [];
  const httpPairs: HttpPair[] = [];
  const markers: Marker[] = [];
  const additional: Record<string, unknown> = {};
  const startedAt = new Date();
  const startedPerf = performance.now();
  const rootDir = options.rootDir ?? detectDefaultArtifactRoot();
  const dateStr = todayDateStr();
  const safeCaseId = sanitizeCaseId(options.caseId);
  const artifactDir = resolve(rootDir, dateStr, config.testRunId, safeCaseId);

  const recordingFetch: typeof fetch = async (input, init) => {
    const t0 = performance.now();
    let url: string;
    let method: string;
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
    } else {
      url = String(input);
      method = init?.method ?? "GET";
    }
    const reqHeadersRaw: Record<string, string> = {};
    if (input instanceof Request) {
      for (const [k, v] of input.headers.entries()) reqHeadersRaw[k] = v;
    }
    if (init?.headers) {
      const h = init.headers;
      const iter: Iterable<[string, string]> =
        h instanceof Headers
          ? (h as Headers).entries()
          : Array.isArray(h)
            ? (h as [string, string][])
            : (Object.entries(h as Record<string, string>) as Iterable<[string, string]>);
      for (const [k, v] of iter) reqHeadersRaw[k] = String(v);
    }

    const response = await globalThis.fetch(input, init);
    const t1 = performance.now();
    const isStream =
      (response.headers.get("content-type") ?? "").includes("text/event-stream");
    const resHeadersRaw: Record<string, string> = {};
    for (const [k, v] of response.headers.entries()) resHeadersRaw[k] = v;

    httpPairs.push({
      request: {
        url: redactString(url, allSecrets),
        method,
        headers: redactHeaders(reqHeadersRaw, allSecrets),
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: redactHeaders(resHeadersRaw, allSecrets),
        isStream,
      },
      timing: {
        startedAt: t0,
        endedAt: t1,
        latencyMs: t1 - t0,
      },
    });
    return response;
  };

  return {
    fetch: recordingFetch,
    recordEvent(event) {
      events.push(redactValue(event, allSecrets));
    },
    recordEvents(items) {
      for (const e of items) events.push(redactValue(e, allSecrets));
    },
    mark(label) {
      markers.push({ label, timestamp: performance.now() - startedPerf });
    },
    addMetadata(key, value) {
      additional[key] = redactValue(value, allSecrets);
    },
    async dump(): Promise<DumpResult> {
      await mkdir(artifactDir, { recursive: true });
      const endedAt = new Date();
      const metadata: RecordedMetadata = {
        caseId: options.caseId,
        runId: config.testRunId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        endpoint: {
          workspaceId: config.workspaceId,
          awsRegion: config.awsRegion,
        },
        additional,
      };
      const eventsJsonl = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
      const httpJsonl = httpPairs.map((p) => JSON.stringify(p)).join("\n") + (httpPairs.length > 0 ? "\n" : "");
      await Promise.all([
        writeFile(resolve(artifactDir, "events.jsonl"), eventsJsonl, "utf8"),
        writeFile(resolve(artifactDir, "http.jsonl"), httpJsonl, "utf8"),
        writeFile(resolve(artifactDir, "marks.json"), JSON.stringify(markers, null, 2), "utf8"),
        writeFile(resolve(artifactDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8"),
      ]);
      return {
        artifactDir,
        counts: {
          events: events.length,
          http_pairs: httpPairs.length,
          markers: markers.length,
        },
      };
    },
  };
}
