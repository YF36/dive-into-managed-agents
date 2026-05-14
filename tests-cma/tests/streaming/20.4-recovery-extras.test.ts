/**
 * Phase 2.5 Batch C — §20.4 recovery extras(20.4.4 / 20.4.6 / 20.4.7)。
 */

import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId, getConfig } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";

const STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
];

describe("20.4 recovery extras(Phase 2.5 Batch C)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 20.4.4 60s reconnect — long disconnect + list seed recovery */
  it("20.4.4 60s reconnect - 长断线 list seed 恢复完整性", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, title: "20.4.4 60s reconnect", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const collector = createThreeLayerCollector(session.id, {
      defaultStopTypes: STOP_TYPES, defaultMaxWaitMs: 30_000,
    });
    await collector.openStream();
    await new Promise((r) => setTimeout(r, 200));

    await collector.send({
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
    });
    // 早停 status_running 就关流
    await collector.consume({ stopTypes: ["session.status_running"], maxWaitMs: 5000 });
    await collector.closeStream();

    console.log("[20.4.4] stream closed,wait 60s...");
    await new Promise((r) => setTimeout(r, 60_000));

    const seed = await collector.listSnapshot();
    console.log("[20.4.4] 60s 后 list seed count:", seed.events.length);

    await collector.reopenStream();
    await collector.consume({ maxWaitMs: 8000 });

    const snap = await collector.finalize();

    const expected = [
      "session.status_running", "session.thread_status_running", "user.message",
      "span.model_request_start", "agent.message", "span.model_request_end",
      "session.thread_status_idle", "session.status_idle",
    ];
    const l1Types = new Set(snap.L1.map((e) => e.type));
    const missing = expected.filter((t) => !l1Types.has(t));
    console.log("[20.4.4] L1 missing types after 60s reconnect:", missing);

    await dumpCorpus("reconnect-60s", snap, {
      description: "§20.4.4 — 60s 断线 + list seed + reopen,L1 完整性验证",
      additionalMeta: { case: "20.4.4", seed_count: seed.events.length, l1_missing: missing },
    });
    expect(missing.length).toBe(0);
  }, 120_000);

  /** 20.4.6 idempotency probe — 同 user.message 重发,server 是否生成 2 个 logical events */
  it("20.4.6 idempotency - 同 payload 重发 server 是否 dedup", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, title: "20.4.6 idempotency", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // 先 list 确认空
    const initial: unknown[] = [];
    for await (const e of client.beta.sessions.events.list(session.id, { limit: 50 })) initial.push(e);

    // 同 payload 连发 2 次(不等 turn 完成,直接 fire 2 个 send POST)
    const payload = {
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
    } as Parameters<typeof client.beta.sessions.events.send>[1];

    await client.beta.sessions.events.send(session.id, payload);
    await client.beta.sessions.events.send(session.id, payload);

    // 等 turn 完成
    await new Promise((r) => setTimeout(r, 10_000));

    const after: unknown[] = [];
    for await (const e of client.beta.sessions.events.list(session.id, { limit: 100 })) after.push(e);

    const userMessages = after.filter((e) => (e as { type?: string }).type === "user.message");
    console.log("[20.4.6] 总 events:", after.length);
    console.log("[20.4.6] user.message count:", userMessages.length);
    console.log("[20.4.6] user.message ids:", userMessages.map((e) => (e as { id?: string }).id));

    // 关键观察:server 是否生成 2 个 logical user.message events?
    const distinctIds = new Set(userMessages.map((e) => (e as { id?: string }).id));
    console.log("[20.4.6] distinct user.message ids:", distinctIds.size);

    // 模拟 corpus dump(从 list 抽 stub L0)
    const stubSnap = {
      baseline: 0,
      L0: { stream: [], listSnapshots: [], sendCalls: [] },
      L1: [], L2: [],
      stats: { l0StreamCount: 0, l0ListSnapshotCount: 0, l0ListEventTotal: 0, l0SendCallCount: 0, l0SendEventTotal: 0, l1Count: 0, l2Count: 0 },
    };
    await dumpCorpus("idempotency-duplicate-send", stubSnap, {
      description: "§20.4.6 — duplicate POST 同 payload,server 是否生成 2 logical events",
      additionalMeta: {
        case: "20.4.6",
        total_events_after_dup_send: after.length,
        user_message_count: userMessages.length,
        distinct_user_message_ids: distinctIds.size,
        user_message_ids: userMessages.map((e) => (e as { id?: string }).id),
      },
    });
  }, 60_000);

  /** 20.4.7 Last-Event-ID header probe — raw fetch with custom header */
  it("20.4.7 Last-Event-ID experimental probe", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, title: "20.4.7", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // 先跑一个 turn 让有事件
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
    });
    await new Promise((r) => setTimeout(r, 8000));

    // 拿一个事件 id
    const events: { id?: string }[] = [];
    for await (const e of client.beta.sessions.events.list(session.id, { limit: 50 })) {
      events.push(e as { id?: string });
    }
    const firstEventId = events[0]?.id ?? "sevt_fakelastid000000000000";
    console.log("[20.4.7] using Last-Event-ID:", firstEventId);

    // 直接 raw fetch 带 Last-Event-ID header
    const cfg = getConfig();
    const apiKey = process.env["ANTHROPIC_AWS_API_KEY"]!;
    const url = `https://aws-external-anthropic.${cfg.awsRegion}.api.aws/v1/sessions/${session.id}/events/stream?beta=true`;
    const headers = {
      Accept: "text/event-stream",
      "x-api-key": apiKey,
      "anthropic-workspace-id": cfg.workspaceId,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      "Last-Event-ID": firstEventId,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    console.log("[20.4.7] response status:", response.status);
    console.log("[20.4.7] response content-type:", response.headers.get("content-type"));

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let captured = "";
      try {
        while (captured.length < 5000) {
          const { value, done } = await reader.read();
          if (done) break;
          captured += decoder.decode(value, { stream: true });
        }
      } catch { /* abort */ }
      reader.cancel().catch(() => {});
      // 解析有多少 event frames(粗略):'event:' 行数
      const eventLineCount = (captured.match(/\nevent:/g) || []).length;
      console.log("[20.4.7] captured chars:", captured.length, "event: line count:", eventLineCount);
      console.log("[20.4.7] first 500 chars:", captured.slice(0, 500));
    }
    clearTimeout(timer);

    // 期望:server 忽略 Last-Event-ID header,从头发或不发(F-0011 已证 stream 不 replay)
    // 实际行为待 raw output 解析
    expect(response.status).toBe(200);
  }, 60_000);
});
