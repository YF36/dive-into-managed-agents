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

事实可信度标注沿用 [`00-overview.md` §10 source taxonomy](./00-overview.md#10-事实可信度-source-taxonomy):四级 `[source: official docs | SDK type | 实测 | hypothesis]` + 联合标注。**`API ref` 不是独立分类**,它属于 `official docs` 的子集(Anthropic 官方 API reference 页面)— 引用时直接用 `[source: official docs]`。

## 20.0 测试基础设施 prep(执行前)

| 项 | 工作 | 文件 |
|---|---|---|
| Catalog 生成脚本(详见 §20.0.A)| 用 **TypeScript Compiler API / ts-morph** 解析 `node_modules/@anthropic-ai/sdk/**/*.d.ts`,提取事件 type union 成员;输出 markdown 表 | `tests-cma/scripts/generate-event-catalog.ts`(新增)+ 输出 `20-event-catalog.generated.md` |
| Raw SSE fetch helper(详见 §20.0.B)| 绕过 SDK 直接 `fetch`,从 env 组装 auth/header,redact 后输出 wire 帧 | `tests-cma/src/utils/raw-sse.ts`(新增)|
| `streamWithHistory` 实装(详见 §20.0.C)| Phase 0 stub → 三层(L0 / L1 / L2)collector 实现,§20.4 三层模型的代码侧 | `tests-cma/src/utils/stream.ts` 已 stub,Phase 2 补 |
| Event schema validator | 按 event type 校验必填字段 + 类型(用 catalog 生成结果反推 schema)| `tests-cma/src/utils/invariants.ts:assertSchemaForType` |
| Event corpus capture helper(详见 §20.0.D)| 把当前 case 的 send-response / stream / list 三路按 §20.2 分类 dump 到 corpus 目录 | `tests-cma/src/utils/corpus.ts`(新增)|
| Mock MCP server(详见 §20.0.E)| 受控 MCP server:happy-path echo / 5xx / timeout 三种 tool,稳定触发 §20.6 MCP chain | `tests-cma/scripts/mock-mcp-server.ts`(新增)|

这些基础设施先做,Phase 2 子 group 才能写。

### 20.0.A Catalog 生成脚本 contract

- 输入:`node_modules/@anthropic-ai/sdk` 安装目录(SDK package),读取 `**/*.d.ts`
- 实现:**不能用运行时反射**(TS 类型编译期擦除);用 `ts-morph` 或 `typescript` compiler API parse,定位 `BetaManagedAgentsStreamSessionEvents`(或当前 SDK union 名)的 union members
- 输出:`docs/test-plan/20-event-catalog.generated.md`,内容含:
  - SDK package name + version(从 `package.json` 读)
  - 解析的 `.d.ts` 路径
  - 生成时间(ISO 8601)
  - 每个 event type 一行 + 其 payload TS 类型 inline 展开 + source 标注(参考 [§10 source taxonomy](./00-overview.md))
- 头部必须含警示注释:`<!-- AUTO-GENERATED, do not edit by hand. Run: npm run generate:event-catalog -->`

### 20.0.B Raw SSE helper contract(auth + redaction)

**输入**(从系统 env 读,绝不进 .env):
- `ANTHROPIC_AWS_API_KEY`、`ANTHROPIC_AWS_WORKSPACE_ID`、`AWS_REGION`(参考 [00-overview §2 凭据](./00-overview.md))

**Request 组装**(确认对照 SDK 源码 `node_modules/@anthropic-ai/sdk/.../sessions/events.js` line 82):
- Method:**GET**(不是 POST — SSE 是只读流)
- Path:`/v1/sessions/{session_id}/events/stream?beta=true`(**不是** `/events` — 后者是 list/send 资源路径)
- Thread stream 走另一个 endpoint:`/v1/sessions/{session_id}/threads/{thread_id}/stream?beta=true`(§20.8)
- Base URL:`https://aws-external-anthropic.{region}.api.aws`
- Headers:
  - `Accept: text/event-stream`
  - `x-api-key: $ANTHROPIC_AWS_API_KEY`
  - `anthropic-workspace-id: $ANTHROPIC_AWS_WORKSPACE_ID`
  - `anthropic-version: 2023-06-01`(**必加** — SDK 自动注入,raw fetch 不能省;见 SDK `client.js` line 729)
  - `anthropic-beta: managed-agents-2026-04-01`
- 用 `fetch` 直拉(不通过 SDK),`Response.body` 走 ReadableStream 逐行读

**Output 落到 corpus**:
- `raw-sse/<scenario>/raw-frames.txt` — 原始字节(已 redact)
- `raw-sse/<scenario>/parsed-events.jsonl` — `data:` 行解析后的 JSON
- `raw-sse/<scenario>/request-meta.json` — request-id + x-amzn-requestid + 时间戳

**Redaction 强制**(参考 [Recorder.ts](https://github.com/YF36/dive-into-managed-agents/blob/main/tests-cma/src/utils/recorder.ts) 的 `SENSITIVE_HEADER_NAMES`):
- 写 raw-frames.txt 前,删 `x-api-key` / `authorization` / `anthropic-workspace-id` / `cookie` 等所有敏感 header 整 value 替换为 `<redacted:xxxx>`
- env secret `ANTHROPIC_AWS_API_KEY` 整 string-equal 替换(沿用 Recorder 已实现的 redactString)
- **禁止把 raw header dump 写进 corpus** — header 单独走 redact 后 metadata,不写进 wire frame

### 20.0.C streamWithHistory 三层 collector

实现 §20.4 三层模型:
- `collectL0(sessionId, opts)`:返回 `{stream, list, sendResponse?}` 三份独立 jsonl(完全不 dedupe)
- `collectL1(sessionId, opts)`:基于 L0 输出,按 `(id, processed_at, payloadHash)` 跨 source dedupe,保留 ack transitions
- `collectL2(sessionId, opts)`:基于 L1,按 id consolidate,UI view

测试代码默认 expose 三层 collector API,case 按需选层。

**`payloadHash` canonicalization 规则**(可复现性的关键):

L1 dedupe 用的 `payloadHash` 必须在 helper 内部定义清楚,否则跨 source 比较会得出不一致结果。规则:

- **覆盖**:`type` 字段 + business payload 字段(content / role / tool_use_id / tool_use_input / outcome 等业务语义字段)+ stable routing 字段(`session_thread_id`)
- **排除**:
  - 所有 observation/source 元数据:`id`、`created_at`、`updated_at`、`processed_at`
  - 所有 source-specific wrapping:HTTP request_id / `_request_id` / SDK 注入的 `_response_metadata` 等
  - read-model 衍生字段:`status` snapshot / `archived_at` 等
- **canonicalization**:用 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) 或简化版(JSON 对象 key 字典序排序;array 保持原顺序;`undefined` → 字段省略;`null` 保留)
- **hash**:SHA-256,取 hex 前 16 字符(对 dedupe 而言冲突概率足够低)

helper 应 expose `computePayloadHash(event)`,case 可以直接调它做断言。规则改动需要更新 helper 单元测试 + 重跑历史 corpus(hash 不向后兼容)。

### 20.0.D Corpus helper

`corpus.dump(scenarioName, collected)` 把 L0 / L1 / L2 三层产物按 §20.2 / §20.4 分目录落盘到 **sibling notes repo** `research/managed-agents/event-corpus/<scenarioName>/`。路径解析沿用 [Recorder.ts rootDir 探测逻辑](https://github.com/YF36/dive-into-managed-agents/blob/main/tests-cma/src/utils/recorder.ts)(`.local-config.json` siblingArtifactRoot 同根)。

### 20.0.E Mock MCP server contract

**为什么需要**:`.invalid` URL 大概率在 session create / agent.create validation / SDK 连接阶段就 fail,根本走不到 `agent.mcp_tool_use → agent.mcp_tool_result` 这条 chain。受控 mock server 才能稳定触发完整 lifecycle。

**关键约束 — CMA 必须能访问到 mock server**(round-3 review 校准):CMA runtime 调 MCP URL 不在本地 test 进程的网络命名空间里,Anthropic platform 从它的基础设施侧发起调用。**绑定本机 loopback 等于 CMA 完全访问不到**,这条链根本测不出。

**提供三种 tool endpoint**:
- `/echo` — happy-path echo,返回 200 + payload(测 §20.6.2 MCP happy chain)
- `/error` — 总返 5xx(测 §20.5.3 retries_exhausted)
- `/slow` — 故意延迟 / hang(测 §20.5.4 status_rescheduled / network timeout)

**Deployment 选项**(按推荐顺序):

1. **AWS host 上对公网 HTTPS expose**(推荐 — 跟测试机器同主机,部署简单)
   - 在 `my-aws` (AWS EC2 / 公网 IP) 起 mock server,绑定 `0.0.0.0`,通过 nginx / caddy 加 TLS
   - URL 形如 `https://mock-mcp-<hash>.<your-domain>/<random-path-token>/sse`
   - 用 Let's Encrypt 拿证书,或 AWS ACM
2. **Cloudflare Tunnel / ngrok / tailscale funnel**(本机开发友好)
   - 不需要管 TLS 证书,vendor 提供
   - 但 URL 是 vendor 子域,某些场景下不稳

**安全 hardening**(无论哪种 deployment):

- **随机路径 token**:URL 含一段 256-bit 随机 base64url 字符串 — `https://.../mcp-mock-v8x9k2L7zQwR.../sse`。没有 token 的请求全部 reject 401。token 生成时 + redact 到 corpus
- **请求 source IP allowlist**(可选):只接受 Anthropic 出站段的请求,日志记录但 reject 其他
- **生命周期短**:每次测试 spawn 时生成新 token,test suite 结束销毁 server + 失效 token
- **Corpus redaction**:token 进 redacted list,所有 corpus / case.md 输出前 string-equal 替换为 `<redacted:mcp-token>`
- **本机 loopback fallback**:若 CMA 真的支持从内部 mock(`mcp_mock://`)注入(待 Phase 2 调研),优先用那条路径,完全避开公网

MCP 协议消息格式参考 [Model Context Protocol spec](https://modelcontextprotocol.io)。

**§20.0.E 优先级**:本身是 Phase 2 §20.6.2 / §20.5.3 / §20.5.4 三个 case 的硬依赖,但**实施成本不低**(部署 + 证书 + 路径 token 体系)。建议:**先跑 §20.6.2 用 .invalid URL 实测确认确实失败(走不通 MCP chain)**,再决定 mock server 投入。如果实测意外能走通(CMA 对 unreachable URL 有特殊行为),mock server 可降级到第二优先级。

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

## 20.2 Canonical Event Envelope(按事件来源拆两路 / 三路对比)

**关键区分**(2026-05-13 round-2 review 校准):事件按**来源**分两类,可观测路径数量不同:

| 事件来源 | 可观测路径数 | 路径 |
|---|---|---|
| **Client-originated**(`user.*` 入站事件:message / interrupt / tool_confirmation / custom_tool_result / define_outcome) | **3 路** | stream(SSE iterator)+ list(events.list)+ **send response**(POST /events 的 echo) |
| **Server-originated**(`agent.*` / `session.*` / `span.*` 全部) | **2 路** | stream + list(**没有 send response 这一路**,因为这些事件不由 client POST 产生) |

→ 把所有事件强行套"三路对比"会卡在 schema generation;必须分开建模。

### 20.2A Client-originated 三路对比(只覆盖 user.*)

| Case | What | 反推 |
|---|---|---|
| 20.2A.1 | 每个 user.* type 在 send response / stream / list 三路的字段集合对比 | POST 是 fire-and-forget 还是 echo-with-server-fields(如 processed_at 是否立刻 set)|
| 20.2A.2 | send response 是否含 server 加的字段(id assign / created_at)| client 是否能从 POST 返回值拿到 id 而不必等 stream |
| 20.2A.3 | send response 字段 vs stream 后续 emit 的同 id 字段差异 | 若 send response 缺 `processed_at`,stream 才补 — 印证双相 occurrence |

### 20.2B Server-originated 两路对比(覆盖 agent.* / session.* / span.*)

| Case | What | 反推 |
|---|---|---|
| 20.2B.1 | 每个 server-originated event 在 stream vs list 的字段全集对比 | stream 是 read-model 投影还是协议 source-of-truth |
| 20.2B.2 | event `id` 唯一性范围:同一 workspace / 多 session / thread vs primary stream 是否 ID 复用 | 协议是否需要 (workspace, session, thread) 三段 namespace |
| 20.2B.3 | created_at / processed_at(若有)时间戳语义和单调性 | 协议字段语义文档化 |
| 20.2B.4 | usage / tool / outcome 等可选字段在 stream vs list 是否一致 | 字段稀疏 vs 全集 |

**产出**:`event-corpus/envelope-fields/<event-type>/` 每事件目录,client-originated 含 `send-response.json` + `stream.jsonl` + `list.jsonl`;server-originated 仅含 `stream.jsonl` + `list.jsonl`。综合表回写 `event-catalog.generated.md`。

## 20.3 processed_at & occurrence semantics(Phase 2 核心)

**最重要的 sub-section** — `processed_at` 决定了 event 协议是单相还是双相,这是 sibling notes repo `protocol` 章节的核心未决问题。

**前置事实状态**(2026-05-13 round-2 review 校准):Phase 1 F-0001 是**低置信观察** — 旧 collector 用 dedupe-by-id 模式(§20.4 L2 UI consolidated),如果 user.message 在 stream 里真的发了 queued + processed 两次,旧 collector 也会合并成一次。**Phase 2 必须用 §20.4 L0(raw observations,完全不 dedupe)+ L1(recovered feed)复验**,不能把 F-0001 当 "single occurrence 已定论"。

| Case | What | 反推 |
|---|---|---|
| 20.3.1 | **用 L0 收集器**重测 user.message stream 里同 id 出现次数(F-0001 复验)| 协议是单相还是双相 occurrence |
| 20.3.2 | user.message **list** 在 ack 前 / ack 后两次拉取,同 id 对象 `processed_at` 字段差异 | list 是 snapshot view 还是 occurrence log |
| 20.3.3 | events.send POST 返回值里 user.message 是否含 `processed_at`(立刻 echo back vs 等 ack)| POST 是 fire-and-forget 还是 echo-with-server-fields |
| 20.3.4 | 先 list(ack 前)+ 立刻再 list(假定 ack 中)+ 等 turn 结束再 list:同 id 在三次 snapshot 的 processed_at 演变 | ack 状态机的中间态可见性 |
| 20.3.5 | agent.* / session.* / span.* 事件:它们的 processed_at 是 always set on emit 还是有自己的双相?| 仅 user.* 走 queued-processed,还是全部事件?|
| 20.3.6 | **archived session** 后,list 仍可读(F-0006 已印证),processed_at 字段是否还能变化(若有 queued 卡在 archive 前)| terminal 状态 ack 冻结 |

**注意**:**deleted session** 后 list 是否可读拆到 §20.5.7 单独测(archive 是 metadata flag,delete 是物理移除,行为不同)。

**产出**:`findings/F-NNNN-processed-at-semantics.md`(顶级 finding,直接喂 protocol 章节)。

## 20.4 Stream + List Recovery(reconnect 协议反推)

Phase 0 review 已校准 Reconnect 计划应区分多种 dedupe 模式 — 本节进一步明确化成**三层模型**(2026-05-13 round-2 review 校准:单纯"不 dedupe"会把 stream / list 跨 source 的同一观察值当成真实 double-occurrence,污染 sequence 字段决策结论)。

### 三层模型

| 层 | 输入 | 输出语义 | dedupe 规则 |
|---|---|---|---|
| **L0 Raw observations** | 各 source(stream / list / send response)各自的原始观察序列 | 保留每路全部观察,**不跨 source 合并** | 完全无 dedupe — `stream.jsonl` + `list-snapshot.jsonl` + `send-response.json` 三路独立 dump |
| **L1 Recovered feed** | 把 L0 三路合并成一条"已发生事件"流(reconnect / 历史回溯用) | 跨 source dedupe **同时保留 ack transition**:用 `(id, processed_at, payloadHash)` 三元组作为唯一 key(payloadHash 定义见下方)| 若 L0 stream 和 list 各有一条 `id=X, processed_at=null, payloadHash=H` → 合并成 1 条;若 stream `id=X, processed_at=null, H` + list `id=X, processed_at=t1, H` → 保留 2 条(ack 前 + ack 后),不当成"double-occurrence";若 **id 不同** payload 相同(server 给同 payload 两个 id),L1 **不合并** — 这是 idempotency 议题,见 §20.4.6 |
| **L2 UI consolidated** | L1 进一步压缩为"每个 id 一张卡片",ack transition 算字段 update 而非新行 | 按 `id` 合并,后到的 processed_at 覆盖前面的 null | UI 端展示用 |

→ **测试代码必须三层都实现并各自落 corpus**。把 L0 当 L1 用(完全不 dedupe)会把跨 source 重复当成真实 double-occurrence,误判 protocol 是否需要 sequence 字段。把 L1 当 L2 用(按 id 合并 ack)会吞掉 ack transition 这条关键 signal。

### Phase 1 F-0001 的局限

F-0001 是在 **L2 UI consolidated** 收集器下做的,所以漏掉了 user.message 是否有 queued + processed 两次 occurrence 的可能性(若 L0 stream 真的出 2 次,L2 会合并)。Phase 2 §20.3 / §20.4 必须用 **L0 + L1** 收集器复验。

### Cases

| Case | What | 反推 |
|---|---|---|
| 20.4.1 | stream-first happy path:L0 三路独立 capture(stream / list / send response)无丢失 | 印证 quickstart 推荐顺序;给 §20.3 提供基线 corpus |
| 20.4.2 | send-then-stream race(明知错的顺序):L0 stream 漏掉哪些事件(status_running / user.message queued?)| client 不依照 quickstart 的代价 |
| 20.4.3 | stream 断开 5s + 制造 1 个事件 → 重连 + list seed:L1 recovered feed 是否完整 | reconnect 协议是否需要 Last-Event-ID |
| 20.4.4 | 同上但 60s + 制造 blocking event(tool requires_action)→ 验证 L1 状态机一致性 | 长断线场景的协议保障 |
| 20.4.5 | **同一输入跑三层 collector**,对比 L0 / L1 / L2 产物 — 量化每层信息损失 | 三层各自适用场景 + 协议是否要 sequence 字段(若 L1 已足够,sequence 可省;否则必需)|
| 20.4.6 | events.send 同一 payload 重 POST:**观察** server 是否生成两个 logical events(不同 id)以及它们是否都进 stream / list | 协议是否必须有 idempotency-key —— 若 server 不去重,client-side payloadHash 去重不安全(用户可能有意重发相同 payload)|
| 20.4.7 | `Last-Event-ID` header 实验性发送 — server 是否识别 + 若识别,L1 是否可省 list seed | SSE 标准 reconnect 协议是否实现 |

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
| 20.5.7A | **archived** session(`status=terminated`):后续 events.list 是否仍返回完整历史(F-0006 已印证)+ active stream 此时是否仍 open / close | 历史可读性 + active stream 命运 |
| 20.5.7B | **deleted** session:delete 时 active stream 是否先收 `session.deleted` event 再 close,后续 events.list 返回 404 / 410 / 200+tombstone 中的哪一种 `[source: official docs — API ref 描述 deletion 发出 session.deleted 并终止 active stream]` | 物理删除的关闭语义 + tombstone 是 in-band event 还是 HTTP 状态 |
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
| 20.6.2 | MCP tool 完整序列 — 用 §20.0.E mock MCP server 的 `/echo` endpoint 触发 happy-path,稳定看 agent.mcp_tool_use → agent.mcp_tool_result | MCP 与 built-in 字段差异 |
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
| 20.7.6 | events.list 在 **archive 后**(F-0006 已印证可读)的边界 — 长期 archived 是否触发数据迁移 / 仍可走原 endpoint;**delete 后**单独走 §20.5.7B 不重复测 | 历史可读性边界 |
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
9. **20.5.7B session.deleted** — delete 时 active stream 是否先收 session.deleted 再 close、list 后续返 404/410/200+tombstone
10. **20.8.1 multi-agent thread cross-post** — 有 access 后第一优先级跑

## 预估用例总数

50-70 条(Phase 2 一次性 ship);其中 **gated 部分(20.8 multi-agent + outcomes events in 20.7)** 拆出来,有 access 才跑;**stable 部分约 40-50 条** 不依赖 research preview,Phase 2 主体可立即启动。

## 准入条件(执行前 checklist)

- [ ] 20.0 基础设施 6 项 prep 完成(catalog 生成脚本 + raw-sse helper + streamWithHistory 三层 collector + schema validator + corpus helper + mock MCP server)
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
