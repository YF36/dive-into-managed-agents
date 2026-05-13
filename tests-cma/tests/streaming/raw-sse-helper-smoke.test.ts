/**
 * Infrastructure smoke for `src/utils/raw-sse.ts` (Phase 2 §20.0.B prep)。
 *
 * 不是 §20.1 正式 case,只验证 helper 本身能跑通:
 *   - 正确 endpoint(GET /v1/sessions/{id}/events/stream?beta=true)
 *   - 必要 headers(Accept / x-api-key / anthropic-workspace-id /
 *     anthropic-version / anthropic-beta)
 *   - response 含 request-id + x-amzn-requestid
 *   - SSE 解析能拿到 frame + events
 *
 * 流程(stream-first per quickstart):
 *   1. SDK 创建 session
 *   2. **先**开 raw SSE stream(防 race)
 *   3. 用 SDK POST send user.message
 *   4. 拉 stream 直到 session.status_idle 或 30s timeout
 *   5. 断言 lines / events 非空 + meta 字段就位
 *   6. 不写 corpus(还没 20.0.D),只 console.log 关键 metric
 *
 * 此 smoke 通过即 20.0.B 验收。
 */

import { describe, expect, it } from "vitest";
import { getClient, resetClientCache } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { rawSseStream } from "../../src/utils/raw-sse.ts";
import { safeArchive } from "../../src/fixtures/sessions.ts";

describe("raw-sse helper smoke (Phase 2 §20.0.B 验收)", () => {
  it("端到端:create session → open raw SSE → send user.message → consume until idle", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();

    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "raw-sse-helper-smoke",
    });

    try {
      // 先开 raw SSE stream(stream-first per quickstart)
      // 注意:rawSseStream 是 blocking — 用 setTimeout pattern 先 schedule send
      // 再 await stream;否则 send 在 stream 开启前发出会 race。
      const streamPromise = rawSseStream(session.id, {
        maxWaitMs: 30_000,
        stopTypes: ["session.status_idle", "session.error", "session.status_terminated"],
      });

      // 给 stream 100ms 时间建连(实际是 fetch 内部 in-flight 异步,这里
      // 是宽松的"已发起请求"边界 — 真要严格 race-free 需要 helper expose
      // onConnected hook,先简化)
      await new Promise((r) => setTimeout(r, 200));

      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Reply 'ok'." }],
          },
        ],
      });

      const result = await streamPromise;

      // ✓ HTTP 200
      expect(result.meta.httpStatus).toBe(200);
      // ✓ content-type 是 SSE
      expect(result.meta.contentType).toMatch(/text\/event-stream/);
      // ✓ request-id 存在(non-401 path 应该有)
      expect(result.meta.requestId).toBeTruthy();
      // ✓ x-amzn-requestid 存在(AWS path 必有,F-0010 已印证)
      expect(result.meta.amznRequestId).toBeTruthy();
      // ✓ 收到至少几行 frame(数据 + blank 分隔)
      expect(result.lines.length).toBeGreaterThan(5);
      // ✓ 聚合后至少几个 event
      expect(result.events.length).toBeGreaterThan(2);

      // 打印关键 metric — Phase 2 §20.1.1-20.1.5 真测时这些会进 corpus
      const fieldTypeCounts: Record<string, number> = {};
      for (const ln of result.lines) {
        fieldTypeCounts[ln.fieldType] = (fieldTypeCounts[ln.fieldType] ?? 0) + 1;
      }
      console.log("[raw-sse smoke] http_status:", result.meta.httpStatus);
      console.log("[raw-sse smoke] content_type:", result.meta.contentType);
      console.log("[raw-sse smoke] request_id:", result.meta.requestId);
      console.log("[raw-sse smoke] x-amzn-requestid:", result.meta.amznRequestId);
      console.log("[raw-sse smoke] line counts:", fieldTypeCounts);
      console.log("[raw-sse smoke] events count:", result.events.length);
      console.log("[raw-sse smoke] duration_ms:", result.meta.durationMs.toFixed(1));

      // §20.1 关键观察(顺便记):server 是否发 event: / id: 行
      console.log("[raw-sse smoke 观察] event: 行数:", fieldTypeCounts["event"] ?? 0);
      console.log("[raw-sse smoke 观察] id: 行数:", fieldTypeCounts["id"] ?? 0);
      console.log("[raw-sse smoke 观察] comment(heartbeat)行数:", fieldTypeCounts["comment"] ?? 0);
      // 第一条 event 内容 preview
      if (result.events.length > 0) {
        const first = result.events[0]!;
        console.log("[raw-sse smoke 观察] 首条 event:", {
          eventType: first.eventType,
          id: first.id,
          dataPreview: first.data.slice(0, 200),
        });
      }
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 60_000);
});
