/**
 * Phase 0 smoke test:验证基本端到端链路可跑通。
 *
 * 流程:
 *   1. getClient() 配置正确
 *   2. 拿到 shared agent / environment id
 *   3. 创建 session
 *   4. send `user.message`
 *   5. 消费 stream 直到 session.status_idle
 *   6. 校验 event log append-only
 *   7. archive session
 *
 * 期望:1 个 test pass + 控制台打印 event 类型计数。
 */

import { describe, it, expect, afterEach } from "vitest";
import { describeCurrentMode, getClient } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createTestSession, safeArchive } from "../../src/fixtures/sessions.ts";
import { collectUntil } from "../../src/utils/stream.ts";
import { assertEventLogAppendOnly } from "../../src/utils/invariants.ts";

describe("smoke · end-to-end basic turn", () => {
  let sessionId: string | undefined;

  afterEach(async () => {
    await safeArchive(sessionId);
    sessionId = undefined;
  });

  it("create session → send user.message → consume stream until idle", async () => {
    console.log(`[smoke] mode=${describeCurrentMode()}`);

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    expect(agentId).toMatch(/^agent_/);
    expect(envId).toBeTruthy();

    const session = await createTestSession({ title: "smoke" });
    sessionId = session.id;
    expect(sessionId).toBeTruthy();
    expect(["idle", "running"]).toContain(session.status);

    const client = getClient();
    await (client as unknown as {
      beta: {
        sessions: {
          events: {
            send: (sid: string, body: Record<string, unknown>) => Promise<unknown>;
          };
        };
      };
    }).beta.sessions.events.send(sessionId!, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Reply with the single word 'ok'." }],
        },
      ],
    });

    const events = await collectUntil(sessionId!, {
      stopTypes: ["session.status_idle", "session.error", "session.status_terminated"],
      maxWaitMs: 60_000,
    });

    expect(events.length).toBeGreaterThan(0);

    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    console.log(`[smoke] received ${events.length} events:`, counts);

    assertEventLogAppendOnly(events);

    const idle = events.find((e) => e.type === "session.status_idle");
    expect(idle, "expected session.status_idle in stream").toBeTruthy();
  }, 90_000);
});
