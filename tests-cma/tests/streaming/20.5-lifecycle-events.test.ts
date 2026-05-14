/**
 * Phase 2 §20.5 Session Lifecycle Events(Top 10 #8 / #9)。
 *
 * 本文件覆盖:
 *   - 20.5.7A archived session — events.list 仍可读 + active stream 命运
 *   - 20.5.7B deleted session — stream 是否先收 session.deleted 再 close +
 *     subsequent events.list / sessions.retrieve 行为(Top 10 #9)
 *
 * Future:
 *   - 20.5.6 session.error / 20.5.4 status_rescheduled(Top 10 #8,需 mock
 *     MCP server,见 §20.0.E,defer)
 *   - 20.5.1-5 其他 lifecycle 状态机
 */

import { describe, expect, it } from "vitest";
import { getClient, resetClientCache } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import { createThreeLayerCollector } from "../../src/utils/three-layer-collector.ts";
import { rawSseStream } from "../../src/utils/raw-sse.ts";
import { dumpCorpus } from "../../src/utils/corpus.ts";

const TURN_STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
];

describe("20.5 Session Lifecycle Events(Phase 2 Top 10)", () => {
  /**
   * 20.5.7A — archive session,events.list 仍可读;active stream 命运实测。
   */
  it("20.5.7A archive session — events.list 仍可读 + active stream 命运", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.5.7A archive lifecycle",
    });

    let cleanedUp = false;
    try {
      const rawSsePromise = rawSseStream(session.id, {
        maxWaitMs: 20_000,
        stopTypes: ["session.error", "session.deleted", "session.status_terminated"],
      });

      const collector = createThreeLayerCollector(session.id, {
        defaultStopTypes: TURN_STOP_TYPES,
        defaultMaxWaitMs: 30_000,
      });
      await collector.openStream();
      await new Promise((r) => setTimeout(r, 200));

      await collector.send({
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
      });
      await collector.consume();

      const preArchive = await collector.listSnapshot();

      const archived = await client.beta.sessions.archive(session.id);
      console.log("[20.5.7A] archive response status:", archived.status, "archived_at:", archived.archived_at);

      await new Promise((r) => setTimeout(r, 1500));

      let postArchiveStreamEvents: number;
      try {
        const afterArchive = await collector.consume({
          stopTypes: ["session.deleted", "session.status_terminated", "session.error"],
          maxWaitMs: 3000,
        });
        postArchiveStreamEvents = afterArchive.length;
      } catch (err) {
        postArchiveStreamEvents = -1;
        console.log("[20.5.7A] post-archive consume threw:", (err as Error).message);
      }

      let postArchiveListEvents: number;
      let postArchiveListError: number | undefined;
      try {
        const events: unknown[] = [];
        for await (const e of client.beta.sessions.events.list(session.id, { limit: 100 })) {
          events.push(e);
        }
        postArchiveListEvents = events.length;
      } catch (err) {
        postArchiveListEvents = -1;
        postArchiveListError = (err as { status?: number } | null)?.status;
      }

      let retrieveStatus: number | string;
      try {
        const r = await client.beta.sessions.retrieve(session.id);
        retrieveStatus = r.status;
      } catch (err) {
        retrieveStatus = (err as { status?: number } | null)?.status ?? "unknown";
      }

      const rawSse = await rawSsePromise;
      const snapshot = await collector.finalize();

      const dump = await dumpCorpus("session-archive-stream-behavior", snapshot, {
        description:
          "§20.5.7A — archive session 后:events.list 是否仍可读(F-0006 已印证);active SSE stream 是否被 server 主动 close;archive 调用后短时间内 SDK stream / raw-sse 是否收到任何新事件。",
        rawSse,
        additionalMeta: {
          case: "20.5.7A",
          archive_response_status: archived.status,
          archive_response_archived_at: archived.archived_at,
          pre_archive_list_count: preArchive.events.length,
          post_archive_stream_events_count: postArchiveStreamEvents,
          post_archive_list_events_count: postArchiveListEvents,
          post_archive_list_error_status: postArchiveListError,
          retrieve_after_archive_status: retrieveStatus,
          raw_sse_exit_reason: rawSse.meta.exitReason,
        },
      });

      expect(archived.archived_at).toBeTruthy();
      expect(archived.status).toBe("terminated");
      expect(postArchiveListEvents).toBeGreaterThan(0);
      expect(postArchiveListError).toBeUndefined();

      console.log("[20.5.7A] corpus:", dump.corpusDir);
      console.log("[20.5.7A] pre-archive list count:", preArchive.events.length);
      console.log("[20.5.7A] post-archive list count:", postArchiveListEvents);
      console.log("[20.5.7A] post-archive new stream events:", postArchiveStreamEvents);
      console.log("[20.5.7A] retrieve-after-archive status:", retrieveStatus);
      console.log("[20.5.7A] raw-sse total events:", rawSse.events.length, "exit:", rawSse.meta.exitReason);
      console.log("[20.5.7A] raw-sse total wall-clock (ms):", rawSse.meta.durationMs.toFixed(0));

      const tailTypes = rawSse.events.slice(-3).map((e) => {
        try {
          return (JSON.parse(e.data) as { type?: string }).type;
        } catch {
          return "<unparseable>";
        }
      });
      console.log("[20.5.7A] raw-sse last 3 event types:", tailTypes);
      cleanedUp = true;
    } finally {
      if (!cleanedUp) {
        try {
          await client.beta.sessions.archive(session.id);
        } catch {
          // ignore
        }
      }
      resetClientCache();
    }
  }, 90_000);

  /**
   * 20.5.7B — delete idle session — Top 10 #9。
   *
   * **极简流水**(不开 SDK iterator,避免 finalize 时 iter.return 卡死):
   *   1. create + 用 raw-sse 单独监听整段(20s deadline)
   *   2. 直接 SDK send 触发 turn(no SDK stream)
   *   3. wait turn 时间 ~6s
   *   4. delete
   *   5. raw-sse 自己按 stopType / deadline / server close 退出
   *   6. await raw-sse,查 lines + exitReason
   *   7. 试 list / retrieve 看 post-delete 行为
   */
  it("20.5.7B delete idle session — in-band session.deleted event + post-delete list/retrieve", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "20.5.7B delete lifecycle",
    });

    let cleanedUp = false;
    try {
      const rawSsePromise = rawSseStream(session.id, {
        maxWaitMs: 15_000,
        stopTypes: ["session.deleted", "session.error", "session.status_terminated"],
      });
      await new Promise((r) => setTimeout(r, 300));

      // 用 SDK 直接 send(不开 SDK iterator,raw-sse 独立监听)
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
      });

      // 等 turn 完成(此 case 不关心 turn 细节,只关心 delete 行为)
      await new Promise((r) => setTimeout(r, 6000));

      const preDeleteEvents: unknown[] = [];
      for await (const e of client.beta.sessions.events.list(session.id, { limit: 100 })) {
        preDeleteEvents.push(e);
      }
      console.log("[20.5.7B] pre-delete list count:", preDeleteEvents.length);

      const sessionsAny = client.beta.sessions as unknown as {
        delete?: (id: string) => Promise<unknown>;
      };
      if (typeof sessionsAny.delete !== "function") {
        throw new Error("SDK beta.sessions.delete unavailable");
      }
      const deleteResp = await sessionsAny.delete(session.id);
      console.log("[20.5.7B] delete response:", deleteResp);

      // await raw-sse — exit 原因由 stopType / deadline / server close 决定
      const rawSse = await rawSsePromise;
      console.log("[20.5.7B] raw-sse exit reason:", rawSse.meta.exitReason);
      console.log("[20.5.7B] raw-sse total events:", rawSse.events.length);
      console.log("[20.5.7B] raw-sse duration_ms:", rawSse.meta.durationMs.toFixed(0));

      const sawSessionDeletedInRawSse = rawSse.events.some((e) => {
        try {
          return (JSON.parse(e.data) as { type?: string }).type === "session.deleted";
        } catch {
          return false;
        }
      });
      const tailTypes = rawSse.events.slice(-3).map((e) => {
        try {
          return (JSON.parse(e.data) as { type?: string }).type;
        } catch {
          return "<unparseable>";
        }
      });
      console.log("[20.5.7B] **raw-sse saw session.deleted event?**", sawSessionDeletedInRawSse);
      console.log("[20.5.7B] raw-sse last 3 event types:", tailTypes);

      let postDeleteListEvents: number;
      let postDeleteListError: number | undefined;
      try {
        const events: unknown[] = [];
        for await (const e of client.beta.sessions.events.list(session.id, { limit: 100 })) {
          events.push(e);
        }
        postDeleteListEvents = events.length;
      } catch (err) {
        postDeleteListEvents = -1;
        postDeleteListError = (err as { status?: number } | null)?.status;
      }
      console.log("[20.5.7B] post-delete list:", postDeleteListEvents, "error_status:", postDeleteListError);

      let retrieveStatus: number | string;
      try {
        await client.beta.sessions.retrieve(session.id);
        retrieveStatus = "200 ok(unexpected)";
      } catch (err) {
        retrieveStatus = (err as { status?: number } | null)?.status ?? "unknown";
      }
      console.log("[20.5.7B] retrieve-after-delete status:", retrieveStatus);

      // dump corpus — 这次只有 raw-sse(stub snapshot 占位)
      const stubSnapshot = {
        baseline: 0,
        L0: { stream: [], listSnapshots: [], sendCalls: [] },
        L1: [],
        L2: [],
        stats: {
          l0StreamCount: 0,
          l0ListSnapshotCount: 0,
          l0ListEventTotal: 0,
          l0SendCallCount: 0,
          l0SendEventTotal: 0,
          l1Count: 0,
          l2Count: 0,
        },
      };
      const dump = await dumpCorpus("session-deleted-stream-behavior", stubSnapshot, {
        description:
          "Top 10 #9 / §20.5.7B — delete idle session 后 active SSE stream 是否先收 in-band session.deleted event 再 close;后续 events.list / sessions.retrieve 行为(404 / 410 / 200+tombstone)。极简流水避开 SDK iterator finalize 卡死,仅用 raw-sse + 直接 SDK 调用。",
        rawSse,
        additionalMeta: {
          case: "20.5.7B",
          top10: "#9",
          delete_response: deleteResp,
          pre_delete_list_count: preDeleteEvents.length,
          raw_sse_saw_session_deleted: sawSessionDeletedInRawSse,
          raw_sse_exit_reason: rawSse.meta.exitReason,
          raw_sse_tail_types: tailTypes,
          post_delete_list_events_count: postDeleteListEvents,
          post_delete_list_error_status: postDeleteListError,
          retrieve_after_delete_status: retrieveStatus,
        },
      });

      expect(retrieveStatus).toBe(404);
      console.log("[20.5.7B] corpus:", dump.corpusDir);

      cleanedUp = true;
    } finally {
      if (!cleanedUp) {
        try {
          await client.beta.sessions.archive(session.id);
        } catch {
          // ignore
        }
      }
      resetClientCache();
    }
  }, 60_000);
});
