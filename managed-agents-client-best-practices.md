# Managed Agents 客户端开发最佳实践

> 一份自成体系的客户端开发指南。目标读者:决定把 Managed Agents(下称 CMA)接入自己产品的应用开发者——无论是 IDE 副驾、网页 chatbot、Slack bot、webhook/cron 后端,还是多租户 SaaS。本文从心智模型讲到架构,从组件设计讲到陷阱清单,覆盖从第一行代码到上线 checklist 的完整路径。

---

## 目录

- [0. 关于本文档](#0-关于本文档)
- [1. 核心概念:四个对象和一条调用链](#1-核心概念四个对象和一条调用链)
- [2. 四条必建的心智模型](#2-四条必建的心智模型)
- [3. 客户端标准架构](#3-客户端标准架构)
- [4. SessionDriver:客户端的核心组件](#4-sessiondriver客户端的核心组件)
- [5. 事件流详解](#5-事件流详解)
- [6. 十个必须掌握的客户端模式](#6-十个必须掌握的客户端模式)
- [7. 关键决策点](#7-关键决策点)
- [8. 按产品形态的落地建议](#8-按产品形态的落地建议)
- [9. 安全实践](#9-安全实践)
- [10. 资源和文件管理](#10-资源和文件管理)
- [11. 错误处理与重试](#11-错误处理与重试)
- [12. 可观测性](#12-可观测性)
- [13. 测试策略](#13-测试策略)
- [14. API 陷阱与命名坑](#14-api-陷阱与命名坑)
- [15. 调试清单](#15-调试清单)
- [16. 上线前 checklist](#16-上线前-checklist)
- [附录 A. SessionDriver TypeScript 模板](#附录-a-sessiondriver-typescript-模板)
- [附录 B. SessionDriver Python 模板](#附录-b-sessiondriver-python-模板)

---

## 0. 关于本文档

### 读者定位

你是一个应用开发者,决定把 Managed Agents(CMA)作为你产品的 agent 运行时。你要做的是写出一个**生产级客户端**——从第一次跑通 hello world,到能上线扛流量、处理故障、满足安全合规。

本文不假设你读过其他资料。每一个关键细节(协议字段、事件类型、错误码、陷阱模式)都在正文里 inline 讲解。

### 怎么读

- **从零开始规划项目**:按章节顺序读 §1 → §6,再按产品形态跳到 §8 对应子节;
- **review 已有代码**:直接看 §6 和 §16;
- **遇到具体症状**:查 §14(命名陷阱)和 §15(调试清单);
- **做架构评审**:§3、§4、§7 是核心。

### 本文不讨论

- 怎么实现 Managed Agents 本身(那是平台工程师的话题);
- Managed Agents 的设计哲学(为什么这么设计);
- Messages API、Claude SDK 的基础用法;
- Anthropic 控制台的使用。

---

## 1. 核心概念:四个对象和一条调用链

### 1.1 四个核心对象

CMA 的整个 API 围绕四个对象展开:

| 对象 | 本质 | 生命周期 | 你会怎么用 |
|---|---|---|---|
| **Agent** | 一份持久化、版本化的 agent 配置(model + system prompt + tools + mcp_servers + skills) | 一次创建,多次 update 产生新版本,最终 archive | **一次性建好,跨所有 session 复用** |
| **Environment** | 一份容器模板(networking 策略 + 预装包) | 创建后可更新(只影响新 session)或 archive | 跨 session 共享 |
| **Session** | 一次具体运行——指向一个 agent + 一个 environment,持有自己的容器实例和事件日志 | 每次用户交互/任务启动一个,走完 archive | 每次运行都新建一个 |
| **Event** | Session 事件日志里的一条记录——user 消息、agent 输出、tool 调用、状态变更 | 进日志不可变 | 通过 stream 实时消费,通过 list 历史回溯 |

**核心关系**:

```
          ┌─────────┐
          │  Agent  │   ←── 配置(可复用)
          │ (类)    │
          └────┬────┘
               │ 引用 by id + version
               ▼
          ┌─────────┐     ┌─────────────┐
          │ Session │ ←── │ Environment│   ← 容器模板
          │ (实例)  │     └─────────────┘
          └────┬────┘
               │ 产生
               ▼
          ┌─────────────────────────────┐
          │ Event log (append-only)     │
          │   user.message              │
          │   agent.message             │
          │   agent.tool_use            │
          │   agent.tool_result         │
          │   session.status_idle       │
          │   ...                       │
          └─────────────────────────────┘
```

**直观比喻**:Agent 是"程序",Session 是"进程",Environment 是"OS"。程序可以运行多次,每次起一个新进程;环境决定了进程能调用什么系统资源。

### 1.2 最小调用链

任何使用 CMA 的客户端,都是以下四步调用的组合:

```
1. agents.create(...)            ← 一次性,建好存起来
2. environments.create(...)      ← 一次性,建好存起来
3. sessions.create(agent_id, environment_id, ...)   ← 每次运行
4. (开 stream) + events.send(user.message) + 消费事件 + 回应 tool
```

**记住**:1 和 2 是 **setup time**,3 和 4 是 **runtime**。它们在代码里**必须物理分开**——§3.1 详细讲。

### 1.3 API beta headers 速览

CMA 所有 endpoint 要求 `anthropic-beta: managed-agents-2026-04-01` header。SDK 会自动加,你在用 `client.beta.agents.*` / `client.beta.sessions.*` / `client.beta.environments.*` / `client.beta.vaults.*` 时不需要手工加。

**但有一个例外**:当你调 Files API 带 `scope_id` 参数(拉 session 的产物)时,SDK 只会自动加 Files 的 header,**你必须手动加 CMA 的 header**:

```python
client.beta.files.list(
    scope_id=session.id,
    betas=["managed-agents-2026-04-01"],   # 必须手动
)
```

这个坑在 §10.2 展开讲。

### 1.4 限流

你会撞到的主要限制(都是 org 级别):

| 操作 | RPM | 并发 |
|---|---|---|
| Create(agents / sessions / vaults) | 60 | — |
| 其他操作(agents / sessions / vaults) | 600 | — |
| Environments 所有操作 | 60 | **5** |
| 模型推理(session 内部) | 走 ITPM/OTPM 标准限速 | — |

**Environments 的 5 并发最容易被低估**——文档没讲清这是"5 个活跃 session 的容器",还是"5 个 CRUD 调用"。保守按前者理解,上线前联系 Anthropic 确认。

---

## 2. 四条必建的心智模型

CMA 不是一个普通 API。以下四条心智,任一条没装对,写出来的客户端会在某个时刻炸裂。

### 2.1 CMA 是基础设施供应商,不是应用框架

**错误心智**:"我把用户输入丢给 session,agent 就会把答案返回,就像调 Messages API 一样。"

**正确心智**:"我在写一个**状态机驱动、长连接、多事件消费者**的客户端。CMA 提供 session 日志 + 沙箱容器 + 模型编排,我的客户端负责把它们串起来驱动。"

这决定了你的代码形态——它**不是**:

```
response = client.call(prompt)
render(response)
```

它**是**:

```
stream = open_stream(session_id)
send(user_event)
for event in stream:
    dispatch_to_handler(event)   # UI 更新 / 工具回应 / 状态持久化 / 错误恢复
```

从启动的第一行代码就在处理事件流、维护 session 状态、准备随时断线重连——跟写一个 REST API consumer 是两种思维模式。

### 2.2 Agent vs Session 是"类 vs 实例"

**错误心智**:"session 创建要传 agent 配置。"(这是 Messages API 的思维)

**正确心智**:"Agent 是一个持久化的**类定义**(model + system + tools + skills + mcp_servers),Session 是每次运行的**实例**——实例只持有对类的引用和版本号,不带配置。"

这决定了你的启动脚本结构——**一次性的 class 定义**(`agents.create`、`environments.create`)要和**每次运行的实例化**(`sessions.create`)严格分开。前者放在部署脚本、migration、secrets manager;后者放在请求路径。在请求路径里调 `agents.create()` 是最经典的反模式,几个月后你会有几万个 orphan agent,且 agent 没有 `delete`,只能 `archive`(单向终态,无 unarchive)。

### 2.3 事件流是唯一真相源

**错误心智**:"我在客户端本地维护一份 agent 说过什么、工具跑没跑完的状态镜像,这样刷新页面可以快速展示。"

**正确心智**:"session 的 event log 是服务端的**权威记录**。任何本地状态都只是事件流的派生(derived state)。刷新、断线、换设备——**永远是重放事件流**,不从本地状态恢复。"

这决定了你的客户端数据流:

```
Event Store (服务端权威)
    ↓ stream + list(consolidation)
本地事件缓冲
    ↓ reduce / project
UI state / 本地缓存(都是派生)
```

单向数据流。UI 不直接持久化任何 agent state;你只需要保存 `session_id`,下次打开从 event 流重建即可。这点在 §6 的 crash recovery 模式里尤其关键。

### 2.4 Session 里很多事情需要你回应,不是等它自动完成

**错误心智**:"发了 user.message,等 agent 回复完就结束了。"

**正确心智**:"Session 随时可能 idle 在某个等你回应的点——等 `user.tool_confirmation`、等 `user.custom_tool_result`、等 interrupt 后的下一步指令。你不回应它就一直 idle。**客户端是对话的另一半**,不是被动接收者。"

这决定了你的事件循环必须有 **idle-break gate**(§6.3 详述):不能只看 `session.status_idle`,必须看 `stop_reason.type`。

---

## 3. 客户端标准架构

这一节给出一个可直接使用的客户端架构模板。所有产品形态都在这个骨架上做裁剪。

### 3.1 分两个 plane:Setup Plane vs Runtime Plane

```
┌──────────────────────────────────────────────┐
│ Setup Plane(一次性 / 低频)                  │
│   ├─ environments.create                     │
│   ├─ agents.create / update                  │
│   ├─ skills.create(如果有 custom skill)     │
│   ├─ vaults.create(共享或 per-tenant 时)    │
│   └─ 输出:ENV_ID, AGENT_ID, AGENT_VERSION   │
│           → 持久化到 config / secrets        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Runtime Plane(每次用户交互)                 │
│   ├─ sessions.create(agent=ID, env=ID, ...)  │
│   ├─ events.stream() + events.send()         │
│   ├─ 处理 tool_use / custom_tool_use 回应    │
│   ├─ 处理错误、断线、中断                    │
│   └─ sessions.archive()                      │
└──────────────────────────────────────────────┘
```

两个 plane **必须物理分离**:
- Setup Plane:部署时/初始化时跑一次的脚本,类似数据库 migration;
- Runtime Plane:请求路径上的代码,每次调用都跑。

放在同一个脚本里不是不行,但要用 `if not os.getenv("AGENT_ID"): setup()` 守起来。否则**每次请求都创建一个新 agent**——这是 CMA 生态里最常见的灾难。

### 3.2 Setup Plane 完整模板

```python
# setup.py —— 部署时跑一次,IDs 写到 config / secrets manager
import anthropic

client = anthropic.Anthropic()

def setup_once():
    # 1. Environment(s)
    env = client.beta.environments.create(
        name="prod-coding-env",
        config={
            "type": "cloud",
            "networking": {"type": "unrestricted"},
            # 或 limited networking:
            # "networking": {
            #     "type": "package_managers_and_custom",
            #     "allowed_hosts": [
            #         "api.github.com",
            #         "api.githubcopilot.com",   # MCP server 域名必须 whitelist!
            #         "pypi.org",
            #     ],
            # },
        },
    )

    # 2. Custom skills(可选)
    # skill = client.beta.skills.create(...)
    # client.beta.skills.versions.create(skill.id, ...)

    # 3. Agent
    agent = client.beta.agents.create(
        name="My Coding Agent v1",
        model="claude-opus-4-7",
        system=SYSTEM_PROMPT,
        tools=[
            {
                "type": "agent_toolset_20260401",
                "default_config": {
                    "enabled": True,
                    "permission_policy": {"type": "always_allow"},
                },
                "configs": [
                    # bash 和 write 要用户点"允许",其它自动放行
                    {"name": "bash", "permission_policy": {"type": "always_ask"}},
                    {"name": "write", "permission_policy": {"type": "always_ask"}},
                ],
            },
            {"type": "mcp_toolset", "mcp_server_name": "github"},
            # 自定义 tool(host 侧执行)
            {
                "type": "custom",
                "name": "open_file_in_ide",
                "description": "Ask the IDE to open a file at a given line.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "line": {"type": "integer"},
                    },
                    "required": ["path"],
                },
            },
        ],
        mcp_servers=[
            {"type": "url", "name": "github", "url": "https://api.githubcopilot.com/mcp/"},
        ],
        skills=[
            {"type": "anthropic", "skill_id": "pdf"},
        ],
    )

    # 4. 持久化到 config / secrets manager / .env
    persist({
        "ENV_ID": env.id,
        "AGENT_ID": agent.id,
        "AGENT_VERSION": agent.version,   # 用于 prod pin
    })
```

几个关键点:
- **不在 setup 里建 per-user vault**——vault 按用户/租户的初始化属于 runtime(§9.2 讲);
- **AGENT_VERSION 必须持久化**,不只 AGENT_ID。prod 建议 pin 版本(§7.5);
- **多 agent 用命名规范区分**(`CODING_AGENT_ID`、`REVIEW_AGENT_ID`),别覆盖;
- **更新 agent 用 `agents.update()`**,不是建新 agent——update 会生成新版本号,旧版本不删,已有 session 继续跑在原版本上。

### 3.3 Runtime Plane 的必备组件

一个生产级客户端 runtime 至少有以下组件:

| 组件 | 职责 | 跳过的代价 |
|---|---|---|
| **SessionDriver** | 单个 session 的事件循环 + 状态机 + 协议处理 | 散落到 UI 里,无法测试,到处都是协议 bug |
| **ToolHandler 注册表** | `agent.custom_tool_use.name` → 处理函数的映射 | 用 if/else 硬编码,维护性差 |
| **ConfirmationPolicy** | `agent.tool_use(ask)` 的 allow/deny 决策逻辑 | 策略散落,审计困难 |
| **SessionStore** | `user_id` / `thread_id` ↔ `session_id` 持久化映射 | 刷新页面就丢 |
| **ReconnectOrchestrator** | 断线/crash 时重建 SessionDriver | 任何异常重启都丢状态 |
| **ObservabilityHook** | 记录 request_id / token usage / 关键事件 | 出问题没法查 |
| **CleanupJob** | 扫僵尸 session(长时间未收尾) | 数据库里累积 running session,操作变慢 |

**SessionDriver 是整个架构的核心,§4 专门讲**。

---

## 4. SessionDriver:客户端的核心组件

SessionDriver 是所有客户端里最重要、也最容易写错的组件。它的质量决定了产品是"demo 能跑"还是"生产能扛"。

### 4.1 SessionDriver 的职责

一个 SessionDriver 实例管理**一个** session 的全生命周期:

1. **启动或重连** session(根据上下文决定);
2. **打开事件流并消费**(先 stream 后 send、断线按 ID 去重);
3. **把事件 dispatch 给上层**(UI、业务逻辑回调);
4. **在合适时机回应** `user.tool_confirmation` / `user.custom_tool_result`;
5. **执行 idle-break gate**(看 `stop_reason.type`,不只看 status);
6. **处理 interrupt**(发 interrupt 事件 + 等真的 idle);
7. **正确收尾**(poll status,再 archive);
8. **错误分类 + 上报**。

UI handler 不应该直接写事件循环。UI 应该只订阅 SessionDriver 的事件回调。

### 4.2 状态机

```
      ┌─────────┐
      │  init   │
      └────┬────┘
           │ start() → sessions.create()
           ▼
      ┌───────────┐     tool_confirm/result 回应完       ┌─────────┐
      │connecting ├──────────────────────────────────────►│ running │
      └─────┬─────┘                                        └────┬────┘
            │ stream 打开 + history 消费完                      │
            ▼                                                   │ idle(requires_action)
      ┌─────────┐                                               │
      │  ready  │◄──────────────────────────────────────────────┘
      └────┬────┘
           │ user.message / user.interrupt
           ▼
      ┌─────────┐
      │ running │
      └────┬────┘
           │ idle(end_turn) / idle(retries_exhausted) / terminated
           ▼
      ┌─────────┐
      │ closing │
      └────┬────┘
           │ poll status → archive
           ▼
      ┌─────────┐
      │  closed │
      └─────────┘
```

### 4.3 标准事件消费循环

```typescript
async function run(sessionId: string): Promise<TerminalReason> {
  // 1. 先打开 stream(服务端立刻开始 buffer)
  const stream = await client.beta.sessions.events.stream(sessionId);

  // 2. 拉历史,按 event.id 加入 seen set
  const seen = new Set<string>();
  for await (const ev of client.beta.sessions.events.list(sessionId)) {
    seen.add(ev.id);
    await dispatchEvent(ev);   // 历史事件也要 dispatch,UI 从历史重建
  }

  // 3. 消费 live 事件
  for await (const ev of stream) {
    // dedupe 只 gate dispatch
    if (!seen.has(ev.id)) {
      seen.add(ev.id);
      await dispatchEvent(ev);
    }

    // 终止判断在 dedupe 之外——即便事件在历史里见过,也要用它判断是否该退出
    if (ev.type === "session.status_terminated") return "terminated";
    if (ev.type === "session.status_idle") {
      const reason = ev.stop_reason?.type;
      if (reason === "requires_action") {
        // agent 在等我们回应,处理后继续循环
        await handleRequiresAction(sessionId, ev.stop_reason.event_ids);
        continue;
      }
      if (reason === "end_turn") return "end_turn";
      if (reason === "retries_exhausted") return "retries_exhausted";
    }
  }

  return "stream_ended";  // 不该走到,但兜底
}
```

**三个细节值得突出**:

1. **历史事件也要 dispatch**——UI 要能从历史重建(刷新页面、crash 恢复都靠这个)。不要只 dispatch live 事件。
2. **dedupe 只 gate dispatch,不 gate 终止判断**——如果终止事件(`session.status_terminated` / `session.status_idle(end_turn)`)落在了历史里(比如 reconnect 一个已经完成的 session),`seen.has(ev.id) continue` 会跳过终止判断,循环永不退出。这是最常见的 bug。
3. **`handleRequiresAction` 按 `stop_reason.event_ids` 找待处理事件**——这些是 agent 在等待被回应的事件 ID 列表。

完整代码见 [附录 A](#附录-a-sessiondriver-typescript-模板)(TypeScript)和 [附录 B](#附录-b-sessiondriver-python-模板)(Python)。

### 4.4 Tool 回应的分发

让 SessionDriver 持有一个 **ToolHandler 注册表 + ConfirmationPolicy**,避免在事件循环里硬编码 if/else:

```typescript
type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

class SessionDriver {
  private customToolHandlers = new Map<string, ToolHandler>();
  private confirmationPolicy: ConfirmationPolicy;

  registerCustomTool(name: string, handler: ToolHandler) {
    this.customToolHandlers.set(name, handler);
  }

  private async handleRequiresAction(
    sessionId: string,
    blockingEventIds: string[]
  ): Promise<void> {
    for (const eventId of blockingEventIds) {
      const ev = this.eventById.get(eventId);
      if (!ev) continue;

      if (ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use") {
        if (ev.evaluated_permission !== "ask") continue;

        const decision = await this.confirmationPolicy.evaluate(ev);
        await client.beta.sessions.events.send(sessionId, {
          events: [{
            type: "user.tool_confirmation",
            tool_use_id: ev.id,   // ev.id 是 sevt_*,不是 toolu_*
            result: decision.allow ? "allow" : "deny",
            ...(decision.allow ? {} : { deny_message: decision.reason }),
          }],
        });
      } else if (ev.type === "agent.custom_tool_use") {
        const handler = this.customToolHandlers.get(ev.name);
        if (!handler) {
          // 没 handler 时必须回 error,否则 session 永远 idle
          await this.sendCustomToolError(
            sessionId, ev.id, `No handler registered for ${ev.name}`
          );
          continue;
        }
        try {
          const result = await handler(ev.input, { sessionId, eventId: ev.id });
          await client.beta.sessions.events.send(sessionId, {
            events: [{
              type: "user.custom_tool_result",
              custom_tool_use_id: ev.id,   // 注意字段名是 custom_tool_use_id
              content: [{ type: "text", text: result.text }],
              is_error: result.isError ?? false,
            }],
          });
        } catch (err) {
          await this.sendCustomToolError(sessionId, ev.id, String(err));
        }
      }
    }
  }
}
```

**四个最关键的点**:

1. **`tool_use_id` 填 `event.id`**(`sevt_...`),**不是**事件里的 `toolu_*` ID。填错服务端找不到,session 永远 idle。
2. **`user.custom_tool_result` 的字段名是 `custom_tool_use_id`**,注意不是 `tool_use_id`——跟 tool_confirmation 的字段名有差异。
3. **没注册 handler 时必须回 `is_error: true`**,不能不回。不回 session 永远 idle 直到 retries_exhausted。
4. **Handler 抛异常时也要回 error result**——不能让异常冒到事件循环外导致循环退出。

### 4.5 断线恢复 vs Crash 恢复

两种场景,处理路径一致但触发不同:

**断线恢复**:SSE 连接断了但客户端进程还在(网络抖动、反代超时、Wi-Fi 切换):
- 触发:stream 迭代器抛异常或自然结束;
- 动作:重新 `sessions.events.stream(session_id)` + 重走标准循环,`seen` set 可以复用。

**Crash 恢复**:客户端进程挂了/重启:
- 触发:进程启动时,从持久化存储读出上次的 `session_id`;
- 动作:新建 SessionDriver 实例,从空 `seen` set 走完整 consolidation。

两者**共用一个 `reconnect` 函数**:

```typescript
async function reconnect(sessionId: string): Promise<TerminalReason> {
  // 先查 session 状态,判断是否还能恢复
  const s = await client.beta.sessions.retrieve(sessionId);
  if (s.status === "terminated") return "terminated";
  if (s.archived_at != null) throw new Error("session archived");
  return await run(sessionId);   // 标准循环
}
```

### 4.6 Interrupt 的正确姿势

```typescript
async function interrupt(sessionId: string): Promise<void> {
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.interrupt" }],
  });
  // 不 archive,不做别的。事件循环的 idle-break gate 会检测到并退出。
}
```

**注意**:Interrupt 不是 SIGKILL——agent 要跑到安全边界(通常是当前 tool call 或模型调用结束)才停。发完 interrupt 不要立刻 archive,不然间歇性 409("cannot archive while running")。

### 4.7 正确的 cleanup 时机

```typescript
async function cleanup(sessionId: string): Promise<void> {
  // SSE 的 session.status_idle 早于 REST 的 status 更新,要 poll
  for (let i = 0; i < 10; i++) {
    const s = await client.beta.sessions.retrieve(sessionId);
    if (s.status !== "running") break;
    await sleep(200);
  }
  await client.beta.sessions.archive(sessionId);
}
```

**禁止**:看到 `session.status_idle` 事件就立刻 archive。会间歇性 409。

---

## 5. 事件流详解

### 5.1 事件类型完整清单

**Agent 侧事件**(服务端推给你):

| 类型 | 含义 | 你要做什么 |
|---|---|---|
| `agent.message` | Agent 的文本输出 | 渲染到 UI |
| `agent.thinking` | Agent 的 extended thinking(推理过程) | 可选渲染,一般折叠 |
| `agent.tool_use` | Agent 调用了 built-in tool(bash/read/write/...) | 如果 `evaluated_permission=='ask'`,需要回 tool_confirmation |
| `agent.tool_result` | Built-in tool 的结果 | 一般不需要处理,dispatch 到 UI 显示即可 |
| `agent.mcp_tool_use` | Agent 调用了 MCP 工具 | 同 `agent.tool_use` 的 permission 逻辑 |
| `agent.mcp_tool_result` | MCP 工具的结果 | 同上 |
| `agent.custom_tool_use` | Agent 调用了你声明的 custom tool | **必须**回 `user.custom_tool_result` |
| `agent.thread_context_compacted` | 历史被自动压缩了 | 一般只记录,UI 可以提示 |

**Session 侧事件**(服务端推给你):

| 类型 | 含义 | 你要做什么 |
|---|---|---|
| `session.status_running` | session 进入 running 状态 | 一般只更新 UI 状态 |
| `session.status_idle` | session 进入 idle,带 `stop_reason.type` | **核心**——根据 stop_reason 决定继续/退出/回应 |
| `session.status_rescheduled` | 瞬时错误,session 重调度中 | 一般记录,等 running 恢复 |
| `session.status_terminated` | session 终止(不可恢复) | 退出事件循环,上报 |
| `session.error` | Session 内部错误 | 记录 + 告警;不一定意味着 session 死了 |

**Span 事件**(观测/计费):

| 类型 | 含义 |
|---|---|
| `span.model_request_start` | 一次模型调用开始 |
| `span.model_request_end` | 一次模型调用结束,带 `model_usage`(token 统计) |

**User 侧事件**(你发给服务端,但也会在 stream 里回显——两次!):

| 类型 | 含义 |
|---|---|
| `user.message` | 用户文本消息 |
| `user.interrupt` | 请求中断 |
| `user.tool_confirmation` | 允许/拒绝 tool 调用 |
| `user.custom_tool_result` | 回应 custom tool |

### 5.2 `stop_reason.type` 的取值

当 `session.status_idle` 事件触发,`stop_reason.type` 决定你下一步动作:

| 值 | 含义 | 客户端动作 |
|---|---|---|
| `requires_action` | Agent 在等你回应(tool_confirmation / custom_tool_result) | `continue`——按 `stop_reason.event_ids` 处理后继续 |
| `end_turn` | 正常完成 | `break`——正常退出循环 |
| `retries_exhausted` | 内部重试耗尽,不可恢复 | `break`——然后 retrieve session 看 error |

**常见错误**:只检查 `session.status_idle` 就退出循环。结果:agent 调 custom tool → idle(requires_action) → 客户端退出 → agent 永远在等。

### 5.3 `processed_at` 的双相语义

客户端发的所有 user 事件(`user.message`、`user.interrupt`、`user.tool_confirmation`、`user.custom_tool_result`)会在 stream 里**出现两次**:

- 第一次:`processed_at: null`(服务端已收到,入队等处理)
- 第二次:`processed_at: "2026-04-23T14:00:00Z"`(agent 真正读到这个事件了)

UI 要能区分这两个阶段,实现"发送中 → 已送达 → 已处理"的视觉:

```typescript
for await (const event of stream) {
  if (event.type === "user.message") {
    if (event.processed_at == null) {
      onQueued(event.id);       // 灰色"已送达"
    } else {
      onProcessed(event.id);    // 变绿"已处理"
    }
  }
}
```

**注意**:`agent.*` 事件没有 queued 阶段,不会两次。服务端自发的 `session.status_*` / `span.*` 也不会。

### 5.4 `event.id` 命名空间区分

客户端代码里最容易搞混的几个 ID:

| ID 前缀 | 含义 | 在哪里出现 |
|---|---|---|
| `sevt_*` | Managed Agents session event ID(**每个事件都有**) | 所有 CMA 事件的 `id` 字段 |
| `toolu_*` | Messages API 内部的 tool_use block ID | `agent.tool_use.tool_use.id` 等嵌套结构里 |
| `sesn_*` | Session ID | `session.id` |
| `agent_*` | Agent ID | `agent.id` |
| `env_*` | Environment ID | `environment.id` |
| `vlt_*` | Vault ID | `vault.id` |
| `file_*` | File ID | `file.id` |

**铁律**:`user.tool_confirmation.tool_use_id` 和 `user.custom_tool_result.custom_tool_use_id` 填的都是**触发事件的 `event.id`**(`sevt_*`),不是任何内部嵌套的 `toolu_*`。

### 5.5 `user.interrupt` 事件的特殊性

`user.interrupt` 是特殊事件:

- **跳过队列**——即使前面还有 user.message 未处理,interrupt 优先触发;
- **不被 agent 当作消息读取**——它只是"请求停止"的信号;
- **`event.id` 可能为空字符串**——当前实现的已知问题,不要依赖它做关联,用 `processed_at` + 相邻事件定位。

### 5.6 消费事件的三种接口

| 接口 | 用途 | 特征 |
|---|---|---|
| `sessions.events.stream(session_id)` | SSE 实时流 | 长连接;**只推开流后的事件**,不 replay |
| `sessions.events.list(session_id)` | 分页拉历史 | 默认 1000/页;返回全量事件历史 |
| `sessions.events.send(session_id, {events: [...]})` | 发事件给 session | POST,可批量发多个事件 |

**关键规则**:
- **Stream 不 replay**——断线重连只收"reconnect 后"的事件,中间的会丢;
- **要完整历史,用 list**;
- **Stream + list 组合做断线恢复**——见 §6.2。

---

## 6. 十个必须掌握的客户端模式

这 10 条是写 CMA 客户端的 non-negotiable 基础。每条给出**问题、正确做法、反例、涉及事件**。

### 6.1 Stream-first:永远先开流再发事件

**问题**:naive 做法是"send → stream"——但 send 返回的那一刻 agent 可能已经开始发事件了。等你把流打开,前面那批事件以 buffered batch 一次性冲过来,逐 token 渲染的 UI 体验全毁。

**正确做法**:

```typescript
// 先 stream
const stream = await client.beta.sessions.events.stream(session.id);
// 再 send
await client.beta.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: "Hello" }] }],
});
// 消费 stream...
```

**反例**:

```typescript
// ❌ 事件被 buffer 成一个大批次
await client.beta.sessions.events.send(session.id, { events: [...] });
const stream = await client.beta.sessions.events.stream(session.id);
```

**对 session 创建同样适用**——`sessions.create()` 完成后立刻开 stream,然后再发 kickoff message。

**涉及事件**:所有 `agent.*` 事件能否按实时顺序到达。

---

### 6.2 Lossless reconnect:断线按历史去重

**问题**:SSE 没有 replay。断线重连时,如果 naive 地"重开 stream 就开始消费",中间那段可能已经发生了关键事件(比如 `agent.custom_tool_use`)——客户端永远收不到,session 死锁在 idle(requires_action)。

**正确做法**——在重连时**同时**拉历史:

```typescript
const seen = new Set<string>();
// 1. 先开 stream(立刻开始 buffer)
const stream = await client.beta.sessions.events.stream(sessionId);
// 2. 拉历史,加入 seen
for await (const ev of client.beta.sessions.events.list(sessionId)) {
  seen.add(ev.id);
  handle(ev);
}
// 3. 消费 live,按 id 去重
for await (const ev of stream) {
  if (!seen.has(ev.id)) {
    seen.add(ev.id);
    handle(ev);
  }
  // ← 终止判断不 gate by dedupe(见 §6.4)
  if (isTerminal(ev)) break;
}
```

**涉及事件**:所有事件,尤其致命的是错过 `agent.custom_tool_use` / `agent.tool_use(ask)` / `session.status_idle(requires_action)`。

---

### 6.3 Idle-break gate:退循环要看 `stop_reason`

**问题**:看到 `session.status_idle` 就 `break` 是典型新手错误。Session 在以下情况都会 idle:
- 并行工具调用之间;
- 等 `user.tool_confirmation`;
- 等 `user.custom_tool_result`;
- interrupt 后。

只看 idle 会提前退出,把 session 晾在那里。

**正确做法**:

```typescript
for await (const ev of stream) {
  handle(ev);
  if (ev.type === "session.status_terminated") break;
  if (ev.type === "session.status_idle") {
    if (ev.stop_reason.type === "requires_action") continue;   // 继续
    break;   // end_turn 或 retries_exhausted
  }
}
```

**反例**:

```typescript
// ❌ 常见新手错
if (ev.type === "session.status_idle") break;
```

**涉及事件**:`session.status_idle.stop_reason.type`。

---

### 6.4 Dedupe 只 gate dispatch,不 gate 终止判断

**问题**:断线重连时的 dedupe 逻辑一旦把终止判断也跳过,会导致循环永不退出(比如一个已经完成的 session 的 `session.status_terminated` 事件在历史里,live stream 回放时 `seen.has(ev.id) continue`,循环不退)。

**正确做法**(把终止判断写在 dedupe 之外):

```typescript
for await (const ev of stream) {
  if (!seen.has(ev.id)) {
    seen.add(ev.id);
    handle(ev);
  }
  // 终止判断必须无条件执行!
  if (ev.type === "session.status_terminated") break;
  if (ev.type === "session.status_idle" && ev.stop_reason.type !== "requires_action") break;
}
```

**反例**:

```typescript
// ❌ 整个循环体都在 dedupe 后面,已见过的事件完全 skip
for await (const ev of stream) {
  if (seen.has(ev.id)) continue;   // BUG:终止也被跳过
  seen.add(ev.id);
  handle(ev);
  if (ev.type === "session.status_terminated") break;   // 永远到不了
}
```

**涉及事件**:`session.status_terminated` / `session.status_idle`。

---

### 6.5 `processed_at` 双相要处理

**问题**:客户端发的 user 事件在 stream 里出现两次(null + timestamp)。UI 不区分就会重复渲染消息气泡,或者一直卡在"发送中"。

**正确做法**:见 §5.3 的代码。

**反例**:

```typescript
// ❌ 每次出现都渲染一个气泡 → 界面重复
if (ev.type === "user.message") renderBubble(ev);
```

**涉及事件**:只有 `user.*` 事件有这个特性。

---

### 6.6 Tool confirmation 的正确回应

**问题**:Agent 配了 `permission_policy: always_ask` 时,每次命中该工具发 `agent.tool_use(evaluated_permission='ask')`,session idle,**必须**回 `user.tool_confirmation`——但客户端最容易犯的错是 `tool_use_id` 字段填错。

**三个 ID 的辨析**:
- `agent.tool_use` 事件本身的 `id` 字段(`sevt_*`);
- 事件里嵌套的 `tool_use.id`(`toolu_*`,来自 Messages API 协议);
- 你要回填的 `tool_use_id` = **事件 id**(`sevt_*`),**不是** `toolu_*`。

**正确做法**:

```typescript
if (ev.type === "agent.tool_use" && ev.evaluated_permission === "ask") {
  await client.beta.sessions.events.send(sessionId, {
    events: [{
      type: "user.tool_confirmation",
      tool_use_id: ev.id,             // ← sevt_*,不是 toolu_*
      result: "allow",                 // or "deny"
      // deny_message: "Read .env.example instead",   // 只在 deny 时
    }],
  });
}
```

**反例**:

```typescript
// ❌ 填了内部的 toolu_*
tool_use_id: ev.tool_use.id;   // 服务端找不到,silent 丢弃,session 永远 idle
```

**涉及事件**:`agent.tool_use(evaluated_permission='ask')` → `user.tool_confirmation` → 后续 `agent.tool_result`。MCP 工具走相同流程,事件类型是 `agent.mcp_tool_use`。

---

### 6.7 Custom tool 回环——字段名和错误处理

**问题**:Custom tool 的协议有几处容易写错:

1. 字段名是 `custom_tool_use_id`,不是 `tool_use_id`;
2. `content` 必须是 `[{type: "text", text: "..."}]` 结构,不是裸字符串;
3. `is_error` 字段决定 agent 如何解释结果——不写 agent 可能把错误当成功;
4. **没注册 handler 时必须主动回 error**,否则 session 永远 idle。

**正确做法**:

```typescript
if (ev.type === "agent.custom_tool_use") {
  const handler = customToolHandlers.get(ev.name);
  if (!handler) {
    await client.beta.sessions.events.send(sessionId, {
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: ev.id,   // sevt_*
        content: [{ type: "text", text: `No handler for ${ev.name}` }],
        is_error: true,
      }],
    });
    return;
  }

  try {
    const result = await handler(ev.input, { sessionId, eventId: ev.id });
    await client.beta.sessions.events.send(sessionId, {
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: ev.id,
        content: [{ type: "text", text: result.text }],
        is_error: false,
      }],
    });
  } catch (err) {
    await client.beta.sessions.events.send(sessionId, {
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: ev.id,
        content: [{ type: "text", text: String(err) }],
        is_error: true,
      }],
    });
  }
}
```

**反例**:

```typescript
// ❌ 没 handler 就不回 → session 永远 idle → retries_exhausted 终止
if (!handler) return;

// ❌ content 结构错
content: result.text   // 错:必须是 [{type:"text", text:...}]
```

**涉及事件**:`agent.custom_tool_use` → `user.custom_tool_result`。

---

### 6.8 Interrupt 不是 SIGKILL

**问题**:发了 `user.interrupt` 不代表立刻停。Agent 要跑到安全边界(当前 tool call 或模型调用结束)才停。**不能发完 interrupt 就 archive**——间歇性 409。

**正确做法**:

```typescript
await client.beta.sessions.events.send(sessionId, {
  events: [{ type: "user.interrupt" }],
});
// 继续消费 stream,直到 idle 或 terminated 才算真的停了
for await (const ev of stream) {
  if (ev.type === "session.status_terminated") break;
  if (ev.type === "session.status_idle" && ev.stop_reason.type !== "requires_action") break;
}
```

**反例**:

```typescript
// ❌ 直接 archive
await client.beta.sessions.events.send(id, { events: [{ type: "user.interrupt" }] });
await client.beta.sessions.archive(id);   // 炸(cannot archive while running)
```

**涉及事件**:interrupt 触发后,最终会看到 `session.status_idle(stop_reason.type != 'requires_action')` 或 `session.status_terminated`。

---

### 6.9 Post-idle race:archive 前先 poll

**问题**:SSE 流发 `session.status_idle` 的时间 ≠ `GET /sessions/{id}` 查到 `status='idle'` 的时间——后者略滞后。客户端收到 idle 立刻 archive,测试环境下 100 次里有 3-5 次失败("cannot delete/archive while running")。

**正确做法**:

```typescript
async function cleanup(sessionId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const s = await client.beta.sessions.retrieve(sessionId);
    if (s.status !== "running") break;
    await sleep(200);
  }
  await client.beta.sessions.archive(sessionId);
}
```

**反例**:

```typescript
// ❌ stream 看到 idle 就 archive → 间歇 409
if (ev.type === "session.status_idle") {
  await client.beta.sessions.archive(sessionId);
}
```

**涉及事件**:`session.status_idle`(stream)→ `GET /sessions/{id}`(REST)最终一致,需要客户端 poll。

---

### 6.10 凭证永不进 prompt / message

**问题**:把 API key 塞进 system prompt 或 user.message 让 agent 用 `bash curl ...`——这是**最致命的反模式**。原因:

- 这些内容会进 **event history**,可被 `events.list()` 原样回读;
- 会被 context compaction 的摘要包含;
- 在 session 生命周期内,**任何能调这个 session 的 API key 持有者都能读到**。

**正确做法**(host-side custom tool 模式):

Agent 侧只声明工具 schema,**不带任何密钥**:

```python
tools=[{
    "type": "custom",
    "name": "stripe_charge_lookup",
    "description": "Look up a Stripe charge by ID.",
    "input_schema": {
        "type": "object",
        "properties": {"charge_id": {"type": "string"}},
        "required": ["charge_id"],
    },
}]
```

你的 orchestrator(host 进程,持有 Stripe key)处理调用:

```typescript
if (ev.type === "agent.custom_tool_use" && ev.name === "stripe_charge_lookup") {
  // 1. 输入校验
  if (!/^ch_[A-Za-z0-9]+$/.test(ev.input.charge_id)) {
    return sendError(...);
  }
  // 2. 权限校验
  const tenant = await getTenantBySessionId(sessionId);
  if (!await tenantCanAccessCharge(tenant, ev.input.charge_id)) {
    return sendError(...);
  }
  // 3. 用 host 的 key 调 Stripe(key 从未出现在 CMA 的任何地方)
  const charge = await stripe.charges.retrieve(ev.input.charge_id);
  // 4. 输出脱敏
  await client.beta.sessions.events.send(sessionId, {
    events: [{
      type: "user.custom_tool_result",
      custom_tool_use_id: ev.id,
      content: [{ type: "text", text: JSON.stringify(safeSummary(charge)) }],
    }],
  });
}
```

**致命反例**:

```python
# ❌ 塞进 system prompt
system = "Use API key sk_live_xxx to call Stripe..."

# ❌ 指望 vault credential 在容器里以 env 形式出现
# vault 只在两个地方被注入:MCP 调用的 proxy、github_repository 的 git proxy
# 容器里永远读不到 process.env.STRIPE_KEY
```

**安全提醒**:这个模式不是把 secret 暴露成 public endpoint——`agent.custom_tool_use` 通过你已经持有的 API key 经 SSE 到达,`user.custom_tool_result` 也通过同一个 key 回去。orchestrator 是 client,不是 server。

**涉及事件**:`agent.custom_tool_use` → host 处理 → `user.custom_tool_result` → session 恢复 `running`。

---

## 7. 关键决策点

### 7.1 Agent 要一个还是多个?

| 场景 | 建议 |
|---|---|
| 功能单一的产品 | **一个 agent**,跨所有 session 复用 |
| 多种任务类型但工具集大致重叠 | **一个 agent + 在 kickoff message 里分类** |
| 工具差异明显 | **多个 agent**,每种任务一个 |
| 多租户 SaaS,不同租户要不同 system prompt | **一个 agent per 租户类型**,不要 per 终端用户 |

**反例**:per-user 建 agent——几个月后积累几万个 orphan。Agent 没有 `delete`,只能 `archive`(终态,无 unarchive)。

### 7.2 Environment 共享还是独立?

**默认答案:尽量共享**。
- Environment 只是模板,容器是 per-session 起的——共享不影响隔离;
- Environment create 有 60 RPM + 5 并发限流,per-session 建会撞墙;
- **例外**:不同场景需要完全不同的 `allowed_hosts` 或包集合,建多个 environment。

### 7.3 Session 是单 owner 还是多客户端共享?

**单 owner 模型**(推荐默认):
- 一个 session 归一个用户;
- 同用户开多窗口时,只主窗口驱动,其他窗口只读;
- 实现:SessionStore 里记 `session_id → owner_client_id`,非 owner 不发事件。

**共享模型**(少见):
- 多人协作驱动同一 session;
- 客户端层必须保证 `tool_use_id` 幂等——同一个 tool_use_id 只能被一个 client 回应,否则 agent 收到重复结果。

**Beta 的 API 本身不管 owner**——权限只到 workspace 级。单 owner 要你自己在应用层实现。

### 7.4 Vault 策略:共享 vs per-user?

| 模式 | 适用 | 优点 | 缺点 |
|---|---|---|---|
| **全局共享 vault** | 内部工具 | 运维简单 | 归属不清、越权风险 |
| **Per-team / per-workspace vault** | B2B SaaS | 租户隔离清晰 | 客户管理凭证 |
| **Per-user vault** | 消费端产品 | 权限细到个人 | Vault CRUD 量大,UI 要做 OAuth dance |

**建议**:从 per-workspace/per-team 开始。切 per-user 要重做 OAuth dance,不是小工程。

### 7.5 Agent 版本:float 还是 pin?

| 环境 | 策略 | 原因 |
|---|---|---|
| **dev** | `agent=agent_id` 字符串简写(float 到 latest) | 快迭代 |
| **staging** | pin `{type: "agent", id, version}` | 测试某版本 |
| **prod** | **显式 pin** | **dev 动一下 agent 就影响 prod = 一键炸线** |

**实操模板**:

```python
AGENT_ID = os.environ["AGENT_ID"]
AGENT_VERSION = int(os.environ.get("AGENT_VERSION", "0"))

def make_agent_ref():
    if AGENT_VERSION == 0:
        return AGENT_ID                                            # float
    return {"type": "agent", "id": AGENT_ID, "version": AGENT_VERSION}  # pin
```

**版本号形式**:Agent version 是一个大整数(形如 `1772585501101368014`,看着像时间戳但别解析,当不透明 ID)。

**Rollback**:改 `AGENT_VERSION` 环境变量即可——不用发版。

### 7.6 MCP tool vs custom tool?

| 如果… | 选 | 理由 |
|---|---|---|
| 目标服务有现成 MCP server(GitHub、Linear、Asana、Notion…) | **MCP** | 凭证经 vault 自动 refresh |
| 只有 REST API 没 MCP | **Custom tool** | Host 持有凭证 |
| 需要访问 host 端资源(IDE、用户本地文件、私有网络) | **Custom tool** | |
| 调用你自己的内部 API | **Custom tool** | Key 只应该在你的后端里 |
| Stdio MCP(本地进程) | 改造成 **HTTP MCP** 或走 **custom tool** | CMA 不支持 stdio |

**反例**:把服务自身的 REST API key(如 Notion `ntn_*`、GitHub `ghp_*`)当成 MCP OAuth 塞进 vault——MCP 走的是 OAuth bearer,跟服务的 REST API key 是**两套认证系统**。

### 7.7 数据传入方式

| 数据类型 | 方式 |
|---|---|
| 大文件(>100KB 文本 / 二进制) | **File resource**:upload → mount |
| 结构化上下文(schema、规则) | **system prompt**(一次性)或 **user.message 内联**(本次有效) |
| 短期/本轮有效的输入 | **user.message 内联** |
| 文件要被 agent 用 bash 处理 | **File resource** |
| Agent 要生成产物给你 | 约定路径 **`/mnt/session/outputs/`** + `files.list({scope_id})` |

### 7.8 Stream vs pull?

| 场景 | 选 |
|---|---|
| 单进程、实时 UI 更新 | **Stream (SSE)** |
| 多节点消费,跨节点故障恢复 | **Pull (events.list)** 定时轮询 |
| 大规模 session 并发 | **Hybrid**:stream 为主,断线用 list 对齐 |

**永远禁止**:多消费者同时 stream 同一 session 并都回应 tool_use / custom_tool_use(会让 agent 收到重复 result)。同一 session 必须单消费者(用 `hash(session_id) % N` 分片)。

---

## 8. 按产品形态的落地建议

### 8.1 交互式产品(IDE copilot / 网页 chatbot)

**特征**:长 session(分钟到小时)、用户多轮交互、UI 驱动。

**关键设计**:
- **SessionStore 持久化 `user_id → session_id`**,刷新能恢复;
- **Tool confirmation 走 UI 模态框**:agent 发 `agent.tool_use(ask)` → ConfirmationPolicy 推给 UI → 用户点允许/拒绝;
- **`processed_at` 双相体现在 UI**:发送中 → 已送达 → 已处理;
- **Interrupt 按钮和"你真的停了吗"分开**:按按钮只是发 interrupt,UI 显示"正在停止…",收到 idle 才显示"已停止"。

**特殊坑**:
- **Session checkpoint 有 TTL**(约 30 天无活动后过期)——要么 UI 提示"会话已过期",要么定期发空消息保活;
- **用户切标签页/切网络** 导致 SSE 断——重连要有 backoff + jitter,不无限 retry;
- **同用户两设备登录**——按 §7.3 单 owner 模型决定主从。

**最小 runtime 代码**:

```python
import anthropic

client = anthropic.Anthropic()

def handle_user_message(user_id: str, text: str):
    session_id = session_store.get_or_create(
        user_id,
        lambda: create_session(user_id),
    )
    # 复用 SessionDriver(见附录)
    driver = get_or_create_driver(session_id)
    driver.send_message(text)

def create_session(user_id: str) -> str:
    session = client.beta.sessions.create(
        agent=make_agent_ref(),
        environment_id=ENV_ID,
        vault_ids=[get_user_vault_id(user_id)],
        title=f"coding-{user_id}",
    )
    return session.id
```

### 8.2 一次性任务(fire-and-forget batch)

**特征**:一次性任务(生成日报、处理上传文件)。跑完归档。

**关键设计**:
- **不需要 SessionStore**——session 不跨请求复用;
- **强化的 idle-break gate**——不然任务永远"看似在跑";
- **必须 poll 再 archive**;
- **输出抓取必须 retry**:索引延迟 1-3 秒;
- **显式超时**:整个 session 设 wall-clock 上限(比如 30 分钟),超了主动 interrupt——避免 agent 走火入魔烧 token。

**最小代码**:

```python
import time

def run_batch_task(input_file_path: str, prompt: str):
    # 1. 上传输入
    with open(input_file_path, "rb") as f:
        uploaded = client.beta.files.upload(file=f)

    # 2. 创建 session,挂载文件
    session = client.beta.sessions.create(
        agent=make_agent_ref(),
        environment_id=ENV_ID,
        resources=[{
            "type": "file",
            "file_id": uploaded.id,
            "mount_path": "/workspace/input",
        }],
        title=f"batch-{time.strftime('%Y-%m-%d-%H%M%S')}",
    )

    # 3. Stream-first,发 kickoff
    with client.beta.sessions.events.stream(session.id) as stream:
        client.beta.sessions.events.send(
            session.id,
            events=[{
                "type": "user.message",
                "content": [{"type": "text", "text": prompt}],
            }],
        )
        for ev in stream:
            if ev.type == "session.status_terminated":
                break
            if ev.type == "session.status_idle":
                if ev.stop_reason.type != "requires_action":
                    break

    # 4. Poll 真实 status
    for _ in range(10):
        if client.beta.sessions.retrieve(session.id).status != "running":
            break
        time.sleep(0.2)

    # 5. 拉输出(带 retry)
    outputs = fetch_outputs_with_retry(session.id)

    # 6. 清理
    client.beta.files.delete(uploaded.id)    # 删原 file,session-scoped copy 自动 GC
    client.beta.sessions.archive(session.id)

    return outputs

def fetch_outputs_with_retry(session_id: str, max_retries=5):
    for attempt in range(max_retries):
        result = client.beta.files.list(
            scope_id=session_id,
            betas=["managed-agents-2026-04-01"],   # ⚠ 必须双 beta header
        )
        outputs = list(result.data)
        if outputs:
            return outputs
        time.sleep(1 + attempt)
    return []
```

### 8.3 Webhook 触发

**特征**:外部事件触发(GitHub webhook、Slack slash command)。

**关键设计**:
- **幂等性**:用 delivery ID 做幂等 key,防止同一事件起多个 session;
- **快速 ACK**:webhook 通常要求几秒内 200——用消息队列:收 webhook → 入队 → 返回 200 → 后台 worker 起 session;
- **失败重投到队列**,不是直接重试(避免同步重试撞 rate limit)。

### 8.4 Cron/定时任务

**特征**:每天/每小时跑一次。

**关键设计**:
- 跟 §8.2 类似,但要做"上次是否跑完"的 bookkeeping;
- 多 region 部署确保只有一个 cron 实例在跑;
- `retries_exhausted` 触发告警,不静默忽略。

### 8.5 多并发 SaaS

**特征**:单 agent 配置 + 多独立 session 并发(PR 审查 SaaS、批量报告)。

**关键设计**:
- **限流是第一约束**:60 RPM session.create + 5 并发 environment。客户端侧节流到 50 RPM 左右留 buffer;
- **单 session 单消费者**:`hash(session_id) % worker_count`;
- **每个 session 跑完要 archive**——数万 active session 会让 list/retrieve 变慢。

**节流示例**(Python asyncio):

```python
import asyncio

async def run_batch(items: list):
    sem = asyncio.Semaphore(4)   # 最多 4 个并发
    async def guarded(item):
        async with sem:
            return await process_one(item)
    return await asyncio.gather(
        *(guarded(x) for x in items),
        return_exceptions=True,
    )
```

### 8.6 企业多租户 SaaS

**客户端层的租户隔离要点**(服务端边界由 Anthropic workspace 管,你要在客户端补足):

- **Agent per 租户类型,不 per 租户**:租户级差异放在 kickoff 或 metadata,不要为每个客户建独立 agent;
- **Vault per 租户**:不同客户的凭证必须在不同 vault(跨 vault 绑同一 MCP server URL 行为未定义);
- **SessionStore 按租户分区**:任何按 user_id 查 session_id 的地方带 tenant_id 过滤——否则跨租户泄露;
- **日志脱敏**:`agent.custom_tool_use.input` / `user.message.text` 可能含机密,按租户分 sink,不打印原始内容;
- **Per-tenant 限速**:保护 org-level rate limit 不被某大客户吃光。

---

## 9. 安全实践

### 9.1 凭证的三个"绝不"

1. **绝不**把 secret 放进 `system` / `user.message` / `custom_tool_result.content`——进 event log 就等于泄露;
2. **绝不**假设 vault credential 会以环境变量形式进容器——它不会。Vault 只在两个地方注入:
   - MCP 调用:Anthropic-side proxy 在请求离开 sandbox 后注入;
   - `github_repository` 的 `authorization_token`:同样走 git proxy 注入。
   容器里的 agent 代码 / bash 脚本读不到凭证。
3. **绝不**在生产脚本里自动 `agents.archive()` / `environments.archive()`——archive 是单向终态,配错一键丢掉线上资源。

### 9.2 Vault OAuth 生命周期

假设给 GitHub MCP 接 OAuth 做 per-user vault:

```
用户首次授权
  ↓
前端跳转 GitHub OAuth → 回调拿 code
  ↓
后端用 code 换 access_token + refresh_token
  ↓
vaults.create(name=f"user-{uid}") → vault_id
  ↓
vaults.credentials.create(vault_id, auth={
    "type": "mcp_oauth",
    "mcp_server_url": "https://api.githubcopilot.com/mcp/",
    "access_token": gh_access_token,
    "expires_at": expires_iso,
    "refresh": {
        "refresh_token": gh_refresh_token,
        "client_id": GH_OAUTH_CLIENT_ID,
        "token_endpoint": "https://github.com/login/oauth/access_token",
        "token_endpoint_auth": {
            "type": "client_secret_basic",
            "client_secret": GH_OAUTH_SECRET,
        },
    },
})
  ↓
存 vault_id 到 user 表
```

**关键点**:
- **`refresh` 必须填全**——Anthropic 才能自动续期;
- **`mcp_server_url` 必须跟 agent `mcp_servers[].url` 完全一致**——按 URL 匹配,一字不差;
- **credential 写了不能读回**——想验证"凭证还对吗"只能 rotate,不能 diff;
- **用户登出/revoke** 时 `vaults.credentials.delete(...)`,不然 Anthropic 一直用旧 refresh_token 续期;
- **MCP OAuth token ≠ 服务自身 REST API key**——Notion `ntn_*`、GitHub `ghp_*` 这些是服务自己的 token,不能做 MCP 的 OAuth credential。

### 9.3 Host-side custom tool 的安全封装

对应 §6.10,生产级 custom tool handler 的模板:

```typescript
async function handleStripeChargeLookup(input: unknown, ctx: ToolContext) {
  // 1. 输入校验——不要信 agent 的输入
  const parsed = z.object({ charge_id: z.string().regex(/^ch_[A-Za-z0-9]+$/) }).parse(input);

  // 2. 权限校验——这个 session 的 tenant 能访问这个 charge 吗?
  const tenant = await getTenantBySessionId(ctx.sessionId);
  if (!(await tenantCanAccessCharge(tenant, parsed.charge_id))) {
    return { text: "Forbidden: charge not in your tenant scope", isError: true };
  }

  // 3. 用 host 的 key 调 Stripe
  const charge = await stripe.charges.retrieve(parsed.charge_id);

  // 4. 输出脱敏——返回值会进 event log
  return { text: JSON.stringify(safeSummary(charge)) };
}
```

**三件必做**:
1. **输入校验**——`tool_use.input` 是 LLM 输出,做类型 + 格式 + 白名单校验;
2. **权限校验**——用 session 的 `tenant_id` 判断能不能访问这个资源;
3. **输出脱敏**——返回值进 event log,PII/机密不要原样塞。

### 9.4 GitHub repo 的 authorization_token 策略

- **权限最小化**:用 fine-grained PAT。只读需求给 Contents: Read;要 push 给 Contents: Read+Write。不给 `repo` 这种 classic PAT 的全权限;
- **Token rotation**:`sessions.resources.update()` 能对运行中 session 改 `authorization_token`,这是少数可更新项;
- **开 PR 需要 GitHub MCP server**:只挂 `github_repository` 只能 clone/commit/push。开 PR 要 vault + MCP server。

---

## 10. 资源和文件管理

### 10.1 文件上传的完整生命周期

```
upload(file) → uploaded.id              # 原 file
    ↓
sessions.create(resources=[{
    type: "file",
    file_id: uploaded.id,
    mount_path: "/workspace/x.csv"
}])
    ↓
# 服务端建 session-scoped copy
# session.resources[0].file_id ≠ uploaded.id (两个不同 ID!)
    ↓
agent 读取 /workspace/x.csv(只读挂载)
    ↓
session.archive()
    ↓
files.delete(uploaded.id)    # 清理原 file
                             # session-scoped copy 跟 session 一起 GC
```

**清理顺序**:先 archive session,再 delete 原 file。反过来做原 file 是 session 的 upstream,服务端可能发警告。

**限制**:
- **`mount_path` 必须是绝对路径**(以 `/` 开头),否则服务端拒;
- **单 session 最多约 999 个 file resources**;
- **挂载的 file 是只读的**——agent 要改只能写到别的路径。

**易混点**:你调 `client.beta.files.upload()` 得到的 `uploaded.id` 是**原文件**的 ID。传给 session 后,`session.resources[0].file_id` 是**session-scoped copy** 的 ID——不是同一个。清理原文件时用 `uploaded.id`,不是 `session.resources[0].file_id`。

### 10.2 Session 产物的抓取(scope_id + 双 beta header)

Agent 可以写文件到约定路径 `/mnt/session/outputs/`。这些文件会被 Files API 自动归档,打上 session 的 `scope_id` 标签。抓取方式:

```python
import time

def fetch_outputs(session_id: str, max_retries: int = 5):
    for attempt in range(max_retries):
        result = client.beta.files.list(
            scope_id=session_id,
            betas=["managed-agents-2026-04-01"],   # ← 必须手动加!
        )
        outputs = list(result.data)
        if outputs:
            return outputs
        time.sleep(1 + attempt)   # linear backoff,索引延迟 1-3s
    return []
```

**三个关键细节**:

1. **`betas=["managed-agents-2026-04-01"]` 必须手动加**——SDK 调 `client.beta.files.*` 时自动加的是 `files-api-2025-04-14`,但 `scope_id` 参数是 CMA 扩展,跨 namespace 需要手动补 CMA 的 header。漏掉会被 API 拒或 silent 忽略;
2. **SDK 版本要求**:TS `@anthropic-ai/sdk >= 0.88.0` / Python `anthropic >= 0.92.0`。老版本连 `scope_id` 字段都不 type;
3. **索引延迟 1-3 秒**:`session.status_idle` 触发后立刻 list 可能返回空,要 retry 1-2 次。

**前置条件**:agent 必须有 `write` 或 `bash` 工具,否则没法写出文件。

### 10.3 GitHub repo resource

```python
session = client.beta.sessions.create(
    agent=AGENT_REF,
    environment_id=ENV_ID,
    resources=[{
        "type": "github_repository",
        "url": "https://github.com/owner/repo",
        "authorization_token": pat,         # 从不进 container
        "mount_path": "/workspace/repo",
        "checkout": {"type": "branch", "name": "main"},
        # 或 pin commit: {"type": "commit", "sha": "abc123..."}
    }],
)
```

**认证机制**:`authorization_token` 永不进容器。`git pull` / `git push` / GitHub REST API 被路由到 Anthropic 的 git proxy,proxy 在请求离开沙箱后注入 token。

**Token rotation**(能对运行中 session 生效):

```python
repo_resource = session.resources[0]
client.beta.sessions.resources.update(
    resource_id=repo_resource.id,
    session_id=session.id,
    authorization_token=new_pat,
)
```

### 10.4 文件类型和大小

Agent 可以处理的文件:源代码、CSV/JSON/YAML/XML、文本、Markdown、压缩包(`.zip`/`.tar.gz`——agent 用 bash 解压)、PDF(配合 `pdf` skill)、二进制(如果 agent 有合适工具)。

**限制**:
- 单文件大小限制看 Files API 上限;
- `/workspace/` 空间有限(具体数值看文档);
- 挂载是文件级别,不支持目录挂载(挂目录用 github_repository)。

---

## 11. 错误处理与重试

### 11.1 完整错误码表

| Status | `error.type` | 典型触发 | 处理 | 幂等 |
|---|---|---|---|---|
| 400 | `invalid_request_error` | 请求体格式错、缺必填、schema 不符、`mount_path` 非绝对 | **不 retry**,fix payload | N/A |
| 401 | `authentication_error` | `x-api-key` 无效或缺失 | abort,检查 key 是否 rotate | N/A |
| 403 | `permission_error` | API key 没权限访问该 resource | abort,检查 scope/workspace | N/A |
| 404 | `not_found_error` | 资源不存在、archived agent 被引用、beta header 缺失 | abort,检查 ID 和 header | N/A |
| 409 | `invalid_request_error`(不是 `conflict_error`) | 状态冲突:send 到 archived session、delete running session、environment name 重名 | 按情况 retry(见下) | 部分 |
| 413 | `request_too_large` | 请求体超限(system prompt >100K 字等) | abort,缩 payload | N/A |
| 422 | 一般 `invalid_request_error` | Schema 校验失败(enum 不匹配、字段类型错) | abort,fix | N/A |
| 429 | `rate_limit_error` | RPM / 并发超限 | 读 `retry-after` header 退避;SDK 自动处理 | 安全 |
| 500 | `api_error` | Anthropic 内部错误 | 指数退避 + retry | 看情况 |
| 529 | `overloaded_error` | 服务暂时过载 | 指数退避 + retry | 安全 |

**注意**:409 走 `invalid_request_error`(**没有**独立的 `conflict_error`)。要同时看 HTTP status + `error.message` 才能区分"payload 错"还是"状态冲突"。

### 11.2 幂等性速查

**天然幂等**(可安全 retry):
- 所有 GET(list、retrieve、events.list、files.download);
- `archive`(二次 archive 返 409,但不改状态);
- `delete` on already-deleted → 404,不幂等但无害。

**不幂等**(盲目 retry 有副作用):
- `POST /v1/agents` — 每次建新 agent,重试积累 orphan;
- `POST /v1/sessions` — 每次建新 session,重试多烧钱;
- `POST /v1/sessions/{id}/events` — 每次追加新事件,**重复发 `user.message` 让 agent 看到两份**;
- `POST /v1/vaults`、`POST /v1/vaults/.../credentials`。

**关键**:**CMA 目前没有 `idempotency-key` header**。客户端**必须自己保证**同一逻辑请求不发两次 POST。

### 11.3 `events.send` 的安全重试

POST events 的请求发出后网络抖动——不知道服务端是否收到。盲目重试会发两次。正确做法:

```python
def send_event_with_retry(session_id, event, max_retries=3):
    # 在 event content 里塞一个客户端侧的 dedup marker
    event_with_marker = {
        **event,
        "content": [
            *event["content"],
            # 可选:用 metadata 代替,看 event 是否支持
        ],
    }
    for attempt in range(max_retries):
        try:
            return client.beta.sessions.events.send(
                session_id=session_id,
                events=[event_with_marker],
            )
        except (requests.Timeout, anthropic.APIConnectionError):
            # 不知道服务端是否收到——先 list 查最新事件确认
            recent = client.beta.sessions.events.list(session_id, limit=20)
            if already_sent(recent, event_with_marker):
                return   # 已经到了
            time.sleep(2 ** attempt)
    raise RuntimeError("send failed")
```

简单做法:把 user message 里塞一个客户端生成的 UUID 作为幂等标记,retry 前查 events.list 里有没有这个 UUID。

### 11.4 `retries_exhausted` 的处理

这是 terminal 状态,继续发消息没用——session 已经走不下去。做法:
1. 不要继续发 `user.message`;
2. `sessions.retrieve()` 看 error 状态;
3. 记录 `request_id`(所有 response 都带),上报 Anthropic;
4. 新建 session 继续(从某个 event 重建 context 作为 kickoff message)。

### 11.5 SDK 自动重试的边界

Anthropic SDK 会自动 retry:
- 429(按 `retry-after`);
- 500 / 503 / 529(指数退避)。

SDK **不会**自动 retry:
- 网络层 error(timeout、connection reset)——这是**你**的责任;
- 4xx(400/401/403/404/409/413/422)——这些不该 retry。

**常见陷阱**:`requests` 的 `timeout=(5, 60)` 和 `httpx.Timeout(120)` 是**per-chunk**读超时,不是 wall-clock——一个慢慢 trickle 的响应能让你的调用 block 到天荒地老。生产里要么用 SDK(它处理了),要么自己用 `time.monotonic()` 做 wall-clock 上限。

---

## 12. 可观测性

### 12.1 客户端必须记录的字段

每次 API 调用日志至少有:

| 字段 | 用途 |
|---|---|
| `request_id`(response 里) | 向 Anthropic 提 bug 必须,事后 trace 根据 |
| `session_id` | 串起一个会话的所有操作 |
| `tenant_id` | 多租户场景溯源 |
| `user_id` | 用户关联 |
| `agent_id` + `agent_version` | 出问题时定位到哪版 agent 的 bug |
| `operation` | create / send / stream / retrieve 分类统计 |
| `duration_ms` | 性能分析 |
| `error_type` + `http_status` | 错误分类 |

**不要记**(至少不要默认记):
- Event payload 原文(可能含用户数据/凭证);
- `agent.custom_tool_use.input` 原文;
- System prompt 原文(业务机密)。

需要排查时用 sampling + manual flag 按需记录。

### 12.2 事件流 dump(事后分析利器)

```python
def dump_session(session_id: str, out_path: str):
    events = list(client.beta.sessions.events.list(session_id))
    with open(out_path, "w") as f:
        json.dump(
            [e.model_dump() for e in events],
            f, indent=2, default=str,
        )
```

**离线 grep**:
- `span.model_request_end.model_usage` → 算每次模型调用的 token;
- `agent.thread_context_compacted` → 看哪一轮压缩、压缩前多大;
- `session.status_idle.stop_reason` → 每次停顿的原因;
- `session.error` → 所有运行时错误;
- `agent.tool_use(evaluated_permission='ask')` + `user.tool_confirmation.result='deny'` → 被拒的工具调用。

### 12.3 Token 成本跟踪

SessionDriver 里维护累加器,订阅 `span.model_request_end`:

```typescript
interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

on("span.model_request_end", (ev) => {
  if (ev.is_error) return;
  usage.inputTokens         += ev.model_usage.input_tokens;
  usage.outputTokens        += ev.model_usage.output_tokens;
  usage.cacheCreationTokens += ev.model_usage.cache_creation_input_tokens;
  usage.cacheReadTokens     += ev.model_usage.cache_read_input_tokens;
});
```

Session 结束时上报——用于计费,也用于识别"cache 命中率低 / input token 爆炸"的异常 session。

### 12.4 关键告警阈值

- **retries_exhausted 率 > 1%**:模型或 tool 持续失败;
- **custom_tool_result 响应时间 p99 > 30s**:host-side tool 越来越慢,快超时;
- **sessions.create 失败率 > 5%**:资源挂载 / rate limit 问题;
- **session archive 失败率 > 0.5%**:Post-idle race 没处理好;
- **Cache read 比例 < 20%** 的 session 集中出现:可能是 system prompt 在变,cache 频繁 invalidate。

---

## 13. 测试策略

### 13.1 测试分层

| 层次 | 测什么 | 依赖 |
|---|---|---|
| **单元测试** | SessionDriver 的状态机 / dedupe / idle-break / tool dispatch | Mock SDK |
| **契约测试** | Event 格式解析、响应结构 | 固定 JSON fixture |
| **集成测试**(低频) | 从 setup 到一次完整 session 跑通 | 真 API + test agent + cheap model |
| **Smoke 测试**(持续) | prod 每小时跑一次"hello" session | 真 prod API |

### 13.2 Mock 什么 / 不 mock 什么

**应该 mock**:
- SDK 客户端:把 `client.beta.sessions.events.stream` mock 成返回固定事件序列的 async iterator;
- 时间:让测试确定性;
- Tool handler:注入假的实现测试调度逻辑。

**不该 mock**:
- Event 数据结构:用真实 fixture,不要手写 mock 对象(字段容易漏);
- 协议顺序:测试事件**正确序列**(`agent.tool_use → user.tool_confirmation → agent.tool_result`),不只是单点。

### 13.3 集成测试的成本控制

- **用最便宜的模型**(Haiku 4.5)跑集成测试,不用 Opus;
- **Test agent 的 system prompt 写高确定性**:"Always respond with 'ok' and call tool X once",减少 token;
- **测完立刻 archive**,别留 running;
- **每周预算上限 guard**:测试脚本记累计 token,超了 skip。

---

## 14. API 陷阱与命名坑

这一节是"知道了就不会炸"的清单。

### 14.1 命名不一致

| 陷阱 | 正确写法 |
|---|---|
| Agent **没有 `delete`**,只有 `archive`,且 archive **永久**(无 unarchive) | 谨慎 archive;清理 orphan 前先 `list()` 人工确认 |
| Session resources 用 **`add`** 不是 `create`(和其他资源 CRUD 不一致) | `client.beta.sessions.resources.add(...)` |
| Go SDK 的 stream 方法叫 **`StreamEvents`**,Python/TS 叫 `stream` | 跨语言注意 |
| `user.tool_confirmation` 用 **`tool_use_id`** 字段 | 填 `sevt_*`(事件 id),不是 `toolu_*` |
| `user.custom_tool_result` 用 **`custom_tool_use_id`** 字段(注意 custom_ 前缀) | 同上,也是 `sevt_*` |
| Agent metadata 限制:**16 keys**,key ≤64 字符,value ≤512 字符 | |
| Session metadata 限制:**8 keys**(和 agent 不一样) | 两个别弄混 |
| Session **update 只能改 `title`**——不能改 resources / metadata / vault_ids | 想改其他属性只能建新 session |
| Tools 数量上限:不同文档写 **50** 和 **128** 两种——取保守值 **50** | 超过联系 Anthropic 确认 |
| GitHub repo 的 checkout 用 **`checkout: {type, name/sha}`** 对象,不是裸 `branch` 字段 | `checkout: {type: "branch", name: "main"}` |

### 14.2 Beta header 矩阵

| 调用 | SDK 自动加 | 你要手动加 |
|---|---|---|
| `client.beta.agents.*` | `managed-agents-2026-04-01` | — |
| `client.beta.sessions.*` | `managed-agents-2026-04-01` | — |
| `client.beta.environments.*` | `managed-agents-2026-04-01` | — |
| `client.beta.vaults.*` | `managed-agents-2026-04-01` | — |
| `client.beta.files.upload` | `files-api-2025-04-14` | — |
| `client.beta.files.list(scope_id=...)` | `files-api-2025-04-14` | **⚠ `managed-agents-2026-04-01`** |
| `client.beta.files.download(id)` | `files-api-2025-04-14` | — |
| `client.beta.skills.*` | `skills-2025-10-02` | — |

**只有 `files.list(scope_id=...)` 需要手动加第二个 header**——这是最容易踩的坑。

### 14.3 字段/参数不一致的注意点

- **`purpose` 字段**(files.upload 用):文档中 `"agent"` 和 `"agent_resource"` 两种写法都出现过。以 SDK 最新类型定义为准,两个在当前版本都能接受。
- **`checkout` vs `branch`**:API reference 用 `checkout: {type, name/sha}` 对象,部分示例代码用裸 `branch` 字段。**统一用 `checkout` 对象**——可以表达 commit sha pin。

### 14.4 Archive 的单向性

- **Agent / Environment / Vault / Credential 的 archive 都是单向门**:归档后不可 unarchive;
- **Agent / Environment archive 后**:现有 session 继续跑,新 session 无法引用;
- **绝对不要**在自动化清理脚本里循环调 `archive`——一次手滑丢掉线上 agent。

### 14.5 Session 阻塞创建

`sessions.create()` **阻塞直到所有 resources 挂载完成**。挂一个 1GB repo + 10 个大 CSV 会让 create 慢几十秒,客户端 HTTP timeout(默认 60s)会中断。**挂大资源前先 upload 好**,或加大客户端 timeout。

### 14.6 MCP token ≠ 服务自身 API key

反复踩的坑:
- Notion `ntn_*` integration token 用于 Notion REST API → **不能**做 Notion MCP 的 credential;
- GitHub `ghp_*` PAT 用于 GitHub REST → **不能**做 GitHub MCP 的 OAuth credential;
- 每个 MCP server 有自己的 OAuth dance,拿 bearer token 塞 vault。

### 14.7 多 vault 绑同一 MCP server 的行为未定义

`vault_ids` 是数组,允许多 vault。但如果两个 vault 都有对同一 MCP server URL 的 credential,**Anthropic 怎么选不明确**。**一个 session 一个 MCP server 绑一个 vault**——安全又可预测。

---

## 15. 调试清单

### 15.1 SSE 看不到事件

按优先级排查:

1. **Beta header 对不对**——`anthropic-beta: managed-agents-2026-04-01`?curl 用 `-v` 看;
2. **Session 状态**——`GET /sessions/{id}` 是 `terminated` 还是 `archived_at` 有值?
3. **Resource 挂载完了吗**——新建 session 会 block 在 `rescheduling` 直到挂载完成;
4. **证书/代理**——企业网络常 intercept SSE;用 curl `-N` 直接测 `/events/stream`;
5. **SDK 版本**——老 SDK 不识别新字段;
6. **Raw HTTP timeout**——`requests`/`httpx` 的 timeout 是 per-chunk,trickle 连接会 block;
7. **API key scope**——403 时检查 key 对应 workspace 是否启用 CMA。

### 15.2 Session 永远 idle

最常见的根因:

1. **Custom tool 没 handler 也没回 error**——agent 在等,永远等不到;
2. **`tool_use_id` 填错**(`toolu_*` 而非 `sevt_*`)——服务端 silent 丢弃;
3. **`custom_tool_use_id` 字段名写成 `tool_use_id`**——同上;
4. **客户端 dedupe 把终止事件也 skip 掉**——事件到了但循环不退;
5. **客户端崩了没重连**——session 还在服务端等,需要 reconnect + consolidation。

### 15.3 Archive 间歇 409

**Post-idle race**:SSE idle 早于 REST status。加 poll:

```python
for _ in range(10):
    if client.beta.sessions.retrieve(id).status != "running":
        break
    time.sleep(0.2)
client.beta.sessions.archive(id)
```

### 15.4 MCP 工具 silent 失败

- 检查 environment networking 是否 allowed MCP server 域名;
- 检查 vault credential 的 `mcp_server_url` 是否和 agent 的 `mcp_servers[].url` 完全一致;
- 检查 OAuth token 是否过期(refresh 失败会发 `session.error`)。

### 15.5 启用 SDK debug log

- **Python**:`import logging; logging.basicConfig(level=logging.DEBUG)`;
- **TypeScript**:`ANTHROPIC_LOG=debug` 环境变量。

能看到:实际发出的 header、retry 情况、SSE 原始数据。

### 15.6 `request_id` 串联

所有 response 都有 `request_id`(body error 里、成功响应的 header 里)。**客户端日志里记每次调用的 request_id**,事后给 Anthropic 提 ticket 时必须带。

---

## 16. 上线前 checklist

分架构层 / 决策层 / 协议层 / 安全层 / 运维层五组,逐条过。

### 架构

- [ ] Setup Plane 和 Runtime Plane 的代码物理分离(`setup.py` / `run.py` 或等价)
- [ ] Runtime 代码里搜不到 `agents.create`、`environments.create`、`skills.create`(硬规则)
- [ ] 存在独立的 SessionDriver 组件,UI / webhook handler 不直接写事件循环
- [ ] 存在 ToolHandler 注册表 + ConfirmationPolicy 抽象
- [ ] ReconnectOrchestrator 存在,能从持久化 `session_id` 恢复
- [ ] SessionStore 的主键包含 `tenant_id`(多租户场景)

### 决策

- [ ] Agent 数量策略明确(§7.1)
- [ ] Environment 复用策略明确(§7.2)
- [ ] Session owner 模型明确(§7.3);共享时有幂等机制
- [ ] Vault 粒度明确(§7.4)
- [ ] 版本 pin 策略明确:**prod 必须 pin**,dev 可 float
- [ ] Network 策略明确:`limited` 时 `allowed_hosts` 包含所有 MCP server 域名

### 协议(§6 的 10 条)

- [ ] Stream-first:`events.stream()` 在 `events.send(user.message)` 之前调用
- [ ] Idle-break gate:`status_terminated` OR `status_idle && stop_reason.type != 'requires_action'`
- [ ] 每个 `agent.custom_tool_use` 都有回应路径(有 handler 或回 error)
- [ ] 每个 `agent.tool_use(evaluated_permission='ask')` 都有回应路径
- [ ] 断线重连走 consolidation(stream + list + dedupe)
- [ ] Dedupe 只 gate dispatch,不 gate 终止判断
- [ ] `tool_use_id` / `custom_tool_use_id` 都填 `event.id`(sevt_*),不是 `toolu_*`
- [ ] `processed_at` 双相在 UI 上区分
- [ ] Interrupt 后等 idle/terminated 再 cleanup
- [ ] Archive 前 poll status

### 安全

- [ ] 日志里搜不到 `agent.custom_tool_use.input` / `user.message.text` 原文
- [ ] System prompt / user message / custom_tool_result 里搜不到 API key / secret
- [ ] Vault credential 是 OAuth bearer token,不是服务自身 REST API key
- [ ] Custom tool handler 有输入校验 + 权限校验 + 输出脱敏
- [ ] `authorization_token` 用 fine-grained PAT,权限最小化
- [ ] 生产 CI/清理脚本里搜不到 `agents.archive` / `environments.archive`

### 运维

- [ ] 每次 API 调用记录 `request_id + session_id + tenant_id + user_id`
- [ ] `span.model_request_end.model_usage` 被累加并上报
- [ ] `retries_exhausted` / `session.error` 接入告警
- [ ] Rate limit 做客户端侧节流(60 RPM session.create 给 buffer)
- [ ] Environment 5 并发上限已联系 Anthropic 确认
- [ ] File upload 和 session-scoped copy 的 ID 差异处理正确
- [ ] `files.list({scope_id})` 调用点都带了 `managed-agents-2026-04-01` beta
- [ ] Cleanup job 扫僵尸 session(`status=running` 超过 X 分钟 + 最近无事件)
- [ ] Agent 的版本推进流程文档化:dev → staging pin → prod pin → 灰度切流
- [ ] Rollback 预案:改 `AGENT_VERSION` 配置即可

---

## 附录 A. SessionDriver TypeScript 模板

精简版,拷走改。生产级还要加 logger、metrics、retry、timeout 等。

```typescript
import Anthropic from "@anthropic-ai/sdk";

type TerminalReason = "end_turn" | "retries_exhausted" | "terminated" | "stream_ended";

type Decision =
  | { allow: true }
  | { allow: false; reason: string };

interface ConfirmationPolicy {
  evaluate(event: any): Promise<Decision>;
}

type ToolContext = { sessionId: string; eventId: string };
type ToolResult = { text: string; isError?: boolean };
type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

export class SessionDriver {
  private client: Anthropic;
  private eventById = new Map<string, any>();
  private customToolHandlers = new Map<string, ToolHandler>();
  private confirmationPolicy: ConfirmationPolicy;
  private onEvent: (ev: any) => void | Promise<void>;

  constructor(opts: {
    client: Anthropic;
    confirmationPolicy: ConfirmationPolicy;
    onEvent: (ev: any) => void | Promise<void>;
  }) {
    this.client = opts.client;
    this.confirmationPolicy = opts.confirmationPolicy;
    this.onEvent = opts.onEvent;
  }

  registerCustomTool(name: string, handler: ToolHandler): void {
    this.customToolHandlers.set(name, handler);
  }

  async createAndRun(params: {
    agentRef: string | { type: "agent"; id: string; version: number };
    environmentId: string;
    vaultIds?: string[];
    resources?: any[];
    kickoff: string;
    title?: string;
  }): Promise<{ sessionId: string; reason: TerminalReason }> {
    const session = await this.client.beta.sessions.create({
      agent: params.agentRef,
      environment_id: params.environmentId,
      vault_ids: params.vaultIds,
      resources: params.resources,
      title: params.title,
    });

    // Stream-first
    const stream = await this.client.beta.sessions.events.stream(session.id);

    // 发 kickoff
    await this.client.beta.sessions.events.send(session.id, {
      events: [{
        type: "user.message",
        content: [{ type: "text", text: params.kickoff }],
      }],
    });

    const reason = await this.runLoop(session.id, stream);
    return { sessionId: session.id, reason };
  }

  async resume(sessionId: string): Promise<TerminalReason> {
    const s = await this.client.beta.sessions.retrieve(sessionId);
    if (s.status === "terminated") return "terminated";
    if (s.archived_at != null) throw new Error("session archived");

    const stream = await this.client.beta.sessions.events.stream(sessionId);
    return this.runLoop(sessionId, stream);
  }

  private async runLoop(
    sessionId: string,
    stream: AsyncIterable<any>
  ): Promise<TerminalReason> {
    // Consolidation - 先消费历史
    for await (const ev of this.client.beta.sessions.events.list(sessionId)) {
      this.eventById.set(ev.id, ev);
      await this.onEvent(ev);
    }

    // Live stream
    for await (const ev of stream) {
      const alreadySeen = this.eventById.has(ev.id);
      if (!alreadySeen) {
        this.eventById.set(ev.id, ev);
        await this.onEvent(ev);
      }

      // 终止判断不 gate by dedupe
      if (ev.type === "session.status_terminated") return "terminated";
      if (ev.type === "session.status_idle") {
        const reason = ev.stop_reason?.type;
        if (reason === "requires_action") {
          if (!alreadySeen) {
            await this.handleRequiresAction(sessionId, ev.stop_reason.event_ids);
          }
          continue;
        }
        if (reason === "end_turn") return "end_turn";
        if (reason === "retries_exhausted") return "retries_exhausted";
      }
    }

    return "stream_ended";
  }

  private async handleRequiresAction(
    sessionId: string,
    blockingEventIds: string[]
  ): Promise<void> {
    for (const eventId of blockingEventIds) {
      const ev = this.eventById.get(eventId);
      if (!ev) continue;

      if (ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use") {
        if (ev.evaluated_permission !== "ask") continue;
        const decision = await this.confirmationPolicy.evaluate(ev);
        await this.client.beta.sessions.events.send(sessionId, {
          events: [{
            type: "user.tool_confirmation",
            tool_use_id: ev.id,
            result: decision.allow ? "allow" : "deny",
            ...(decision.allow ? {} : { deny_message: decision.reason }),
          }],
        });
      } else if (ev.type === "agent.custom_tool_use") {
        const handler = this.customToolHandlers.get(ev.name);
        if (!handler) {
          await this.sendCustomToolError(sessionId, ev.id, `No handler for ${ev.name}`);
          continue;
        }
        try {
          const result = await handler(ev.input, { sessionId, eventId: ev.id });
          await this.client.beta.sessions.events.send(sessionId, {
            events: [{
              type: "user.custom_tool_result",
              custom_tool_use_id: ev.id,
              content: [{ type: "text", text: result.text }],
              is_error: result.isError ?? false,
            }],
          });
        } catch (err) {
          await this.sendCustomToolError(sessionId, ev.id, String(err));
        }
      }
    }
  }

  private async sendCustomToolError(
    sessionId: string,
    useEventId: string,
    message: string
  ): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: useEventId,
        content: [{ type: "text", text: message }],
        is_error: true,
      }],
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.interrupt" }],
    });
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{
        type: "user.message",
        content: [{ type: "text", text }],
      }],
    });
  }

  async cleanup(sessionId: string): Promise<void> {
    // Poll before archive
    for (let i = 0; i < 10; i++) {
      const s = await this.client.beta.sessions.retrieve(sessionId);
      if (s.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await this.client.beta.sessions.archive(sessionId);
  }
}
```

---

## 附录 B. SessionDriver Python 模板

```python
import asyncio
import anthropic
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional

TerminalReason = Literal["end_turn", "retries_exhausted", "terminated", "stream_ended"]


@dataclass
class Decision:
    allow: bool
    reason: Optional[str] = None


class ConfirmationPolicy:
    async def evaluate(self, event: Any) -> Decision:
        raise NotImplementedError


# handler 返回 {"text": str, "is_error"?: bool}
ToolHandler = Callable[[Any, dict], Awaitable[dict]]


class SessionDriver:
    def __init__(
        self,
        client: anthropic.AsyncAnthropic,
        confirmation_policy: ConfirmationPolicy,
        on_event: Callable[[Any], Awaitable[None]],
    ):
        self.client = client
        self.confirmation_policy = confirmation_policy
        self.on_event = on_event
        self.event_by_id: dict[str, Any] = {}
        self.custom_tool_handlers: dict[str, ToolHandler] = {}

    def register_custom_tool(self, name: str, handler: ToolHandler) -> None:
        self.custom_tool_handlers[name] = handler

    async def create_and_run(
        self, *,
        agent_ref,
        environment_id: str,
        kickoff: str,
        vault_ids=None,
        resources=None,
        title: Optional[str] = None,
    ) -> tuple[str, TerminalReason]:
        session = await self.client.beta.sessions.create(
            agent=agent_ref,
            environment_id=environment_id,
            vault_ids=vault_ids,
            resources=resources,
            title=title,
        )

        # Stream-first
        async with self.client.beta.sessions.events.stream(session.id) as stream:
            await self.client.beta.sessions.events.send(
                session_id=session.id,
                events=[{
                    "type": "user.message",
                    "content": [{"type": "text", "text": kickoff}],
                }],
            )
            reason = await self._run_loop(session.id, stream)
        return session.id, reason

    async def resume(self, session_id: str) -> TerminalReason:
        s = await self.client.beta.sessions.retrieve(session_id)
        if s.status == "terminated":
            return "terminated"
        if s.archived_at is not None:
            raise RuntimeError("session archived")
        async with self.client.beta.sessions.events.stream(session_id) as stream:
            return await self._run_loop(session_id, stream)

    async def _run_loop(self, session_id: str, stream) -> TerminalReason:
        # Consolidation
        async for ev in self.client.beta.sessions.events.list(session_id):
            self.event_by_id[ev.id] = ev
            await self.on_event(ev)

        async for ev in stream:
            already_seen = ev.id in self.event_by_id
            if not already_seen:
                self.event_by_id[ev.id] = ev
                await self.on_event(ev)

            if ev.type == "session.status_terminated":
                return "terminated"
            if ev.type == "session.status_idle":
                reason = ev.stop_reason.type if ev.stop_reason else None
                if reason == "requires_action":
                    if not already_seen:
                        await self._handle_requires_action(
                            session_id, ev.stop_reason.event_ids
                        )
                    continue
                if reason == "end_turn":
                    return "end_turn"
                if reason == "retries_exhausted":
                    return "retries_exhausted"

        return "stream_ended"

    async def _handle_requires_action(
        self, session_id: str, event_ids: list[str]
    ) -> None:
        for eid in event_ids:
            ev = self.event_by_id.get(eid)
            if ev is None:
                continue

            if ev.type in ("agent.tool_use", "agent.mcp_tool_use"):
                if getattr(ev, "evaluated_permission", None) != "ask":
                    continue
                decision = await self.confirmation_policy.evaluate(ev)
                payload = {
                    "type": "user.tool_confirmation",
                    "tool_use_id": ev.id,
                    "result": "allow" if decision.allow else "deny",
                }
                if not decision.allow and decision.reason:
                    payload["deny_message"] = decision.reason
                await self.client.beta.sessions.events.send(
                    session_id=session_id, events=[payload]
                )
            elif ev.type == "agent.custom_tool_use":
                handler = self.custom_tool_handlers.get(ev.name)
                if handler is None:
                    await self._send_custom_tool_error(
                        session_id, ev.id, f"No handler for {ev.name}"
                    )
                    continue
                try:
                    result = await handler(ev.input, {
                        "session_id": session_id,
                        "event_id": ev.id,
                    })
                    await self.client.beta.sessions.events.send(
                        session_id=session_id,
                        events=[{
                            "type": "user.custom_tool_result",
                            "custom_tool_use_id": ev.id,
                            "content": [{"type": "text", "text": result["text"]}],
                            "is_error": result.get("is_error", False),
                        }],
                    )
                except Exception as exc:
                    await self._send_custom_tool_error(session_id, ev.id, str(exc))

    async def _send_custom_tool_error(
        self, session_id: str, use_event_id: str, message: str
    ) -> None:
        await self.client.beta.sessions.events.send(
            session_id=session_id,
            events=[{
                "type": "user.custom_tool_result",
                "custom_tool_use_id": use_event_id,
                "content": [{"type": "text", "text": message}],
                "is_error": True,
            }],
        )

    async def interrupt(self, session_id: str) -> None:
        await self.client.beta.sessions.events.send(
            session_id=session_id,
            events=[{"type": "user.interrupt"}],
        )

    async def send_message(self, session_id: str, text: str) -> None:
        await self.client.beta.sessions.events.send(
            session_id=session_id,
            events=[{
                "type": "user.message",
                "content": [{"type": "text", "text": text}],
            }],
        )

    async def cleanup(self, session_id: str) -> None:
        for _ in range(10):
            s = await self.client.beta.sessions.retrieve(session_id)
            if s.status != "running":
                break
            await asyncio.sleep(0.2)
        await self.client.beta.sessions.archive(session_id)
```

---

## 尾声

一份合格的 CMA 客户端至少具备:

- **明确的 Setup / Runtime 分离**——`agents.create` 在部署时,不在请求路径;
- **独立的 SessionDriver 组件**——状态机、事件循环、tool 分发都在里面,不散落;
- **§6 十条模式全部落实**——这是 non-negotiable;
- **关键决策点(§7)有自觉选择**,能说清楚为什么这么选;
- **产品形态(§8)的特有坑有预案**;
- **§16 checklist 逐条过**。

把这份文档当 code review checklist——review 自己或队友写的 CMA 客户端代码时,按项对照。做不到的地方,要么有明确豁免理由写在 ADR 里,要么就是技术债。
