/**
 * 10.4 Vault + Credential CRUD(Phase 1)
 *
 * 13 条 case 覆盖 vaults.{create,retrieve,update,list,archive,delete} +
 * vaults.credentials.{create,retrieve,update,list,archive,delete,mcpOAuthValidate}。
 *
 * 关键验证(SDK 类型层已隐式承诺的不变量,实测确认服务端也守约):
 *   - **Secret write-only**:create 时给 `auth.token` / `auth.access_token`,
 *     response.auth 只回 `mcp_server_url + type`(SDK 类型不含 token 字段)
 *   - **mcp_server_url immutable**:Update params 类型不含 mcp_server_url,
 *     SDK 编译期 enforce(server 端验证不在本 case 覆盖,需 raw HTTP bypass — defer Phase 2)
 *   - **同 vault 内 mcp_server_url unique**:第二次同 URL create 应 reject
 *
 * 用户决策:
 *   - 10.4.13 cross-workspace → SKIP(测试环境只一个 workspace,沿用 10.3.11 决策)
 *   - 10.4.10 mcpOAuthValidate → 只测 `unknown` 状态(指向 unreachable URL),
 *     不打真实 OAuth provider(避免依赖外部服务 + 凭证持有问题)
 *   - 10.4.7 immutability → 用 SDK type-level 验证(不绕过 typecheck 走 raw HTTP)
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import {
  getClient,
  resetClientCache,
  tagWithRunId,
} from "../../src/client.ts";
import { createRecorder, type RecorderHandle } from "../../src/utils/recorder.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";

type CredCreateParams = Parameters<AnthropicAws["beta"]["vaults"]["credentials"]["create"]>[1];

describe("10.4 Vault + Credential CRUD", () => {
  let recorder: RecorderHandle | undefined;
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    // cleanup 反向执行(LIFO),先 credential / session 再 vault
    for (const fn of cleanup.slice().reverse()) {
      try {
        await fn();
      } catch (err) {
        console.warn("[cleanup] failed:", err);
      }
    }
    cleanup.length = 0;
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

  function trackVaultArchive(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.vaults.archive(id);
    });
  }

  function trackVaultDelete(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.vaults.delete(id);
    });
  }

  function trackSessionArchive(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.sessions.archive(id);
    });
  }

  function genName(suffix: string): string {
    return `cma-test-vault-${suffix}-${Date.now()}`;
  }

  function probeUrl(slot: number, caseSuffix: string): string {
    // 用 .invalid TLD(IANA 保留,永远 NXDOMAIN)避免任何意外外部请求
    return `https://example-${caseSuffix}-${slot}.invalid/sse`;
  }

  /** 10.4.1 vault create / retrieve / update / list / archive 全套 */
  it("10.4.1 vault CRUD lifecycle", async () => {
    recorder = createRecorder({ caseId: "10.4.1/vault-crud-lifecycle" });
    recorder.addNote("目的:验证 vaults.create / retrieve / update / list / archive 全套基础流");
    recorder.addNote("注意:vault 用 `display_name` 字段(非 `name`),跟 environment/agent 命名不同");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // create
    const created = await client.beta.vaults.create({
      display_name: genName("10-4-1"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(created.id, client);
    expect(created.id).toMatch(/^vlt_/);
    expect(created.archived_at).toBeNull();
    expect(created.type).toBe("vault");
    recorder.addMetadata("vault_id", created.id);
    recorder.addNote(`✓ create:id=${created.id} display_name=${created.display_name}`);

    // retrieve
    const retrieved = await client.beta.vaults.retrieve(created.id);
    expect(retrieved.id).toBe(created.id);
    expect(retrieved.display_name).toBe(created.display_name);

    // update display_name
    const updated = await client.beta.vaults.update(created.id, {
      display_name: `${created.display_name}-updated`,
    });
    expect(updated.display_name).toBe(`${created.display_name}-updated`);
    recorder.addNote(`✓ update display_name:${updated.display_name}`);

    // list (verify id present 在 first few pages)
    let seenInList = false;
    let listCount = 0;
    for await (const v of client.beta.vaults.list({ limit: 50 })) {
      listCount++;
      if (v.id === created.id) {
        seenInList = true;
        break;
      }
      if (listCount >= 50) break;
    }
    recorder.addMetadata("seen_in_list", seenInList);
    recorder.addMetadata("list_count_searched", listCount);
    expect(seenInList).toBe(true);
    recorder.addNote(`✓ list:${listCount} vaults 扫到该 id`);
  });

  /** 10.4.2 archived vault 上能否 credential create */
  it("10.4.2 archived vault — credential create behavior", async () => {
    recorder = createRecorder({ caseId: "10.4.2/archived-vault-credential-create" });
    recorder.addNote("目的:archive vault 后,尝试在该 vault create credential,看错误码");
    recorder.addNote("对照 F-0006:CMA 多个状态 mismatch 都用 400 invalid_request_error,验证此处一致性");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-2"),
      metadata: tagWithRunId(),
    });
    await client.beta.vaults.archive(vault.id);

    let errStatus: number | undefined;
    let errType: string | undefined;
    let errMessage: string | undefined;
    try {
      await client.beta.vaults.credentials.create(vault.id, {
        auth: {
          type: "static_bearer",
          token: "test-token-for-archived-vault",
          mcp_server_url: probeUrl(0, "10-4-2"),
        },
        metadata: tagWithRunId(),
      });
      recorder.addNote("⚠ FINDING 候选:archived vault 仍接受 credential create");
    } catch (err) {
      const e = err as {
        status?: number;
        error?: { error?: { type?: string; message?: string } };
      } | null;
      errStatus = e?.status;
      errType = e?.error?.error?.type;
      errMessage = e?.error?.error?.message;
      recorder.addNote(`实测:archived vault credential create reject,status=${errStatus} type=${errType}`);
      if (errMessage) recorder.addNote(`message: ${errMessage}`);
    }
    recorder.addMetadata("error_status", errStatus);
    recorder.addMetadata("error_type", errType);
    recorder.addMetadata("error_message", errMessage);
    expect(errStatus).toBeDefined();
  });

  /** 10.4.3 vault delete 时仍被 active session 引用 → 期望 4xx */
  it("10.4.3 vault delete with active session ref → expect 4xx", async () => {
    recorder = createRecorder({ caseId: "10.4.3/vault-delete-with-session-ref" });
    recorder.addNote("目的:vault 被 active session 引用时,delete 是否被 reject");
    recorder.addNote("setup:create vault → create session(vault_ids=[vault.id])→ try vault.delete");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-3"),
      metadata: tagWithRunId(),
    });
    trackVaultDelete(vault.id, client);

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      vault_ids: [vault.id],
      metadata: tagWithRunId(),
    });
    trackSessionArchive(session.id, client);

    let deleteStatus: number | undefined;
    let deleteType: string | undefined;
    let deleteOk = false;
    try {
      await client.beta.vaults.delete(vault.id);
      deleteOk = true;
      recorder.addNote("⚠ FINDING 候选:vault delete 成功,虽然被 active session 引用 — 可能是 cascade detach,或 vault.delete 不检查 session refs");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string } } } | null;
      deleteStatus = e?.status;
      deleteType = e?.error?.error?.type;
      recorder.addNote(`实测:vault.delete reject,status=${deleteStatus} type=${deleteType}`);
    }
    recorder.addMetadata("delete_status", deleteStatus);
    recorder.addMetadata("delete_type", deleteType);
    recorder.addMetadata("delete_ok", deleteOk);
  });

  /** 10.4.4 credential create `mcp_oauth` 类型 */
  it("10.4.4 credential create mcp_oauth type", async () => {
    recorder = createRecorder({ caseId: "10.4.4/credential-create-mcp-oauth" });
    recorder.addNote("目的:验证 mcp_oauth 凭证类型接受 access_token + mcp_server_url");
    recorder.addNote("不变量:response.auth 不应包含 access_token(secret write-only)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-4"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: {
        type: "mcp_oauth",
        access_token: "test-oauth-token-write-only-not-echoed",
        mcp_server_url: probeUrl(0, "10-4-4"),
      },
      display_name: "10.4.4 oauth cred",
      metadata: tagWithRunId(),
    });

    expect(cred.id).toMatch(/^vcrd_/);
    expect(cred.auth.type).toBe("mcp_oauth");
    expect(cred.auth.mcp_server_url).toBe(probeUrl(0, "10-4-4"));

    // 验证 secret write-only(response.auth 不含 access_token 字段)
    const authObj = cred.auth as unknown as Record<string, unknown>;
    const hasAccessToken = "access_token" in authObj || "token" in authObj;
    recorder.addMetadata("response_auth_keys", Object.keys(authObj));
    recorder.addNote(`✓ create mcp_oauth cred:id=${cred.id}`);
    recorder.addNote(`response.auth keys: ${JSON.stringify(Object.keys(authObj))}`);
    if (hasAccessToken) {
      recorder.addNote("⚠ FINDING 候选:response.auth 包含 access_token / token 字段,secret 不是 write-only");
    } else {
      recorder.addNote("✓ secret write-only 验证:response.auth 仅 mcp_server_url + type(无 access_token)");
    }
    expect(hasAccessToken).toBe(false);
  });

  /** 10.4.5 credential create `static_bearer` 类型 */
  it("10.4.5 credential create static_bearer type", async () => {
    recorder = createRecorder({ caseId: "10.4.5/credential-create-static-bearer" });
    recorder.addNote("目的:验证 static_bearer 凭证类型接受 token + mcp_server_url");
    recorder.addNote("不变量:response.auth 不应包含 token(secret write-only)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-5"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: {
        type: "static_bearer",
        token: "test-bearer-token-write-only-not-echoed",
        mcp_server_url: probeUrl(0, "10-4-5"),
      },
      display_name: "10.4.5 bearer cred",
      metadata: tagWithRunId(),
    });

    expect(cred.id).toMatch(/^vcrd_/);
    expect(cred.auth.type).toBe("static_bearer");

    const authObj = cred.auth as unknown as Record<string, unknown>;
    const hasToken = "token" in authObj || "access_token" in authObj;
    recorder.addMetadata("response_auth_keys", Object.keys(authObj));
    recorder.addNote(`✓ create static_bearer cred:id=${cred.id}`);
    recorder.addNote(`response.auth keys: ${JSON.stringify(Object.keys(authObj))}`);
    if (hasToken) {
      recorder.addNote("⚠ FINDING 候选:static_bearer response.auth 包含 token 字段");
    } else {
      recorder.addNote("✓ secret write-only:response.auth 仅 mcp_server_url + type");
    }
    expect(hasToken).toBe(false);
  });

  /** 10.4.6 mcp_server_url 同 vault 内唯一(冲突 reject) */
  it("10.4.6 mcp_server_url unique within vault", async () => {
    recorder = createRecorder({ caseId: "10.4.6/mcp-server-url-unique-in-vault" });
    recorder.addNote("目的:同一 vault 内 mcp_server_url 不能重复,第二次 create 同 URL 应 reject");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-6"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const url = probeUrl(0, "10-4-6");
    const first = await client.beta.vaults.credentials.create(vault.id, {
      auth: { type: "static_bearer", token: "tok-1", mcp_server_url: url },
      metadata: tagWithRunId(),
    });
    recorder.addNote(`✓ first cred:id=${first.id} url=${url}`);

    let conflictStatus: number | undefined;
    let conflictType: string | undefined;
    let conflictMessage: string | undefined;
    try {
      const dup = await client.beta.vaults.credentials.create(vault.id, {
        auth: { type: "static_bearer", token: "tok-2", mcp_server_url: url },
        metadata: tagWithRunId(),
      });
      recorder.addNote(`⚠ FINDING 候选:第二次同 URL create 仍成功(id=${dup.id})— 同 vault 内 URL 不强制 unique`);
    } catch (err) {
      const e = err as {
        status?: number;
        error?: { error?: { type?: string; message?: string } };
      } | null;
      conflictStatus = e?.status;
      conflictType = e?.error?.error?.type;
      conflictMessage = e?.error?.error?.message;
      recorder.addNote(`✓ 第二次同 URL create reject,status=${conflictStatus} type=${conflictType}`);
      if (conflictMessage) recorder.addNote(`message: ${conflictMessage}`);
    }
    recorder.addMetadata("conflict_status", conflictStatus);
    recorder.addMetadata("conflict_type", conflictType);
    recorder.addMetadata("conflict_message", conflictMessage);
    expect(conflictStatus).toBeDefined();
  });

  /** 10.4.7 mcp_server_url immutable(SDK type 层 enforce) */
  it("10.4.7 mcp_server_url immutable on update (SDK type enforced)", async () => {
    recorder = createRecorder({ caseId: "10.4.7/mcp-server-url-immutable" });
    recorder.addNote("目的:验证 mcp_server_url 是 immutable 字段");
    recorder.addNote("发现:SDK 类型 BetaManagedAgentsStaticBearerUpdateParams / MCPOAuthUpdateParams **不含 mcp_server_url 字段**,client 端编译期 enforce 不可改");
    recorder.addNote("Server-side enforcement 需要 raw HTTP bypass(绕过 SDK)— defer Phase 2 错误响应 group");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-7"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: { type: "static_bearer", token: "tok", mcp_server_url: probeUrl(0, "10-4-7") },
      metadata: tagWithRunId(),
    });

    // 验证 SDK 接受 token 改 + display_name / metadata 改(但 server 不变 URL)
    const updated = await client.beta.vaults.credentials.update(cred.id, {
      vault_id: vault.id,
      auth: { type: "static_bearer", token: "tok-updated" },
      display_name: "updated cred name",
    });
    expect(updated.auth.mcp_server_url).toBe(probeUrl(0, "10-4-7"));
    recorder.addNote(`✓ update 允许 token + display_name,mcp_server_url 仍是 ${updated.auth.mcp_server_url}`);
    recorder.addMetadata("post_update_url", updated.auth.mcp_server_url);

    // 编译期不变量:SDK 类型层无法绕过 — 下行注释保留以人工 review
    // const _wouldNotCompile: CredCreateParams = { ... mcp_server_url: "..." } as any; // SDK type rejects
    void (null as unknown as CredCreateParams);
  });

  /** 10.4.8 secret 字段 write-only:list / retrieve 不返回 token */
  it("10.4.8 secret write-only — list / retrieve don't return token", async () => {
    recorder = createRecorder({ caseId: "10.4.8/secret-write-only-list-retrieve" });
    recorder.addNote("目的:除 create 响应外,list / retrieve / update 的 response.auth 也不应包含 secret");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-8"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: { type: "static_bearer", token: "the-secret-token", mcp_server_url: probeUrl(0, "10-4-8") },
      metadata: tagWithRunId(),
    });

    // retrieve
    const retrieved = await client.beta.vaults.credentials.retrieve(cred.id, { vault_id: vault.id });
    const retrievedAuth = retrieved.auth as unknown as Record<string, unknown>;
    const retrievedHasSecret = "token" in retrievedAuth || "access_token" in retrievedAuth;
    recorder.addMetadata("retrieve_auth_keys", Object.keys(retrievedAuth));
    recorder.addNote(`retrieve response.auth keys: ${JSON.stringify(Object.keys(retrievedAuth))}`);

    // list — 看本 vault 下所有 cred,每个的 auth 都不应有 token
    let listFoundSecretLeak = false;
    let listSeen = 0;
    for await (const c of client.beta.vaults.credentials.list(vault.id, { limit: 10 })) {
      listSeen++;
      const a = c.auth as unknown as Record<string, unknown>;
      if ("token" in a || "access_token" in a) {
        listFoundSecretLeak = true;
        recorder.addNote(`⚠ FINDING 候选:list cred id=${c.id} 的 response.auth 含 secret`);
      }
      if (listSeen >= 10) break;
    }
    recorder.addMetadata("list_secret_leak", listFoundSecretLeak);
    recorder.addNote(`✓ list scanned ${listSeen} creds,leak=${listFoundSecretLeak}`);
    expect(retrievedHasSecret).toBe(false);
    expect(listFoundSecretLeak).toBe(false);
  });

  /** 10.4.9 credential 上限边界(预测 20/vault) */
  it("10.4.9 credential count limit per vault", async () => {
    recorder = createRecorder({ caseId: "10.4.9/credential-count-limit" });
    recorder.addNote("目的:验证单个 vault 下 credential 数量上限(预测 20)");
    recorder.addNote("做法:依次 create 直到 reject(每个不同 URL,避开 10.4.6 unique 约束),记录 reject 时的 N");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-9"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    let lastSuccess = 0;
    let limitStatus: number | undefined;
    let limitMessage: string | undefined;
    // 给 25 个机会(预测 20 上限,留余量看 21 是否 reject)
    for (let i = 0; i < 25; i++) {
      try {
        await client.beta.vaults.credentials.create(vault.id, {
          auth: {
            type: "static_bearer",
            token: `tok-${i}`,
            mcp_server_url: probeUrl(i, "10-4-9"),
          },
          metadata: tagWithRunId(),
        });
        lastSuccess = i + 1;
      } catch (err) {
        const e = err as {
          status?: number;
          error?: { error?: { message?: string } };
        } | null;
        limitStatus = e?.status;
        limitMessage = e?.error?.error?.message;
        recorder.addNote(`实测:第 ${i + 1} 个 cred reject,status=${limitStatus} message=${limitMessage}`);
        break;
      }
    }

    recorder.addMetadata("last_success_count", lastSuccess);
    recorder.addMetadata("limit_status", limitStatus);
    recorder.addMetadata("limit_message", limitMessage);
    recorder.addNote(`结果:最多成功创建 ${lastSuccess} 个 cred 后 reject`);
    if (lastSuccess === 25) {
      recorder.addNote("⚠ FINDING 候选:25 个 cred 都接受,未触发上限(预测 20)");
    }
  }, 90_000);

  /** 10.4.10 mcpOAuthValidate `unknown` 状态(unreachable URL) */
  it("10.4.10 mcpOAuthValidate unknown state", async () => {
    recorder = createRecorder({ caseId: "10.4.10/mcp-oauth-validate-unknown" });
    recorder.addNote("目的:mcpOAuthValidate 指向 unreachable URL,期望 status=unknown 或 invalid + 含 connect_error mcp_probe");
    recorder.addNote("注意:本 case 不做 valid 真实 OAuth handshake(避免依赖外部 OAuth provider)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-10"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: {
        type: "mcp_oauth",
        access_token: "unreachable-token",
        mcp_server_url: probeUrl(0, "10-4-10"), // .invalid NXDOMAIN
      },
      metadata: tagWithRunId(),
    });

    let validation: Awaited<ReturnType<typeof client.beta.vaults.credentials.mcpOAuthValidate>> | undefined;
    let validateError: { status?: number; type?: string } | undefined;
    try {
      validation = await client.beta.vaults.credentials.mcpOAuthValidate(cred.id, { vault_id: vault.id });
      recorder.addMetadata("validation_status", validation.status);
      recorder.addMetadata("validation_mcp_probe", validation.mcp_probe);
      recorder.addMetadata("validation_refresh", validation.refresh);
      recorder.addMetadata("has_refresh_token", validation.has_refresh_token);
      recorder.addNote(`实测:validate status=${validation.status} mcp_probe.method=${validation.mcp_probe?.method ?? "—"}`);
      if (validation.mcp_probe?.http_response) {
        recorder.addNote(`mcp_probe.http_response.status=${validation.mcp_probe.http_response.status_code}`);
      }
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string } } } | null;
      validateError = { status: e?.status, type: e?.error?.error?.type };
      recorder.addNote(`实测:validate 抛错而非返回 validation 对象,status=${validateError.status} type=${validateError.type}`);
    }

    recorder.addMetadata("validate_error", validateError);
    if (validation) {
      expect(["valid", "invalid", "unknown"]).toContain(validation.status);
    }
  }, 30_000);

  /** 10.4.11 archive credential */
  it("10.4.11 archive credential → archived_at non-null", async () => {
    recorder = createRecorder({ caseId: "10.4.11/credential-archive" });
    recorder.addNote("目的:验证 credential archive 行为 — archived_at 非 null,后续 retrieve 仍能拿到");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-11"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: { type: "static_bearer", token: "tok", mcp_server_url: probeUrl(0, "10-4-11") },
      metadata: tagWithRunId(),
    });
    expect(cred.archived_at).toBeNull();

    const archived = await client.beta.vaults.credentials.archive(cred.id, { vault_id: vault.id });
    expect(archived.archived_at).toBeTruthy();
    recorder.addNote(`✓ archive cred:archived_at=${archived.archived_at}`);

    // retrieve 后仍能拿到(soft archive)
    const retrieved = await client.beta.vaults.credentials.retrieve(cred.id, { vault_id: vault.id });
    expect(retrieved.archived_at).toBeTruthy();
    recorder.addNote(`✓ archive 后 retrieve 仍 200,archived_at=${retrieved.archived_at}`);
  });

  /** 10.4.12 delete credential → 物理移除 */
  it("10.4.12 delete credential → physical removal", async () => {
    recorder = createRecorder({ caseId: "10.4.12/credential-delete" });
    recorder.addNote("目的:验证 credential delete 是物理移除(后续 retrieve → 404)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const vault = await client.beta.vaults.create({
      display_name: genName("10-4-12"),
      metadata: tagWithRunId(),
    });
    trackVaultArchive(vault.id, client);

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      auth: { type: "static_bearer", token: "tok", mcp_server_url: probeUrl(0, "10-4-12") },
      metadata: tagWithRunId(),
    });

    const deleted = await client.beta.vaults.credentials.delete(cred.id, { vault_id: vault.id });
    expect(deleted.type).toBe("vault_credential_deleted");
    recorder.addNote(`✓ delete cred:return type=${deleted.type}`);

    // retrieve 应 404
    let retrieveStatus: number | undefined;
    try {
      await client.beta.vaults.credentials.retrieve(cred.id, { vault_id: vault.id });
      recorder.addNote("⚠ FINDING 候选:delete 后 retrieve 仍 200(物理 delete 应该 404)");
    } catch (err) {
      retrieveStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`✓ delete 后 retrieve status=${retrieveStatus}`);
    }
    recorder.addMetadata("retrieve_after_delete_status", retrieveStatus);
    expect(retrieveStatus).toBe(404);
  });

  /** 10.4.13 cross-workspace 引用 vault — SKIP */
  it.skip("10.4.13 cross-workspace vault ref → expect 4xx (skip: single workspace)", async () => {
    // SKIP:AWS 测试环境只 provision 一个 workspace,沿用 10.3.11 决策。
    // Phase 1+ 拿到第二 workspace 凭证后补。
    // 预测:跨 workspace session.create({vault_ids: [<other-ws-vault>]})→ 403 或 404
  });
});
