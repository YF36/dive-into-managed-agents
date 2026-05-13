/**
 * Phase 0 smoke test:验证基本端到端链路可跑通,且产出 artifact 供后续 finding 引用。
 *
 * 流程(Phase 0 review H1 修复 + 产出物模型):
 *   1. 创建 Recorder,注入 fetch 给 SDK,自动 capture HTTP traffic
 *   2. getClient() 配置正确 + await client.ready
 *   3. 拿到 shared agent / environment id
 *   4. 创建 session(timing mark + Recorder 自动捕 HTTP)
 *   5. **先 open stream,再 send user.message,再 consume** —— 由 runTurnAndCollect 包揽
 *   6. 校验 event log append-only(created_at 单调)+ 校验 processed_at 单调(若有 occurrence)
 *   7. Recorder.dump():events.jsonl / http.jsonl / marks.json / metadata.json 落盘
 *   8. archive session
 *
 * 期望:1 个 test pass + 控制台打印 event 计数 + artifact 路径(后续 finding F-0001 引用)。
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
import { createRecorder, type RecorderHandle } from "../../src/utils/recorder.ts";

describe("smoke · end-to-end basic turn", () => {
  let sessionId: string | undefined;
  let recorder: RecorderHandle | undefined;

  afterEach(async () => {
    if (sessionId) await safeArchive(sessionId);
    if (recorder) {
      try {
        const dumpResult = await recorder.dump();
        console.log(
          `[smoke] artifact dumped to ${dumpResult.artifactDir}`,
          dumpResult.counts,
        );
      } catch (err) {
        console.warn("[smoke] artifact dump failed:", err);
      }
    }
    sessionId = undefined;
    recorder = undefined;
  });

  it("create session → send user.message → consume stream until idle", async () => {
    recorder = createRecorder({ caseId: "smoke/end-to-end-basic-turn" });
    // 注入 recorder.fetch 让 SDK 所有 HTTP 都被 capture(URL / method / headers / status / timing)
    const client = getClient({ fetch: recorder.fetch });
    await client.ready;
    console.log(`[smoke] endpoint=${describeClient()}`);
    recorder.addMetadata("endpoint", describeClient());

    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    expect(agentId).toMatch(/^agent_/);
    expect(envId).toBeTruthy();
    recorder.addMetadata("agent_id", agentId);
    recorder.addMetadata("environment_id", envId);

    recorder.mark("session.create.start");
    const session = await createTestSession({ title: "smoke" });
    recorder.mark("session.create.end");
    sessionId = session.id;
    expect(sessionId).toBeTruthy();
    expect(["idle", "running"]).toContain(session.status);
    recorder.addMetadata("session_id", sessionId);

    // H1 修复:stream-first 顺序由 runTurnAndCollect 内部保证。
    // 默认 occurrence-preserving(不按 event_id 去重),让我们能观察到 user.message
    // 的 queued + processed 两次回流(M1 修复:这正是 EV §1.3.2 想验证的语义)。
    recorder.mark("turn.start");
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
    recorder.mark("turn.end");
    recorder.recordEvents(events);

    expect(events.length).toBeGreaterThan(0);

    // 输出统计:event type 分布 + 同 event_id 多 occurrence 分布
    const typeCounts: Record<string, number> = {};
    for (const e of events) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    const idGroups = groupByEventId(events);
    const multiOccurrence = [...idGroups.values()].filter((g) => g.length > 1).length;
    console.log(`[smoke] received ${events.length} events (${idGroups.size} unique ids, ${multiOccurrence} ids with multi-occurrence)`);
    console.log(`[smoke] type counts:`, typeCounts);
    recorder.addMetadata("type_counts", typeCounts);
    recorder.addMetadata("multi_occurrence_ids", multiOccurrence);

    // 不变量校验
    assertEventLogAppendOnly(events);
    assertProcessedAtMonotonicInStream(events);

    const idle = events.find((e) => e.type === "session.status_idle");
    expect(idle, "expected session.status_idle in stream").toBeTruthy();
  }, 90_000);
});
