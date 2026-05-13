# Streaming & Events(Phase 2 展开)

> Phase 0 骨架。Phase 2 时把每个 section 展开成完整用例表。

## 范围

- SSE wire 协议探测(framing / heartbeat / close 条件)
- Reconnect 三种模式实测(纯 stream / stream+list+dedupe / `Last-Event-ID`)
- 30 种 event 触发场景全覆盖
- stream / list 双通道一致性
- events.send 批量 + 边界

## 关键不变量

- `event_id` 全局唯一
- `processed_at` 单调 null → timestamp(不会反向)
- 同 session 内 event 顺序在 stream / list 两边一致
- append-only(已发生的 event 不被 update / delete)
- events.list 的 cursor 稳定性(同 cursor 二次拉取字节级一致)

## 用例分组(Phase 2 展开)

### 20.1 SSE wire 协议探测(预计 8-12 条)

- 20.1.1 Content-Type / Accept header
- 20.1.2 event framing:`data:` 行格式
- 20.1.3 是否有 `event:` 行(命名 event type)
- 20.1.4 是否有 `id:` 行(SSE 标准 last-event-id 机制)
- 20.1.5 heartbeat / keepalive 帧(是否有 `:` comment 行)
- 20.1.6 stream 正常 close(session.status_idle 后)
- 20.1.7 stream 异常 close(session.error / session.deleted)
- 20.1.8 stream open before send(quickstart race condition)
- 20.1.9 stream 长时间 idle 是否被服务端主动 close
- 20.1.10 客户端 abort stream 后再开新 stream

### 20.2 Reconnect 三种模式(预计 10-15 条)

模式 (a) 纯 stream:
- 20.2.1 断开连接 5s 后重连,中间事件是否 replay → 期望 **不 replay**(CMA 无 cursor)
- 20.2.2 同上但 60s 后,行为差异

模式 (b) 推荐 stream + list + dedupe:
- 20.2.3 open new stream → list events → 按 event_id 去重的完整流程
- 20.2.4 在去重窗口内 SDK 是否吞掉 stream 的旧事件
- 20.2.5 list 的 ordering(asc / desc)对去重逻辑的影响

模式 (c) 实验性 `Last-Event-ID`:
- 20.2.6 `Last-Event-ID: <event_id>` header 服务端是否识别(实验性,验证 SSE 标准实现)
- 20.2.7 服务端忽略 header 时的 fallback 行为

### 20.3 ~30 种 event 类型全覆盖(预计 25-30 条)

**事实可信度标注**(详见 [`00-overview.md` §10 source taxonomy](./00-overview.md#10-事实可信度-source-taxonomy)):本节 event type 全集**来自 SDK 类型 union**(`@anthropic-ai/sdk` `BetaManagedAgentsStreamSessionEvents`)。Phase 1 实施时**应该跑脚本从 SDK 类型生成 `event-catalog.generated.md`**,本节引用 generated 文档而不是手写枚举,避免漂移。下面是 Phase 0 的临时清单,带 source 标注:

每个 event type 至少一个用例触发 + 断言 payload schema:

**user.\*** (5) `[source: official docs + SDK type]`:`message` / `interrupt` / `tool_confirmation` / `custom_tool_result` / `define_outcome`

**agent.\*** (10) `[source: SDK type union]`:`message` / `thinking` / `tool_use` / `tool_result` / `mcp_tool_use` / `mcp_tool_result` / `custom_tool_use` / `thread_message_received` / `thread_message_sent` / `thread_context_compacted`

**session.\*** (11) `[source: SDK type union]`:`status_running` / `status_idle` / `status_rescheduled` / `status_terminated` / `error` / `thread_created` / `thread_status_running` / `thread_status_idle` / `thread_status_rescheduled` / `thread_status_terminated` / **`deleted`** `[source: SDK type union, unverified in official API ref]` — Phase 0 review M5 标出此项:SDK 暴露但官方 docs 未列,Phase 1 用例第一条就是 trigger + capture,确认是否真存在以及在什么条件下发

**span.\*** (5) `[source: SDK type union]`:`model_request_start` / `model_request_end` / `outcome_evaluation_start` / `outcome_evaluation_ongoing` / `outcome_evaluation_end`

(实际触发某些 event 需要 multi-agent / outcomes / 中断场景,会跟 `40-multi-agent-memory-outcomes.md` 重叠)

### 20.4 events.send 批量与边界(预计 8-12 条)

- 20.4.1 单 event POST
- 20.4.2 多 event 批量 POST(原子还是 partial commit?)
- 20.4.3 单批最大 event 数(实测上限)
- 20.4.4 send 到 terminated session → 期望 410 或 409,实测
- 20.4.5 send 到 archived session → 实测
- 20.4.6 send 到 deleted session → 期望 404
- 20.4.7 重复 POST 同 payload(无 idempotency-key)→ 是否产生重复 event_id
- 20.4.8 `tool_confirmation` 引用过期 tool_use_id → 错误码
- 20.4.9 `custom_tool_result` 引用错的 custom_tool_use_id → 错误码
- 20.4.10 user.interrupt 不带 session_thread_id(单 agent vs multi-agent 行为差异)
- 20.4.11 同时 user.interrupt 多个 thread

### 20.5 events.list 行为(预计 8-10 条)

- 20.5.1 默认 asc / 显式 desc
- 20.5.2 limit 边界(0 / 1 / 100 / 1000)
- 20.5.3 cursor 稳定性:同 cursor 二次拉取字节级一致
- 20.5.4 types[] filter
- 20.5.5 created_at 范围 filter
- 20.5.6 list 与 stream 的事件集合一致(`assertSseListConsistency`)
- 20.5.7 大量 event session 的分页深度
- 20.5.8 list 在 archive 后仍可读

## 预估用例总数

50-70 条(Phase 2 一次性 ship)
