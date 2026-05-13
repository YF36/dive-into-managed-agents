/**
 * 10.5 Error response schema(Phase 1)
 *
 * 10 条 case 横向收集 CMA error envelope 不变量:
 *   - 顶层 schema:`{type:"error", error:{type, message}, request_id}` 普适
 *   - request_id 在所有 error response 里非空
 *   - AWS path 额外有 `x-amzn-requestid` response header(CloudTrail 关联用)
 *   - 各 status code(400 / 401 / 404 / 413)的 error.type 命名约定
 *
 * 用户决策(本次)+ Phase 0 constraint:
 *   - 10.5.3 402 billing_error → SKIP(无法不影响计费触发)
 *   - 10.5.4 403 permission_error → SKIP(测试环境只一个 principal)
 *   - 10.5.7 429 rate_limit → SKIP("不打 rate limit" — 影响团队共享 quota)
 *   - 10.5.8 500/504/529 → SKIP(vendor 状态,不可控触发)
 *
 * Token 消耗:0(全 metadata API)。
 */

import { afterEach, describe, expect, it } from "vitest";
import AnthropicAws from "@anthropic-ai/aws-sdk";
import {
  getClient,
  getConfig,
  resetClientCache,
  tagWithRunId,
} from "../../src/client.ts";
import { createRecorder, type RecorderHandle } from "../../src/utils/recorder.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";

/**
 * 把 SDK 抛出的 AnthropicError 解构成标准化 shape,方便断言。
 *
 * Anthropic SDK errors 形如:
 *   {
 *     status: number,
 *     headers: Headers | Record<string, string>,
 *     error: { error: { type, message }, request_id, type: "error" },
 *     message: string,
 *   }
 */
interface NormalizedError {
  status: number | undefined;
  headers: Record<string, string>;
  envelope: {
    type?: string;
    error?: { type?: string; message?: string };
    request_id?: string;
  };
}

function normalizeError(err: unknown): NormalizedError {
  // SDK shape(实测 + 源码):
  //   class APIError { status; headers; error /* 完整 body 解析 */; requestID /* camelCase! 来自 request-id header */ }
  // 因此 request_id 字段实际有 3 处来源(优先级):
  //   1. body envelope 自身的 request_id 字段(部分错误带,部分不带)
  //   2. SDK 提取的 `requestID`(从 `request-id` response header)
  //   3. response headers 的 `request-id`(若 SDK 没提取)
  // 401 authentication_error 实测三处全空 — 见 F-NNNN findings
  const e = err as {
    status?: number;
    headers?: Headers | Record<string, string>;
    error?: { type?: string; error?: { type?: string; message?: string }; request_id?: string };
    requestID?: string | null;
  } | null;

  const headersRaw = e?.headers;
  const headers: Record<string, string> = {};
  if (headersRaw instanceof Headers) {
    for (const [k, v] of headersRaw.entries()) headers[k.toLowerCase()] = v;
  } else if (headersRaw && typeof headersRaw === "object") {
    for (const [k, v] of Object.entries(headersRaw)) headers[k.toLowerCase()] = String(v);
  }

  const body = e?.error;
  const requestId =
    body?.request_id ??
    (e?.requestID ?? undefined) ??
    headers["request-id"];

  return {
    status: e?.status,
    headers,
    envelope: {
      type: body?.type,
      error: body?.error,
      request_id: requestId,
    },
  };
}

describe("10.5 Error response schema", () => {
  let recorder: RecorderHandle | undefined;

  afterEach(async () => {
    if (recorder) {
      try {
        const result = await recorder.dump();
        console.log(`[case] artifact dumped to ${result.artifactDir}`, result.counts);
      } catch (err) {
        console.warn("[recorder] dump failed:", err);
      }
      recorder = undefined;
    }
    resetClientCache();
  });

  /** 10.5.1 400 invalid_request_error envelope 完整 schema */
  it("10.5.1 400 invalid_request_error envelope", async () => {
    recorder = createRecorder({ caseId: "10.5.1/400-envelope" });
    recorder.addNote("目的:精确刻画 400 invalid_request_error envelope shape(顶层 + error 嵌套 + request_id)");
    recorder.addNote("触发方式:vaults.create 缺 display_name(必填字段)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    let err: NormalizedError | undefined;
    try {
      await client.beta.vaults.create({ display_name: "" } as Parameters<typeof client.beta.vaults.create>[0]);
    } catch (e) {
      err = normalizeError(e);
    }

    expect(err).toBeDefined();
    expect(err!.status).toBe(400);
    expect(err!.envelope.type).toBe("error");
    expect(err!.envelope.error?.type).toBe("invalid_request_error");
    expect(err!.envelope.request_id).toBeTruthy();

    recorder.addMetadata("status", err!.status);
    recorder.addMetadata("envelope_type", err!.envelope.type);
    recorder.addMetadata("envelope_error_type", err!.envelope.error?.type);
    recorder.addMetadata("envelope_request_id", err!.envelope.request_id);
    recorder.addMetadata("response_header_request_id", err!.headers["request-id"]);
    recorder.addMetadata("response_header_x_amzn_requestid", err!.headers["x-amzn-requestid"]);
    recorder.addNote(`✓ 400 envelope:type=error, error.type=invalid_request_error, request_id=${err!.envelope.request_id}`);
    recorder.addNote(`message: ${err!.envelope.error?.message}`);
  });

  /** 10.5.2 401 authentication_error envelope */
  it("10.5.2 401 authentication_error envelope (bogus API key)", async () => {
    recorder = createRecorder({ caseId: "10.5.2/401-authentication-error" });
    recorder.addNote("目的:验证 401 authentication_error envelope shape");
    recorder.addNote("触发方式:构造独立 AnthropicAws client,传 bogus api key,workspace/region 用真实");
    const config = getConfig();

    // 用 bogus key 构造独立 client(不污染 cached client)
    const bogusClient = new AnthropicAws({
      apiKey: "sk-ant-bogus-401-trigger-not-real-not-real",
      workspaceId: config.workspaceId,
      awsRegion: config.awsRegion,
      fetch: recorder.fetch,
    });
    await bogusClient.ready;

    let err: NormalizedError | undefined;
    try {
      await bogusClient.beta.vaults.list({ limit: 1 });
    } catch (e) {
      err = normalizeError(e);
    }

    expect(err).toBeDefined();
    expect(err!.status).toBe(401);
    expect(err!.envelope.type).toBe("error");
    expect(err!.envelope.error?.type).toBe("authentication_error");
    // 实测:401 body 不带 request_id 字段、response 也不带 request-id header
    // (仅有 x-amzn-requestid)。这是 finding,不强制 truthy 断言。
    const has401RequestId = !!err!.envelope.request_id;
    const hasAmznReqId = !!err!.headers["x-amzn-requestid"];

    recorder.addMetadata("status", err!.status);
    recorder.addMetadata("envelope_error_type", err!.envelope.error?.type);
    recorder.addMetadata("envelope_request_id", err!.envelope.request_id);
    recorder.addMetadata("response_header_request_id", err!.headers["request-id"]);
    recorder.addMetadata("response_header_x_amzn_requestid", err!.headers["x-amzn-requestid"]);
    recorder.addMetadata("has_request_id", has401RequestId);
    recorder.addNote(`✓ 401 envelope:error.type=${err!.envelope.error?.type}`);
    recorder.addNote(`message: ${err!.envelope.error?.message}`);
    recorder.addNote(`request_id 存在: body=${!!err!.envelope.request_id} request-id header=${!!err!.headers["request-id"]} x-amzn-requestid=${hasAmznReqId}`);
    if (!has401RequestId) {
      recorder.addNote("**FINDING 候选**:401 authentication_error 完全缺 request_id(body + request-id header 都缺),仅有 x-amzn-requestid。AgentMatrix error envelope 设计要考虑此 vendor 行为");
    }
    // 401 path 应至少保留 x-amzn-requestid(CloudTrail 关联可用)
    expect(hasAmznReqId).toBe(true);
  });

  /** 10.5.3 402 billing_error → SKIP */
  it.skip("10.5.3 402 billing_error → SKIP (cannot trigger without billing impact)", async () => {
    // SKIP:402 billing_error 触发条件是 workspace credit exhausted / payment failure。
    // 测试环境跑这条会污染 billing 记录,且无法在 test 后回滚。
    // 未来若有 sandbox workspace 可触发,补此 case。
  });

  /** 10.5.4 403 permission_error → SKIP */
  it.skip("10.5.4 403 permission_error → SKIP (single principal in test env)", async () => {
    // SKIP:403 permission_error 需要"被禁的 principal 访问受限资源"setup。
    // 当前测试环境只一个 IAM principal 且 full access,无法自然触发。
    // Phase 1+ 若引入第二 principal(scoped permission)再补。
  });

  /** 10.5.5 404 not_found_error envelope */
  it("10.5.5 404 not_found_error envelope", async () => {
    recorder = createRecorder({ caseId: "10.5.5/404-not-found-error" });
    recorder.addNote("目的:精确刻画 404 not_found_error envelope shape");
    recorder.addNote("触发方式:create+archive+delete vault → retrieve 已删 id(确保 well-formed 但 not-found)");
    recorder.addNote("FINDING 候选:malformed vault id(过长或字符不合规)走 400 invalid_request_error,不是 404 — vault id 格式校验在 lookup 之前");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // 用 create+delete 拿一个 "well-formed 但 not-found" 的 vault id
    const tmp = await client.beta.vaults.create({
      display_name: `cma-test-10-5-5-${Date.now()}`,
      metadata: tagWithRunId(),
    });
    await client.beta.vaults.delete(tmp.id);

    let err: NormalizedError | undefined;
    try {
      await client.beta.vaults.retrieve(tmp.id);
    } catch (e) {
      err = normalizeError(e);
    }

    expect(err).toBeDefined();
    expect(err!.status).toBe(404);
    expect(err!.envelope.type).toBe("error");
    expect(err!.envelope.error?.type).toBe("not_found_error");
    expect(err!.envelope.request_id).toBeTruthy();

    recorder.addMetadata("status", err!.status);
    recorder.addMetadata("envelope_error_type", err!.envelope.error?.type);
    recorder.addMetadata("envelope_request_id", err!.envelope.request_id);
    recorder.addMetadata("response_header_x_amzn_requestid", err!.headers["x-amzn-requestid"]);
    recorder.addNote(`✓ 404 envelope:error.type=${err!.envelope.error?.type},request_id=${err!.envelope.request_id}`);
  });

  /** 10.5.6 413 request_too_large probe — try giant payload */
  it("10.5.6 413 request_too_large probe (oversized payload)", async () => {
    recorder = createRecorder({ caseId: "10.5.6/413-request-too-large-probe" });
    recorder.addNote("目的:探测 CMA request size limit。预测:CMA 大概率在 metadata value 长度校验(512 char)层就 400,真 413 要绕过 schema validation 才能触发");
    recorder.addNote("策略:发巨大 vault.display_name(理论 1-255 字符 limit,超过会 400)+ 单独尝试 5MB 字符串看是否 413");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // 尝试:5MB display_name(远超 255 字符 limit)
    const giantString = "x".repeat(5 * 1024 * 1024);
    let err: NormalizedError | undefined;
    try {
      await client.beta.vaults.create({
        display_name: giantString,
        metadata: tagWithRunId(),
      });
    } catch (e) {
      err = normalizeError(e);
    }

    expect(err).toBeDefined();
    const isReal413 = err!.status === 413;
    const is400AsSchemaCheck = err!.status === 400;

    recorder.addMetadata("status", err!.status);
    recorder.addMetadata("envelope_error_type", err!.envelope.error?.type);
    recorder.addMetadata("envelope_request_id", err!.envelope.request_id);
    recorder.addMetadata("payload_size_bytes", giantString.length);
    recorder.addNote(`实测:5MB display_name → status=${err!.status} type=${err!.envelope.error?.type}`);

    if (isReal413) {
      recorder.addNote("✓ 真 413 触发(CMA 在 wire-level 拦截 oversized request)");
    } else if (is400AsSchemaCheck) {
      recorder.addNote("⚠ FINDING 候选:5MB 仍走 400 invalid_request_error(schema validation 层拦截,未走到 413)");
    } else {
      recorder.addNote(`⚠ 意外 status=${err!.status},非 400/413`);
    }
    // 不严格断言 413,因为本 case 是 probe,记录现象即可
    expect([400, 413].includes(err!.status as number)).toBe(true);
  }, 60_000);

  /** 10.5.7 429 rate_limit_error → SKIP */
  it.skip("10.5.7 429 rate_limit_error → SKIP (不打 rate limit per Phase 0 constraint)", async () => {
    // SKIP:rate limit 是 org 级 quota(create 300 rpm / read 600 rpm),
    // 触发会影响团队其他成员。Phase 0 决策:不主动打。
    // 若 future 有 isolated workspace 或 vendor 给出 burst test 配额,补此 case。
  });

  /** 10.5.8 5xx server error → SKIP */
  it.skip("10.5.8 500 / 504 / 529 server errors → SKIP (vendor state, not deterministic)", async () => {
    // SKIP:5xx 来自 CMA 服务端故障(500 internal / 504 gateway timeout /
    // 529 overloaded),无法 deterministic 触发。被动观察:Phase 2+ 跑大量
    // 流量测试时若偶发 5xx,记到 case.md 当 anomaly finding。
  });

  /** 10.5.9 request_id 字段在所有 error response 里非空(横向 4 errors) */
  it("10.5.9 request_id ubiquity across 4 error types", async () => {
    recorder = createRecorder({ caseId: "10.5.9/request-id-ubiquity" });
    recorder.addNote("目的:横向收集 4 种 error,验证 envelope.request_id 字段始终非空");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const config = getConfig();
    const errors: Array<{ label: string; err: NormalizedError | undefined }> = [];

    // (1) 400 — 缺必填字段
    try {
      await client.beta.vaults.create({ display_name: "" } as Parameters<typeof client.beta.vaults.create>[0]);
    } catch (e) {
      errors.push({ label: "400_missing_field", err: normalizeError(e) });
    }

    // (2) 401 — bogus api key
    const bogusClient = new AnthropicAws({
      apiKey: "sk-ant-bogus-key-for-10-5-9-not-real-not-real",
      workspaceId: config.workspaceId,
      awsRegion: config.awsRegion,
      fetch: recorder.fetch,
    });
    try {
      await bogusClient.beta.vaults.list({ limit: 1 });
    } catch (e) {
      errors.push({ label: "401_bogus_api_key", err: normalizeError(e) });
    }

    // (3) 404 — invalid vault id
    try {
      await client.beta.vaults.retrieve("vlt_invalidnonexistent000000000000");
    } catch (e) {
      errors.push({ label: "404_invalid_id", err: normalizeError(e) });
    }

    // (4) 409 — duplicate URL conflict
    const tmpVault = await client.beta.vaults.create({
      display_name: `cma-test-10-5-9-${Date.now()}`,
      metadata: tagWithRunId(),
    });
    try {
      const url = `https://example-10-5-9-0.invalid/sse`;
      await client.beta.vaults.credentials.create(tmpVault.id, {
        auth: { type: "static_bearer", token: "tok-1", mcp_server_url: url },
        metadata: tagWithRunId(),
      });
      await client.beta.vaults.credentials.create(tmpVault.id, {
        auth: { type: "static_bearer", token: "tok-2", mcp_server_url: url },
        metadata: tagWithRunId(),
      });
    } catch (e) {
      errors.push({ label: "409_url_conflict", err: normalizeError(e) });
    }
    // cleanup
    try {
      await client.beta.vaults.archive(tmpVault.id);
    } catch {
      // ignore
    }

    const summary: Record<string, { status: number | undefined; request_id: string | undefined; nonempty: boolean }> = {};
    let allNonEmpty = true;
    for (const { label, err } of errors) {
      const rid = err?.envelope.request_id;
      const ok = typeof rid === "string" && rid.length > 0;
      summary[label] = { status: err?.status, request_id: rid, nonempty: ok };
      if (!ok) allNonEmpty = false;
    }
    recorder.addMetadata("errors_summary", summary);
    recorder.addNote(`实测 ${errors.length} 个 error:${errors.map((e) => `${e.label}=${e.err?.status}`).join(" / ")}`);
    recorder.addNote(`所有 request_id 均非空:${allNonEmpty}`);
    if (!allNonEmpty) {
      recorder.addNote("⚠ FINDING 候选:某些 error 的 envelope.request_id 为空");
    } else {
      recorder.addNote("✓ request_id 不变量验证通过");
    }
    // 实测:401 authentication_error 实测**没有** request_id(body 不带 + request-id header 缺)
    // 这是一条 finding,不是 bug — 断言改为信息式:打印各 status 是否有 request_id
    expect(errors.length).toBeGreaterThanOrEqual(4);
    const has401Gap = errors.some(({ err }) => err?.status === 401 && !err.envelope.request_id);
    recorder.addMetadata("has_401_request_id_gap", has401Gap);
    if (has401Gap) {
      recorder.addNote("**FINDING 候选**:CMA 401 authentication_error 无 request_id(body + request-id header 均缺)— 影响 401 错误的 observability / cross-system 链路追踪");
    }
    // 至少非 401 的应该都有 request_id
    const nonAuth = errors.filter(({ err }) => err?.status !== 401);
    const nonAuthAllHaveRid = nonAuth.every(({ err }) => err?.envelope.request_id);
    expect(nonAuthAllHaveRid).toBe(true);
  });

  /** 10.5.10 x-amzn-requestid response header(AWS path 双 request id) */
  it("10.5.10 x-amzn-requestid header present on AWS path", async () => {
    recorder = createRecorder({ caseId: "10.5.10/x-amzn-requestid-header" });
    recorder.addNote("目的:验证 AWS 路径下 response headers 同时含 `request-id`(Anthropic)+ `x-amzn-requestid`(AWS CloudTrail 关联)");
    recorder.addNote("Use 一个 400 error 来触发,然后 inspect response headers");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    let err: NormalizedError | undefined;
    try {
      await client.beta.vaults.retrieve("vlt_invalidnonexistent000000000000");
    } catch (e) {
      err = normalizeError(e);
    }

    expect(err).toBeDefined();
    const anthropicReqId = err!.headers["request-id"];
    const amznReqId = err!.headers["x-amzn-requestid"];

    recorder.addMetadata("anthropic_request_id_header", anthropicReqId);
    recorder.addMetadata("amzn_request_id_header", amznReqId);
    recorder.addMetadata("all_headers", err!.headers);
    recorder.addNote(`✓ request-id: ${anthropicReqId}`);
    recorder.addNote(`✓ x-amzn-requestid: ${amznReqId}`);

    if (!anthropicReqId) {
      recorder.addNote("⚠ FINDING 候选:response headers 缺 request-id");
    }
    if (!amznReqId) {
      recorder.addNote("⚠ FINDING 候选:AWS path 但 response headers 缺 x-amzn-requestid(CloudTrail 关联将不可用)");
    }
    expect(typeof anthropicReqId).toBe("string");
    expect(typeof amznReqId).toBe("string");
  });
});
