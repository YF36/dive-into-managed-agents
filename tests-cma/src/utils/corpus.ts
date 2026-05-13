/**
 * Event corpus helper(Phase 2 §20.0.D)。
 *
 * 把 case 的 3-layer snapshot + raw-sse 结果按 plan §20.2 / §20.4 / §20.5
 * 分目录 dump 到 sibling notes repo 的 `event-corpus/<scenario>/`。
 *
 * 跟 [`recorder.ts`](./recorder.ts) 的 artifact 区别(详见 [plan §20.2](
 * https://github.com/YF36/dive-into-managed-agents/blob/main/docs/test-plan/20-streaming-and-events.md)):
 *   - artifacts/<date>/<run_id>/<case-id>/: **每 case 完整原始数据**,用于
 *     审计 / 回放,沿用 Phase 1 模式
 *   - event-corpus/<scenarioName>/: **每场景策展过的代表性样本**,用于
 *     跨 vendor 对照引用 + 人类可读,corpus 文件少而精
 *
 * 目录结构(按场景固定,**不**带 date / run_id 分段** — 每次跑覆盖,history
 * 走 git):
 *
 *   event-corpus/<scenarioName>/
 *   ├── meta.json                       场景上下文 + sdk version + 时间戳
 *   ├── L0/
 *   │   ├── stream.jsonl                stream source 原始观察
 *   │   ├── list-snapshots/
 *   │   │   ├── 00.jsonl
 *   │   │   ├── 01.jsonl
 *   │   │   └── ...
 *   │   └── send-responses/
 *   │       ├── 00.json
 *   │       └── ...
 *   ├── L1.jsonl                        recovered feed
 *   ├── L2.jsonl                        UI consolidated
 *   └── raw-sse/                        (可选)
 *       ├── raw-frames.txt
 *       ├── parsed-events.jsonl
 *       ├── request-meta.json
 *       └── response-headers.json
 *
 * Path 解析沿用 [`recorder.ts` siblingArtifactRoot](./recorder.ts) 同款机制:
 * `.local-config.json`(gitignored)`siblingArtifactRoot` 指向 sibling repo
 * 的 `artifacts/`,corpus 通过 sibling-of-artifacts(`../event-corpus/`)推
 * 出根目录。
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getConfig } from "../client.ts";
import type {
  ThreeLayerSnapshot,
  SourcedEvent,
  ListSnapshot,
  SendCall,
} from "./three-layer-collector.ts";
import type { RawSseResult } from "./raw-sse.ts";

const __filename = fileURLToPath(import.meta.url);
const TESTS_CMA_ROOT = resolve(dirname(__filename), "../..");
const LOCAL_CONFIG_FILE = resolve(TESTS_CMA_ROOT, ".local-config.json");

interface LocalConfig {
  /** Sibling notes repo 中 artifact 根目录(相对 tests-cma/)*/
  siblingArtifactRoot?: string;
  /** 显式覆盖 corpus 根目录(否则推算)*/
  siblingCorpusRoot?: string;
}

function loadLocalConfig(): LocalConfig | null {
  if (!existsSync(LOCAL_CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8")) as LocalConfig;
  } catch {
    return null;
  }
}

/**
 * 推算 corpus 根目录(详见 Phase 2 plan §20.0.D)。优先级:
 *   1. `CMA_CORPUS_ROOT` env 显式覆盖
 *   2. `.local-config.json` `siblingCorpusRoot` 显式
 *   3. 从 `siblingArtifactRoot` 推 `../event-corpus`(默认 sibling repo 结构)
 *   4. fallback `tests-cma/event-corpus/`(本地兜底)
 */
function detectCorpusRoot(): string {
  const env = process.env["CMA_CORPUS_ROOT"];
  if (env) return resolve(env);
  const local = loadLocalConfig();
  if (local?.siblingCorpusRoot) {
    return resolve(TESTS_CMA_ROOT, local.siblingCorpusRoot);
  }
  if (local?.siblingArtifactRoot) {
    const artifactDir = resolve(TESTS_CMA_ROOT, local.siblingArtifactRoot);
    const corpus = resolve(dirname(artifactDir), "event-corpus");
    if (existsSync(dirname(corpus))) return corpus;
  }
  return resolve(TESTS_CMA_ROOT, "event-corpus");
}

function sanitizeScenarioName(name: string): string {
  return name
    .replace(/\//g, "--")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._\-]/g, "_");
}

function toJsonl(events: readonly unknown[]): string {
  if (events.length === 0) return "";
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

export interface CorpusDumpOptions {
  /** Scenario 上下文(写进 meta.json description 字段)*/
  description?: string;
  /** 可选:把 raw-sse 结果一并 dump 到 corpus/<scenario>/raw-sse/ */
  rawSse?: RawSseResult;
  /** 覆盖默认 corpus root */
  rootDir?: string;
  /** 自定义 metadata 字段(进 meta.json)*/
  additionalMeta?: Record<string, unknown>;
}

export interface CorpusDumpResult {
  /** 完整 corpus 目录绝对路径 */
  corpusDir: string;
  /** 写入的所有相对文件路径(给 case.md 索引用)*/
  files: string[];
  /** 简要 stats */
  stats: ThreeLayerSnapshot["stats"];
}

/**
 * 把 3-layer snapshot + 可选 raw-sse 结果 dump 到 `event-corpus/<scenarioName>/`。
 *
 * 同名 scenario 重复跑会覆盖现有文件(git history 保留旧版)。这是有意设计 —
 * corpus 是策展样本,每个场景一份"权威"版本。
 */
export async function dumpCorpus(
  scenarioName: string,
  snapshot: ThreeLayerSnapshot,
  options: CorpusDumpOptions = {},
): Promise<CorpusDumpResult> {
  const root = options.rootDir ?? detectCorpusRoot();
  const safe = sanitizeScenarioName(scenarioName);
  const corpusDir = resolve(root, safe);
  await mkdir(corpusDir, { recursive: true });

  const config = getConfig();
  const meta = {
    scenario: scenarioName,
    description: options.description ?? "",
    dumped_at: new Date().toISOString(),
    test_run_id: config.testRunId,
    endpoint: {
      workspaceId: config.workspaceId,
      awsRegion: config.awsRegion,
    },
    stats: snapshot.stats,
    has_raw_sse: !!options.rawSse,
    additional: options.additionalMeta ?? {},
  };

  const files: string[] = [];

  // ─── meta ───
  await writeFile(resolve(corpusDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  files.push("meta.json");

  // ─── L0 ───
  const l0Dir = resolve(corpusDir, "L0");
  await mkdir(l0Dir, { recursive: true });
  await writeFile(resolve(l0Dir, "stream.jsonl"), toJsonl(snapshot.L0.stream), "utf8");
  files.push("L0/stream.jsonl");

  if (snapshot.L0.listSnapshots.length > 0) {
    const listDir = resolve(l0Dir, "list-snapshots");
    await mkdir(listDir, { recursive: true });
    for (const snap of snapshot.L0.listSnapshots) {
      const pad = String(snap.index).padStart(2, "0");
      const filename = `${pad}.jsonl`;
      // Per-snapshot meta is small (index/startedAt/endedAt) — write as first line as JSON meta object,
      // followed by events JSONL.
      const metaLine = JSON.stringify({
        _meta: true,
        index: snap.index,
        startedAt: snap.startedAt,
        endedAt: snap.endedAt,
        eventCount: snap.events.length,
      });
      const content = metaLine + "\n" + toJsonl(snap.events);
      await writeFile(resolve(listDir, filename), content, "utf8");
      files.push(`L0/list-snapshots/${filename}`);
    }
  }

  if (snapshot.L0.sendCalls.length > 0) {
    const sendDir = resolve(l0Dir, "send-responses");
    await mkdir(sendDir, { recursive: true });
    for (const call of snapshot.L0.sendCalls) {
      const pad = String(call.index).padStart(2, "0");
      const filename = `${pad}.json`;
      const payload = {
        index: call.index,
        issuedAt: call.issuedAt,
        respondedAt: call.respondedAt,
        request: call.request,
        eventsEcho: call.events,
        rawResponse: call.rawResponse,
      };
      await writeFile(resolve(sendDir, filename), JSON.stringify(payload, null, 2), "utf8");
      files.push(`L0/send-responses/${filename}`);
    }
  }

  // ─── L1 / L2 ───
  await writeFile(resolve(corpusDir, "L1.jsonl"), toJsonl(snapshot.L1), "utf8");
  files.push("L1.jsonl");
  await writeFile(resolve(corpusDir, "L2.jsonl"), toJsonl(snapshot.L2), "utf8");
  files.push("L2.jsonl");

  // ─── raw-sse(可选) ───
  if (options.rawSse) {
    const rawDir = resolve(corpusDir, "raw-sse");
    await mkdir(rawDir, { recursive: true });
    // raw frames as text(每行一个 frame entry,含 fieldType 元信息便于人读)
    const frameLines = options.rawSse.lines
      .map((ln) => `[${ln.fieldType}] ${ln.raw}`)
      .join("\n");
    await writeFile(resolve(rawDir, "raw-frames.txt"), frameLines + "\n", "utf8");
    files.push("raw-sse/raw-frames.txt");

    // parsed events
    await writeFile(resolve(rawDir, "parsed-events.jsonl"), toJsonl(options.rawSse.events), "utf8");
    files.push("raw-sse/parsed-events.jsonl");

    // request meta
    await writeFile(
      resolve(rawDir, "request-meta.json"),
      JSON.stringify(
        {
          url: options.rawSse.url,
          requestHeaders: options.rawSse.requestHeaders,
          ...options.rawSse.meta,
        },
        null,
        2,
      ),
      "utf8",
    );
    files.push("raw-sse/request-meta.json");
  }

  return {
    corpusDir,
    files,
    stats: snapshot.stats,
  };
}

export function describeCorpusRoot(): string {
  return detectCorpusRoot();
}
