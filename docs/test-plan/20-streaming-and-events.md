# Streaming & Events(Phase 2 协议研究计划)

> **2026-05-13 升级**:从"功能测试清单"升级到"协议研究计划"。
>
> 跑 Phase 2 不是为了"验证 CMA 流不丢事件"——那是 Anthropic 的事;是为了**借鉴 CMA event 设计的具体决定,反推 sibling notes repo 维护的跨 vendor event 协议**。CMA 是当前最完整的 managed agent 协议实现,每条字段、每条 race condition、每个 status code 都是设计 signal。
>
> 跟 Phase 1 不同的是:Phase 1 产出的是"vendor 行为 finding 集合";Phase 2 产出**"反推协议结论"**,直接喂 sibling notes repo 的 event-protocol 设计章节。

## 范围 / 反推目标

每个 sub-section 必须回答**两类问题**:

| 类别 | 形态 |
|---|---|
| **What CMA does** | 实测客观刻画(status code / 字段 / 顺序 / race 行为) |
| **What target protocol should do** | 反推决策(借鉴 / 增强 / 拒绝跟随 / 在 adapter 层补)|

第二类是真正交付物,沉淀到 sibling notes repo `research/managed-agents/findings/F-NNNN-*.md` + 顶层综合到 `cma-event-model.md`。

## 关键不变量(两层模型)

Phase 1 把 "append-only" 写成"event 不被 update / delete",在 CMA 是错的 — `processed_at` 字段允许 `null → timestamp` 单向更新(queued → processed ack)。正确的不变量分**两层**:

| 层 | 不变量 | 验证 |
|---|---|---|
| **Logical** | event 的 `id` / `type` / 业务 payload 字段 一旦发出**永不变** | 多次 list / archive 后 list,比较 byte equal |
| **Occurrence / read-model** | `processed_at` 允许且**只允许** `null → timestamp` 单向迁移 | stream / list 多路对比,**禁止** timestamp → null 或 timestamp → 不同 timestamp |

→ Phase 2 测试代码的 `assertEventLogAppendOnly` helper 要按这两层分别断言,**不能合一**。

其他不变量(实测确认 + 待测):

- event `id` 唯一性范围:workspace 全局 / session 局部 / thread vs primary stream 同 id 复用?**Phase 2 待测**(20.2.2 / 20.8)
- 同 session 内 event 顺序在 stream / list 两边一致(`assertSseListConsistency`)
- events.list 的 cursor 语义:在 quiescent session 下稳定;append 新事件后旧 cursor 行为待测(20.7)

## 与目标 event 协议的关键问题映射

实测要回答下列设计问题(每条都标明对应 sub-section):

| 问题 | sub-section | 决策选项 |
|---|---|---|
| 是否要保留 `sequence` 字段(int 全局单调)? | 20.4 + 20.9 | (a) 跟 CMA 一样不要(client 用 id 集合做去重)/ (b) 保留(driver 层合成)|
| 是否要 `parent_event_id` / `cause_event_id`? | 20.6 + 20.9 | CMA 用 `stop_reason.event_ids` 做隐式 ref,反推 explicit ref 是否更好 |
| `processed_at` 是协议字段还是 read-model 字段? | 20.3 + 20.9 | (a) 协议级承诺(client 必看)/ (b) read-model 投影(transport 层不见)|
| reconnect 是 occurrence-preserving 还是 id-consolidating? | 20.4 + 20.9 | 两种 dedupe 模式各自的 use case;协议是否提供 `Last-Event-ID` |
| `requires_action` 协议:blocking event_ids 是 explicit 字段还是 message? | 20.6 + 20.9 | partial resolve 行为反推 |
| Multi-agent 是 primary stream 投影 thread events 还是 thread 独立 stream? | 20.8 + 20.9 | session_thread_id 路由策略 |
| Error event 是 in-band(stream)还是 out-of-band(HTTP)? | 20.5 | session.error 在 stream 内 vs HTTP 4xx 各自 trigger |
| 是否区分 stable / gated event types? | 20.7 | research preview event 是否进 stable enum |

## 研究产物 + 证据格式

Phase 2 跑完后**应该产出**以下 artifact(目录结构):

```
dive-into/
└── docs/test-plan/
    └── 20-event-catalog.generated.md  ★ 从 SDK 类型 union 脚本生成,带每事件 source 标注
                                         (stable docs / SDK only / research preview)

sibling notes repo (research/managed-agents/)/
├── event-corpus/                       ★ Phase 2 新增 — 每场景的 stream / list / send response 三路原始记录
│   ├── happy-path-end-turn/
│   │   ├── stream.jsonl                  (从 SSE iterator 收的 events)
│   │   ├── list-snapshot.jsonl           (turn 结束后 list events 全集)
│   │   ├── send-response.json            (POST send 返回值)
│   │   └── raw-sse.txt                   (从 raw fetch 抓的 wire-level 帧)
│   ├── tool-confirmation-flow/...
│   ├── custom-tool-blocking-flow/...
│   ├── session-error/...
│   └── ...
├── artifacts/<date>/<run_id>/...       (每 case 的 Recorder 输出,沿用 Phase 1 模式)
└── findings/
    ├── F-NNNN-cma-event-model.md       ★ Phase 2 顶层综合 finding(回写跨 vendor 协议章节)
    ├── F-NNNN-processed-at-semantics.md
    ├── F-NNNN-requires-action-protocol.md
    └── ...
```

`event-corpus/` 跟 `artifacts/` 的区别:**artifacts 是每 case 完整原始数据**(用于审计 / 回放);**event-corpus 是每场景策展过的代表性样本**(用于跨 vendor 对照引用,人类可读)。corpus 文件少而精,artifacts 全而散。

事实可信度标注沿用 [`00-overview.md` §10 source taxonomy](./00-overview.md):每条事件 / 字段 / 不变量都标 `[source: official docs | API ref | SDK type | 实测]`。

## 20.0 测试基础设施 prep(执行前)

| 项 | 工作 | 文件 |
|---|---|---|
| Catalog 生成脚本 | 从 `BetaManagedAgentsStreamSessionEvents` union 反射,输出 markdown 表(event type / payload TS 类型 / source) | `tests-cma/scripts/generate-event-catalog.ts`(新增)+ 输出 `20-event-catalog.generated.md` |
| Raw SSE fetch helper | 绕过 SDK 直接 `fetch(stream URL)`,逐行读 `data:` / `event:` / `id:` / heartbeat | `tests-cma/src/utils/raw-sse.ts`(新增)|
| `streamWithHistory` 实装 | Phase 0 stub → 完整 stream + list + 客户端两种 dedupe 模式 | `tests-cma/src/utils/stream.ts` 已 stub,Phase 2 补 |
| Event schema validator | 按 event type 校验必填字段 + 类型 | `tests-cma/src/utils/invariants.ts:assertSchemaForType` |
| Event corpus capture helper | 把当前 case 的 stream / list / send response 三路 dump 到 corpus 目录 | `tests-cma/src/utils/corpus.ts`(新增)|

这些基础设施先做,Phase 2 子 group 才能写。

## 20.1 Raw SSE Wire(SDK 之下的真 wire)

> **关键**:SDK async iterator 已经把原始 SSE 帧吞掉了,只测 SDK object 测不到真 wire。本 sub-section **必须走 raw fetch / curl 路径**,SDK 路径作为第二验证。

| Case | Path | What | 反推 |
|---|---|---|---|
| 20.1.1 | raw fetch | Content-Type / Accept 协商(`text/event-stream` 必有)| 协议层 wire content type 约定 |
| 20.1.2 | raw fetch | `data:` 行 framing(JSON-per-line / multi-line?)| wire format 选 SSE 还是 NDJSON 还是 gRPC stream |
| 20.1.3 | raw fetch | 是否有 `event:` 命名行 vs 全部 `data:` | client 是否要从 payload 自己解析 type |
| 20.1.4 | raw fetch | 是否有 `id:` 行(SSE 标准 Last-Event-ID 机制)| 是否走 SSE 标准 reconnect path |
| 20.1.5 | raw fetch | heartbeat / keepalive(`:` 注释行 / `event: ping` / TCP keepalive)| 协议是否要应用层 ping;heartbeat 间隔 |
| 20.1.6 | raw fetch + SDK | 正常 close 时(session_idle 后)server 发什么 vs 直接 TCP FIN | client 怎么区分"事件流结束" vs "连接断了"|
| 20.1.7 | raw fetch + SDK | server-side close 异常(session.error / session.deleted)| in-band 错误事件 + close vs HTTP error |
| 20.1.8 | raw fetch + SDK | 长时间(60s+)idle 是否被 server 主动 close | session keepalive 协议 |
| 20.1.9 | raw fetch | 客户端 abort 后 server 是否记录 / 留 zombie 资源 | client 主动断流的副作用 |

**产出**:`event-corpus/raw-sse/*.txt`(每种场景的 wire 帧)+ `findings/F-NNNN-cma-sse-wire-format.md`。

## 20.2 Canonical Event Envelope(stream / list / send response 三路对比)

每个事件在 3 个观测点出现:**stream**(SSE iterator)/ **list**(events.list)/ **send response**(POST /events 的返回值)。三路字段是否完全一致是协议设计的关键 — **如果 stream 有 `processed_at` 但 list 没有(或反之),透过 SDK 看到的不是同一个对象模型**。

| Case | What | 反推 |
|---|---|---|
| 20.2.1 | 每个 event type 在 stream / list / send response 的字段全集对比 | 协议级 vs read-model 字段划分 |
| 20.2.2 | event `id` 唯一性范围:同一 workspace / 多 session / thread vs primary stream 是否 ID 复用 | 协议是否需要 (workspace, session, thread) 三段 namespace |
| 20.2.3 | created_at / updated_at / processed_at 三个时间戳的语义和单调性 | 协议字段语义文档化 |
| 20.2.4 | usage / tool / outcome 等可选字段在不同 path 是否一致 | 字段稀疏 vs 全集 |

**产出**:`event-corpus/envelope-fields/*.json`(每事件三路 dump 一份)+ envelope-fields 综合表 → `event-catalog.generated.md` 自动补全。

## 20.3 processed_at & occurrence semantics(Phase 2 核心)

**最重要的 sub-section** — `processed_at` 决定了 event 协议是单相还是双相,这是 sibling notes repo `protocol` 章节的核心未决问题。

Phase 1 F-0001 已确认:`user.message` 在 stream 里**只出现一次**,但当时没看 list 多次。Phase 2 必须搞清楚下面 6 条:

| Case | What | 反推 |
|---|---|---|
| 20.3.1 | user.message **stream** 里同 id 是否出现 2 次(queued + processed)| 协议是单相还是双相 occurrence |
| 20.3.2 | user.message **list** 在 ack 前 / ack 后两次拉取,同 id 对象 `processed_at` 字段差异 | list 是 snapshot view 还是 occurrence log |
| 20.3.3 | events.send POST 返回值里是否含 queued event(立刻 echo back)| POST 是 fire-and-forget 还是 echo-with-ack |
| 20.3.4 | 先 list(ack 前)+ 立刻再 list(假定 ack 中)+ 等 turn 结束再 list:同 id 在三次 snapshot 的 processed_at 演变 | ack 状态机的中间态可见性 |
| 20.3.5 | agent.* / session.* / span.* 事件:它们的 processed_at 是 always set on emit 还是有自己的双相?| 仅 user.* 走 queued-processed,还是全部事件?|
| 20.3.6 | archive / delete session 后,list 仍可读,processed_at 字段是否还能变化 | terminal 状态 ack 冻结 |

**产出**:`findings/F-NNNN-processed-at-semantics.md`(顶级 finding,直接喂 protocol 章节)。

## 20.4 Stream + List Recovery(reconnect 协议反推)

Phase 0 review 已校准 Reconnect 计划应区分两种 dedupe 模式 — 本节明确化:

### 两种模式

| 模式 | 用途 | 实现 |
|---|---|---|
| **id-consolidating** | UI 端 — "同 id 算同一张卡片",ack 算字段更新 | `seenIds: Set<id>`,二次见 id 时只更新字段不新增 entry |
| **occurrence-preserving** | Transport / recovery — 不能吞掉 queued + processed 两次 occurrence(若有)| 不 dedupe,每次 occurrence 都记录 |

如果用 id-consolidating 跑 reconnect 测试,**会吞掉关键 ack 信号**(F-0001 之所以漏掉 user.message double-occurrence 的可能性,就是因为 Phase 0 默认 dedupe by event_id)。

### Cases

| Case | What | 反推 |
|---|---|---|
| 20.4.1 | stream-first happy path(open stream → send → consume)无丢失 | 印证 quickstart 推荐顺序 |
| 20.4.2 | send-then-stream race(明知错的顺序)漏哪些事件 — 是否漏 status_running、user.message ack? | client 不依照 quickstart 的代价 |
| 20.4.3 | stream 断开 5s 期间制造 1 个事件(简单回复)→ 重连 + list seed:用 occurrence-preserving 模式合并能否恢复 | reconnect 协议是否需要 Last-Event-ID |
| 20.4.4 | 同上但 60s 断开 + 制造 blocking event(tool requires_action)→ 验证状态机一致性 | 长断线场景的协议保障 |
| 20.4.5 | id-consolidating vs occurrence-preserving 同输入下结果差异 | 两种模式各自适用场景 |
| 20.4.6 | events.send 同一 payload 重 POST → 服务端是否生成重复 event(无 idempotency-key 的代价)| 协议是否要 idempotency-key |
| 20.4.7 | `Last-Event-ID` header 实验性发送 — server 是否识别 | SSE 标准 reconnect 协议是否实现 |

**产出**:`event-corpus/reconnect-scenarios/*` + `findings/F-NNNN-reconnect-protocol.md`。

## 20.5 Session Lifecycle Events(协议级状态机)

Phase 1 F-0006 已建立 session 状态机基础(idle / running / terminated;archive 改 status)。Phase 2 把 lifecycle events 跟 status 字段对应起来。

| Case | What | 反推 |
|---|---|---|
| 20.5.1 | status_running → status_idle (`stop_reason.type=end_turn`) happy path | baseline lifecycle 事件顺序 |
| 20.5.2 | requires_action 触发(custom_tool_use blocking)→ idle with `stop_reason.event_ids=[blocking_id]` | 协议 requires_action 语义 |
| 20.5.3 | retries_exhausted(MCP 5xx N 次后)| terminal failure 形态 |
| 20.5.4 | status_rescheduled 触发条件 + 自动恢复时的事件流 | rescheduling 是 internal 重试还是 client 可见 |
| 20.5.5 | status_terminated(主动 archive vs 自然 end-of-life)的事件流差异 | terminated 是否区分原因 |
| 20.5.6 | session.error 触发(MCP 不可达 / model overload)→ session.error event payload vs HTTP 4xx | in-band error event vs out-of-band HTTP error |
| 20.5.7 | session.deleted event:delete 时 active stream 收到什么,然后 list 是否 404 | 关闭语义 + tombstone `[source: API reference]` |
| 20.5.8 | session object `status` 字段与 stream 内 session.status_* event 是否始终一致 | 协议状态机投影一致性 |

**产出**:lifecycle event 跟 session status 字段的 state machine 图 → `event-corpus/lifecycle/*` + `findings/F-NNNN-session-lifecycle-events.md`。

## 20.6 Tool / MCP / Custom Tool Event Chains(HITL / action gate)

> 用户 review 校准:`requires_action` + `stop_reason.event_ids` 是 event 设计精髓,Phase 0 骨架里只点到。本 sub-section 升为独立章节。

### 4 条核心链(每条独立 corpus)

| 链 | 事件序列 | 反推 |
|---|---|---|
| **Built-in tool** | agent.tool_use → agent.tool_result(automatic, no client gate)→ status_idle | tool execution 是 server-side 黑盒 |
| **MCP tool** | agent.mcp_tool_use → agent.mcp_tool_result → status_idle | MCP 是否也 server-side(vault token 注入) |
| **Custom tool blocking** | agent.custom_tool_use → status_idle (`stop_reason.event_ids=[custom_tool_use_id]`) → user.custom_tool_result(client send) → status_running → ... | client-side gate 完整闭环 |
| **Permission confirmation** | agent.* → status_idle (`stop_reason.event_ids=[?]`) → user.tool_confirmation (allow/deny) → status_running / terminate | confirmation 是 generic gate 还是 tool-specific |

### Cases

| Case | What | 反推 |
|---|---|---|
| 20.6.1 | built-in tool 完整序列 capture | baseline tool lifecycle |
| 20.6.2 | MCP tool 完整序列(用 .invalid URL 触发失败也行,关键看 tool_use / tool_result 事件)| MCP 与 built-in 字段差异 |
| 20.6.3 | custom_tool 完整 blocking flow(声明 custom tool → trigger → resolve)| client gate 协议 |
| 20.6.4 | **stop_reason.event_ids 引用** — blocking event 的 id 是否精确出现在 stop_reason | 协议级 explicit cause_event_id 雏形 |
| 20.6.5 | partial resolve:多个 blocking event,只 resolve 一部分,session 是否重发 idle with remaining event_ids | partial resolve 是否在协议层支持 |
| 20.6.6 | tool_confirmation allow / deny 两路 — deny 时 session 怎么走 | allow / deny gate 的协议形态 |
| 20.6.7 | 过期 tool_use_id 引用(confirm 一个已被 supersede 的 tool_use)| stale ref 错误码 |
| 20.6.8 | 错的 custom_tool_use_id(乱填一个 id)| 类型错误码,跟 F-0007 / F-0010 对照 |

**产出**:4 条核心链各自一份 corpus + `findings/F-NNNN-requires-action-protocol.md`。

## 20.7 Event Catalog & Schema Coverage(stable vs gated)

> 用户 review 校准:catalog 应拆 stable vs gated,不让 multi-agent / outcomes 阻塞 Phase 2 stable 部分。

按访问门槛分三类:

### Core stable(Phase 2 必跑)

来自 SDK union + 官方 docs 双重 source:

| 类别 | 事件 | 触发场景 |
|---|---|---|
| user.* | message / interrupt / tool_confirmation / custom_tool_result | 直接 send |
| agent.* | message / thinking / tool_use / tool_result / mcp_tool_use / mcp_tool_result / custom_tool_use | 跑 turn(可能需 mcp / custom tool 声明)|
| session.* | status_running / status_idle / status_rescheduled / status_terminated / error / deleted | lifecycle 自然触发 + delete API |
| span.* | model_request_start / model_request_end | 跑 turn |

### Multi-agent gated(需 research preview access,Phase 3 先确认后跑)

`agent.thread_message_received / thread_message_sent / thread_context_compacted`
`session.thread_created / thread_status_*` (4 种)

`agent.delegation` 是早期二手汇编误称,SDK union 不存在 — 不出现在 catalog。

### Outcomes gated(需 research preview access,Phase 3 先确认后跑)

`user.define_outcome`
`span.outcome_evaluation_start / ongoing / end`

### Cases

| Case | What | 反推 |
|---|---|---|
| 20.7.1 | 从 SDK union 反射生成 `20-event-catalog.generated.md`(脚本)| 文档跟 SDK 不漂移 |
| 20.7.2 | 每个 stable event 至少 1 个触发 case + schema snapshot dump | schema 全集 |
| 20.7.3 | events.list cursor:quiescent session 同 cursor 二次拉取字节级一致 | cursor 协议语义 1 |
| 20.7.4 | events.list cursor:append 新事件后旧 cursor 是否仍稳定 | cursor 协议语义 2(moving view vs frozen view)|
| 20.7.5 | events.list asc / desc 互通:asc cursor 能否在 desc 用 | cursor 方向独立性 |
| 20.7.6 | events.list 在 archive / delete 后是否仍可读(对照 lifecycle)| 历史可读性边界 |
| 20.7.7 | types[] / created_at filter | list filter 表达力 |

**产出**:`20-event-catalog.generated.md`(每次 SDK 升级重跑)+ 每事件 schema snapshot。

## 20.8 Multi-agent Thread Streams(gated,Phase 3 时再确认)

> 用户 review 校准:不是"事件类型覆盖",是测 **primary stream 与 thread stream 的投影关系**。

| Case | What | 反推 |
|---|---|---|
| 20.8.1 | primary stream 是否包含 thread events(cross-post)还是只走 thread stream | 协议是否要 stream 路由层 |
| 20.8.2 | thread-specific stream(`sessions.threads.stream(thread_id)`)与 primary stream 同时开,事件分布对比 | thread namespace 独立性 |
| 20.8.3 | 同一事件如果同时出现在 primary + thread stream,id 是否一致(还是各自一份 id)| event id 跨 stream 复用语义 |
| 20.8.4 | `session_thread_id` 字段路由:primary stream 看到的事件是否都有 thread_id,thread stream 是否过滤 | 路由字段语义 |
| 20.8.5 | child thread status 与 session 顶层 status 的 aggregation:thread 都 idle 时 session 是否 idle | 协议层状态聚合规则 |
| 20.8.6 | thread events.list 是否走独立 endpoint | API surface 拆分 |

**产出**:thread stream / primary stream 关系图 + `findings/F-NNNN-multi-agent-stream-projection.md`(Phase 3 阶段填)。

## 20.9 跨 Vendor Event 协议设计反推(本 Phase 顶层综合)

> 本节是 Phase 2 的"why"。前 8 个 sub-section 是 "what CMA does",本节是 "what target protocol should do"。每条结论引用前文 case + Phase 1 findings + sibling notes repo 已有 RFC discussion。

候选结论(待 Phase 2 实测后定稿):

| 议题 | 候选结论 | 触发 case | 落到 |
|---|---|---|---|
| 是否保留 `sequence` 字段 | TBD — CMA 没有,但 client 需要"严格全序"才能跨 vendor 一致 | 20.4 reconnect 实测 | `cma-event-model.md` + sibling repo protocol RFC |
| 是否引入 explicit `cause_event_id` / `parent_event_id` | TBD — CMA 用 `stop_reason.event_ids` 隐式 ref,反推 explicit 是否更优 | 20.6 partial resolve | 同上 |
| `processed_at` 是协议字段还是 read-model 投影 | TBD — 取决于 20.3 实测 list 是否是 snapshot | 20.3 | 同上 |
| reconnect 默认是 occurrence-preserving 还是 id-consolidating | TBD — 协议层应同时支持,client 按场景选 | 20.4 | 同上 |
| `requires_action` 是 stop_reason 内嵌还是顶层独立字段 | TBD — CMA 嵌在 stop_reason 是合并设计;独立字段更显眼 | 20.6 | 同上 |
| Stable / gated event 是否同 enum 还是分 enum | TBD — 影响 client SDK 类型设计 | 20.7 | 同上 |
| Multi-agent stream 是路由层(primary 投影)还是独立 endpoint | TBD — CMA 看起来两条都有 | 20.8 | 同上 |
| Error 是 in-band(stream)还是 out-of-band(HTTP)| 候选答案:**双轨**(stream 内嵌 session.error 用于异步错误,HTTP 4xx 用于同步)| 20.1 + 20.5 | 同上 |

每个议题在 Phase 2 结束时应落出**一份 finding + 一节 cma-event-model.md 章节 + sibling repo 协议 RFC 的 PR 草稿**。

## Top 10 优先级(时间窗口有限时先跑这些)

按用户 review 的列表:

1. **20.4.1 stream-first happy path** — 捕获 raw SSE + SDK events + list events 三路
2. **20.4.2 send-then-stream race** — 证明是否漏 status_running / user.message ack
3. **20.3.1 + 20.3.2 + 20.3.3 user.message processed_at 三路对比** — stream / list / send response
4. **20.3.4 list snapshot** — 同一 event 多次 list,哪些字段变化
5. **20.4.3 stream+list reconnect** — 断线期间制造 tool/custom-tool blocking event,验证恢复
6. **20.6.4 custom tool requires_action** — agent.custom_tool_use 与 stop_reason.event_ids 引用关系
7. **20.6.6 tool confirmation requires_action** — allow / deny 两条路径
8. **20.5.6 session.error / 20.5.4 status_rescheduled** — 制造可重试 MCP 5xx 或网络错误
9. **20.5.7 session.deleted** — delete 时 active stream 收到什么、list 后续可读性
10. **20.8.1 multi-agent thread cross-post** — 有 access 后第一优先级跑

## 预估用例总数

50-70 条(Phase 2 一次性 ship);其中 **gated 部分(20.8 multi-agent + outcomes events in 20.7)** 拆出来,有 access 才跑;**stable 部分约 40-50 条** 不依赖 research preview,Phase 2 主体可立即启动。

## 准入条件(执行前 checklist)

- [ ] 20.0 基础设施 5 项 prep 完成(catalog 生成脚本 + raw-sse helper + streamWithHistory 实装 + schema validator + corpus helper)
- [ ] sibling notes repo `research/managed-agents/event-corpus/` 目录建好
- [ ] Phase 1 git tag `cma-tests-phase-1` 已打(便于回滚)
- [ ] 用户对本计划的 review 已纳入(2026-05-13 review 已落)

## 同步更新需要时

| 文件 | 更新触发 |
|---|---|
| [`00-overview.md` §2 关键事实](./00-overview.md#2-调研已确定的关键事实测试方案的设计前提) | Phase 2 实测推翻 / 印证表中字段 |
| [`00-overview.md` §10 source taxonomy](./00-overview.md) | 新事件 / 字段类别加入时 |
| `20-event-catalog.generated.md`(新增) | SDK 升级后重跑生成脚本 |
| `40-multi-agent-memory-outcomes.md` `agent.delegation` 注 | 若 20.8.1 实测发现新 delegation event,更新该注释 |
