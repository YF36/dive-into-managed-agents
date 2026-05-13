/**
 * CMA 没有 cursor / Last-Event-ID,reconnect 推荐模式是
 * "open stream + list history + 按 event_id 去重"。这个模块封装这一逻辑。
 *
 * 它同时是 AgentMatrix v1 黑盒托管 CMA 时 RuntimeDriver adapter 的早期原型。
 */

import { getClient } from "../client.ts";

export interface CollectedEvent {
  id: string;
  type: string;
  created_at?: string;
  processed_at?: string | null;
  // payload 字段保持松弛——按 type 在 invariants.ts 里校验
  [key: string]: unknown;
}

export interface CollectUntilOptions {
  /** 命中即停的 event type 集合(默认 session.status_idle / session.error / session.status_terminated) */
  stopTypes?: string[];
  /** 最长等待 ms(防卡死) */
  maxWaitMs?: number;
}

const DEFAULT_STOP_TYPES = [
  "session.status_idle",
  "session.error",
  "session.status_terminated",
  "session.deleted",
];

/**
 * 从 session SSE stream 收集事件,直到命中 stop_types 或超时。
 *
 * Phase 0 给最小实现,Phase 2 时扩展:
 * - 自动 reconnect on transient error
 * - list history seed(reconnect 后去重)
 * - heartbeat 监控
 */
export async function collectUntil(
  sessionId: string,
  options: CollectUntilOptions = {},
): Promise<CollectedEvent[]> {
  const client = getClient();
  const stopTypes = new Set(options.stopTypes ?? DEFAULT_STOP_TYPES);
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const startedAt = Date.now();

  const collected: CollectedEvent[] = [];
  const seenIds = new Set<string>();

  const stream = await client.beta.sessions.events.stream(sessionId);

  for await (const rawEvent of stream) {
    if (Date.now() - startedAt > maxWaitMs) break;
    const event = rawEvent as unknown as CollectedEvent;
    if (!event.id || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    collected.push(event);
    if (stopTypes.has(event.type)) break;
  }
  return collected;
}

/**
 * Phase 2 扩展用:同时拉 list history,跟 stream 合并去重。
 *
 * 调用顺序应是:
 * 1. open stream(buffer 起)
 * 2. list events from origin(seed seenIds)
 * 3. 消费 stream,按 id 去重
 *
 * Phase 0 仅 stub,Phase 2 实装。
 */
export async function streamWithHistory(
  _sessionId: string,
  _options: CollectUntilOptions = {},
): Promise<CollectedEvent[]> {
  throw new Error("streamWithHistory: Phase 2 实装");
}
