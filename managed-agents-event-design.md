# Event 设计:Managed Agents 的核心抽象

> Managed Agents(下称 **CMA**)几乎所有特性——工具权限审批、多 agent 协作、outcome 迭代、断线重连、观测计费——都不是独立的协议模块,而是**同一套事件系统的不同编排**。这份文档聚焦 CMA 的 event design,分析这个抽象为什么选、怎么选、带来什么、边界在哪。

---

## 目录

- [0. 本文视角](#0-本文视角)
- [1. 为什么选择"事件"作为核心抽象](#1-为什么选择事件作为核心抽象)
- [2. 事件模型的三件合一](#2-事件模型的三件合一)
- [3. 四个事件命名空间](#3-四个事件命名空间)
- [4. Append-Only Log:事件作为真相源](#4-append-only-log事件作为真相源)
- [5. 双接口:Stream 与 List](#5-双接口stream-与-list)
- [6. processed_at 的双相语义](#6-processed_at-的双相语义)
- [7. Event ID:客户端去重 vs 服务端回放](#7-event-id客户端去重-vs-服务端回放)
- [8. 状态机通过事件表达](#8-状态机通过事件表达)
- [9. 复杂交互 = 事件编排](#9-复杂交互--事件编排)
- [10. 事件的自描述元信息](#10-事件的自描述元信息)
- [11. 对比其他协议模型](#11-对比其他协议模型)
- [12. 事件设计带来的工程收益](#12-事件设计带来的工程收益)
- [13. 客户端的事件处理模式](#13-客户端的事件处理模式)
- [14. 设计边界与未解决问题](#14-设计边界与未解决问题)
- [15. 总结:八条设计原则](#15-总结八条设计原则)

---

## 0. 本文视角

这份文档不是 event 的 API 清单(那在别处),而是把 CMA 的**所有设计决策**放在"事件"这个放大镜下重新审视:

- **为什么**把事件作为核心?相比 RPC / WebSocket / 消息队列,这么选换来了什么?
- **怎么做**才让一个事件系统既能承载实时通信,又能做持久化日志,还能驱动状态机?
- **代价是什么**?哪些场景下这套设计会露出边界?

读者预设:已理解 CMA 的四对象(Agent / Environment / Session / Event)、标准 agent loop、基本 API 形态。

---

## 1. 为什么选择"事件"作为核心抽象

### 1.1 传统选择的三条路

构建一个能跑长任务的 agent 平台,client-server 的交互模型有三种典型选择:

**A. RPC 风格**(类似 Messages API)
```
POST /agent/run  { prompt, tools, ... }
→ 200 OK        { response }
```
特征:请求-响应,无状态,每次完整往返。

**B. Long-lived RPC**(类似 OpenAI Assistants API 早期形态)
```
POST /threads/{id}/runs       # 启动
GET  /threads/{id}/runs/{id}  # 轮询状态
GET  /threads/{id}/messages   # 拉结果
```
特征:有状态,但通过多个独立 endpoint 表达——启动是一回事、查状态是一回事、拉内容是另一回事。

**C. WebSocket / gRPC streaming**
```
bidirectional_stream(protocol_messages)
```
特征:双向,实时,但无持久化——断线即丢。

### 1.2 每条路的痛点

每种选择都有显而易见的盲区:

| 方案 | 盲区 |
|---|---|
| A. RPC | 长任务撑不住;无法实时反馈;无法中途干预 |
| B. Long-lived RPC | 状态和内容分家——状态机、内容列表、运行进度各自独立 endpoint,客户端要拼;缺少"我什么时候该再查一次"的语义;无自然的推送 |
| C. WebSocket | 断线即丢;无持久化;无法让多个客户端/工作节点消费同一流;调试噩梦(没历史可看) |

CMA 面对的是一个**三维都有要求**的场景:

1. **长任务**(可能几分钟到几小时)——A 做不到;
2. **实时反馈**(agent 说话要流式,工具调用要观察)——A/B 做不到;
3. **可恢复**(客户端可能崩、网络可能断)——C 做不到。

### 1.3 CMA 的选择:事件流 + append-only log

CMA 的答案是把这三种需求**折叠进一个抽象**:

> **客户端和服务端只通过"事件"沟通,所有事件构成一份 append-only 日志,日志即 session 状态。**

这个选择带来一个多米诺式的简化:

- 协议 = 事件序列 → 不需要独立的"请求-响应"schema;
- 状态 = 日志投影 → 不需要独立的状态查询 endpoint;
- 持久化 = 日志本身 → 不需要独立的"保存结果"逻辑;
- 恢复 = 重放日志 → 不需要独立的 snapshot/restore;
- 观测 = 日志分析 → 不需要独立的 trace 流;
- 多消费 = 多订阅 → 不需要独立的 fan-out 层。

这不是把三件事拼在一起,而是**发现它们本来就是同一件事**。

---

## 2. 事件模型的三件合一

### 2.1 协议、状态、持久化的统一

传统系统里,这三个维度各有各的表达:

```
传统:
┌─────────────┐  ┌─────────────┐  ┌──────────────┐
│   协议       │  │   状态       │  │   持久化      │
│  (REST/     │  │  (DB schema │  │   (log/      │
│   gRPC/etc) │  │   +cache)   │  │    snapshot) │
└─────────────┘  └─────────────┘  └──────────────┘
      ↑              ↑                   ↑
  client/server   查询接口           备份/审计
```

CMA 的事件模型把这三者折叠:

```
CMA:
┌──────────────────────────────────────────┐
│            Event Log                      │
│  ┌──────────────────────────────────────┐ │
│  │ user.message    sevt_001             │ │
│  │ agent.message   sevt_002             │ │
│  │ agent.tool_use  sevt_003             │ │
│  │ agent.tool_result  sevt_004          │ │
│  │ session.status_idle  sevt_005        │ │
│  │ ...                                   │ │
│  └──────────────────────────────────────┘ │
│     ↑           ↑            ↑            │
│   协议        状态         持久化          │
│  (收发)     (投影)        (就是它)         │
└──────────────────────────────────────────┘
```

三者不是在"协作",而是**同一个对象的三种用法**。

### 2.2 这个合一带来的"意外之喜"

因为三件事是同一份日志,很多以前难搞的问题自动消失:

- **"状态和数据库不一致"不存在**——没有"另一份"状态;
- **"缓存失效"不存在**——没有缓存,每次读日志;
- **"状态丢失"不存在**——日志就是状态;
- **"恢复后状态对不齐"不存在**——重放日志即可;
- **"审计和业务逻辑漂移"不存在**——审计流就是业务流。

这些不是 CMA"实现得好",而是**架构层面没给它们留下存在空间**。

### 2.3 事件作为统一媒介的一个直接例证

考虑这个场景:一个运行中的 session 发生了这些事:

1. 用户发消息;
2. Agent 开始思考;
3. Agent 调用工具,工具执行成功;
4. Agent 给出最终回复;
5. Session 进入 idle;
6. 用户刷新页面,看到了完整历史。

这在 CMA 里**全部**由一条事件流承载:

```
user.message          sevt_001
agent.thinking        sevt_002
agent.tool_use        sevt_003
agent.tool_result     sevt_004
agent.message         sevt_005
session.status_idle   sevt_006
```

刷新页面 = 调 `events.list(session_id)` 拉到这六条事件 = UI 能从零重建完整对话。**没有额外的 `/conversations/{id}/messages` endpoint**、**没有独立的 session state object**——全是事件。

---

## 3. 四个事件命名空间

CMA 的事件类型遵循 `{namespace}.{action}` 的命名法。四个命名空间清晰表达**谁在说话**:

### 3.1 `user.*` — 客户端的意图

客户端发给服务端的事件。

| 事件 | 语义 |
|---|---|
| `user.message` | 用户文本消息 |
| `user.interrupt` | 请求中断 |
| `user.tool_confirmation` | 允许/拒绝工具调用 |
| `user.custom_tool_result` | 回应 custom tool 的结果 |
| `user.define_outcome` | 定义一个 outcome(研究预览) |

这些事件都在一个基本事实上:**客户端不查询状态,只表达意图**。没有"GET my_state"这样的事件——状态是客户端从事件流里自己投影出来的。

### 3.2 `agent.*` — Agent/模型的产出

Agent 推理和工具使用产生的事件。

| 事件 | 语义 |
|---|---|
| `agent.message` | Agent 的文本输出 |
| `agent.thinking` | Extended thinking |
| `agent.tool_use` | Agent 调用 built-in tool |
| `agent.tool_result` | Built-in tool 的结果 |
| `agent.mcp_tool_use` | Agent 调用 MCP 工具 |
| `agent.mcp_tool_result` | MCP 工具的结果 |
| `agent.custom_tool_use` | Agent 调用 custom tool |
| `agent.thread_context_compacted` | 上下文被压缩 |
| `agent.thread_message_sent` | 多 agent 间消息(研究预览) |
| `agent.thread_message_received` | 多 agent 间消息(研究预览) |

注意两个看似"子事件"的设计:
- `tool_use` 和 `tool_result` 是**两个独立事件**,不是一个复合事件——因为 tool 执行可能很长,把它们分开后中间可以插入其他观测事件(thinking、status 变化);
- `thread_context_compacted` 是一个**显式事件**——让客户端能感知"harness 刚刚做了件事",而不是让压缩动作默默发生。

### 3.3 `session.*` — 会话生命周期

Session 状态机的转换本身就是事件。

| 事件 | 语义 |
|---|---|
| `session.status_running` | 进入 running |
| `session.status_idle` | 进入 idle(带 `stop_reason`) |
| `session.status_rescheduled` | 瞬时错误,重调度中 |
| `session.status_terminated` | 终止(不可恢复) |
| `session.error` | 内部错误(不一定 session 死) |
| `session.outcome_evaluated` | Outcome 评估完成(研究预览) |
| `session.thread_created` | 多 agent 线程创建(研究预览) |
| `session.thread_idle` | 多 agent 线程 idle(研究预览) |

**这里有一个重要的设计决定**:状态变化是**事件**,不是**外部可查询的状态**。

客户端不是"轮询 session 状态",而是"订阅 session 状态变化事件"。状态查询(`GET /sessions/{id}`)仍然存在,但那只是"把当前事件流的最新投影返回一次"——不是权威接口。权威接口是事件流本身。

### 3.4 `span.*` — 观测记号

用来标记"一段时间内发生了什么"的观测事件——不是业务行为,是**可观测性 marker**。

| 事件 | 语义 |
|---|---|
| `span.model_request_start` | 一次模型调用开始 |
| `span.model_request_end` | 一次模型调用结束(带 `model_usage`) |
| `span.outcome_evaluation_start` | Outcome 评估开始(研究预览) |
| `span.outcome_evaluation_ongoing` | 评估心跳 |
| `span.outcome_evaluation_end` | 评估结束 |

这个命名空间的存在明确表达了一种态度:**观测性是一等公民,不是事后补丁**。

其他系统里,"这次模型调用花了多少 token"往往藏在某个 metrics 后端、trace backend 或事后计算里。CMA 把它**直接嵌进事件流**——你在消费事件时顺便就拿到了 usage/timing 数据,不需要另外 instrument。

### 3.5 命名空间带来的三个收益

#### 3.5.1 所有权清晰

看到 `user.*` 就知道这是客户端发的,`agent.*` 就是 agent 产出的,`session.*` 是状态,`span.*` 是观测。Onboarding 文档和代码都受益。

#### 3.5.2 扩展性自然

新增事件类型永远是**在现有命名空间里加一个 action**——比如研究预览加的 `user.define_outcome`、`session.thread_created`、`span.outcome_evaluation_start`。

老客户端看到不认识的事件类型怎么办?**忽略它**——因为命名空间的语义稳定,客户端写处理逻辑时是"匹配已知 type、其他 dispatch 到 default",不认识的事件不影响已知事件的处理。

这让 CMA 可以在**不破坏向后兼容**的前提下持续演进。

#### 3.5.3 客户端可以精确订阅/过滤

Dashboard 只关心 `span.*`,UI 只关心 `agent.message` 和 `agent.tool_use`,审计系统只关心 `user.*` + `session.*`——四个命名空间让过滤变成语义化操作。

---

## 4. Append-Only Log:事件作为真相源

### 4.1 Log 的三个公理

CMA 的事件日志遵循三条:

1. **Append-only**:事件一旦写入不可修改。修改表达成新事件(比如压缩表达成 `agent.thread_context_compacted`)。
2. **Totally ordered within a session**:同一 session 内所有事件严格排序(用 seq 或 created_at)。
3. **Unique IDs globally**:每个事件有全局唯一 ID(`sevt_*`)。

仅仅这三条,已经把很多平台级问题消解:

- 顺序问题:"agent.tool_use 和 agent.tool_result 谁先"——严格顺序保证。
- 一致性:"两个消费者看到的事件一样吗"——同一日志 + ID 去重 = 是。
- 并发写冲突:append-only 消除更新冲突。

### 4.2 State = Projection of Log

Session 的任何"状态"都从日志投影:

```
# 当前状态 = reduce 所有事件
current_status = fold(events, initial_state, apply_event)
```

具体例子:

- **是否 running**:扫事件,最后一个 `session.status_*` 是什么;
- **对话历史**:过滤 `user.message` + `agent.message`;
- **上下文**(喂给模型的 prompt):过滤相关事件,按规则拼接;
- **使用量统计**:把所有 `span.model_request_end.model_usage` 相加;
- **UI 里显示的 agent 工具使用记录**:过滤 `agent.tool_use` + `agent.tool_result` 配对。

这是 **Event Sourcing** 范式的直接应用——但 CMA 不需要解释它是 event sourcing,因为**没有留下其他选项**。没有独立的 state DB、没有 snapshot、没有 projection cache(至少对外没有)——只有日志。

### 4.3 Context 管理也是 Projection

Agent 的 context(喂给模型的 input)本身就是事件日志的一个 projection:

```
           Event Log (durable)
                │
                ▼
      ┌──────────────────┐
      │   Harness 的     │
      │   context 策略   │   ← system prompt、skill、
      │                  │     tool schemas、
      │                  │     event 序列 → message 序列
      └──────────┬───────┘
                 │
                 ▼
         Claude model input
```

Compaction 触发时,harness 产出一个新事件 `agent.thread_context_compacted` 记录"这段发生了"——但原始事件还在日志里。你想用未压缩的原版重建 context?理论上做得到(读全历史自己拼)。

这个设计的含义:**context 策略是 harness 层可变的,而日志是 session 层不变的**。换 compaction 算法、换 caching 策略、换 thinking 保留规则——都不需要动日志。

### 4.4 Durability 带来的免费能力

把日志做成 durable,三样东西自动来:

#### 4.4.1 断线重连不丢

客户端断网 5 分钟,重连后拉 list 能拿到这 5 分钟的所有事件。

#### 4.4.2 崩溃恢复不丢

客户端进程挂了、换台机器重启——只要还有 `session_id`,重新消费日志就能重建 UI。

#### 4.4.3 回放式调试不丢

生产环境 session 出 bug?`dump = list_events(session_id)` → 离线分析。事件顺序、字段、时间戳都在——复现 bug 不需要复现"状态",只需要复现"事件"。

这三件事在传统架构里都要单独做系统:
- 重连:要靠消息队列 + offset 管理;
- 崩溃恢复:要靠 snapshot + checkpoint;
- 调试:要靠 trace backend + logs ingestion。

CMA 下**它们都是同一个机制的副作用**。

---

## 5. 双接口:Stream 与 List

### 5.1 两种消费方式

事件日志通过两个接口暴露给客户端:

```
GET  /v1/sessions/{id}/events/stream    # SSE,实时推送
GET  /v1/sessions/{id}/events           # 分页,历史回溯
POST /v1/sessions/{id}/events           # 发事件(客户端写)
```

**Stream** 和 **list** 返回**完全相同的事件对象**——同样的 ID、同样的 payload、同样的 processed_at。

### 5.2 为什么不是一个接口

一个简单问题:为什么不做成一个接口?"从 since_id 开始,流式返回所有事件,包括历史和新的"——这样客户端只要连一次就够。

Anthropic 的选择是**不做**。理由:

- **实现复杂度**:服务端要维护 per-connection position、处理 out-of-order、catch-up 过程中的新事件如何混入——边界条件多;
- **资源占用**:长连接本身就贵,加上 catch-up 的 back-pressure 控制更贵;
- **责任不清**:如果 replay 快 catch 上了,切到 live 的时机谁决定?客户端还是服务端?
- **调试复杂**:一个接口既做 replay 又做 push,故障排查变难。

分成两个接口,各自职责单一:

- `stream` 只做"打开连接后的推送";
- `list` 只做"历史分页读取";
- **组合由客户端决定**(lossless reconnect 模式)。

**这是把复杂度推给客户端**。但客户端只需要做一次(SDK 封装好),收益是服务端极简。

### 5.3 Consolidation 模式

客户端组合两个接口的标准姿势:

```python
seen = set()

# 1. 先开 stream(服务端开始 buffer)
async with client.beta.sessions.events.stream(session_id) as stream:
    # 2. 拉历史
    async for ev in client.beta.sessions.events.list(session_id):
        seen.add(ev.id)
        handle(ev)
    # 3. 消费 live,按 ID 去重
    async for ev in stream:
        if ev.id not in seen:
            seen.add(ev.id)
            handle(ev)
        if is_terminal(ev):
            break
```

三步的语义:

- **Step 1**:打开 stream 这一刻,服务端开始把之后的事件排队到这个连接(有限 buffer);
- **Step 2**:同时读历史——可能读到 stream 里也会推过来的事件(重复),但没关系,后面去重;
- **Step 3**:消费 live,已见过的 ID skip,没见过的处理;用 ID 集合去重。

**关键不变式**:没有事件会被漏掉(stream 在 Step 1 已开始 buffer),也不会被处理两次(用 `seen` set 去重)。

### 5.4 "Responsibility Shift" 作为设计原则

这个双接口设计是一个更大的原则的例证:**能推给客户端的复杂度就推给客户端**。

CMA 在几处都这么选:

| 本可以服务端做 | CMA 的选择 |
|---|---|
| Stream replay | 客户端 list + dedupe |
| 幂等性(idempotency-key) | 客户端自己保证不重复发送 |
| Context compaction 策略 | Harness 默认做,但客户端可以 opt out 自己重建 |
| Session ownership | Workspace 级授权,单 owner 语义靠客户端 |

这个选择背后的理由:**服务端的通用机制可能不合你业务**。客户端知道自己是什么产品、有什么约束,自己组合更灵活。服务端提供**稳定的基本原语**,不预设复合逻辑。

代价:**客户端必须做对**。但 SDK 封装一次,所有用户受益。

---

## 6. processed_at 的双相语义

### 6.1 一个事件出现两次

客户端发出的事件(`user.message`、`user.interrupt`、`user.tool_confirmation`、`user.custom_tool_result`)会在 stream 里**出现两次**:

- 第一次:`processed_at: null` —— 已收到,入队未处理;
- 第二次:`processed_at: "2026-04-23T14:00:00Z"` —— agent 真的读到这个事件了。

两次**用的是同一个 `event.id`**。客户端按 ID 索引到"同一件事"的两个阶段。

### 6.2 为什么不做独立的 ack 事件

这是一个能深入看设计哲学的选择。假设需求是"UI 要区分'发送中'和'已处理'"——有几种方案:

**方案 A**:独立的 `user.message.ack` 事件
```
user.message        sevt_001
user.message.ack    sevt_002  (references sevt_001)
```
需要引入新事件类型、客户端要做 id 关联、服务端要发两个事件。

**方案 B**:独立的"has been processed"字段
```
user.message  sevt_001  { processed: false }
user.message  sevt_001  { processed: true }
```
基本等价,只是字段名不同。

**方案 C**:客户端轮询状态
```
POST /events  sevt_001
GET  /events/sevt_001 → check status
```
需要独立的状态查询 endpoint。

**CMA 的方案 D**:同一事件两次出现,`processed_at` 从 null 变 timestamp

方案 D 的优势:

- **不引入新事件类型**——命名空间干净;
- **利用已有字段**(`processed_at` 本来就是所有事件都有的元信息)——没有 schema 膨胀;
- **时间戳本身是增量信息**——同时告诉你"已处理"和"什么时候处理"的;
- **Stream 语义天然**——只是同一事件的两次推送,不需要特殊协议。

这个决定展示了一种"**用现有原语组合出新语义**"的审美偏好。

### 6.3 双相在 UI 上的应用

典型 UI 映射:

```typescript
for await (const event of stream) {
  if (event.type === "user.message") {
    const bubble = bubblesById.get(event.id) ?? createBubble(event);
    if (event.processed_at == null) {
      bubble.status = "queued";      // "发送中"或"已送达"
    } else {
      bubble.status = "processed";   // "已被 agent 读到"
      bubble.processedAt = event.processed_at;
    }
  }
}
```

相当于每条用户消息有三个状态:

- **Local only**(客户端已 render,还没 POST 成功)——UI 层面;
- **Queued**(POST 成功,`processed_at: null`)——第一次出现;
- **Processed**(`processed_at` 有值)——第二次出现。

对"发消息是否有效"这件事,UI 能给用户精确反馈。

### 6.4 反过来想:如果没有这个设计

如果 CMA 没选择双相出现,客户端要做什么?

- **估算**处理时间(基于 session status 变化)——估不准;
- **查询**事件是否被处理(轮询,或新 API)——增加成本;
- **盲发 and hope**——用户体验差("我发了消息但它处理了吗?")。

所以这个设计不只是"一个小巧思"——它**让客户端有了让 UI 表达精确性的抓手**。

---

## 7. Event ID:客户端去重 vs 服务端回放

### 7.1 Event ID 的形式

CMA 的事件 ID 形如 `sevt_01HQR2K...`——ULID 风格:

- 前缀 `sevt_`:类型可见;
- 128-bit 容量:全局唯一;
- 时间戳前缀:天然按时间粗略有序。

选 ULID 而不是 UUIDv4 的原因:

- **可排序**:用作数据库索引时不会出现"热点扩散"问题(UUIDv4 完全随机,插入全 B-tree 到处跳);
- **Debug 友好**:看一眼 ID 就能大致知道时间;
- **无状态可分配**:每个 worker 独立生成不会冲突。

### 7.2 ID 在协议中扮演什么角色

事件 ID 至少承担三种职责:

#### 7.2.1 客户端去重的主键

断线重连时的 consolidation 模式完全依赖 event ID 相等来去重。没有稳定的全局唯一 ID,这个模式跑不起来。

#### 7.2.2 Tool 回应的关联键

工具调用的回应必须**引用触发事件的 ID**:

- `user.tool_confirmation.tool_use_id = ev.id` (ev 是触发的 `agent.tool_use`);
- `user.custom_tool_result.custom_tool_use_id = ev.id` (ev 是触发的 `agent.custom_tool_use`)。

这个引用关系让协议有了图结构——agent 事件和 user 回应可以精确配对。

#### 7.2.3 多路消费的一致性

同一 session 可能被多个订阅者消费:UI、后台分析、observability、审计。所有订阅者看到的事件 ID 相同——他们可以拿 ID 作 cross-system 的"这是同一件事"的判据。

### 7.3 客户端去重 vs 服务端回放的取舍

前面提过 CMA 选了"客户端去重"——这一节具体分析这个取舍。

**服务端回放路线**(假设):

```
GET /stream?since_event_id=sevt_001
→ 服务端从 sevt_001 之后的事件开始推
```

看起来简单,但实现复杂:

- 服务端要记 per-connection 的 offset;
- 要处理 `since_id` 已被 GC 的情况(返回 410?从头开始?);
- 要处理 catch-up 过程中 session 状态变化(新事件持续产生,怎么混入回放?);
- Race:客户端同时发新事件时,既要 flush 回放,又要处理新事件;
- 负载:多客户端各自 `since_id` 不同,服务端要做 per-client view 维护。

**客户端去重路线**(CMA 选的):

```
# 服务端只提供两个独立原语
GET /stream              # 从"现在"推送
GET /events?page=...     # 分页历史

# 客户端组合:先 stream 再 list,按 ID 去重
```

服务端只做:

- 把新事件丢到 stream channel;
- 分页返回历史。

服务端**不需要**:

- 记 position;
- 处理 since_id;
- 做 catch-up 切 live 的状态机。

**代价全部落在客户端**——但 SDK 封一次,业务层看不到复杂度。

这体现了一种工程偏好:**让复杂度落在"做一次就够"的地方**,而不是"每次上线都要再想一遍"的地方。服务端每天承载百万客户端,每个 bug 都是全量影响;客户端一次封装万人受益。

### 7.4 Interrupt 事件的特殊性

有一个边界情况:`user.interrupt` 事件的 `event.id` **可能为空字符串**(当前实现的已知限制)。

这意味着你不能用 `event.id` 去做 interrupt 的关联。但这是**可以接受的**——interrupt 不需要被"回应",它就是一个单向信号。其他事件用 ID 做路由/关联,interrupt 不需要。

这也展示了一个设计态度:**对核心原语严格统一,对非关键场景可以容许局部豁免**。不是每个事件都必须参与 ID-based 去重才能工作。

---

## 8. 状态机通过事件表达

### 8.1 状态不是查询,是事件

在传统设计里,状态机是这样的:

```
# 客户端
state = GET /sessions/{id}/status   # 查一次
if state == "running": wait_and_retry()
```

CMA 的状态机是:

```
# 服务端推事件
session.status_running
session.status_idle(stop_reason=end_turn)

# 客户端订阅
for ev in stream:
    match ev.type:
        case "session.status_running":   on_running(ev)
        case "session.status_idle":      on_idle(ev, ev.stop_reason)
```

**状态转换本身就是事件**。客户端不问"现在什么状态",它消费"状态刚刚变成 X"。

### 8.2 这个设计的直接后果

#### 8.2.1 客户端不需要轮询

在 `long-lived RPC` 的模型里,客户端必须轮询状态——"现在 run 完了吗?""还没。""现在呢?"……

CMA 下,客户端开 stream 就够。状态变了,服务端推。这降低了客户端的复杂度和服务端的轮询 QPS。

#### 8.2.2 状态转换时点是显式事件

你可以**事后精确看到**状态变迁的时间:`session.status_idle` 事件的 `processed_at` 就是"这一刻进入 idle"。

在别的系统里,你要靠 metrics 或 log 才能知道"这个 task 什么时候从 running 变成 idle"——CMA 下这是一等公民信息。

#### 8.2.3 状态转换可以携带额外语义

`session.status_idle` 不是光秃秃的"我 idle 了",而是**带 `stop_reason` 子字段**:

```json
{
  "type": "session.status_idle",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["sevt_003"]
  }
}
```

`stop_reason` 让状态机的表达力大大提升。同一个状态(idle)因为不同原因进入——客户端的动作完全不同:

- `end_turn` → 正常退出循环;
- `retries_exhausted` → 终止性失败,上报;
- `requires_action` → 看 `event_ids` 找要回应的事件,回应后继续;
- `interrupted`(outcome 场景) → 标记中断,可以发新 outcome。

**状态 × 原因的组合爆炸**,全部在一个事件里表达清楚。

### 8.3 事件驱动状态机的工程收益

把状态机做成"事件订阅"而不是"状态查询",直接带来:

- **无 race**:你要么看到了状态事件,要么没看到——没有"我查的时候刚好在变"的中间态;
- **Exactly-once 动作**:对应某状态应该做的动作,你处理了那个事件就是做了,不会重复做;
- **历史可重放**:事件流回放时,状态机的所有转换都重现,状态派生的任何逻辑都能被重测;
- **Debug 友好**:session 出问题,dump 事件流,状态机转换路径一目了然。

---

## 9. 复杂交互 = 事件编排

CMA 最有力的证明不是"事件是 protocol",而是**所有复杂交互模式都是事件编排,没有新协议**。

### 9.1 工具权限审批(`always_ask`)

当 agent 调一个需要确认的工具时,流程如下:

```
1. agent.tool_use (evaluated_permission="ask")   sevt_010
   ↓
2. session.status_idle (stop_reason={
     type: "requires_action",
     event_ids: ["sevt_010"]
   })
   ↓ client 审阅 + 回应
3. user.tool_confirmation (tool_use_id="sevt_010", result="allow")
   ↓
4. session.status_running
   ↓
5. agent.tool_result                             sevt_020
```

这里的每一步都是普通事件——**没有引入"权限审批协议"**。用既有的 agent tool_use、session status、user event 三种基本事件,组合出一个完整的权限审批回路。

### 9.2 Custom Tool 调用

相同的编排原则:

```
1. agent.custom_tool_use                        sevt_030
   ↓
2. session.status_idle (stop_reason={
     type: "requires_action",
     event_ids: ["sevt_030"]
   })
   ↓ client host 执行 tool
3. user.custom_tool_result (custom_tool_use_id="sevt_030", content=...)
   ↓
4. session.status_running
```

跟权限审批**几乎一模一样的编排**——只是 agent 侧发的是 custom_tool_use,客户端回的是 custom_tool_result。这说明 CMA 把"Anthropic 侧工具"和"客户端侧工具"用**同构协议**处理。

### 9.3 Outcome 迭代(研究预览)

```
1. user.define_outcome                           sevt_040
   ↓
2. session.status_running
   ↓
3. agent.message, agent.tool_use, agent.tool_result … (标准 loop)
   ↓
4. span.outcome_evaluation_start (iteration=0)
   ↓
5. span.outcome_evaluation_ongoing (heartbeat)
   ↓
6. span.outcome_evaluation_end (result="needs_revision", explanation=...)
   ↓ (agent 读反馈,继续工作)
7. agent.message, agent.tool_use, ...
   ↓
8. span.outcome_evaluation_start (iteration=1)
   ↓
9. span.outcome_evaluation_end (result="satisfied")
   ↓
10. session.outcome_evaluated
   ↓
11. session.status_idle (stop_reason=end_turn)
```

Outcome 没有单独的 RPC——grader 的工作通过 **span 事件**表达,agent 的反应通过**继续产出 agent 事件**表达,最终评估结果通过 **session 事件**表达。

### 9.4 Multi-agent 委派(研究预览)

```
1. user.message (to coordinator)                 sevt_050
   ↓
2. session.thread_created (session_thread_id="thd_001", agent_name="Reviewer")
   ↓
3. agent.thread_message_sent (to_thread_id="thd_001", ...)
   ↓
4. agent.thread_message_received (in thd_001, from_thread_id=primary)
   ↓ (reviewer 在 thd_001 里跑标准 loop,事件带 session_thread_id=thd_001)
5. agent.tool_use (session_thread_id="thd_001", ...)
6. agent.message (session_thread_id="thd_001", ...)
   ↓
7. session.thread_idle (session_thread_id="thd_001")
   ↓
8. agent.thread_message_received (in primary, from_thread_id="thd_001")
   ↓ (coordinator 在 primary thread 继续)
```

Multi-agent 看起来是最复杂的特性,但仔细看:**没有新的 primitive**。每个 thread 就是普通事件流的一个子集(用 `session_thread_id` 标签分流),thread 间通信就是两个特殊事件(sent/received)——都在 `agent.*` 命名空间里。

### 9.5 "事件编排"的一般规律

从上面四个特性可以抽出**编排范式**:

```
Trigger event(触发) → Idle with action reason(等待客户端/grader) → Response event(回应) → Resume
```

或更一般地:**所有 complex workflow = 事件之间的前驱后继关系**。

你可以把 CMA 的每一个特性画成一个**事件状态图**——节点是事件,边是"如果发生 X 就接下来可能发生 Y"。**完整协议就是这张图**,没有隐藏在事件之外的业务逻辑。

这种设计的力量:

- **新特性不需要新 API**——加新事件类型 + 在命名空间里加新 action,已有客户端不破坏;
- **特性可以组合**——outcome + multi-agent 可以叠,因为它们用同一套事件基础设施;
- **Debug 容易**——任何 bug 都可以 dump 事件流还原发生了什么;
- **Mock 容易**——测试一个特性只要 mock 对应的事件序列。

---

## 10. 事件的自描述元信息

### 10.1 每个事件都带"元"

CMA 的事件对象至少包含:

```
{
  "id": "sevt_01HQR2K...",
  "type": "agent.tool_use",
  "processed_at": "2026-04-23T14:00:00Z",
  "created_at": "2026-04-23T13:59:59Z",
  "session_thread_id": "thd_001",    // 可选:多 agent 场景
  ...                                  // type-specific 字段
}
```

再加上 `type` 特定的 payload 字段。

元信息的关键:**事件能自己说清楚自己**,不需要外部上下文解读。

### 10.2 几个关键的自描述字段

#### 10.2.1 `stop_reason`(在 session.status_idle 上)

```json
{
  "type": "session.status_idle",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["sevt_010", "sevt_011"]
  }
}
```

- `type`:idle 的原因(requires_action / end_turn / retries_exhausted / interrupted);
- `event_ids`:如果是 requires_action,指明在等哪些事件的回应。

客户端拿到这个事件,**不需要去别的地方查**——它自己说了:"我 idle 了,因为在等这两个 event 的回应。"

#### 10.2.2 `evaluated_permission`(在 agent.tool_use 上)

```json
{
  "type": "agent.tool_use",
  "evaluated_permission": "ask",
  ...
}
```

值是 "allow" 或 "ask"。如果是 "ask",客户端知道要回 tool_confirmation。**权限策略的结果直接附在事件上**,不需要客户端查 agent 配置再推导。

#### 10.2.3 `session_thread_id`(多 agent 事件上)

```json
{
  "type": "agent.tool_use",
  "session_thread_id": "thd_001",    // 如果存在,来自子 thread
  ...
}
```

- 存在:事件来自某个子 thread;
- 不存在:事件来自 primary thread。

客户端回应时要带同样的 `session_thread_id`——**路由信息在事件上自带**,不需要外部查询"这个事件属于哪个 thread"。

#### 10.2.4 `model_usage`(在 span.model_request_end 上)

```json
{
  "type": "span.model_request_end",
  "model_usage": {
    "input_tokens": 3571,
    "output_tokens": 727,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 6656
  }
}
```

观测数据直接嵌进事件——不需要另外查 metrics 或 trace backend。

### 10.3 自描述的设计意图

这些字段背后有一个共同原则:**任何消费事件流的消费者,都能独立完成它关心的工作,不需要查其他接口**。

- UI:从 event 就能渲染;
- 审计:从 event 就能记录谁做了什么;
- 计费:从 event 就能算 token;
- 路由(多 agent):从 event 就能分流;
- 权限(ask):从 event 就能知道要不要弹窗。

这是 **self-contained event** 原则。代价是事件比"最小"要大一点(带了一些上下文信息),收益是**消费者实现简单、无外部依赖、不会 out-of-sync**。

### 10.4 对比:不自描述的设计会怎样

假设 `session.status_idle` 不带 `stop_reason`,客户端怎么知道要不要 `break`?

- 方案 A:客户端 `GET /sessions/{id}` 查 session 的 stop_reason 字段——多一次 RPC,还有可能 out-of-sync(idle 事件到了但 status 字段还没更新);
- 方案 B:客户端从最近事件推断——复杂,fragile;
- 方案 C:永远等下一个事件——如果没有下一个事件,循环卡死。

带上 `stop_reason`,这些问题都不存在。**自描述是简单客户端代码的根本保证**。

---

## 11. 对比其他协议模型

### 11.1 vs. REST / RPC

REST/RPC 是"请求-响应"模型,每次调用独立,无状态。

**CMA 做到的:REST 做不到的**:

- 长任务实时反馈(REST 下要么轮询、要么不知道);
- 中途干预(REST 下要么 abort 整个请求、要么等完);
- 自然的 server-initiated 通知(REST 下要靠 webhook 或 SSE 增强,而那本身就是事件)。

**REST 做到的:CMA 可能不如**:

- 独立请求的无状态——更容易水平扩展(但 CMA session 本身也是水平可扩的);
- 简单客户端(一个 curl 就够);
- 标准工具链丰富(curl、postman、HTTP 缓存等)。

CMA **仍然暴露 REST endpoint**(`POST /events`、`GET /events`)——底层传输是 REST + SSE,但**协议语义是事件**。这是两层:传输层还是 REST 的好处(熟悉、工具多),语义层是事件的好处(状态、持久、实时)。

### 11.2 vs. WebSocket / bidirectional streaming

WebSocket 是双向实时,但无持久化——消息只在连接期间有效。

CMA 通过**把消息也写进 durable log** 打掉了 WebSocket 的主要局限:

| 问题 | WebSocket | CMA |
|---|---|---|
| 断线重连 | 要自己做 replay | `list` 拉历史 |
| 崩溃恢复 | 状态丢 | 重放日志 |
| 审计 | 要旁路抓包 | 事件就是审计 |
| 多消费者 | 要自己 fan-out | 多个 SSE 订阅 + ID 去重 |

代价:CMA 的 SSE 不是双向的。客户端发事件走独立 POST,不走同一连接。但这个"代价"换来的是**事件可以被任意数量的消费者同时读到,不仅仅是打开 stream 的那个**。

### 11.3 vs. 消息队列(Kafka / Pulsar / etc.)

消息队列非常像事件日志——但有几个差别:

| 维度 | 消息队列 | CMA |
|---|---|---|
| 消费语义 | At-least-once(客户端要去重) | 完全一致的去重机制(ID-based) |
| 消费者 offset | 服务端管(consumer group) | 客户端管(SDK 或业务管 `seen` set) |
| Schema | Schemaless / 自管 | 强类型(type namespace + 字段) |
| 跨 topic 关联 | 需要应用层做 | 单 topic(session) |
| Agent loop 驱动 | 无 | 内建 |

CMA 借鉴了消息队列的 log 思想,但**加了 agent loop 这个消费者**——日志不只是被动存,也驱动计算。

### 11.3.1 CMA 是 "Event Sourcing for AI Agents"

本质上,CMA 把经典 event sourcing 模式搬到 agent 产品上:

- **Event log**:session events;
- **State**:从事件投影;
- **Commands**:`user.*` 事件(意图);
- **Projections**:agent 的 context、UI 的状态、观测数据。

加了一层 agent loop:**event log 不只是业务历史,也是模型 context 的源**。

### 11.4 对比总结

| 模型 | 长任务 | 实时 | 持久化 | 多消费 | 审计 | 状态管理 |
|---|---|---|---|---|---|---|
| REST/RPC | ✗ | ✗ | ✗ | ✗ | 需旁路 | 客户端查 |
| Long-lived RPC | ✓ | ✗ | ✓ | ✗ | 需旁路 | 客户端查 |
| WebSocket | ✓ | ✓ | ✗ | ✗ | 需旁路 | 连接期内 |
| 消息队列 | ✓ | ✓ | ✓ | ✓ | ✓ | 业务层做 |
| **CMA 事件流** | ✓ | ✓ | ✓ | ✓ | ✓ | **内建** |

CMA 的事件设计是**把消息队列的能力和 agent loop 融合**——既是协议,也是状态,也是持久化。

---

## 12. 事件设计带来的工程收益

具体一点,事件设计给实际工程带来了什么。

### 12.1 调试极简

生产 session 出问题,传统系统要:

- 查 application log(找错误);
- 查 database state(看当时状态);
- 查 metrics / trace(看时序);
- 推测事件顺序(因为没有单一来源)。

CMA 下只需要:

```python
events = list(client.beta.sessions.events.list(session_id))
with open("session.json", "w") as f:
    json.dump([e.model_dump() for e in events], f, indent=2, default=str)
```

**一份事件流包含 session 完整生命周期**——状态转换时间点、tool 调用输入输出、模型延迟、错误发生位置。本地用 `jq` 或自写脚本筛选,问题定位效率提升一个数量级。

### 12.2 恢复极简

客户端崩溃恢复:

```python
def resume(session_id):
    s = client.beta.sessions.retrieve(session_id)
    if s.status in ("terminated",): return "done"

    # 重建本地状态 = 消费历史 + 订阅新的
    with client.beta.sessions.events.stream(session_id) as stream:
        for ev in client.beta.sessions.events.list(session_id):
            handle(ev)
        for ev in stream:
            handle(ev)
            if is_terminal(ev): break
```

**没有 checkpoint、没有 snapshot、没有 state diff**。持久化完全由事件日志承担。

### 12.3 多订阅者免费

典型 SaaS 场景:UI 需要实时、后台需要分析、合规需要审计。

传统架构要建三套:WebSocket for UI、Kafka for analytics、audit log for compliance。

CMA 下:三个系统**订阅同一份事件流**。每个消费者有自己的 filter、自己的 `seen` set、自己的状态派生——互不干扰。

### 12.4 观测免费

Observability 通常需要:

- 代码里插 instrumentation(metrics/trace SDK);
- 埋点维护成本;
- 分析工具(Datadog、Jaeger、等);
- 业务关联(request_id 跨服务)。

CMA 把**关键观测信息嵌入 span 事件**:

- `span.model_request_start/end` + `model_usage` = 延迟 + token 消耗;
- `agent.thread_context_compacted` = context 动作;
- `session.status_*` = 生命周期 trace。

你的客户端在消费事件的**同时**就拿到了这些数据。写个 `events.list()` dump 分析脚本就能替代相当一部分 trace backend。

### 12.5 扩展性成本低

新增一个高级特性(比如 outcome):

- 不需要新 API endpoint;
- 不需要新客户端协议库;
- 不需要老客户端升级;

只需要:

- 加几个事件类型(都在既有命名空间里);
- 客户端 opt-in 消费新事件;
- 老客户端**自动忽略**——因为它们本来就是 switch/case,匹配不到就 no-op。

这就是命名空间设计的扩展性收益。outcome 和 multi-agent 都是研究预览阶段功能——能 beta 发布、不破坏存量用户、随时可以演进,事件模型居功至伟。

### 12.6 测试友好

Unit test 一个 SessionDriver:

```python
def mock_stream():
    yield make_event("session.status_running")
    yield make_event("agent.message", content=[...])
    yield make_event("agent.tool_use", name="bash", input={...})
    yield make_event("agent.tool_result", ...)
    yield make_event("agent.message", content=[...])
    yield make_event("session.status_idle", stop_reason={"type": "end_turn"})

def test_driver_completes_normally():
    driver = SessionDriver(stream=mock_stream(), ...)
    result = driver.run()
    assert result == "end_turn"
```

**事件 = 测试数据**。你可以完整捕捉一个真实 session 的事件流 → 保存为 fixture → 未来无数次回放测试客户端逻辑。

这种"事件驱动"的 test 比"mock HTTP calls"或"mock state transitions"清晰得多,因为它反映了真实协议而不是实现细节。

---

## 13. 客户端的事件处理模式

把事件设计吃透,客户端代码应该长这样。

### 13.1 Event Router

不要在事件循环里堆 if/else。用 router 模式:

```typescript
class EventRouter {
  private handlers = new Map<string, (ev: any) => Promise<void>>();

  on(type: string, handler: (ev: any) => Promise<void>) {
    this.handlers.set(type, handler);
  }

  async dispatch(ev: any) {
    const handler = this.handlers.get(ev.type);
    if (handler) await handler(ev);
    // 未知 type 静默 drop——保证向前兼容
  }
}

// 业务代码注册
const router = new EventRouter();
router.on("agent.message", renderMessageToUI);
router.on("agent.tool_use", logToolUse);
router.on("session.status_idle", checkIdleBreakGate);
// ... 新事件类型不影响已有 handler
```

好处:

- 每个 handler 独立可测;
- 扩展简单(加个新的 `.on(...)` 调用);
- 未知事件 type 自动忽略——老客户端跑新 API 不炸。

### 13.2 State Projection

从事件派生状态,不要让业务逻辑直接维护状态:

```typescript
class SessionStateProjection {
  messages: Array<{ role: "user" | "agent"; text: string }> = [];
  totalTokens = 0;
  status: "running" | "idle" | "terminated" = "idle";
  stopReason: string | null = null;

  apply(ev: any) {
    switch (ev.type) {
      case "user.message":
        if (ev.processed_at != null) {
          this.messages.push({ role: "user", text: extractText(ev) });
        }
        break;
      case "agent.message":
        this.messages.push({ role: "agent", text: extractText(ev) });
        break;
      case "session.status_running":
        this.status = "running";
        break;
      case "session.status_idle":
        this.status = "idle";
        this.stopReason = ev.stop_reason?.type ?? null;
        break;
      case "session.status_terminated":
        this.status = "terminated";
        break;
      case "span.model_request_end":
        this.totalTokens += ev.model_usage.input_tokens
                         + ev.model_usage.output_tokens;
        break;
    }
  }
}
```

UI 订阅 projection 对象——事件到来 `projection.apply(ev)` 后 UI 自动 rerender。**单向数据流**。

### 13.3 Tool Response Automation

把"工具回应"做成 SessionDriver 的内建能力,不要散在业务层:

```typescript
interface ToolHandler {
  (input: unknown, ctx: { sessionId: string; eventId: string }): Promise<ToolResult>;
}

class ToolResponder {
  private handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }

  async respondToRequiresAction(sessionId: string, blockingEvents: any[]) {
    for (const ev of blockingEvents) {
      if (ev.type === "agent.custom_tool_use") {
        const handler = this.handlers.get(ev.name);
        const result = handler
          ? await safeCall(handler, ev.input)
          : { text: "No handler", isError: true };
        await sendResult(sessionId, ev.id, result, ev.session_thread_id);
      }
      // 处理 tool_confirmation 类似
    }
  }
}
```

关键:**session_thread_id 自动 propagate**——调用方不用记得多 agent 时要带路由信息。

### 13.4 Consolidation as Primitive

Reconnect 逻辑不要散在业务代码:

```typescript
class EventConsumer {
  private seen = new Set<string>();

  async consume(sessionId: string, onEvent: (ev: any) => Promise<void>) {
    const stream = await client.beta.sessions.events.stream(sessionId);

    // 先 list 历史
    for await (const ev of client.beta.sessions.events.list(sessionId)) {
      this.seen.add(ev.id);
      await onEvent(ev);
    }

    // 再接 live
    for await (const ev of stream) {
      if (!this.seen.has(ev.id)) {
        this.seen.add(ev.id);
        await onEvent(ev);
      }
      if (isTerminal(ev)) return;   // 终止判断不 gate by dedupe
    }
  }
}
```

**所有业务共用同一个 EventConsumer**——它处理了 consolidation、dedup、终止判断。新业务逻辑只写 `onEvent`。

### 13.5 Event-Driven Testing

把 session 捕获下来做 replay test:

```python
# 生产里捕获一个 session 的完整事件
def capture(session_id: str, outpath: str):
    events = list(client.beta.sessions.events.list(session_id))
    json.dump([e.model_dump() for e in events], open(outpath, "w"), default=str)

# 测试里用 fixture 跑 driver
def test_driver_with_fixture():
    events = json.load(open("fixtures/session-12345.json"))
    driver = SessionDriver(
        stream=mock_stream_from_fixture(events),
        ...,
    )
    result = driver.run()
    assert result == "end_turn"
```

这种测试**直接反映真实协议**,比 unit-test 各个函数更接近生产行为。bug 修复后,把导致 bug 的事件流作为 regression fixture——**永远不会再同一个坑摔两次**。

---

## 14. 设计边界与未解决问题

事件设计很强大,但也有代价和边界。

### 14.1 事件大小的限制

单个事件的 payload 大小不是无限的:

- `user.message.content` 的 text 长度受 API 限制;
- `agent.tool_result` 如果 tool 返回很长的 stdout(比如 `find /` 的输出),会膨胀事件;
- `agent.custom_tool_use.input` 如果是客户端构造的大 blob……

**大 payload 的问题**:

- 每次 list 都会加载全量——内存成本高;
- Stream 推大事件延迟增加;
- 压缩(context compaction)时也是大对象,更消耗。

**缓解策略**:

- 大数据走 `file` resource(放 object store),事件里只引用 file_id;
- Tool 返回做截断(CLI 的 `head`、结构化摘要);
- 避免把大输入塞到事件 content 里——用 file 挂载代替。

### 14.2 Stream fan-out 成本

单 session 如果有很多 SSE 订阅者(UI + 后台 + 观测 + ……):

- 每个订阅者一个长连接;
- 每次事件广播要推给所有订阅者;
- 服务端的 connection 管理成本。

CMA 没限制 per-session 订阅者数量(实际有软上限),但业务层建议:

- 单 session 保持 1-N(N 通常 <10)订阅者;
- 多消费者场景用 pull(list)代替 stream;
- Dashboard 这种"不需要实时"的场景走定时 pull 而不是 stream。

### 14.3 事件历史的 GC

事件不是永远保存。归档(archive)/删除(delete)session 的语义:

- **Archive**:session 成为只读,事件仍保留;新 session 不能建,现有 session 继续跑(但 archive 过的就是终态);
- **Delete**:session + event history + container + checkpoint 全部永久删除。

**长期运行的产品**要设计事件历史生命周期:

- 分层存:近期在线、远期离线(冷存档);
- 按业务意义裁剪(一份对话超过 N 天后只保留 user + agent message,丢 span);
- 多租户下明确"多久删 session"的默认。

当前 CMA 没给明确的 GC 策略——这是客户端责任。

### 14.4 客户端去重的责任

前面讲过"客户端去重 vs 服务端回放"的取舍。收益是服务端简单,代价是**客户端必须做对**。

客户端代码不写对(dedup gate 把终止判断也 skip、用错 `event.id` 字段、etc.),会出各种诡异问题。SDK 会封装一些,但业务层自己写的事件处理如果没吃透 consolidation 模式,bug 少不了。

这是一个**教育成本**的问题——CMA 的设计简单,但要求客户端开发者理解这些模式。

### 14.5 跨 session 的事件关联不存在

所有事件都绑定到单个 session。没有"跨 session 的事件"概念。

这意味着:

- 想做"同一用户的所有 session 的总 token 消耗"——要客户端自己按 `tenant/user_id` 聚合;
- 想追踪"一个任务分多个 session 跑"(比如同一个工作进度跨天)——要自己维护 session 关联;
- Memory store 虽然跨 session,但它的事件(agent 读写 memory)**仍然发生在单个 session 里**。

这是一个有意的边界——Session 是水平扩展的最小单元,跨 session 协调的复杂度留给应用层。

### 14.6 事件粒度的选择问题

哪些信息该做成事件、哪些不该?

- Agent 每 token 的生成过程——不做成事件(太多,成本高);
- 模型内部的 thinking——做成 `agent.thinking`(粒度选在整个 thinking block,不是每 token);
- 工具的 stdout 实时流——不做成事件(tool 返回作为一个原子事件);
- Context compaction——做成事件(虽然是 harness 内部行为,但客户端要感知);
- Permission evaluation——不做成事件(权限是 tool_use 的字段,不是独立事件)。

这些粒度选择**会影响设计决定**,而且**一旦暴露就难以收回**——因为客户端会依赖它。

设计过细事件 = 协议膨胀 + 性能问题;设计过粗 = 客户端能力受限。这是个持续权衡,也是为什么研究预览特性(outcome 的 ongoing heartbeat、thread lifecycle)可能还会调整。

### 14.7 强排序 vs 并发处理

同一 session 内事件严格有序——这保证了语义正确,但:

- 单 session 无法水平扩展处理(必须 pin 到一个 worker);
- 事件流的消费也是顺序的(如果 handler 慢,积压在后面);
- 大 session 的 list 分页会很深(数万事件的 session 很常见)。

这是一个**业务约束驱动的设计取舍**——agent 行为本质是时序敏感的(你不能把 tool_use 和 tool_result 乱序处理),所以强排序是对的。代价是吞吐上限。

---

## 15. 总结:八条设计原则

通过这一整份分析,CMA 的事件设计背后可以抽出八条原则。这些原则**可以直接拿去设计其他 stateful API**:

### P1. 协议、状态、持久化 = 同一份事件日志

不要把三件事分开建模。设计一个 append-only 事件流,让它同时承担这三种职责。

### P2. 命名空间即所有权

`{domain}.{action}` 的命名法让扩展不破坏既有客户端。四个命名空间(user/agent/session/span)各有清晰的发起方语义。

### P3. 事件自描述,消费者无外部依赖

在事件上带足够的元信息(`stop_reason`、`session_thread_id`、`evaluated_permission`、`model_usage`),消费者不需要查其他接口就能完成工作。

### P4. 状态转换是事件,不是查询结果

状态机的每次转变都产生事件。客户端订阅状态事件,不轮询状态。状态转换的语义(为什么变)附在事件的元信息上。

### P5. 复杂交互 = 事件编排,不是新协议

工具权限、多 agent、outcome、custom tool——每个"特性"都是既有事件类型的组合,不是独立的协议层。这让特性可叠加、可演进、不破坏兼容。

### P6. 客户端去重优于服务端回放

服务端只提供两个原语(stream 推新事件、list 返历史),让客户端通过 consolidation 模式组合出 lossless reconnect。复杂度落在客户端一次(SDK 封装),服务端永远简单。

### P7. 双相事件(processed_at)优于独立 ack

需要区分"已收到"和"已处理"时,让同一事件出现两次(用元信息区分)而不是引入新事件类型。利用已有原语组合出新语义。

### P8. Observability 是一等公民,不是补丁

把观测信息(token usage、延迟、生命周期标记)嵌入 span 事件。客户端消费事件的同时就拿到观测数据,不需要额外 instrumentation。

---

## 尾声

事件设计的成功不在于"事件是什么"——RFC 里从 1970 年代就有事件。成功在于**把事件作为唯一抽象**的决心:

- 一切交互 → 事件;
- 一切状态 → 事件日志的投影;
- 一切观测 → span 事件;
- 一切特性 → 事件编排。

当一个系统能把所有维度收敛到单一抽象上,它获得的不只是"整洁"——是**复合能力**:持久 + 实时 + 审计 + 恢复 + 扩展性一次性具备,因为它们本来就是同一个机制的不同用法。

这是 CMA 最值得学的东西:**不是某个具体功能的聪明实现,而是那一步"把事情统一成同一件事"的识别与坚持**。当你在设计自己的 agent 平台、stateful API、或任何长期任务系统时,问问自己:能不能把协议、状态、持久化用**同一份 append-only 事件流**来承担?如果能,很多问题会在出生之前就消失。
