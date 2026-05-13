/**
 * Phase 0 smoke test:验证基本端到端链路可跑通。
 *
 * 流程(Phase 0 review H1 修复:用 `runTurnAndCollect` 保证 stream-first 顺序):
 *   1. getClient() 配置正确 + await client.ready
 *   2. 拿到 shared agent / environment id
 *   3. 创建 session
 *   4. **先 open stream,再 send user.message,再 consume** —— 由 runTurnAndCollect 包揽
 *   5. 校验 event log append-only(created_at 单调)+ 校验 processed_at 单调(若有 occurrence)
 *   6. archive session
 *
 * 期望:1 个 test pass + 控制台打印 event 类型计数 + occurrence 分布。
 */

import { afterEach, describe, expect, it } from "vitest";
import { describeClient, getClient } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createTestSession, safeArchive } from "../../src/fixtures/sessions.ts";
import { runTurnAndCollect } from "../../src/utils/stream.ts";
import {
  assertEventLogAppendOnly,
  assertProcessedAtMonotonicInStream,
  groupByEventId,
} from "../../src/utils/invariants.ts";

describe("smoke · end-to-end basic turn", () => {
  let sessionId: string | undefined;

  afterEach(async () => {
    await safeArchive(sessionId);
    sessionId = undefined;
  });

  it("create session → send user.message → consume stream until idle", async () => {
    const client = getClient();
    await client.ready;
    console.log(`[smoke] endpoint=${describeClient()}`);

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    expect(agentId).toMatch(/^agent_/);
    expect(envId).toBeTruthy();

    const session = await createTestSession({ title: "smoke" });
    sessionId = session.id;
    expect(sessionId).toBeTruthy();
    expect(["idle", "running"]).toContain(session.status);

    // H1 修复:stream-first 顺序由 runTurnAndCollect 内部保证。
    // 默认 occurrence-preserving(不按 event_id 去重),让我们能观察到 user.message
    // 的 queued + processed 两次回流(M1 修复:这正是 EV §1.3.2 想验证的语义)。
    const events = await runTurnAndCollect(
      sessionId!,
      {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Reply with the single word 'ok'." }],
          },
        ],
      },
      {
        stopTypes: ["session.status_idle", "session.error", "session.status_terminated"],
        maxWaitMs: 60_000,
      },
    );

    expect(events.length).toBeGreaterThan(0);

    // 输出统计:event type 分布 + 同 event_id 多 occurrence 分布
    const typeCounts: Record<string, number> = {};
    for (const e of events) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    const idGroups = groupByEventId(events);
    const multiOccurrence = [...idGroups.values()].filter((g) => g.length > 1).length;
    console.log(`[smoke] received ${events.length} events (${idGroups.size} unique ids, ${multiOccurrence} ids with multi-occurrence)`);
    console.log(`[smoke] type counts:`, typeCounts);

    // 不变量校验
    assertEventLogAppendOnly(events);
    assertProcessedAtMonotonicInStream(events);

    const idle = events.find((e) => e.type === "session.status_idle");
    expect(idle, "expected session.status_idle in stream").toBeTruthy();
  }, 90_000);
});
