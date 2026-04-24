# Managed Agents 实现指南

> 本文是为想自建一套 Managed Agents 形态系统的工程团队写的设计参考。读者预设已读过 Anthropic Beta API 文档与本仓库 `managed-agents-design-philosophy.md`。本文不重复 API 细节，而是专注于实现者视角——每一个设计选择背后的工程取舍、替代方案、以及选错了会怎样。

---

## 目录

- [0. 关于这份文档](#0-关于这份文档)
- [1. 系统定位与设计原则](#1-系统定位与设计原则)
- [2. 技术架构总览](#2-技术架构总览)
- [3. 核心抽象与数据模型](#3-核心抽象与数据模型)
- [4. Harness 层设计](#4-harness-层设计)
- [5. Session 层设计](#5-session-层设计)
- [6. Sandbox 层设计](#6-sandbox-层设计)
- [7. 安全架构](#7-安全架构)
- [8. 可扩展性与可靠性](#8-可扩展性与可靠性)
- [9. 关键技术方案取舍](#9-关键技术方案取舍)
- [10. API 形态建议](#10-api-形态建议)
- [11. 实施路线](#11-实施路线)
- [12. 开放问题与设计余地](#12-开放问题与设计余地)

---

## 0. 关于这份文档

### 目标读者
- 已经理解 agent harness 的基本形态（Messages API 的 tool-use 循环是其最小版本）；
- 在评估或规划一套"托管式 agent 平台"，希望把 harness、sandbox、安全、状态管理做成可复用基础设施；
- 想清楚"直接把 Anthropic Managed Agents 抄过来"不等于做对了设计——知道每条 API 背后的工程取舍，才能在自己的场景里做正确的裁剪。

### 这份文档要回答的问题
1. **组件边界怎么切？** Agent、Environment、Session、Harness、Sandbox 各自的职责应该怎么划，为什么这么划。
2. **状态放在哪？** Agent config、session history、container state、credentials——每种状态的最佳存放位置是什么。
3. **关键接口长什么样？** Harness ↔ Session、Harness ↔ Sandbox、客户端 ↔ 编排层各自的最小接口。
4. **安全边界怎么建？** 凭证如何做到 Claude 写的代码永远拿不到；prompt injection 怎么防。
5. **可扩展性怎么保证？** 如何支持 many brains × many hands 且不牺牲可靠性。
6. **实现时的关键取舍是什么？** 每个决策点的替代方案与 trade-off。

### 不做的事
- 不给具体代码（不到 implementation-detail 层）；
- 不复述 Beta API 字段定义；
- 不讨论前端/客户端 SDK 的设计；
- 不涉及商业化、计量计费、账单、配额等业务层问题（虽然落地时必须考虑）。

### 核心思想压缩成一句
> 把 agent harness 做成一组**稳定接口 + 可演进实现**——对"agent 需要什么"强 opinionated（durable 日志、沙箱、凭证隔离、无状态编排），对"怎么实现它们"保持开放。

---

## 1. 系统定位与设计原则

### 1.1 我们在构建什么

**Managed Agents 不是一个 harness，而是一个让各种 harness 都能跑的平台。**

一个 harness 是把 Claude 和工具组装成 agent 的那段循环：拼 context → 调模型 → 解析 tool-use → 跑工具 → 把结果塞回 context → 再循环。自己写一个 harness 不难，真正难的是——怎么让 harness 可以被替换、可以被多租户共享、可以在长任务上不丢状态。

Managed Agents 给出的答案：**把 harness 需要的基础设施虚拟化出来**——session 是 durable 事件日志，sandbox 是可插拔的计算环境，凭证走独立的 vault。harness 本身变成无状态的编排循环，可以随时扩展、替换、升级。

这套架构的最终效果是：
- 一个 Anthropic 官方 harness（默认策略，覆盖 90% 场景）；
- **为用户自带 harness 留出空间**（通过公开接口，用户可以在同一份 session、sandbox、vault 之上实现自己的 context 策略、自己的 tool 路由逻辑）；
- 多个 agent 可以共享同一份基础设施（参见第 9.10 节的多 agent 讨论）。

### 1.2 设计原则

**P1. 对接口 opinionated，对实现 unopinionated。**
Session 只保证日志是 durable 的；具体怎么压缩、什么时候缓存、怎么复用 thinking block——是 harness 层的工作，且未来可以换。这条原则贯穿整个系统：凡是可能随模型能力或运行经验演进的东西，都不写进接口。

**P2. 状态外置。**
Harness 无状态，sandbox 的持久状态通过 checkpoint 外化到 session 日志，凭证存在独立 vault。任何一个组件失败都不拖垮其他组件。

**P3. 凭证永不触达 Claude 生成的代码。**
无论用 prompt injection 怎么哄 Claude，它能访问到的世界里就不应该存在凭证。这是物理隔离，不是"信任但验证"。

**P4. 写路径去重，读路径重放。**
事件流不做 server-side replay（昂贵、易出错），而是靠客户端拿事件 ID 去重。Session 日志是真相之源，SSE 只是传输优化。

**P5. Agent 是持久资源，不是请求参数。**
配置是 versioned resource，每次 run 不应该重新创建配置。版本化让滚动升级、回滚、A/B 测试成为自然能力。

**P6. 长任务优先。**
所有设计决策都要经过"这个任务跑 2 小时还成立吗"的检验。容器会重启、网络会断、模型调用会超时——每一条路径都要能恢复。

### 1.3 非目标

明确**不做**的事情同样重要：

- **不做"一键 agent 框架"**。这套系统不负责"告诉 Claude 怎么做 agent"，只负责让 harness + sandbox + session 这三件事彼此解耦地跑起来。
- **不做工具市场**。工具（MCP servers）由第三方或客户提供；平台只做接入。
- **不做模型训练**。模型是外部资源（Claude API / 兼容模型），平台是消费者。
- **不做无约束多路递归**。多 agent 编排只开放一层委派（callable agents），不允许 sub-agent 再 sub-agent——复杂度和成本不值。
- **不承诺完全复现当前 session 的可见行为**。Compaction 触发点、缓存命中率、thinking 保留策略都可能随 harness 版本演进；用户只应该依赖事件语义，不依赖事件数量和顺序的具体波形。

---

## 2. 技术架构总览

### 2.1 四层视图

```
┌────────────────────────────────────────────────────────────────────┐
│ 客户端（用户应用）                                                  │
│   - 通过 REST 创建 Agent / Environment / Session                    │
│   - 通过 events.send() 发 user 事件                                 │
│   - 通过 events.stream() 消费 agent / session 事件                  │
└───────────────────────┬────────────────────────────────────────────┘
                        │ HTTPS + SSE
┌───────────────────────┴────────────────────────────────────────────┐
│ 控制面（Control Plane）                                             │
│   - Agent / Environment / Session / Vault CRUD                     │
│   - 事件收发 API                                                    │
│   - 权限、多租户、配额                                              │
└───────────────────────┬────────────────────────────────────────────┘
                        │ 内部 RPC / 消息总线
┌───────────────────────┴────────────────────────────────────────────┐
│ 编排层（Orchestration Plane）                                       │
│   - Harness Worker 池（无状态）                                     │
│     ├ 从 Session 日志读事件                                         │
│     ├ 拼 context → 调模型                                           │
│     ├ 解析 tool_use → 调 Sandbox                                    │
│     └ 把结果写回 Session 日志                                       │
│   - 调度器：把 pending work 分给 Harness Worker                     │
└─────┬──────────────────────────┬──────────────────────────────────┘
      │                          │
      ▼                          ▼
┌─────────────────────┐ ┌────────────────────────────────────────────┐
│ 状态层              │ │ 沙箱层（Sandbox Plane）                    │
│   - Event Store     │ │   - Container Pool（预热池）               │
│     （append-only）│ │   - 每个 Session 绑一个容器实例            │
│   - Checkpoint Store│ │   - 容器外置 proxy 做：                    │
│   - Vault Store     │ │     * MCP 凭证注入                         │
│   - Object Store    │ │     * Git 凭证注入                         │
│     （files/blobs） │ │     * 网络 egress 控制                     │
└─────────────────────┘ └────────────────────────────────────────────┘
```

### 2.2 组件责任划分

| 层 | 核心责任 | 不做的事 |
|---|---|---|
| **控制面** | 资源 CRUD、事件收发、认证授权、配额 | 跑 agent loop、跑 tool、存大文件 |
| **编排层** | 运行 harness loop、调度 session 到 worker、做 context/compaction | 持久化任何状态、持有凭证 |
| **状态层** | Durable 存储（event log、checkpoint、file、vault） | 做业务逻辑、跑工具 |
| **沙箱层** | 执行 tool call（bash、file ops、MCP 请求）、容器生命周期 | 读 session 日志、持久化 context |

**关键边界：编排层和沙箱层之间只有一个接口——`execute(name, input) → string`。** 这是整个架构的核心解耦点，对应 engineering 博客里的"Harness Leaves the Container"。

### 2.3 数据流与控制流

**正常一轮循环（客户端发消息 → agent 回复 + 跑工具 → 回复完成）：**

```
1. Client            : POST /sessions/{id}/events  (user.message)
2. Control Plane     : 写入 Event Store（append）
3. Control Plane     : 通知调度器有新事件
4. Scheduler         : 分配 Harness Worker
5. Harness Worker    : 从 Event Store 读 session 历史
6. Harness Worker    : 拼 context → 调 Claude API
7. Harness Worker    : 把 agent.message / agent.tool_use 写入 Event Store
8. Harness Worker    : 对每个 tool_use，调 Sandbox 的 execute()
9. Sandbox           : 跑工具，返回结果
10. Harness Worker   : 把 agent.tool_result 写入 Event Store
11. Harness Worker   : 循环回 step 6 直到模型 stop_reason == "end_turn"
12. Harness Worker   : 写 session.status_idle 事件
13. Client           : 从 SSE 流消费所有事件
```

**关键设计点：**

- **步骤 2 是真相点**。事件一旦写入 Event Store 就是既成事实，后续所有消费都是从这里来的——包括 SSE 流（实时 tail）、list API（历史回溯）、harness worker（读历史拼 context）。没有双写、没有 cache invalidation。
- **步骤 4-5 之间可以有任意延迟**。Harness Worker 拿到任务时，从 Event Store 读最新状态即可；session 不绑定到任何一个 worker 实例上。
- **步骤 8 可以失败和重试**。Sandbox 调用失败是一种 tool-call error，不是 session 崩溃——参见 6.7 节的错误分类。

---

## 3. 核心抽象与数据模型

这一节定义系统的五个核心资源——每个资源都要回答三个问题：**是什么、存在哪、生命周期怎么管。**

### 3.1 Agent

**是什么：** 一份 agent 配置——模型、system prompt、工具、MCP servers、skills、callable agents。

**存在哪：** 控制面元数据库（PostgreSQL / DynamoDB / 任意关系或文档存储都可以）。配置内容本身不大（KB 级），完全放在行里即可。

**生命周期：** 创建 → 多次更新（每次生成新版本）→ 归档。

#### 关键设计：版本化

Agent 的更新必须生成新版本（不可变历史），原因有三：
1. **已有 session 需要版本锁定**——session 跑到一半时 agent 被改掉，行为会突变；
2. **滚动升级**——新 session 走新版本，旧 session 继续跑旧版本；
3. **回滚与审计**——出问题时能一键指回上一个 good version。

**实现方案对比：**

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 单表 + version 列 | `agent(id, version, config_json, ...)`，主键 `(id, version)` | 简单；单表 SELECT 就能拿历史 | 查最新版本需要子查询 |
| B. 当前表 + 版本表 | `agent_current` 存最新，`agent_version` 存历史 | 查最新快 | 双写一致性、历史查询跨表 |
| C. Event Sourcing | 只存 create/update 事件，版本状态投影出来 | 审计流最自然 | 读操作昂贵，得加 cache |

**推荐 A**：单表 + 复合主键。复杂度最低，性能对小配置足够；查最新版本加 `(id, created_at DESC)` 索引即可。

#### Session 引用 agent 的两种形态

- **String shorthand** `agent: "agent_abc123"`：启动 session 时查最新版本；启动后该 session 就被 pin 到那一版，后续 agent 更新不影响它。
- **Explicit pin** `agent: {id, version}`：启动时直接 pin 到指定版本。

这两种形态本质一样，只是 pin 动作发生在服务端还是客户端。语义上 session 一旦启动就持有一个**不可变的 agent 快照**——这是 P5 原则的直接体现。

#### 实现陷阱

- **不要让 agent 的 tool 配置包含 per-session 密钥。** 这会把不可复用的东西塞进可复用的容器。凭证走 vault（见 3.6）。
- **不要允许 agent 更新"立即作用于所有 session"。** 这等于把版本化砍掉一半价值。
- **不要跳过 version 字段，让更新直接覆盖。** 看起来省事，但失去了审计和回滚能力。

### 3.2 Environment

**是什么：** 容器模板——网络策略、预装包、计算规格、基础镜像。

**存在哪：** 控制面元数据库。Environment 本身不是容器，不消耗任何运行时资源。

**生命周期：** 创建 → 可更新（更新只影响新创建的 session）→ 归档或删除。

#### 为什么独立成资源，而不是直接塞在 session 里

**核心理由：环境复用。** 预装大量 npm / pip 包是慢且昂贵的操作；把 environment 做成模板，让多个 session 共享同一套已构建好的镜像，可以把容器冷启动从分钟级压到秒级。

**次要理由：配置分离。** Agent 是"大脑配置"，environment 是"手的配置"。一个 agent 可能要跑在不同 environment 上（开发/生产/隔离租户），分开后组合自由。

#### Environment 不做的事

- **不绑定到特定容器实例。** Environment 只是个 spec，每次 session 创建时才 provision 一个实例。
- **不共享文件系统。** 两个 session 即便用同一个 environment，也各自有独立的容器和文件系统——resource（下节）是 per-session 的。
- **不版本化（当前 Beta 不做）。** 因为不像 agent 那样需要 session 锁定——环境变化影响的是未来 session，旧 session 用的是已经 provision 好的容器。这是 Beta 文档里明确提到的设计取舍。

#### 关键实现决策：镜像构建时机

三种方案：

1. **每次创建 session 时构建镜像**——最简单，但慢，且浪费（同一 environment 重复构建）。
2. **Environment 创建时构建镜像**——快启动，但 environment 创建变成异步操作（要等镜像构建完成才能用）。
3. **Environment 创建时构建 base，session 启动时增量 layer**——折中方案；base image 预热，per-session 的 resource mount 是独立 layer。

**推荐方案 3**。现代容器运行时（containerd / CRI-O）都支持 layered mount，base image 的 layer 可以 cache，session 启动只需要加一层 session-specific mount（file resource、git clone 结果）。

### 3.3 Session

**这是整个系统的脊柱。** Session 是一份 durable 的事件日志 + 一个在跑的容器 + 关联的一组 resource。

**存在哪：** Event 存在 Event Store（追加优化的存储，见 3.4），session 元数据存控制面元数据库，容器实例存在 Sandbox Plane。

**生命周期：**

```
idle (创建) → running ↔ idle → terminated
                ↓
           rescheduling（可重试错误时临时进入）
                ↓
            running（恢复后）
```

#### 状态机详解

| 状态 | 语义 | 可以做什么 |
|---|---|---|
| `idle` | Agent 空闲，等待输入（end_turn 或 requires_action） | 发新消息、查询、归档 |
| `running` | Harness worker 正在跑 | 发消息（入队）、发 interrupt、查询 |
| `rescheduling` | 遇到可重试错误，等待重调度 | 只能查询 |
| `terminated` | 不可恢复状态 | 只能读 |

**关键点：`idle` 不等于"本轮完成"。** Session 可能因为多种原因进入 idle：
- `end_turn`：正常完成；
- `requires_action`：等待 tool_confirmation 或 custom_tool_result；
- `retries_exhausted`：可重试错误耗尽；
- `interrupted`：用户 interrupt 了。

客户端判断"真的完成了"的逻辑不能简单看 `status == idle`，必须同时看 `stop_reason`——这是 Beta 文档里反复强调的"idle-break gate"模式。

#### Session 创建的阻塞语义

Session 创建要**等所有 resource 挂载完成**才返回。原因：挂载失败需要能在创建时反馈给用户，而不是在第一次发消息时才炸。这决定了 session 创建是一个可能耗时几秒到几十秒的操作（git clone 大仓库、文件下载），API 设计要接受这个延迟。

**替代方案考虑过：**
- 异步创建 + 轮询状态——UX 差，客户端要维护额外状态；
- 同步创建 + 后台 fetch——挂载失败时的错误无法返回给 create 调用。

Beta 选的是同步阻塞，加长 timeout 窗口（建议 60s）。这是合理的。

#### 一个 session 的组成

```
Session {
  id              // sesn_xxx
  status          // 状态机当前值
  stop_reason     // idle 时带这个
  agent_snapshot  // {agent_id, agent_version} —— 创建时 pin
  environment_id  // 引用
  container_id    // 指向 Sandbox Plane 的容器实例
  resources[]     // per-session 挂载的 files / repos
  vault_ids[]     // 关联的凭证
  usage           // 累计 token 统计
  created_at / updated_at / archived_at
}
```

### 3.4 Event

**是什么：** Session 日志的基本单元。所有交互——user 发的消息、agent 的输出、工具调用、状态变化——都是事件。

**存在哪：** Event Store。这是整个系统 I/O 最重的地方，单独讨论。

#### Event Store 的选型

三种存储方案：

| 方案 | 写路径 | 读路径 | 适用场景 |
|---|---|---|---|
| **关系型（Postgres / MySQL）** | INSERT 单行 | 按 session_id + seq 查 | 中等规模，熟悉运维 |
| **专用日志系统（Kafka / Kinesis / Pulsar）** | Produce | Consume（需要额外投影） | 超大规模 |
| **KV + 二级索引（DynamoDB / Bigtable）** | PutItem | Query by partition key | 云原生、跨区域 |

**实用推荐：起步用 Postgres + `partitioned-by-session_id` 表。** 关系型存储能覆盖到单集群百万 session 级别，且事务、索引、运维都熟悉。真的撑不住再往 Kafka + 投影迁移。

**关键表结构：**

```sql
CREATE TABLE session_events (
  session_id   TEXT NOT NULL,
  seq          BIGINT NOT NULL,       -- 单 session 内单调递增
  event_id     TEXT NOT NULL,         -- 全局唯一（ULID 或雪花）
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX ON session_events (event_id);
CREATE INDEX ON session_events (session_id, created_at DESC);
```

按 `session_id` hash 分区，单 session 的写入集中到同一个分区——这让单 session 顺序一致性天然成立，不需要跨分区事务。

#### Event ID 的生成

**必须满足：全局唯一、按时间粗略有序、客户端可生成（用于幂等）。**

推荐 **ULID**（128-bit，前缀时间戳）。客户端发送 user 事件时可以带上自己生成的 ULID，服务端写入时做幂等检查——这让客户端重试 `events.send()` 是安全的。

替代选项：
- 雪花 ID：短（64-bit），但需要 worker 编号分配；
- UUIDv7：和 ULID 类似但更标准；
- 自增主键：单机简单，分布式需要协调。

**避免 UUIDv4**：完全随机，不能按时间排序，做索引会有热点问题。

#### `processed_at` 的双相语义

事件刚写入时 `processed_at = NULL`（已入队，未处理）；harness worker 处理后回写 `processed_at = NOW()`。

这意味着**同一个事件会在 SSE 流上出现两次**——一次 null，一次带时间戳。客户端需要能处理这个行为（做 pending → acknowledged UI）。

这是 Beta 文档 Pattern 2 的核心。实现上简单：事件表的 `processed_at` 字段做 UPDATE，SSE 分发器把更新也推送下去。

#### 事件类型分类

按来源划分：

- **user.*** ：客户端发来的（message、interrupt、tool_confirmation、custom_tool_result）
- **agent.*** ：模型/harness 生成的（message、thinking、tool_use、tool_result、mcp_tool_use、custom_tool_use、thread_context_compacted）
- **session.*** ：状态变化（status_idle、status_running、status_rescheduled、status_terminated、error）
- **span.*** ：观测性 marker（model_request_start、model_request_end）

**设计选择：state 变化是事件，不是轮询状态。** 客户端可以纯靠事件流知道 session 状态，不需要轮询 `GET /sessions/{id}`。这和 P1 原则吻合——只暴露事件流这一个接口，状态变化作为事件的一种存在于同一个流里。

#### 写入一致性

单 session 的写入必须**严格有序**，否则 harness worker 重读历史会看到错乱的 tool_use → tool_result 配对。

实现上：
- 把单 session 的写入串行化到**一个 harness worker**上（见 8.2）；
- 或者加 `session_id` 粒度的数据库锁。

前者更 scalable——全局锁瓶颈小，但需要调度器保证同一 session 不会被并发分给多个 worker。

### 3.5 Resource

**是什么：** Session 启动时挂载到容器里的外部数据——文件、Git 仓库。

**存在哪：** 
- 元数据（resource_id、type、mount_path、引用的 file_id 或 repo URL）：控制面元数据库；
- 实际内容：Object Store（文件）或容器本地文件系统（git clone 后的内容）。

**关键设计：resource 是 per-session 的快照。**

上传的 file 通过 Files API 存到 object store；session 创建时把 file **复制**一份到 session-scoped 存储，再挂载进容器。这让客户端可以放心删除原 file（不影响 session），也让 session 结束时 garbage collection 可以干净地清理。

**为什么不直接 mount 原 file**：
- 原 file 可能被其他 session / 其他用户共享，mount 语义会混乱；
- 权限边界：session 的容器只应该能看到它自己的 resource，不应该能触达全局 file 存储；
- 生命周期：用户删除原 file 不应该影响正在跑的 session。

#### Git repo 作为 resource 的特殊性

Git repo 不是简单的文件挂载——它要：
1. 在容器初始化时用 PAT clone 进来（凭证一次性使用）；
2. 之后 `git pull` / `git push` 要能走 Anthropic-side git proxy（凭证在容器外注入）；
3. 所有对该 repo 的 GitHub API 调用同样走 proxy。

这是整个凭证隔离架构最具体的应用点。实现细节见 7.1。

### 3.6 Vault 与 Credential

**是什么：** 
- Vault：凭证容器，隶属于 workspace；
- Credential：具体的凭证条目（OAuth 或 static token），隶属于某个 vault。

**存在哪：** 专用加密存储，不和普通 metadata 混。常见选型：
- 云厂商 KMS + 加密字段（AWS Secrets Manager、GCP Secret Manager）；
- HashiCorp Vault；
- 自建的 envelope 加密（DEK 存数据库，KEK 存 HSM）。

**生命周期：** 
- 凭证写入是**write-only**——API 可以创建、更新、删除，但**不能读取明文**。
- 读取发生在 proxy 的注入时刻，走独立的内部 API（不走控制面公共 API）。

#### 关键设计：workspace 级共享 vs per-session 绑定

**推荐 workspace 级共享**（Beta 的选择）：
- 一个 vault 被多个 session 引用，减少凭证管理负担；
- 适合"一套开发者共用一套 MCP 凭证"的典型场景。

**替代：per-session vault**——隔离更彻底，但凭证管理成了噩梦。只在"每个终端用户有自己的 vault"的多租户场景下才值得。

#### OAuth auto-refresh 的实现

Vault 存的不只是 access_token，还有 refresh_token + token_endpoint + client_id 等，让 Anthropic 侧可以在 access_token 过期前自动刷新：

```
credential = {
  access_token:  "..."
  expires_at:    "2026-04-02T14:00:00Z"
  refresh: {
    refresh_token:   "..."
    token_endpoint:  "https://provider.com/oauth/token"
    client_id:       "..."
    auth_method:     "none" | "client_secret_basic" | "client_secret_post"
  }
}
```

Proxy 在注入前检查 expires_at，提前一分钟触发 refresh，把新 token 写回 vault。

#### 一个实现陷阱

**Refresh 的并发问题**：同一个 credential 被多个 session 并发使用时，refresh 必须加锁——否则多个 worker 同时 refresh 会导致 refresh_token 被旋转多次，只有最后一次有效，前面几个 session 拿到的 access_token 立刻失效。

常见解法：
- 用分布式锁（Redis SETNX + TTL）包 refresh；
- 或者：读 credential 时返回当前 access_token + expires_at，只有 `now > expires_at - 60s` 的那一个 worker 才负责 refresh，其他 worker sleep 等待。

---

## 4. Harness 层设计

Harness 是编排层的核心——它是那段"agent loop"代码。整个系统的设计都围绕着让这段代码**无状态、可替换、可演进**。

### 4.1 Harness 的核心循环

抽象成伪代码：

```
function run_harness(session_id):
    while True:
        context = build_context(session_id)   // 从 Event Store 读
        response = call_claude(context)
        write_event(session_id, response)     // agent.message / agent.tool_use

        if response.stop_reason == "end_turn":
            write_event(session_id, session.status_idle(reason="end_turn"))
            return

        if response.has_tool_calls():
            for tool_call in response.tool_calls:
                result = execute_tool(tool_call)  // 调 sandbox
                write_event(session_id, tool_result(tool_call, result))
            continue

        if response.has_custom_tool_calls():
            write_event(session_id, session.status_idle(reason="requires_action"))
            return   // 等客户端发 custom_tool_result 后重新被调度

        // 其他 stop_reason 处理...
```

**关键点：**

1. **Harness 可以在任意一步停下，不丢状态。** 因为所有状态都在 Event Store 里。Worker 崩溃、重启、迁移都没关系。
2. **`build_context()` 从事件日志重建 context**——这是 context 策略可以灵活演进的原因。换一个更聪明的 compaction 算法，只需要改这个函数。
3. **`execute_tool()` 是同步阻塞调用**——在当前 worker 的 goroutine/线程里等结果。Sandbox 可以异步返回（长任务），但对 worker 而言是一个 RPC。

### 4.2 Harness 与 Session 的读写模式

**读：** 按需读（on-demand），不持有 session 的副本。每次循环迭代都从 Event Store 拉最新事件——因为可能有并发的 user 事件入队。

**写：** 追加写（append-only），单 session 串行。

**关键设计：Context 构建是在 harness 里做的，不是在存储层。**

存储层只保证一件事：给定 session_id，返回按 seq 排序的全部事件。

Harness 拿到这个流之后自己决定：
- 哪些事件需要放进 Claude 的 prompt；
- 哪些要 summarize 掉（compaction）；
- 哪些 thinking block 要保留（对应 extended thinking 的后续 turn）；
- 怎么利用 prompt caching（把稳定前缀分离出来）。

这就是为什么 engineering 文章说"The interfaces push that context management into the harness"——存储层只承诺 durability，策略在 harness 里。

### 4.3 Context 管理策略

这是 harness 层最有技术含量的部分。实现时至少要处理：

**基础策略**

- **头部稳定化**：system prompt + agent description + tool schemas 永远在最前面，不随 session 进展变化——这是 prompt cache 的 cache key。
- **历史按时序排列**：不要乱序或重排历史事件，否则 cache miss。
- **Compaction 触发点**：监控当前 context 接近模型 window（比如 90%）时触发。

**Compaction 算法选择**

| 策略 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **截断最老**（sliding window） | 直接丢最早的 N 轮 | 实现最简单 | 丢信息，长任务早期关键上下文会丢 |
| **LLM summarize** | 用另一次 Claude 调用把历史压成摘要 | 信息保留好 | 贵、慢 |
| **分层 summarize**（hierarchical） | 远古历史大粒度摘要，近历史细粒度 | 平衡质量与成本 | 实现复杂 |
| **结构化选择性保留** | 基于事件类型保留（比如保留所有 user message 和 tool_result，summarize agent message） | 启发式好调 | 硬编码策略，不适应不同任务 |

**推荐演进路径：**
1. MVP：截断最老 + 保留 system 头部；
2. 增强：当截断会丢关键 tool_result 时，触发 LLM summarize；
3. 成熟：分层 summarize + 基于 agent 反馈调整（比如 agent 自己说"我需要回忆前面的内容"时触发 full rebuild）。

**触发 compaction 时要发事件**：`agent.thread_context_compacted`。这让客户端知道 harness 刚做了动作，可以选择自己从事件列表重建 context。这是 P1（对实现 unopinionated）的直接体现——客户端不满意默认策略时有退路。

### 4.4 Prompt caching 的实现考量

Claude API 支持 cache breakpoint。Harness 应该在这几个位置打 breakpoint：

1. **System prompt + agent description + tool schemas 结束处**——这是变化最慢的前缀；
2. **每次 compaction 完成处**——新前缀稳定下来；
3. **每轮 user turn 结束处**（可选）——如果连续 turn 很频繁。

**坑：** Cache TTL 是 5 分钟。间隔超过 5 分钟的 session 交互每次都会 cache miss，成本是普通调用的 1x（不是 0.1x）。Harness 应该暴露 `cache_creation_input_tokens` 和 `cache_read_input_tokens` 指标，让客户端感知到这一点。

### 4.5 Extended thinking 处理

Thinking block 是 Claude 模型的"草稿纸"输出。实现时要注意：

- **Thinking 要写入 Event Store**（作为 `agent.thinking` 事件），不能丢掉；
- **但 thinking 不一定要重新注入到下一轮 context**——大部分场景下只需要给 Claude 看它上一轮的 message + tool_use，不需要看 thinking；
- **但某些模型设置（如 Claude 4.7 的 interleaved thinking）下，保留 thinking block 是强制的**——否则模型行为会退化。

Harness 要根据模型能力决定保留策略。这又是一个"接口稳定、实现演进"的例子：事件存了 thinking，但怎么用它是 harness 的自由。

### 4.6 Harness Worker 的部署形态

- **无状态 HTTP/gRPC service**，水平扩展；
- **从消息总线（SQS / Pub/Sub / Kafka）消费 "session_id has new work" 事件**；
- **持有 session_id 粒度的短期锁**（比如 5 分钟 lease），保证单 session 不被并发处理。

锁的粒度很重要：
- 太细（每次事件都 lock/unlock）：overhead 大；
- 太粗（worker 绑定 session 全生命周期）：worker 无法 rebalance。

推荐 **lease 模式**：worker 拿到 session 后持有 lease，每 30 秒续期；worker 崩溃后 lease 过期，session 被调度到其他 worker。

---

## 5. Session 层设计

Session 层的 API 是整个平台对外的主接口。这一节聚焦实现细节。

### 5.1 事件写入路径

**路径 1：客户端 POST `/sessions/{id}/events`**

```
Client → Control Plane:
  1. 认证 + 授权（是不是这个 session 的 owner）
  2. 验证 event shape（type 合法、payload 字段完整）
  3. 生成 event_id（如果客户端没带）+ seq（单 session 递增）
  4. 写入 Event Store
  5. 推送到 SSE 分发器（让已连的 stream 消费者看到）
  6. 通知调度器（如果事件会触发 harness work）
  7. 返回 event_id 给客户端
```

**路径 2：Harness Worker 写事件**

```
Worker → Event Store:
  1. 生成 event_id + seq（复用客户端路径的逻辑）
  2. 写入 Event Store
  3. 推送到 SSE 分发器
  （不需要通知调度器——worker 就在处理这个 session）
```

**两条路径关键区别：**
- 客户端写的事件可能触发 worker 调度；
- worker 写的事件不触发（避免自循环）。

### 5.2 SSE 分发器的实现

这是 session 层最头疼的部分——要支持成千上万的长连接，同时保证事件按序推送。

**三种实现方案：**

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **DB poll + per-connection loop** | 每个 SSE 连接起一个 goroutine，轮询 Event Store 变化 | 实现简单 | DB 压力大，scale 差 |
| **Pub/Sub fan-out** | 事件写入后 publish 到 Redis/NATS channel，SSE connection 订阅 | Scalable | 要保证 publish 的原子性 |
| **WAL tailer** | 一个专门的服务 tail Event Store 的 WAL（Postgres logical replication、Kinesis stream），再 fan out | 推送延迟最低，DB 压力最小 | 实现复杂 |

**推荐方案 2**（Pub/Sub fan-out）作为主线，方案 3 作为超大规模优化。

**关键点：publish 必须在 event 成功写入 Event Store 之后。** 否则订阅者可能收到事件但去 Event Store 查询时发现还没入库（时序不一致）。实现上要么用事务性 outbox 模式，要么接受"publish 可能重复但不可能漏"的松语义（配合客户端去重）。

### 5.3 断线重连语义

**SSE 不做 server-side replay。** 这是 Beta 的明确选择——实现简单、降低服务端状态开销、让客户端承担一致性责任。

客户端标准模式：
```
1. 开 stream（GET /sessions/{id}/events/stream）
2. 并行调用 list（GET /sessions/{id}/events）拉全量历史
3. 按 event_id 去重：先把 list 里的 event_id 加入 seen set，
   stream 里 already-seen 的跳过
4. 处理 live 事件
```

**为什么不做 replay：** 带 "since_id" 参数的 stream 听起来合理，但实现上意味着 SSE 服务端要持久化 position 映射、处理 out-of-order 事件、考虑 catch-up 延迟——复杂度不值。客户端去重模式简单很多。

### 5.4 心跳与超时

SSE 长连接必须定时发心跳，否则中间网络设备会默认 timeout（通常 30-60s）断掉。

推荐：每 15 秒发一个 SSE comment（`:keepalive\n\n`），不作为事件进入客户端数据流。

客户端超时：如果 45 秒没收到任何数据（事件或心跳），判定连接死亡，重连。

### 5.5 Checkpoint 与 Session 恢复

Session 可能 idle 几分钟到几天后被重新激活（用户继续发消息）。期间容器不能一直跑——成本太高。解决方案：

**Checkpoint 机制：**
1. Session 进入 idle 一段时间（比如 5 分钟）后，sandbox 对容器做 checkpoint（文件系统 snapshot + memory state 如果支持）；
2. 容器释放到池子里（或销毁）；
3. 下一次有事件进来时，基于 checkpoint 恢复容器；
4. 恢复后继续 harness loop——session 日志还在，agent 看到的上下文一致。

**Checkpoint 的选型：**

| 技术 | 支持度 | 恢复速度 | 限制 |
|---|---|---|---|
| CRIU（Linux checkpoint/restore） | 需要特定 kernel | 快 | 难处理有网络连接的进程 |
| 容器镜像 snapshot | 广泛支持 | 中 | 只存文件系统，不存内存 |
| 文件系统 snapshot（ZFS/btrfs） | 依赖 FS | 快 | 只存 FS |
| 应用层 checkpoint（把状态 dump 到文件） | 要改 tool | 慢 | 最通用 |

**推荐组合：容器镜像 snapshot（保存 FS）+ harness 重启后重走事件流建内存状态。** 简单可靠，恢复时间秒级可接受。

**Checkpoint TTL：** Beta 文档提到 30 天。超过后 checkpoint 删除；继续对话需要从头起一个新容器——session 日志还在，但文件系统状态丢了。这是合理的成本/价值取舍。

### 5.6 Interrupt 的实现

`user.interrupt` 事件的语义：**跳过队列，强制让 agent 尽快进入 idle。**

实现：
1. 写入 interrupt 事件；
2. 通知当前正在跑这个 session 的 harness worker；
3. Worker 在下一个 checkpoint（通常是 tool call 边界或模型调用边界）检查 interrupt flag；
4. 中止当前操作，写 `session.status_idle(reason=interrupted)`。

**不做的事：** 不强制杀掉正在跑的 tool call。正在跑的 bash 命令要跑完才能安全停——强行 kill 可能留下脏状态。

**一个细节：** 如果 user 同时发了 interrupt + 新 message，语义应该是"停止现在的，执行新的"。实现上：interrupt 事件优先处理，新 message 事件在 idle 后被消费。

---

## 6. Sandbox 层设计

Sandbox 是工具执行的地方，同时是最敏感的攻击面。

### 6.1 `execute(name, input) → string` 接口

整个 sandbox 层对外只有这一个接口：

```
execute(
  session_id: str,
  tool_name: str,
  tool_input: json,
  timeout: duration,
) -> ExecuteResult {
  is_error: bool,
  content:  string | structured,
  metadata: { latency_ms, stdout_bytes, ... }
}
```

**Harness 永远只和这个接口打交道。** 这让 sandbox 的内部可以随时换——容器还是虚拟机，本地还是远程，单租户还是多租户，全部是实现细节。

### 6.2 容器 runtime 选型

三种选择：

| Runtime | 隔离级别 | 冷启动 | 支持的工具 | 推荐场景 |
|---|---|---|---|---|
| **gVisor** | User-space kernel（syscall 拦截） | 100ms 级 | 大部分 | 通用，平衡隔离与性能 |
| **Firecracker** | microVM（真虚拟化） | 125ms | 所有 | 多租户、高隔离要求 |
| **Kata Containers** | 轻量 VM | 秒级 | 所有 | 强隔离、性能允许 |
| **runc / containerd** | 共享 kernel namespace | 50ms | 所有 | 单租户或可信内部工具 |

**推荐 Firecracker 或 gVisor**。两者都提供真正的安全隔离（不是只靠 Linux namespace），在多租户场景下必须用其中之一。

**为什么不用普通 Docker/containerd：** Container escape 漏洞历史上层出不穷，共享 kernel 意味着一个容器 escape 可以攻击其他租户。在 multi-tenant 场景里，这是不可接受的风险。

### 6.3 文件系统设计

Session 容器的文件系统布局：

```
/                      → 基础镜像（只读）
/workspace             → 默认工作目录（可读写，session 私有）
/mnt/session/outputs/  → agent 写出的文件，会被自动 capture
/mnt/resources/        → resource mount 点（file、git repo）
```

**关键点：**

- **Resource mount 是只读的。** Agent 修改 resource 要写到新路径——这保留了"原 resource 不被篡改"的语义，也让 session 结束时 GC 简单（只清理 workspace）。
- **`/mnt/session/outputs/` 的自动 capture：** Sandbox 在 session 进入 idle 时扫描这个目录，把新产生的文件注册到 Files API（scope 到 session）。这给出了 agent → host 的数据输出通道。
- **实现 capture 的时机选择：**
  - 每次 tool call 后扫描——开销大但实时；
  - 只在 idle 时扫描——简单但用户要等；
  - 用 inotify 监听——零延迟但实现复杂。
  
  推荐**只在 idle 时扫描**，配合 session 恢复时对已扫描文件去重（按 path + content hash）。

### 6.4 网络隔离

**默认策略：deny all，按需打开。**

两种策略需求：

1. **Unrestricted**：除了法律黑名单，全部允许。适合开发环境、可信场景。
2. **Limited + allowlist**：只允许访问指定域名 + 可选的 package manager / MCP 专用通道。适合生产、多租户。

**实现：egress proxy。**

容器的出站流量走一个 proxy（Envoy / 自建），proxy 根据策略放行或拒绝。优点：
- 策略可以实时改；
- 拒绝时返回可解析的错误（不是 TCP reset），agent 能理解发生了什么；
- 可以在 proxy 里做凭证注入（见 7.1）。

**坑：** DNS 也要走 proxy 或独立 resolver，否则 agent 可以通过 DNS 隧道绕过策略。

### 6.5 容器池化与冷启动优化

每次 session 创建都全新 provision 容器——冷启动几秒，体验差。优化方案：

**预热池（Warm Pool）：**
- 维护一个"就绪但未分配"的容器池；
- Session 创建时从池子取一个，秒级可用；
- Session 释放时容器放回池子或销毁（要看容器是否被污染）。

**池子大小的调整：**
- Fixed size：简单，但旁晚低峰时浪费；
- Auto-scale：按当前 session 创建速率预测——复杂但成本优化。

**Environment 匹配：** 池子里的容器不是无差别的——每个 environment 对应一个子池，因为预装的包不一样。这意味着小众 environment 的冷启动优化有限。

**Resource mount 时机：**
- 池子里的容器是"裸环境"（只预装包）；
- 分配给 session 后才挂载 per-session resource；
- Resource mount 走 overlay / bind mount，开销很小（毫秒级）。

### 6.6 MCP 工具路由

MCP 工具的调用链：

```
Agent 发 tool_use (name="search_linear")
  → Harness 识别为 MCP tool，查 agent 的 mcp_servers 找到对应 URL
  → Harness 调 sandbox.execute("mcp_call", {server, tool, args})
  → Sandbox 的 egress proxy 识别为 MCP 请求
  → Proxy 从 vault 取对应 server URL 的 credential
  → Proxy 加 Bearer token 到请求头，转发给 MCP server
  → 响应原路返回给 agent
```

**为什么经过 sandbox 而不是从 harness 直接调 MCP：**
- 一致性：所有工具都经过同一接口，harness 不需要识别"这个 tool 是不是 MCP"；
- 安全：凭证注入发生在一个点（egress proxy），不是散布在 harness 里；
- 网络策略：MCP 请求也受 environment 的网络策略约束。

**Refresh token 的并发处理** 见 3.6 节。

### 6.7 错误分类

Sandbox 向 harness 返回的错误有多种语义，harness 的处理完全不同：

| 错误类别 | 示例 | 正确处理 |
|---|---|---|
| **Tool 业务错误** | bash 命令 exit code 非 0、文件不存在 | `is_error: true`，写入 tool_result，让 Claude 自己决定下一步 |
| **工具输入验证失败** | tool_input 字段类型错 | 同上，Claude 可以重试 |
| **Sandbox 瞬时故障** | 容器重启中、网络抖动 | Rescheduling（harness 重试整个 loop） |
| **Sandbox 永久故障** | 容器被杀、物理资源耗尽 | Session 进入 terminated 或 rescheduling |
| **MCP server 错误** | MCP 端点 500 | 按 sandbox 瞬时故障处理，可配重试次数 |
| **凭证失效** | OAuth refresh 失败 | 写 `session.error`，保留 session（让用户更新凭证） |

**一个坑：** 把瞬时故障当成 tool 业务错误返回给 Claude，会让 Claude 以为"这个工具真的不工作"，它可能编造替代方案——而不是等你修复。所以 retry 要在 sandbox 或 harness 层做，不要暴露给模型。

---

## 7. 安全架构

安全是这套系统能不能用于 production 的关键。凭证隔离、沙箱隔离、prompt injection 防御、多租户边界——四个核心话题。

### 7.1 凭证隔离的三层保证

**第 1 层：凭证不进容器。**

Vault 里的 credential 永远不会以环境变量、文件、或任何形式出现在 session 容器内。所有需要凭证的出站请求都走 egress proxy，proxy 在**请求离开容器后**注入凭证。

这不是"软策略"，是**架构决定**：容器里根本没有任何机制可以拿到 credential——没有 API 调用、没有 socket 到 vault、没有环境变量注入通道。即便 agent 被 prompt injection 完全控制，它能看到的世界里就不存在凭证。

**第 2 层：Proxy 只注入匹配的请求。**

Proxy 要根据目标 URL 判断要不要注入什么凭证：

```
if request.host == "api.github.com" and session has github vault credential:
    inject Authorization: Bearer <github_token>
elif request.host == "mcp.linear.app" and session has linear vault credential:
    inject Authorization: Bearer <linear_token>
else:
    pass through unchanged
```

这个匹配逻辑很关键——如果注入错了（比如把 Linear token 发给 attacker 控制的域），整条安全链就断了。所以：
- Host 匹配必须精确（不能是 substring 匹配）；
- URL 必须是 HTTPS（防止中间人）；
- Credential 条目必须声明绑定的 host，proxy 不允许跨 host 使用。

**第 3 层：可观测的凭证使用。**

每一次凭证注入都记日志：`{session_id, credential_id, target_host, timestamp, result}`。这让你可以：
- 审计哪个 session 用了什么凭证；
- 发现异常（一个 session 突然频繁用凭证，可能是被 injection 操纵）；
- 出 incident 时追溯。

### 7.2 Git 凭证的特殊处理

Git 凭证和 MCP 凭证机制不同——git 的 authentication 在 TCP 层 + Git protocol 层，不能简单加个 header。

**方案：git proxy（HTTPS CONNECT-based）。**

1. 容器里配置 `git config --global http.proxy http://git-proxy.internal`；
2. Git proxy 拦截 `git push/pull` 的 HTTPS 请求；
3. 根据目标 URL 匹配到对应 session 的 GitHub credential；
4. 以 proxy 自己的身份（持有 credential）做 HTTPS 请求，重新建立到 GitHub 的连接；
5. 把响应透传回容器。

**关键细节：**
- Git clone 时用的 credential 和 push/pull 时用的是同一个，但注入点不同（clone 在 session init 时发生，走特殊路径；push/pull 走 proxy）；
- GitHub REST API 调用（比如 gh CLI）也走同一个 proxy，用同一套凭证。

**坑：** SSH-based git 更难代理——建议只支持 HTTPS 协议，拒绝 SSH。

### 7.3 Sandbox 隔离

即便凭证隔离做完美，仍要防止：
- 容器 escape 到 host；
- 一个租户的容器攻击另一个租户的容器；
- 容器向 Anthropic 内部服务发请求。

**核心实践：**

1. **用 Firecracker 或 gVisor，不用普通 container**（见 6.2）。
2. **容器没有任何 "internal" 网络路由。** 内部服务（vault、event store、control plane）不能从容器 IP 路由到——只能从编排层路由到。
3. **容器没有主机 credential。** 云厂商的 IMDS（instance metadata）必须在容器网络里不可达（block 169.254.169.254）。
4. **每个租户独立的 Firecracker VM pool**，不跨租户复用 VM 实例。

### 7.4 Prompt injection 防御

Prompt injection 是 agent 产品的核心风险。Managed Agents 架构里几个关键防线：

**防线 1：凭证物理隔离（见 7.1）。** 即便 injection 成功，能偷到的东西有限。

**防线 2：敏感操作需要 confirmation。** Permission policy `always_ask` 让危险工具（比如 `bash`）在执行前要用户确认，降低自动化 injection 的威力。

**防线 3：Session 隔离。** 一个 session 被 injection 了，影响不会扩散到其他 session——它们运行在独立容器里，共享的只有 agent 配置（而 agent 配置不可写）。

**防线 4：审计事件流。** Injection 的痕迹会留在 event log 里（奇怪的 tool_use、诡异的 message）。产品层可以做异常检测。

**不防的威胁：**
- **Data exfiltration via web_fetch**：如果 agent 可以访问互联网，被 inject 后它可以把 session 里能看到的内容 POST 到 attacker 的 endpoint。防御：`limited` networking + allowlist。
- **Social engineering**：agent 被说服以为用户同意了某个操作。防御：依赖 permission policy 的人类确认，不依赖模型的判断力。

### 7.5 多租户边界

**租户维度的隔离：**

| 资源 | 租户边界 | 实现 |
|---|---|---|
| Agent / Environment / Session metadata | Workspace | DB 行级 tenant_id + API 层授权 |
| Event Store | Workspace | 同上 + 分区键包含 workspace_id |
| Files / blobs | Workspace | Object Store bucket/prefix 按 workspace 分 |
| Vault credentials | Workspace | 加密存储按 workspace 分 key |
| Container instances | Per-session（强隔离） | Firecracker 独立 VM |
| Harness workers | 共享（无状态） | 但单 session 锁保证串行 |

**关键原则：** **Workspace 边界在 API 层、DB 行层、存储 prefix 层、容器层**——不是单一机制。即便一层失守（比如 API 授权 bug），其他层还在。

**Cross-tenant attack 场景分析：**

- **知道别人的 session_id 能不能访问？** 不能，API 授权检查 session 的 workspace 是否匹配调用者。
- **容器 escape 后能看到别的租户容器吗？** 如果用 Firecracker，不能——VM 级隔离。如果用共享 kernel container，可能——所以必须用 Firecracker。
- **Vault proxy 能不能给 A 租户注入 B 租户的凭证？** Proxy 的凭证查询必须按 `{session_id, host}` 维度，且 session 关联的 vault 必须同租户——这个检查加在 vault 层。

---

## 8. 可扩展性与可靠性

### 8.1 Harness 水平扩展

Harness worker 无状态，可以按 CPU 或消息队列 backlog 自动扩缩。

**关键指标：**
- 每个 worker 同时跑多少 session（建议 1-5，看模型调用并发）；
- Session 被分配到 worker 的延迟（从消息队列 produce 到 consume）；
- Tool call 平均延迟（决定 worker 吞吐）。

**关键陷阱：** 单 session 的锁粒度——如果锁过粗（worker 生命周期持有），session 在 worker 之间无法 rebalance；如果锁过细（每次 event 重抢），抢锁 overhead 吃掉收益。推荐 lease 模式（5 分钟 lease + 自动续期）。

### 8.2 Session 一致性

**单 session 内：** 严格有序写入，靠 `session_id` 分区键 + 单 worker 持锁实现。

**跨 session 间：** 无一致性约束。两个 session 的事件顺序完全独立。

**这简化了很多东西：** 你不需要分布式事务、不需要跨 session 的 snapshot isolation、不需要 ordered delivery 跨 session。每个 session 就是一条独立的 log stream。

### 8.3 容器调度

容器调度的核心问题是**匹配**：给一个新 session，找个合适的 warm pool container 分配过去。

**调度维度：**
- Environment ID（决定镜像）；
- Tenant / workspace（决定 VM pool）；
- Region（决定数据局部性）；
- Resource requirements（CPU、memory）。

**简单策略：**
```
for container in warm_pool:
    if container.env == session.env
       and container.tenant == session.tenant
       and container.status == ready:
        assign(session, container)
        return
provision_new(session.env, session.tenant)
```

**高级策略：** 预测性预热——根据历史的 session 创建 pattern，提前 provision 对应 environment 的容器。

### 8.4 Rescheduling 与重试

Session 的 `rescheduling` 状态是可重试错误的表达。

**什么错误属于可重试：**
- Harness worker 崩溃（lease 过期，session 被重调度）；
- Model API 5xx（配合指数退避）；
- Sandbox 临时不可用（比如容器正在重启）；
- Tool call timeout（可配重试次数）。

**什么错误不是：**
- 客户端 4xx（参数错，重试也错）；
- Model 说 tool_input 无效（这是 agent 错，不是系统错）；
- 配额耗尽（重试只会继续失败）。

**实现上：**
- 每个可重试错误有重试上限（比如 3 次）；
- 超过上限后进入 `idle` + `stop_reason: retries_exhausted`；
- 客户端看到这个状态可以选择手动重试或放弃。

### 8.5 观测性

每一层都要有 metric + trace：

- **控制面**：API 请求量、延迟、错误率（按 endpoint）；
- **Event Store**：写入 TPS、读取 QPS、分区热点；
- **Harness**：session 处理延迟、context build 时间、model 调用 latency/tokens、tool call 分布；
- **Sandbox**：容器冷启动时间、warm pool 命中率、tool 执行延迟；
- **Vault**：凭证访问频率、refresh 失败率。

**Trace 跨越：** 一个 session 的完整 trace 应该串起来——客户端发 event → 控制面写入 → 调度 → harness 处理 → sandbox 执行 → 结果写回 → 推送给客户端。用 session_id 做 trace 的 common attribute 而不是 trace_id（因为一个 session 可能横跨多个"请求"）。

---

## 9. 关键技术方案取舍

这一节集中讨论实现 Managed Agents 时会遇到的若干关键决策点——每个都列出选项、选择、和理由。

### 9.1 Session：日志 vs 快照

**选项：**
- A. **快照模式**：存"当前会话状态"，每次交互 update。
- B. **日志模式**：append-only 事件流，状态从事件投影出来。

**选：B（事件日志）。**

**理由：**
- 长任务里会有 compaction——快照模式下 compaction 后怎么还原历史？只能留备份。日志模式下，compaction 本身是事件，不破坏历史。
- 断线重连要按 event_id 去重——日志是去重的天然单元。
- 审计、回放、调试都需要完整历史。
- 多订阅者（SSE + list API + harness）读同一份数据——日志天然支持。

**代价：** 存储成本比快照高（压缩前 N 倍），读取时要投影（但有 cache 可加速）。

### 9.2 事件分发：SSE vs WebSocket vs Long-polling

**选项：**
- A. Server-Sent Events（SSE）
- B. WebSocket
- C. Long-polling

**选：A（SSE）。**

**理由：**
- 单向通信（server → client）够用——客户端发事件走独立的 POST；
- 基于 HTTP，穿透性好（过代理、CDN 都没问题）；
- 浏览器原生支持（EventSource API），实现简单；
- 断线恢复的语义比 WebSocket 清晰（重连 = 新 GET 请求）。

**什么时候选 WebSocket：** 如果 client → server 的事件流量也很大、需要双向交互、或者需要二进制协议（audio streaming 等）。Managed Agents 不需要。

**什么时候选 long-polling：** 对网络环境极不友好（企业防火墙）时的 fallback。可以作为 SSE 的降级路径，但不作为主路径。

### 9.3 断线语义：server replay vs client dedupe

**选项：**
- A. Server 接受 `since_event_id` 参数，只发之后的事件。
- B. Server 不 replay，client 调 list API + stream 做去重。

**选：B（client dedupe）。**

**理由：**
- A 让 server 要维护 per-connection position 状态，复杂度高；
- A 还要处理 "since_event_id 是旧到已 GC 的事件怎么办"等边界；
- B 让 server 只需暴露两个简单接口（stream、list），组合由客户端决定；
- B 的实现完全对称——SDK 可以封装这个模式，应用代码不用感知复杂度。

**代价：** 首次连接时客户端要多发一次 list 请求（但这只发生在重连时，成本低）。

### 9.4 Context 管理放哪

**选项：**
- A. 放在模型层（让模型自己处理超长 context）。
- B. 放在 harness 层。
- C. 放在存储层（Event Store 触发 compaction）。
- D. 放在客户端。

**选：B（harness），同时给 D 留接口。**

**理由：**
- A 不现实：模型 context 有硬上限；
- C 违反 P1 原则：存储层应该只承诺 durability，不涉足策略；
- D 是好的退路：Beta 暴露了完整 event list 给客户端，客户端可以自己做 compaction——但默认走 B 省事；
- B 是默认的、可演进的、对客户端透明的。

**实现细节：** Harness 的 compaction 作为一个 `agent.thread_context_compacted` 事件写入日志，客户端可以看到发生了压缩，也可以选择重建自己的 context。

### 9.5 Agent 配置：inline vs resource

**选项：**
- A. Session 创建时 inline 传 agent 配置（model、system、tools）。
- B. Agent 是独立 resource，session 只引用 ID。

**选：B（resource）。**

**理由：**
- Agent 配置可能很大（100K 字符 system prompt + 几十个 tools + skills）——inline 每次传浪费带宽；
- 版本化需要 agent 是资源（inline 没有版本语义）；
- Session 级别的 agent pinning（"我要用 v3"）需要引用；
- 多个 session 共享同一个 agent——resource 天然支持。

**代价：** 客户端必须两步操作（先 `agents.create`，再 `sessions.create`）。Beta 文档里反复强调"Agent once, session every run"——就是因为开发者最容易误操作的地方是把 `agents.create` 写在 session loop 里。

**要不要支持 inline 作为 fallback：** 不要。提供 inline 会让开发者偷懒，跳过 resource 化带来的所有好处。"不能 inline"本身是一种 forcing function。

### 9.6 Agent 版本化：immutable vs mutable

**选项：**
- A. Agent 不可变（update 创建新 agent）。
- B. Agent 可变（update 覆盖，但生成新版本号）。

**选：B（mutable + 版本化）。**

**理由：**
- A 让"同一个 agent 的不同版本"失去连续性——你有 `agent_v1`、`agent_v2`、`agent_v3` 三个 ID，但它们在逻辑上是同一个 agent；
- B 允许 "update in place"——agent_id 稳定，内部版本递增，session 根据需要 pin 不同版本；
- B 更贴合用户的心智模型（"我要升级这个 agent" 而不是"我要创建 agent 的新版本并废弃旧的"）。

**实现要点：**
- 每次 update 生成新版本记录，旧版本不删；
- Session 在创建时 snapshot 它引用的版本；
- 提供 archive 让用户能停止新 session 引用这个 agent，但已有 session 继续跑。

### 9.7 Tool 执行：容器内 harness vs 远程 RPC

**选项：**
- A. Harness 跑在容器里，tool 执行和 harness 同进程。
- B. Harness 在外，tool 通过 RPC 调容器。

**选：B（远程 RPC）。**

**理由见 engineering 博客的 "Harness Leaves the Container"**：
- 容器失败不影响 harness；
- Harness 可以水平扩展；
- TTFT 大幅下降（harness 启动不等容器）；
- Harness 可以同时调多个容器（多 sandbox）。

**代价：** 每次 tool call 多一跳 RPC（网络延迟几毫秒到几十毫秒）。对于 bash 命令这种内部耗时秒级的 tool 可以忽略；对于 `read` 文件这种毫秒级 tool 会有相对延迟。实践里值。

### 9.8 凭证：容器 env var vs proxy 注入

**选项：**
- A. 容器启动时把凭证注入为环境变量。
- B. 凭证只在 egress proxy 里出现，容器里看不到。

**选：B（proxy 注入）。**

**理由见 7.1。** 根本上：A 让 Claude 生成的任何 shell 命令都能 `env | grep TOKEN` 拿到凭证。这在 prompt injection 场景下是致命的。

**代价：** 只能支持有网络出站的凭证消费模式（HTTP/HTTPS API）。CLI 本地操作（比如 `aws s3 cp` 用本地 credential file）不 work——必须通过 custom tool 绕到 host 端。这是可以接受的约束。

### 9.9 Checkpoint 策略

**选项：**
- A. 每次 idle 都 checkpoint。
- B. 仅 idle 持续超过 N 分钟才 checkpoint。
- C. 定时 checkpoint（比如每 5 分钟一次）。

**选：B（N 分钟后 checkpoint）。**

**理由：**
- A 太激进：idle 后马上发消息的场景（连续对话）会反复 checkpoint/restore；
- C 浪费：跑得好的 session 不需要打扰；
- B 是 pay-for-what-you-use：只有真的闲置了才做。

**N 的选择：** 5 分钟是一个常见选择——覆盖"去喝杯咖啡"这种短离开，但对"几天后继续"这种场景能省下大量资源。

### 9.10 多 agent：同容器 vs 跨容器

**选项：**
- A. 所有 agent 共享同一个容器（共享文件系统）。
- B. 每个 agent 独立容器。

**选：A（共享容器）**—— Beta 的选择。

**理由：**
- 多 agent 协作的典型场景是 coordinator 派活给 specialist，specialist 要看 coordinator 写的文件（比如代码改动）——A 下是天然的；B 下要做文件同步；
- 容器成本：A 一个 session 一个容器；B 一个 session N 个容器（贵）；
- Context 隔离通过 **thread**（每个 agent 独立 session thread）实现——agent 的对话历史是独立的，但工作空间共享。

**代价：**
- 一个 agent 写脏的文件会影响其他 agent（需要自律）；
- 不能按 agent 维度限制网络策略。

**什么时候选 B：** 如果 agent 之间需要强隔离（不同信任级别）——但在这种场景下你可能根本不应该把它们放同一个 session。

---

## 10. API 形态建议

### 10.1 资源 endpoint 的最小集

完全对齐 Beta 的路径形态，但此处做剪裁说明——MVP 里哪些必须、哪些可选。

```
# 必须（MVP）
POST   /v1/agents                          (create)
GET    /v1/agents/{id}                     (retrieve)
POST   /v1/agents/{id}                     (update → new version)

POST   /v1/environments                    (create)
GET    /v1/environments/{id}               (retrieve)

POST   /v1/sessions                        (create)
GET    /v1/sessions/{id}                   (retrieve)
POST   /v1/sessions/{id}/events            (send event)
GET    /v1/sessions/{id}/events            (list events)
GET    /v1/sessions/{id}/events/stream     (SSE)

# 重要但非 MVP
GET    /v1/agents                          (list)
POST   /v1/agents/{id}/archive
GET    /v1/agents/{id}/versions
POST   /v1/vaults
POST   /v1/vaults/{id}/credentials
POST   /v1/files                           (upload)

# 进阶
GET    /v1/sessions/{id}/threads           (multi-agent)
POST   /v1/memory_stores                   (research preview)
```

### 10.2 事件 envelope

所有事件的通用结构：

```json
{
  "id": "sevt_01...",                       // ULID
  "session_id": "sesn_01...",
  "seq": 42,                                // 单 session 内自增
  "type": "agent.message",
  "processed_at": "2026-04-23T14:00:00Z",   // nullable
  "created_at": "2026-04-23T13:59:59Z",
  "session_thread_id": "thd_01...",         // nullable, for multi-agent
  "payload": { ... }                        // type-specific
}
```

**设计要点：**
- `seq` 是单 session 内严格递增——客户端如果想做"按顺序处理"不用靠 `created_at`（时钟偏差不准）；
- `id` 是全局唯一——跨 session 的去重也能做；
- `session_thread_id` 在 primary thread 时为 null，子 thread 时带上——这样客户端可以按 thread 分流。

### 10.3 错误响应

统一的错误 envelope（对齐 Anthropic API 风格）：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error" | "authentication_error" | ...,
    "message": "具体错误信息",
    "details": { ... }                      // 可选，比如哪个字段错了
  },
  "request_id": "req_01..."
}
```

**关键：** 每个响应带 `request_id`——服务端日志用它来溯源，客户端用它向支持团队报告。

---

## 11. 实施路线

### Phase 0：最小可运行骨架（2-4 人月）

**范围：**
- 单租户；
- 单 region；
- Agent / Environment / Session CRUD；
- Event Store（Postgres）；
- SSE stream + list API；
- 单进程 harness（无池化）；
- 单 Docker 容器作 sandbox（不做多租户隔离）；
- 只支持 agent toolset（bash / file ops）；
- 无 MCP、无 vault、无多 agent。

**目标：** 能跑通"create agent → create session → send user message → stream agent response → 看到 agent 写文件"的完整 e2e flow。

### Phase 1：多租户 + 凭证隔离（2-3 人月）

**加入：**
- Tenant / workspace 概念，全部 resource 加 workspace_id；
- API 授权层；
- Firecracker 或 gVisor 替换普通 Docker；
- Vault + credential CRUD；
- Egress proxy + MCP 凭证注入；
- Git repo resource + git proxy。

**目标：** 能接入外部客户用于 production。

### Phase 2：可扩展性（3-4 人月）

**加入：**
- 消息队列 + harness worker 池化；
- 容器 warm pool；
- Checkpoint / restore；
- Rescheduling 重试机制；
- SSE 分发器改为 Pub/Sub 模式；
- Prompt caching 支持；
- Compaction 默认策略。

**目标：** 支撑数千并发 session，99% SLO。

### Phase 3：高级能力（持续）

**按需加入：**
- Multi-agent（callable_agents）；
- Memory stores；
- Outcomes（rubric grader）；
- 跨 region 部署；
- 私有网络接入（VPC peering）；
- 更聪明的 compaction 策略。

### 常见陷阱清单

实施过程中必踩的坑，提前知道能省 6 个月：

1. **过早优化 cache。** Prompt caching 看起来能省钱，但策略错了会把成本变高（cache miss 付全价）。先跑通再优化。

2. **把 agent 配置塞到 session body 里。** 用户会这么用，看起来方便。但这会让所有版本化和复用都失效。从 API 设计上禁止它。

3. **容器池化过度。** Warm pool 大小设太大，idle 容器烧钱；设太小，冷启动体验差。必须配合指标自动调。

4. **忽略 processed_at 的双相语义。** 客户端 SDK 如果 naive 地按 event_id 去重，会错过"同一个事件的 processed_at 更新"——导致 UI 一直显示"pending"。

5. **Event Store 不分区。** 随 session 量增长，一张 events 表会迅速变成 TB 级——查询变慢、vacuum 停不下。从第一天就按 session_id 分区。

6. **Checkpoint 过度依赖 CRIU。** CRIU 对有 TCP 连接的进程恢复很脆弱。推荐"FS snapshot + harness 从日志重建进程状态"的组合。

7. **凭证 proxy 做 URL substring 匹配。** 这是开后门。必须精确 host 匹配 + HTTPS only。

8. **Rescheduling 没有上限。** 无限重试会把故障 session 变成 cost sink。必须配上限 + retries_exhausted 状态。

9. **不区分 tool 业务错误和系统错误。** 把系统错误作为 tool_result 返回给 Claude，它会改写业务逻辑绕过——难 debug。

10. **SSE 没有心跳。** 中间 proxy（企业防火墙、load balancer）会在 30-60s 无数据时断连接，看起来像随机断线。15 秒一个心跳。

---

## 12. 开放问题与设计余地

一些 Beta 还没明确答案、或者未来可能演进的方向——如果你实施时遇到，可以自己做选择。

### 12.1 用户自带 harness

Beta 目前没暴露"用户替换 harness"的接口——你用的是 Anthropic 提供的默认 harness。但架构上这是可能的：所有接口（session、sandbox、vault）都足够独立，理论上可以让用户自带 harness 来消费它们。

**设计空间：**
- 把 harness 做成可插件化的 agent 配置？（风险：用户写的 harness 质量不一，支持成本高）；
- 把 session 日志 + sandbox 暴露为独立 API，让用户完全在外部编排？（风险：平台价值被稀释）；
- 中间路线：只允许替换 context 策略（比如自定义 compaction），其他保持默认？（最安全的渐进）。

### 12.2 非 container sandbox

目前 sandbox 都是容器。但 `execute(name, input)` 接口不限定容器——理论上可以是：
- 无服务器 function（Lambda、Cloud Functions）；
- 物理机远程执行（企业场景）；
- WebAssembly 运行时（轻量隔离）；
- 用户自管的 runtime。

每种都有不同的 trade-off：启动时间、隔离强度、能跑什么、成本。当有客户提出"我要在我自己的 VPC 里跑 sandbox" 时，这个抽象能扩展过去。

### 12.3 Session 分叉

当前 session 是线性的——事件按时间顺序排。但概念上 session 是 git 式的树可以 fork：
- 从某个事件 X 派生两条分支，分别试不同方案；
- A/B 测试 agent 行为；
- "回到 5 分钟前重试"。

实现成本很高（event ID 需要支持 lineage、container state 要能 fork），但对某些场景（evaluation、回放调试）价值巨大。

### 12.4 成本控制

MVP 时很容易忽略，但 production 必须解决：

- **Per-session token 上限。** 防止 agent 进入循环烧钱。
- **Per-tenant 并发 session 上限。**
- **Idle 容器超时。** 多久不活动就强制 terminate（不只是 checkpoint）。
- **预估成本的接口。** 让客户端知道"这次 session 到现在花了多少钱"。

这些都不是架构决定，但不做你会亏钱。

### 12.5 可观测性的对外暴露

今天平台知道每个 session 内部发生的一切——哪些 tool 被调了、token 用了多少、延迟在哪。但对用户暴露多少是个产品问题：
- 最少：session 的 usage 字段（token 统计）；
- 中等：每个 model call 的 latency 和 token（已有 `span.model_request_end`）；
- 多：tool 级别的 latency 分布、prompt cache 命中率、compaction 发生时机；
- 极限：可以供 debugging 的完整执行 trace（可能泄露内部实现）。

暴露得多用户感恩，但以后改实现会破坏他们的 dashboard。从 P1 原则出发——只暴露**语义稳定**的指标，不暴露实现细节（比如"compaction 算法版本号"就别暴露了）。

---

## 结语

Managed Agents 不是一堆功能的集合，而是一个**取舍的集合**：在每一个关键决策点上选了"对实现者友好、对实现的未来友好"的那一条。

这份文档的价值不在于让你**抄**这套系统，而在于让你**复用它的思考框架**：

- 在你的系统里，哪些东西属于"接口"（稳定、对外承诺）？哪些属于"实现"（可演进、不对外承诺）？
- 你的状态放在哪？每一处状态能不能独立失败？
- 你的凭证怎么做到"Claude 写的代码物理上拿不到"？
- 你的 agent 配置能不能版本化、能不能在多个 session 间安全共享？
- 你的 harness 能不能在任何时刻重启而不丢数据？

如果这五个问题你都有清晰的答案——无论答案是不是和 Anthropic 的一样——你就建成了一套合格的 Managed Agents 形态系统。
