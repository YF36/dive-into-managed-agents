/**
 * Phase 2.5 Batch D — §20.7 list page edges(20.7.3 / 20.7.4 / 20.7.5 / 20.7.7)。
 */

import { afterEach, describe, expect, it } from "vitest";
import { getClient, resetClientCache, tagWithRunId, getConfig } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";

interface ListPage {
  data: Array<{ id?: string; type?: string; processed_at?: string; created_at?: string }>;
  next_page?: string | null;
  has_more?: boolean;
}

/** raw fetch list — 拿到单页 + page 元信息(SDK auto-paginate 屏蔽细节) */
async function rawList(sessionId: string, params: Record<string, string> = {}): Promise<ListPage> {
  const cfg = getConfig();
  const apiKey = process.env["ANTHROPIC_AWS_API_KEY"]!;
  const url = new URL(`https://aws-external-anthropic.${cfg.awsRegion}.api.aws/v1/sessions/${sessionId}/events`);
  url.searchParams.set("beta", "true");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "x-api-key": apiKey,
      "anthropic-workspace-id": cfg.workspaceId,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
    },
  });
  if (!resp.ok) throw new Error(`list failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as ListPage;
}

async function prepareSessionWithTurn() {
  const client = getClient();
  await client.ready;
  const agentId = await getSharedAgentId();
  const envId = await getSharedEnvironmentId();
  const session = await client.beta.sessions.create({
    agent: agentId, environment_id: envId, metadata: tagWithRunId(),
  });
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
  });
  await new Promise((r) => setTimeout(r, 8000));
  return { client, session };
}

describe("20.7 list page edges(Phase 2.5 Batch D)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.slice().reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
    resetClientCache();
  });

  /** 20.7.3 quiescent page stability — limit=N first page,then 2nd page with page 二次拉 */
  it("20.7.3 quiescent page stable - 同 page 二次拉 byte-equal", async () => {
    const { client, session } = await prepareSessionWithTurn();
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const page1 = await rawList(session.id, { limit: "3" });
    console.log("[20.7.3] page1 data count:", page1.data?.length, "next_page:", !!page1.next_page);
    expect(page1.data?.length).toBeGreaterThan(0);

    if (!page1.next_page) {
      console.log("[20.7.3] events 不够多,无 next_page — 验证不完整");
      return;
    }

    const page = page1.next_page!;
    const page2a = await rawList(session.id, { limit: "3", page });
    const page2b = await rawList(session.id, { limit: "3", page });
    console.log("[20.7.3] page2a count:", page2a.data?.length, "page2b count:", page2b.data?.length);

    // byte-equal? compare ids
    const ids2a = page2a.data?.map((e) => e.id) ?? [];
    const ids2b = page2b.data?.map((e) => e.id) ?? [];
    console.log("[20.7.3] page2a ids:", ids2a);
    console.log("[20.7.3] page2b ids:", ids2b);
    expect(ids2a).toEqual(ids2b);
    console.log("[20.7.3] ✓ 同 page 二次拉 id 序一致");
  }, 60_000);

  /** 20.7.4 append + same page — turn 后 send 一个新 user.message,旧 page 行为 */
  it("20.7.4 append after page - 旧 page 是否含新 events", async () => {
    const { client, session } = await prepareSessionWithTurn();
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const page1 = await rawList(session.id, { limit: "3" });
    if (!page1.next_page) {
      console.log("[20.7.4] events 不够多,skip");
      return;
    }
    const page = page1.next_page!;
    const beforeAppend = await rawList(session.id, { limit: "100", page });
    const beforeCount = beforeAppend.data?.length ?? 0;
    console.log("[20.7.4] before append, page 续拉 count:", beforeCount);

    // Append new turn
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Once more, 'ok'." }] }],
    });
    await new Promise((r) => setTimeout(r, 8000));

    // Re-list with same page
    const afterAppend = await rawList(session.id, { limit: "100", page });
    const afterCount = afterAppend.data?.length ?? 0;
    console.log("[20.7.4] after append, same page count:", afterCount);

    // 关键观察:page 是否含新 events
    const newEventCount = afterCount - beforeCount;
    console.log("[20.7.4] page 续拉 delta(新事件含/不含):", newEventCount);
    if (newEventCount > 0) {
      console.log("[20.7.4] ✓ page 是 \"moving view\"(continues from logical position,包含 newer)");
    } else {
      console.log("[20.7.4] ✓ page 是 \"frozen page boundary\"(只返 page 之后的 originally existed events)");
    }
  }, 60_000);

  /** 20.7.5 asc vs desc — order param 翻转结果 */
  it("20.7.5 asc vs desc order", async () => {
    const { client, session } = await prepareSessionWithTurn();
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const asc = await rawList(session.id, { limit: "100", order: "asc" });
    const desc = await rawList(session.id, { limit: "100", order: "desc" });
    const ascIds = asc.data?.map((e) => e.id) ?? [];
    const descIds = desc.data?.map((e) => e.id) ?? [];
    console.log("[20.7.5] asc count:", ascIds.length, "desc count:", descIds.length);
    console.log("[20.7.5] asc 前 3:", ascIds.slice(0, 3));
    console.log("[20.7.5] desc 前 3:", descIds.slice(0, 3));

    expect(ascIds.length).toBe(descIds.length);
    // desc 应是 asc 的 reverse
    const ascReversed = [...ascIds].reverse();
    expect(descIds).toEqual(ascReversed);
    console.log("[20.7.5] ✓ desc === reverse(asc)");
  }, 60_000);

  /** 20.7.7 types filter + created_at filter */
  it("20.7.7 types[] + created_at filter", async () => {
    const { client, session } = await prepareSessionWithTurn();
    cleanup.push(async () => { await client.beta.sessions.archive(session.id); });

    const all = await rawList(session.id, { limit: "100" });
    const allCount = all.data?.length ?? 0;
    console.log("[20.7.7] no filter count:", allCount);

    // types filter
    const userOnly = await rawList(session.id, { limit: "100", "types[]": "user.message" });
    const userMsgs = userOnly.data?.filter((e) => e.type === "user.message") ?? [];
    console.log("[20.7.7] types=[user.message] count:", userOnly.data?.length, "of which user.message:", userMsgs.length);
    expect(userOnly.data?.every((e) => e.type === "user.message")).toBe(true);

    // created_at filter — 用 first event created_at 做 cutoff
    const firstCreated = all.data?.[0]?.created_at;
    if (firstCreated) {
      // events strictly after first
      const afterFirst = await rawList(session.id, { limit: "100", "created_at[gt]": firstCreated });
      console.log("[20.7.7] created_at>first count:", afterFirst.data?.length, "(应 < total)");
      expect((afterFirst.data?.length ?? 0)).toBeLessThan(allCount);
    }
  }, 60_000);
});
