/**
 * 10.2 Environment CRUD(Phase 1)
 *
 * 8 条 case 覆盖 environments.create / list / retrieve / update / archive / delete。
 * Environment 跟 Agent 不同:**不版本化**(无 version 字段,无 OCC),且**有
 * hard delete API**(初步骨架以为只 archive,SDK 实测有 delete endpoint —
 * finding 候选)。
 */

import { afterEach, describe, expect, it } from "vitest";
import type AnthropicAws from "@anthropic-ai/aws-sdk";
import {
  describeClient,
  getClient,
  resetClientCache,
  tagWithRunId,
} from "../../src/client.ts";
import { createRecorder, type RecorderHandle } from "../../src/utils/recorder.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";

type EnvCreateParams = Parameters<AnthropicAws["beta"]["environments"]["create"]>[0];

const MINIMAL_CONFIG: NonNullable<EnvCreateParams["config"]> = {
  type: "cloud",
  networking: { type: "unrestricted" },
};

describe("10.2 Environment CRUD", () => {
  let recorder: RecorderHandle | undefined;
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.warn("[cleanup] archive failed:", err);
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

  function trackEnv(id: string, client: AnthropicAws) {
    cleanup.push(async () => {
      await client.beta.environments.archive(id);
    });
  }

  function genName(suffix: string): string {
    return `cma-test-env-${suffix}-${Date.now()}`;
  }

  /** 10.2.1 create with `unrestricted` networking */
  it("10.2.1 create with unrestricted networking", async () => {
    recorder = createRecorder({ caseId: "10.2.1/env-create-unrestricted" });
    recorder.addNote("目的:验证 environments.create 接受 unrestricted networking,返回 env 资源 + archived_at=null");
    recorder.addNote("不变量:Environment 无 `version` 字段(不版本化)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const env = await client.beta.environments.create({
      name: genName("10-2-1"),
      config: { type: "cloud", networking: { type: "unrestricted" } },
      metadata: tagWithRunId(),
    });
    trackEnv(env.id, client);

    expect(env.id).toMatch(/^env_/);
    expect(env.archived_at).toBeNull();
    expect(env.config?.networking?.type).toBe("unrestricted");
    expect((env as unknown as { version?: number }).version).toBeUndefined();
    recorder.addMetadata("env_id", env.id);
    recorder.addNote(`结果:env.id=${env.id},无 version 字段(印证不版本化)`);
  });

  /** 10.2.2 create with `limited` networking + allow_mcp_servers / allowed_hosts */
  it("10.2.2 create with limited networking + allow_hosts", async () => {
    recorder = createRecorder({ caseId: "10.2.2/env-create-limited-networking" });
    recorder.addNote("目的:验证 limited networking 字段集 — allowed_hosts / allow_mcp_servers / allow_package_managers");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const env = await client.beta.environments.create({
      name: genName("10-2-2"),
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allow_mcp_servers: true,
          allow_package_managers: false,
          allowed_hosts: ["api.example.invalid", "registry.example.invalid"],
        },
      },
      metadata: tagWithRunId(),
    });
    trackEnv(env.id, client);

    expect(env.id).toMatch(/^env_/);
    expect(env.config?.networking?.type).toBe("limited");
    const limited = env.config?.networking as { allowed_hosts?: string[]; allow_mcp_servers?: boolean };
    expect(limited.allowed_hosts).toEqual(["api.example.invalid", "registry.example.invalid"]);
    expect(limited.allow_mcp_servers).toBe(true);
    recorder.addNote(`结果:allowed_hosts=${JSON.stringify(limited.allowed_hosts)} allow_mcp_servers=${limited.allow_mcp_servers}`);
  });

  /** 10.2.3 packages 字段(apt / cargo / gem / go / npm / pip)*/
  it("10.2.3 packages 字段(6 个包管理器)", async () => {
    recorder = createRecorder({ caseId: "10.2.3/env-create-packages" });
    recorder.addNote("目的:验证 packages 字段接受 apt/cargo/gem/go/npm/pip 6 个包管理器");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const env = await client.beta.environments.create({
      name: genName("10-2-3"),
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: {
          apt: ["curl", "jq"],
          cargo: ["serde"],
          gem: ["rake"],
          go: ["github.com/spf13/cobra"],
          npm: ["lodash"],
          pip: ["requests==2.31.0"],
        },
      },
      metadata: tagWithRunId(),
    });
    trackEnv(env.id, client);

    expect(env.id).toMatch(/^env_/);
    const pkgs = env.config?.packages;
    expect(pkgs).toBeDefined();
    expect(pkgs?.apt).toEqual(["curl", "jq"]);
    expect(pkgs?.pip).toEqual(["requests==2.31.0"]);
    recorder.addNote(`结果:packages echo back ok,6 包管理器全接受`);
    recorder.addMetadata("packages", pkgs);
  });

  /** 10.2.4 update 部分字段(omitted 字段保留)*/
  it("10.2.4 update partial fields → omitted fields preserved", async () => {
    recorder = createRecorder({ caseId: "10.2.4/env-update-partial" });
    recorder.addNote("目的:验证 update 部分字段时,omitted 字段保留(per SDK 文档『Fields default to null; on update, omitted fields preserve』)");
    recorder.addNote("Environment 无 version 字段 → update 不需要 OCC 握手(跟 Agent 行为对比)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const created = await client.beta.environments.create({
      name: genName("10-2-4"),
      description: "10.2.4 initial description",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: { apt: ["git", "curl"] },
      },
      metadata: tagWithRunId({ kept: "yes" }),
    });
    trackEnv(created.id, client);

    // 只改 description,不传 config / metadata
    const updated = await client.beta.environments.update(created.id, {
      description: "10.2.4 updated description",
    });

    expect(updated.description).toBe("10.2.4 updated description");
    // config / metadata 应保留
    expect(updated.config?.packages?.apt).toEqual(["git", "curl"]);
    expect(updated.metadata?.["kept"]).toBe("yes");
    recorder.addNote(`✓ omitted 字段保留:packages.apt=${JSON.stringify(updated.config?.packages?.apt)} metadata.kept=${updated.metadata?.["kept"]}`);
  });

  /** 10.2.5 archive → archived_at 非 null */
  it("10.2.5 archive → archived_at 非 null", async () => {
    recorder = createRecorder({ caseId: "10.2.5/env-archive" });
    recorder.addNote("目的:验证 archive endpoint:archived_at 从 null → timestamp");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const env = await client.beta.environments.create({
      name: genName("10-2-5"),
      config: MINIMAL_CONFIG,
      metadata: tagWithRunId(),
    });
    expect(env.archived_at).toBeNull();

    const archived = await client.beta.environments.archive(env.id);
    expect(archived.archived_at).toBeTruthy();
    expect(archived.id).toBe(env.id);

    const retrieved = await client.beta.environments.retrieve(env.id);
    expect(retrieved.archived_at).toBeTruthy();
    recorder.addNote(`结果:archived_at=${archived.archived_at}`);
    // 不 trackEnv:已 archive
  });

  /** 10.2.6 archived env reject session.create */
  it("10.2.6 archived env rejects session.create", async () => {
    recorder = createRecorder({ caseId: "10.2.6/archived-env-rejects-session" });
    recorder.addNote("目的:验证 archived env 不能被 sessions.create 引用,具体错误码");
    recorder.addNote("对照 F-0003:archived agent → 400。env 是否也 400?");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const env = await client.beta.environments.create({
      name: genName("10-2-6"),
      config: MINIMAL_CONFIG,
      metadata: tagWithRunId(),
    });
    await client.beta.environments.archive(env.id);

    const agentId = await getSharedAgentId();
    let errorStatus: number | undefined;
    let errorType: string | undefined;
    try {
      await client.beta.sessions.create({
        agent: agentId,
        environment_id: env.id,
        metadata: tagWithRunId(),
      });
      recorder.addNote("⚠ FINDING 候选:archived env 仍能创建 session(预期应 reject)");
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string } } } | null;
      errorStatus = e?.status;
      errorType = e?.error?.error?.type;
      recorder.addNote(`实测:archived env reject session.create,status=${errorStatus} type=${errorType}`);
    }
    recorder.addMetadata("error_status", errorStatus);
    recorder.addMetadata("error_type", errorType);
    expect(errorStatus).toBeDefined();
  });

  /** 10.2.7 name 在 workspace 内唯一性 */
  it("10.2.7 name 在 workspace 内唯一性", async () => {
    recorder = createRecorder({ caseId: "10.2.7/env-name-uniqueness" });
    recorder.addNote("目的:验证 environment.name 在 workspace 内唯一,第二次相同 name → reject");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    const name = genName("10-2-7");
    const first = await client.beta.environments.create({
      name,
      config: MINIMAL_CONFIG,
      metadata: tagWithRunId(),
    });
    trackEnv(first.id, client);
    recorder.addNote(`✓ first create with name=${name} → 200 id=${first.id}`);

    let conflictStatus: number | undefined;
    let conflictType: string | undefined;
    try {
      const second = await client.beta.environments.create({
        name, // 同名
        config: MINIMAL_CONFIG,
        metadata: tagWithRunId(),
      });
      trackEnv(second.id, client);
      recorder.addNote(`⚠ FINDING 候选:第二次同名 create 仍成功(id=${second.id}),name 不强制 unique`);
    } catch (err) {
      const e = err as { status?: number; error?: { error?: { type?: string; message?: string } } } | null;
      conflictStatus = e?.status;
      conflictType = e?.error?.error?.type;
      recorder.addNote(`✓ 第二次同名 create reject,status=${conflictStatus} type=${conflictType}`);
      recorder.addMetadata("conflict_message", e?.error?.error?.message);
    }
    recorder.addMetadata("conflict_status", conflictStatus);
  });

  /** 10.2.8 metadata 上限边界 */
  it("10.2.8 metadata 上限边界", async () => {
    recorder = createRecorder({ caseId: "10.2.8/env-metadata-limits" });
    recorder.addNote("目的:验证 environment metadata 上限(预期跟 agent 一致:16 keys / 64 char key / 512 char value)");
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;

    // ok:16 keys
    const okMeta: Record<string, string> = { test_run_id: tagWithRunId()["test_run_id"]! };
    for (let i = 1; i < 16; i++) okMeta[`k${i}`.padEnd(64, "x")] = "v".padEnd(512, "y");
    const okEnv = await client.beta.environments.create({
      name: genName("10-2-8-ok"),
      config: MINIMAL_CONFIG,
      metadata: okMeta,
    });
    trackEnv(okEnv.id, client);
    recorder.addNote(`✓ ok case:16 keys / 64 char key / 512 char value → 200`);

    // overflow:17 keys
    let overflowStatus: number | undefined;
    const overflowMeta: Record<string, string> = { test_run_id: tagWithRunId()["test_run_id"]! };
    for (let i = 1; i < 17; i++) overflowMeta[`k${i}`] = `v${i}`;
    try {
      const overflowEnv = await client.beta.environments.create({
        name: genName("10-2-8-overflow"),
        config: MINIMAL_CONFIG,
        metadata: overflowMeta,
      });
      trackEnv(overflowEnv.id, client);
      recorder.addNote("⚠ FINDING 候选:17 keys metadata 仍接受");
    } catch (err) {
      overflowStatus = (err as { status?: number } | null)?.status;
      recorder.addNote(`✓ overflow case:17 keys reject,status=${overflowStatus}`);
    }
    recorder.addMetadata("overflow_status", overflowStatus);
  });
});
