/**
 * Raw SSE helper — 绕过 SDK 直接 fetch SSE stream,逐行 capture wire frame。
 *
 * 为什么需要(详见 [`docs/test-plan/20-streaming-and-events.md` §20.1](
 * https://github.com/YF36/dive-into-managed-agents/blob/main/docs/test-plan/20-streaming-and-events.md)):
 * SDK `client.beta.sessions.events.stream()` 返回的 async iterator 已经把
 * 原始 SSE 帧(`data:` / `event:` / `id:` / `:` heartbeat)吞掉,直接给
 * 解析过的 event object。Phase 2 §20.1 要测真 wire 协议(framing /
 * heartbeat / id 行 / close behavior),必须绕过 SDK。
 *
 * Endpoint(2026-05-13 对照 SDK 源码 `sessions/events.js:82` 确认):
 *   GET /v1/sessions/{session_id}/events/stream?beta=true
 *   (**不是** `/events`,后者是 list/send 资源路径)
 *
 * Required headers(SDK 自动注入,raw fetch 必须显式):
 *   - Accept: text/event-stream
 *   - x-api-key: $ANTHROPIC_AWS_API_KEY
 *   - anthropic-workspace-id: $ANTHROPIC_AWS_WORKSPACE_ID
 *   - anthropic-version: 2023-06-01           ← 不能省,见 SDK client.js:729
 *   - anthropic-beta: managed-agents-2026-04-01
 *
 * Redaction(强制,符合 Recorder.ts 同款契约):
 *   - 所有 sensitive header value 在 frame dump 前替换为 `<redacted:...>`
 *   - env secret 整 string-equal 替换(沿用 ANTHROPIC_AWS_API_KEY)
 *   - 禁止把 raw auth header dump 进任何输出
 *
 * 设计选择:
 *   - 本 helper 只**采集**,不**落盘**;落盘交给 corpus.ts(decouple I/O)
 *   - SSE 解析保持松弛 — 只按"line-and-blank-line"分帧,不做事件聚合
 *     (聚合靠 caller 按 SSE spec 自己组装,因为不同 framing 假设要分别测)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getConfig } from "../client.ts";

const __filename = fileURLToPath(import.meta.url);
const TESTS_CMA_ROOT = resolve(dirname(__filename), "../..");
const LOCAL_CONFIG_FILE = resolve(TESTS_CMA_ROOT, ".local-config.json");

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "x-amz-security-token",
  "anthropic-workspace-id",
  "cookie",
  "set-cookie",
]);

const REDACTED_VALUE = "<redacted:sensitive-header>";

/** SSE field 行 — 解析后保留原始字符串 + 拆出 field type / value。 */
export interface RawSseLine {
  /** 原始字节(已 redacted),含 newline 之前的部分 */
  raw: string;
  /** SSE 字段类型 */
  fieldType: "data" | "event" | "id" | "retry" | "comment" | "blank" | "unknown";
  /** field value(冒号后,trim 一个 leading space per SSE spec)*/
  fieldValue: string;
  /** 行接收的 wall clock(ms,performance.now() 相对值) */
  receivedAt: number;
}

export type RawSseExitReason =
  | "stop_type_matched"   // 命中 stopTypes 之一
  | "server_close"        // 服务端正常关流(reader.done)
  | "deadline"            // maxWaitMs 到期
  | "user_abort"          // caller 通过 options.signal 主动 abort
  | "error";              // 其他异常(已 rethrow 之前 finally 才走这条 — 仅占位)

export interface RawSseRequestMeta {
  /** HTTP status code */
  httpStatus: number;
  /** Anthropic 内部 request_id(来自 response header `request-id`) */
  requestId: string | null;
  /** AWS CloudTrail request id(来自 response header `x-amzn-requestid`)*/
  amznRequestId: string | null;
  /** response `content-type` */
  contentType: string | null;
  /** 已 redacted 的 response headers map(sensitive value 替换为 placeholder)*/
  responseHeaders: Record<string, string>;
  /** Wall clock ms */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** 退出原因 — finding 分析关键字段 */
  exitReason: RawSseExitReason;
}

export interface RawSseResult {
  /** 已 redacted 的请求 URL(query param 不含 secret,但保留 ?beta=true 等) */
  url: string;
  /** 已 redacted 的请求 headers(用于 corpus dump,sensitive header 替换为占位)*/
  requestHeaders: Record<string, string>;
  /** 收到的所有 raw lines(blank line + data + event + id + : 注释 都保留)*/
  lines: RawSseLine[];
  /**
   * 按 SSE spec 聚合后的 events — 每个 event 是若干 data: 行拼接成的 string。
   * 若 data 是 JSON,caller 自己 parse;helper 不假设 payload 是 JSON
   * (因为想看 wire-level 真实 framing,SDK level parse 在另一处做)。
   */
  events: Array<{ data: string; eventType: string | null; id: string | null; receivedAt: number }>;
  /** Request / response metadata */
  meta: RawSseRequestMeta;
}

export interface RawSseOptions {
  /** Max wall-clock ms,含空闲时间(防 hang)。默认 60s */
  maxWaitMs?: number;
  /** 命中即停的 event type(从 data 行解析出的 JSON.type 字段,若为 JSON) */
  stopTypes?: string[];
  /** 额外要 redact 的 secret(api key 自动加入)*/
  redactedSecrets?: readonly string[];
  /** AbortSignal — caller 可强制断流 */
  signal?: AbortSignal;
  /** 是否走 thread stream endpoint(§20.8 用),默认 false */
  threadId?: string;
}

interface LocalConfig {
  siblingArtifactRoot?: string;
  /**
   * 可选:覆盖默认的 base URL。Phase 2 测试用 AWS 路径(`aws-external-anthropic.{region}.api.aws`),
   * 此处主要给 staging / mock 场景用。默认 undefined,helper 自己合成。
   */
  baseUrlOverride?: string;
}

function loadLocalConfig(): LocalConfig | null {
  if (!existsSync(LOCAL_CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8")) as LocalConfig;
  } catch {
    return null;
  }
}

function composeBaseUrl(awsRegion: string): string {
  const local = loadLocalConfig();
  if (local?.baseUrlOverride) return local.baseUrlOverride;
  return `https://aws-external-anthropic.${awsRegion}.api.aws`;
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

function redactHeaders(
  headers: Record<string, string>,
  secrets: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lowerK = k.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lowerK)) {
      out[k] = REDACTED_VALUE;
    } else {
      out[k] = redactString(v, secrets);
    }
  }
  return out;
}

function gatherSecretsFromEnv(): string[] {
  const collected: string[] = [];
  const apiKey = process.env["ANTHROPIC_AWS_API_KEY"];
  if (apiKey && apiKey.length >= 8) collected.push(apiKey);
  return collected;
}

/**
 * 按 SSE wire spec 解析一行(已经 chunked 读出的 line)— 不处理多行 data 聚合,
 * caller 拿到所有 lines 后自己组装 events(见 collectEvents helper)。
 *
 * SSE wire spec(RFC eventsource):
 *   - 空行  → 分发 event(end of frame)
 *   - 以 `:` 开头 → 注释(heartbeat / keepalive)
 *   - 含 `:` → field:value,value 前一个空格 strip(per spec)
 *   - 不含 `:` → 整行作为 field name,value 为空
 */
function parseLine(line: string, receivedAt: number): RawSseLine {
  if (line === "") return { raw: line, fieldType: "blank", fieldValue: "", receivedAt };
  if (line.startsWith(":")) {
    return { raw: line, fieldType: "comment", fieldValue: line.slice(1), receivedAt };
  }
  const colonIdx = line.indexOf(":");
  let fieldName: string;
  let value: string;
  if (colonIdx === -1) {
    fieldName = line;
    value = "";
  } else {
    fieldName = line.slice(0, colonIdx);
    value = line.slice(colonIdx + 1);
    // SSE spec: strip a single leading space
    if (value.startsWith(" ")) value = value.slice(1);
  }
  switch (fieldName) {
    case "data":
    case "event":
    case "id":
    case "retry":
      return { raw: line, fieldType: fieldName, fieldValue: value, receivedAt };
    default:
      return { raw: line, fieldType: "unknown", fieldValue: value, receivedAt };
  }
}

/**
 * 按 SSE spec 把 lines 聚合成 events(空行作为 frame 分隔符)。
 * Multi-line `data:` 用 `\n` join(spec 行为),`event:` / `id:` 取最后一个。
 */
function collectEvents(
  lines: RawSseLine[],
): Array<{ data: string; eventType: string | null; id: string | null; receivedAt: number }> {
  const events: Array<{ data: string; eventType: string | null; id: string | null; receivedAt: number }> = [];
  let dataBuf: string[] = [];
  let eventType: string | null = null;
  let id: string | null = null;
  let frameStartAt = 0;

  for (const line of lines) {
    if (line.fieldType === "blank") {
      if (dataBuf.length > 0 || eventType !== null) {
        events.push({
          data: dataBuf.join("\n"),
          eventType,
          id,
          receivedAt: frameStartAt,
        });
      }
      dataBuf = [];
      eventType = null;
      // id is "persisted" per spec across frames, but for raw analysis we reset
      id = null;
      frameStartAt = 0;
    } else if (line.fieldType === "data") {
      if (dataBuf.length === 0) frameStartAt = line.receivedAt;
      dataBuf.push(line.fieldValue);
    } else if (line.fieldType === "event") {
      eventType = line.fieldValue;
    } else if (line.fieldType === "id") {
      id = line.fieldValue;
    }
    // comment / retry / unknown 不参与 frame 聚合
  }
  // tail flush — server 不发 trailing blank line 时也保留最后一个事件
  if (dataBuf.length > 0 || eventType !== null) {
    events.push({
      data: dataBuf.join("\n"),
      eventType,
      id,
      receivedAt: frameStartAt,
    });
  }
  return events;
}

/**
 * 主入口 — 直接对 CMA AWS endpoint 发 GET stream 请求,逐字节 capture wire,
 * 返回 lines + 聚合后的 events + metadata。
 *
 * 注意:
 *   - 函数本身不写文件,落盘由 corpus.ts 负责
 *   - 函数会阻塞直到 stream 自然结束 / `maxWaitMs` 到期 / signal abort / 命中 stopType
 *   - 失败时 throw,caller 自己处理(可以选择仍 dump 部分 lines + 错误 metadata)
 */
export async function rawSseStream(sessionId: string, options: RawSseOptions = {}): Promise<RawSseResult> {
  const config = getConfig();
  const apiKey = process.env["ANTHROPIC_AWS_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_AWS_API_KEY env not set");
  }
  const allSecrets = [...gatherSecretsFromEnv(), ...(options.redactedSecrets ?? [])];
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const stopTypes = new Set(options.stopTypes ?? []);

  const baseUrl = composeBaseUrl(config.awsRegion);
  const path = options.threadId
    ? `/v1/sessions/${sessionId}/threads/${options.threadId}/stream?beta=true`
    : `/v1/sessions/${sessionId}/events/stream?beta=true`;
  const url = `${baseUrl}${path}`;

  // 注意:redact 在 dump 前做,不在内存里改 key —— 真发到 server 必须用原值
  const realRequestHeaders: Record<string, string> = {
    Accept: "text/event-stream",
    "x-api-key": apiKey,
    "anthropic-workspace-id": config.workspaceId,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01",
  };
  const dumpedRequestHeaders = redactHeaders(realRequestHeaders, allSecrets);

  const startedAt = performance.now();
  const controller = new AbortController();
  let exitReason: RawSseExitReason = "server_close"; // default — overridden below
  let deadlineHit = false;
  let userAborted = false;
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      userAborted = true;
      controller.abort();
    });
  }
  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    controller.abort();
  }, maxWaitMs);
  (deadlineTimer as { unref?: () => void }).unref?.();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: realRequestHeaders,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(deadlineTimer);
    throw err;
  }

  const respHeaders: Record<string, string> = {};
  for (const [k, v] of response.headers.entries()) respHeaders[k.toLowerCase()] = v;
  const requestId = respHeaders["request-id"] ?? null;
  const amznRequestId = respHeaders["x-amzn-requestid"] ?? null;
  const contentType = respHeaders["content-type"] ?? null;
  const httpStatus = response.status;

  const lines: RawSseLine[] = [];

  // body 可能 null(server 直接返 4xx + empty body)
  if (!response.body) {
    clearTimeout(deadlineTimer);
    const endedAt = performance.now();
    return {
      url: redactString(url, allSecrets),
      requestHeaders: dumpedRequestHeaders,
      lines: [],
      events: [],
      meta: {
        httpStatus,
        requestId,
        amznRequestId,
        contentType,
        responseHeaders: redactHeaders(respHeaders, allSecrets),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        exitReason: "server_close",
      },
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buf = "";
  let shouldStop = false;

  try {
    while (!shouldStop) {
      const { value, done } = await reader.read();
      if (done) {
        exitReason = "server_close";
        break;
      }
      buf += decoder.decode(value, { stream: true });
      // Split on \n(server 可能 \r\n;先 normalize)
      buf = buf.replace(/\r\n/g, "\n");
      let nlIdx: number;
      while ((nlIdx = buf.indexOf("\n")) !== -1) {
        const rawLine = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        const redacted = redactString(rawLine, allSecrets);
        const parsed = parseLine(redacted, performance.now() - startedAt);
        lines.push(parsed);

        // 早停:若是 data 行且 payload 含 stopType
        if (parsed.fieldType === "data" && stopTypes.size > 0) {
          try {
            const payload = JSON.parse(parsed.fieldValue) as { type?: string };
            if (typeof payload.type === "string" && stopTypes.has(payload.type)) {
              shouldStop = true;
              exitReason = "stop_type_matched";
              break;
            }
          } catch {
            // 非 JSON data,忽略
          }
        }
      }
    }
  } catch (err) {
    // 区分 graceful abort(deadline / user signal)vs 真错
    if (deadlineHit) {
      exitReason = "deadline";
    } else if (userAborted) {
      exitReason = "user_abort";
    } else {
      clearTimeout(deadlineTimer);
      throw err;
    }
  } finally {
    clearTimeout(deadlineTimer);
    try {
      reader.cancel().catch(() => {});
    } catch {
      // ignore
    }
  }

  // tail flush — buf 剩余字节作为最后一行(server 不发 trailing newline 时)
  if (buf.length > 0) {
    const redacted = redactString(buf, allSecrets);
    lines.push(parseLine(redacted, performance.now() - startedAt));
  }

  const endedAt = performance.now();
  return {
    url: redactString(url, allSecrets),
    requestHeaders: dumpedRequestHeaders,
    lines,
    events: collectEvents(lines),
    meta: {
      httpStatus,
      requestId,
      amznRequestId,
      contentType,
      responseHeaders: redactHeaders(respHeaders, allSecrets),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      exitReason,
    },
  };
}
