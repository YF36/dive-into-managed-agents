/**
 * Infrastructure smoke for `src/utils/corpus.ts`
 * (Phase 2 §20.0.D 验收 + §20.0 全 ABCD 端到端集成验证)。
 *
 * 这是 Phase 2 prep 阶段的"末端 smoke":
 *   - §20.0.B raw-sse helper
 *   - §20.0.C 三层 collector
 *   - §20.0.D corpus helper
 *   全跑通,可以正式开始 §20.1+ 实测 case。
 *
 * 流程:
 *   1. create session
 *   2. **同时**开 raw-sse 流 + 3-layer collector(两条 path 各跑各)
 *   3. send user.message
 *   4. raw-sse 走自己 consume,3-layer 也 consume
 *   5. dumpCorpus 把 3-layer snapshot + raw-sse 结果落到
 *      `sibling-repo/event-corpus/_phase2-prep-smoke/`
 *   6. 验证目录结构 + 文件就位
 *
 * 此 smoke 通过即 Phase 2 prep §20.0 ABCD 全部完成,可以开始 §20.1+ case。
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getClient, resetClientCache } from "../../src/client.ts";
import { getSharedAgentId } from "../../src/fixtures/agents.ts";
import { getSharedEnvironmentId } from "../../src/fixtures/environments.ts";
import {
  createThreeLayerCollector,
} from "../../src/utils/three-layer-collector.ts";
import { rawSseStream } from "../../src/utils/raw-sse.ts";
import { dumpCorpus, describeCorpusRoot } from "../../src/utils/corpus.ts";
import { safeArchive } from "../../src/fixtures/sessions.ts";

describe("§20.0 ABCD 集成 smoke(corpus helper 验收 + Phase 2 prep 端到端)", () => {
  it("create → openStream(2 path)→ send → consume → dumpCorpus → 检查文件", async () => {
    const client = getClient();
    await client.ready;
    const agentId = await getSharedAgentId();
    const envId = await getSharedEnvironmentId();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: "phase-2-prep-smoke",
    });

    try {
      // raw-sse 走自己一条 stream(独立 HTTP 连接)
      const rawSsePromise = rawSseStream(session.id, {
        maxWaitMs: 30_000,
        stopTypes: ["session.status_idle", "session.error", "session.status_terminated"],
      });

      // 3-layer collector 走 SDK iterator
      const collector = createThreeLayerCollector(session.id);
      await collector.openStream();

      // 给两条 path 一点时间建连
      await new Promise((r) => setTimeout(r, 200));

      await collector.send({
        events: [{ type: "user.message", content: [{ type: "text", text: "Reply 'ok'." }] }],
      });

      await collector.listSnapshot();
      await collector.consume();
      await collector.listSnapshot();

      const [snapshot, rawSse] = await Promise.all([collector.finalize(), rawSsePromise]);

      console.log("[§20.0 smoke] corpus root:", describeCorpusRoot());
      console.log("[§20.0 smoke] L0 stream/list/send:", snapshot.stats.l0StreamCount, snapshot.stats.l0ListEventTotal, snapshot.stats.l0SendEventTotal);
      console.log("[§20.0 smoke] L1:", snapshot.stats.l1Count, "L2:", snapshot.stats.l2Count);
      console.log("[§20.0 smoke] raw-sse lines/events:", rawSse.lines.length, rawSse.events.length);

      const dump = await dumpCorpus("_phase2-prep-smoke", snapshot, {
        description: "Phase 2 prep §20.0 ABCD 集成验收 smoke — happy path end-turn,两条 path(raw-sse + SDK iterator)各跑一次",
        rawSse,
        additionalMeta: {
          phase: "2-prep",
          test_file: "tests/streaming/corpus-helper-smoke.test.ts",
        },
      });

      console.log("[§20.0 smoke] dumped corpus dir:", dump.corpusDir);
      console.log("[§20.0 smoke] files:", dump.files);

      // 必有文件断言
      expect(existsSync(dump.corpusDir)).toBe(true);
      for (const f of ["meta.json", "L0/stream.jsonl", "L1.jsonl", "L2.jsonl"]) {
        const fullPath = resolve(dump.corpusDir, f);
        expect(existsSync(fullPath), `missing ${f}`).toBe(true);
        const s = await stat(fullPath);
        expect(s.size).toBeGreaterThan(0);
      }
      // raw-sse 目录就位
      for (const f of ["raw-sse/raw-frames.txt", "raw-sse/parsed-events.jsonl", "raw-sse/request-meta.json"]) {
        const fullPath = resolve(dump.corpusDir, f);
        expect(existsSync(fullPath), `missing ${f}`).toBe(true);
      }
      // list-snapshots 至少 2 个(本 case 拉了 2 次)
      expect(existsSync(resolve(dump.corpusDir, "L0/list-snapshots/00.jsonl"))).toBe(true);
      expect(existsSync(resolve(dump.corpusDir, "L0/list-snapshots/01.jsonl"))).toBe(true);
      // send-responses 至少 1 个
      expect(existsSync(resolve(dump.corpusDir, "L0/send-responses/00.json"))).toBe(true);
    } finally {
      await safeArchive(session.id);
      resetClientCache();
    }
  }, 90_000);
});
