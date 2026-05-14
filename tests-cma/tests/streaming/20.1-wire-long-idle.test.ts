/**
 * Phase 2.5 Batch E — §20.1 wire long-idle observations(20.1.5 / 20.1.8 / 20.1.9)。
 *
 * 慢 tests(60-120s wait)— wire-level keepalive / idle close 行为。
 */

import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { rawSseStream } from "../../src/utils/raw-sse.ts";

describe("20.1 wire long-idle(Phase 2.5 Batch E)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /**
   * 20.1.5 + 20.1.8 combined — open stream, no send, wait long, observe:
   *   - heartbeat / `:` comment 行 频率(是否周期性)
   *   - server 是否主动 close stream(exitReason='server_close')
   */
  it("20.1.5+20.1.8 long idle stream — heartbeat 周期 + 60s+ close 行为", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, title: "20.1.5+8", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // Open raw-sse,no send → 应只见 idle 流(preamble + 可能 heartbeats)
    // Wait up to 90s,看 server 是否 close 或继续 idle
    console.log("[20.1.5+8] opening stream + 90s idle wait...");
    const result = await rawSseStream(session.id, {
      maxWaitMs: 90_000,
      stopTypes: [], // 不主动 stop,等 server close 或 deadline
    });

    console.log("[20.1.5+8] exit reason:", result.meta.exitReason);
    console.log("[20.1.5+8] duration_ms:", result.meta.durationMs.toFixed(0));

    const fieldTypeCounts: Record<string, number> = {};
    for (const ln of result.lines) {
      fieldTypeCounts[ln.fieldType] = (fieldTypeCounts[ln.fieldType] ?? 0) + 1;
    }
    console.log("[20.1.5+8] line field types:", fieldTypeCounts);

    const commentLines = result.lines.filter((ln) => ln.fieldType === "comment");
    console.log("[20.1.5+8] comment lines:", commentLines.length);
    if (commentLines.length > 0) {
      const timestamps = commentLines.map((ln) => ln.receivedAt);
      console.log("[20.1.5+8] comment timestamps (ms):", timestamps.map((t) => t.toFixed(0)));
      // 计算间隔
      const intervals: number[] = [];
      for (let i = 1; i < timestamps.length; i++) intervals.push(timestamps[i]! - timestamps[i - 1]!);
      console.log("[20.1.5+8] comment intervals (ms):", intervals.map((i) => i.toFixed(0)));
    }
    console.log("[20.1.5+8] comment line contents:", commentLines.map((ln) => ln.fieldValue.slice(0, 50)));

    // 关键判断:
    // - exitReason='server_close' + 早于 90s → server 主动 close idle stream
    // - exitReason='deadline'(90s 到)+ 多 comment 行 → keepalive 维持
    // - exitReason='deadline' + 仅 preamble 1 comment → server 完全 silent idle(无主动 keepalive)
    expect(["server_close", "deadline"]).toContain(result.meta.exitReason);
  }, 120_000);

  /** 20.1.9 client abort — start stream + abort + verify session 仍可访问 */
  it("20.1.9 client abort — abort signal 后 session 仍可访问", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId, environment_id: envId, title: "20.1.9", metadata: tagWithRunId(),
    });
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    // Start stream + send a turn,中途 abort
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
    });
    const ac = new AbortController();
    const streamPromise = rawSseStream(session.id, {
      maxWaitMs: 30_000,
      signal: ac.signal,
    });
    // 等 2s 后 abort
    await new Promise((r) => setTimeout(r, 2000));
    console.log("[20.1.9] aborting stream...");
    ac.abort();

    const result = await streamPromise;
    console.log("[20.1.9] exit reason:", result.meta.exitReason);
    console.log("[20.1.9] lines captured:", result.lines.length);
    expect(result.meta.exitReason).toBe("user_abort");

    // Abort 后 session 仍可访问
    const retrieved = await client.beta.sessions.retrieve(session.id);
    console.log("[20.1.9] session status after abort:", retrieved.status);
    expect(["idle", "running"]).toContain(retrieved.status);

    // 拉 list 确认还能读
    const events: unknown[] = [];
    for await (const e of client.beta.sessions.events.list(session.id, { limit: 50 })) events.push(e);
    console.log("[20.1.9] events.list after abort count:", events.length);
    expect(events.length).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
