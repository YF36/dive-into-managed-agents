# Managed Agents 的设计思想：把"大脑"和"双手"解耦

> 本文基于 Anthropic 工程博客 [Scaling Managed Agents: Decoupling the Brain from the Hands](https://www.anthropic.com/engineering/managed-agents) 与 Managed Agents Beta API 文档整理，讨论这套产品背后的设计哲学，并把每一条原则映射到它在 Beta API 中的具体体现。

---

## 一、起点：harness 里藏着会过期的假设

构建一个 agent harness，核心工作其实是在回答一个问题——**Claude 自己做不了什么，需要 harness 替它兜底？** 每一次给出具体答案，都在 harness 里沉淀出一段代码：一个上下文清理策略、一段重试逻辑、一条特殊指令。

这些答案有一个共同的脆弱性：**它们编码的是模型在某一时刻的能力边界**。Anthropic 团队给出的具体案例很典型——Claude Sonnet 4.5 存在"context anxiety"，他们在 harness 里加了一段 context-reset 逻辑来兜底；等 Claude Opus 4.5 出来之后，这个问题不存在了，那段代码就变成了纯粹的复杂度负担。

团队总结了一句核心洞察：

> Harnesses encode assumptions about what Claude can't do on its own. However, those assumptions need to be frequently questioned because they can go stale as models improve.

如果一个 harness 是为"今天的 Claude"量身打造的，那它几乎一定会被"明天的 Claude"甩在身后。要想让这套基础设施活得比任何一个模型版本都长，就必须让它**不编码**对模型能力的任何具体假设。

## 二、操作系统给出的答案：虚拟化出"不变的接口"

这个挑战在工程史上不是第一次出现。操作系统面对的就是"要支持尚未被写出来的程序"——做法是把硬件虚拟化成稳定的抽象层（进程、文件、网络 socket），新程序只要面对这些抽象编程，具体硬件怎么换、怎么扩容都不影响它。

Managed Agents 借用了同一个套路。它把"agent 在长任务里到底需要什么"抽象成三个虚拟化组件：

| 组件 | 本质 |
|---|---|
| **Session** | 一份 append-only 的事件日志 |
| **Harness** | 调用 Claude 的编排循环 |
| **Sandbox** | 执行代码和文件操作的容器 |

这三者被有意拆成独立接口。底层怎么实现可以随时换——换一套 compaction 策略、换一种容器编排方式、换一个调度器——但**对上层的接口保持稳定**。这就是整个产品的设计基底：对外是一组可预期的接口，对内是可以自由演进的实现。

## 三、"宠物 vs 牛群"：从单容器架构脱身

最初的 Managed Agents 并没有做这种分离。harness、会话状态、工具执行都塞在同一个容器里——一个实现起来最直接、但也最容易退化成"宠物"的形态。

团队的复盘很直白：

> By coupling everything into one container, we ran into an old infrastructure problem: we'd adopted a pet.

这种架构暴露了两个结构性问题：

1. **容错性差**：容器挂掉，一次会话的所有上下文一起消失。
2. **运维越界**：调试得让工程师进到一个装着用户数据的容器里操作——安全边界和运维需求打架。

解法是把三件事拆开。下面这三条架构决策，是整篇工程文章最硬核的部分，也是后来 Beta API 各种细节背后共同的"根"。

### 决策一：Harness 搬出容器，变成无状态

Harness 不再住在容器里，而是退到 Anthropic 的编排层，通过一个通用接口调容器：

```
execute(name, input) → string
```

从 harness 的角度看，sandbox 就跟任何别的工具没有区别。容器崩溃不再是"会话崩溃"，而是"一次 tool-call 失败"——Claude 自己就能决定是重试、换个方式，还是告诉用户出问题了。

这套解耦直接带来性能收益：**TTFT（time-to-first-token）在 p50 下降约 60%，p95 下降超过 90%**。原因很朴素——推理不必再等容器 provisioning 完成，harness 可以先跑起来，工具调用时再去接沙箱。

#### 在 Beta API 中的体现

- **Agent / Session / Environment 是三个独立资源。** Agent 里放的是模型、system prompt、工具列表、MCP 服务器——这些都不在容器里，而是在编排层。Environment 是容器的"模板"，Session 是具体一次运行。
- 文档里反复强调的那句话——*"The agent loop runs on Anthropic's orchestration layer; the container is where the agent's tools execute"*——就是这个架构决策的直接陈述。
- **Session 可以 `rescheduling`**。当底层出现可重试错误，session 会进入 `rescheduling` 状态等待重新被调度——这种"容器失败不等于会话失败"的语义，只有在 harness 和容器解耦之后才成立。

### 决策二：Session 作为外部状态

如果 harness 变成无状态，上下文得存在别处。自然的选择是把它做成一份独立的、可查询的事件日志——也就是 Session。

关键的接口是 `getEvents()`：它不是简单的"给我当前状态"，而是一个**灵活的切片接口**。harness 可以：

- 从上次停止的位置读起；
- 回退到某个事件之前重新拼装上下文；
- 重读历史事件来恢复情境。

团队是这么总结这个设计的空间的：

> The interfaces push that context management into the harness, and only guarantee that the session is durable.

Session 只保证一件事：日志是持久的。**怎么读、怎么裁剪、怎么压缩，是上层的自由**。这让未来想换 context engineering 策略的时候，不用去动核心抽象。

#### 在 Beta API 中的体现

- **事件系统就是这份日志**。`user.message`、`agent.message`、`agent.tool_use`、`agent.custom_tool_use`、`session.status_*`、`span.model_request_*`——每个事件都有 `id` 和 `processed_at`，组成一份可按 ID 去重、按时间切片的 append-only 序列。
- **两种读取方式并存**：SSE 流（`GET /v1/sessions/{id}/events/stream`）用于实时消费，分页列表（`GET /v1/sessions/{id}/events`）用于历史回溯。这不是冗余，而是对应了 session 作为"durable 日志"的两种基本访问模式。
- **断线重连模式就是这个设计的直接推论**。客户端文档里描述的"先开 stream、再拉 history、按 event id 去重"，只有把 session 当成日志才说得通。如果 session 是传统的"当前状态"，断线就得靠 snapshot-and-diff；做成日志之后，reconnect 变成纯粹的去重问题。
- **Context compaction、prompt caching、extended thinking 是 harness 在 session 日志之上构建出来的能力**，不是 session 本身的职责。Session 只承诺"这份日志是持久的"——怎么压缩、什么时候命中缓存、怎么复用 thinking block，都是上层（harness）的工作。Anthropic 的默认 harness 把这些作为开箱即用的策略提供给所有用户，省掉了应用层自己实现的负担；但这条分层也意味着：将来想换一套压缩或缓存策略，动的是 harness，session 接口不需要变。这正是"只承诺接口、不承诺实现"原则的具体兑现——也为将来用户自带 harness、在同一份 session 日志上实现自己的 context 策略，留出了空间。
- **Session 的状态机（`idle` / `running` / `rescheduling` / `terminated`）+ `stop_reason`** 本身也是把 harness 内部的生命周期暴露成稳定接口。客户端不用猜 agent 在干什么，状态机讲清楚了。

### 决策三：凭证永不进沙箱

安全是第三条线。只要 Claude 生成的代码能接触到凭证，prompt injection 就有一个永远存在的攻击面。Managed Agents 的做法是**彻底切断这条路径**——Claude 从来看不到凭证。

两种具体模式：

1. **Resource-bundled auth**：比如 Git token 只在 sandbox 初始化时用一次，用来把仓库 clone 进来；之后 Claude 完全接触不到它。
2. **Vault-stored credentials**：MCP 工具的 OAuth token 集中存在 vault 里；当 Claude 要调外部服务时，**请求离开 sandbox 之后**，由 proxy 从 vault 取 token 注入出站请求。容器里的代码无论如何都读不到凭证。

这个设计把"Claude 会不会被 prompt injection 骗出 token"这个问题，变成了一个**物理上没有答案**的问题——凭证根本不在它能触达的地方。

#### 在 Beta API 中的体现

- **Agent 的 `mcp_servers` 数组只声明 `type`、`name`、`url`，不带 auth 字段**。认证信息不污染可复用的 agent 定义。
- **Vault 是一个独立资源**。`vault_ids` 是在 session 创建时传入的，与 agent 解耦；Anthropic 自动用 refresh token 续期 OAuth 凭证。
- **GitHub 仓库的 `authorization_token` 通过 git proxy 注入**。`git pull` / `git push` 都走代理，Claude 写的任何代码都拿不到这个 token。
- **容器里没办法设置环境变量**——这一点在文档里反复出现。不是"还没做"，而是**故意**不做：一旦允许往容器里塞密钥，整条隔离链就破了。
- **非 MCP 的 API 或 CLI 需要密钥时，官方推荐走 custom tools**：agent 发出 `agent.custom_tool_use` 事件，你的 orchestrator（在 host 端，持有密钥）执行调用，通过 `user.custom_tool_result` 把结果送回去。容器端始终看不到密钥。
- **把 API key 写进 system prompt 或 user message** 是明确的反模式——这些内容会进事件历史，也会进 compaction 摘要，会在整个 session 生命期内可读。

## 四、解耦带来的可扩展空间：many brains, many hands

这三条架构决策的综合效果，是让"大脑"和"双手"各自可以独立伸缩。

### Many Brains（多个大脑）

Harness 无状态之后，可以水平扩展。多个 harness 可以同时连到同一组资源；接入客户 VPC 不再需要网络 peering，也不用等容器提前起好。

**在 Beta API 中的体现**：`callable_agents`（多 agent 编排，research preview）是这个能力的直接外化——一个 coordinator agent 可以委派任务给其他 agent，所有 agent 共享同一个容器文件系统，但各自跑在独立的 session thread 里，context 相互隔离。这是"多大脑共享一双手"。

### Many Hands（多双手）

每一个执行环境（sandbox、容器、custom tool）都统一成同一个工具接口。Claude 可以同时推理多个 sandbox、多个容器、多个自定义工具——任意一个工具挂掉，不会连累其他工具。

**在 Beta API 中的体现**：

- **Custom tools** 本质上就是把 host 端的能力挂到 agent 上。文档里的 Pattern 9（*"Secrets for non-MCP APIs and CLIs — keep them host-side via custom tools"*）是这个模式最典型的应用。
- **Multi-agent + 共享 sandbox** 让多个大脑可以看同一套文件系统，但带着各自独立的工具权限和 system prompt。

## 五、长任务：context 是活在 context window 外面的对象

实际的 agent 任务很难被塞进一次 context window。传统 harness 面对这个问题时要做**不可逆决定**：该丢哪段历史？丢掉以后还能找回来吗？

Managed Agents 的答案是把这件事反过来：

> The session provides a context object that lives outside Claude's context window.

Context 不是 harness 要想办法压进窗口的东西，而是一个**活在窗口之外、随时可查的持久对象**。harness 决定每一步往窗口里塞什么，session 负责保证任何时候都能把某段历史再拿出来。

**在 Beta API 中的体现**：

- **`agent.thread_context_compacted` 事件** 明确告知客户端"刚刚做了一次压缩"——这把压缩从黑盒行为变成了可观察事件，客户端需要的话可以自己取未压缩的原始历史。
- **Session 默认跨交互持久化**，文档明确说 *"session persists between interactions"*。容器会在 idle 时做 checkpoint，下次发事件进来能原地恢复文件系统状态。
- **Memory stores**（research preview）是进一步的扩展：把"活在 context window 外"的范围再放大一层，跨 session 持久存放学到的东西。

## 六、核心原则：对接口 opinionated，对实现 unopinionated

贯穿整套设计的一条元原则是：

> 对接口有强烈主张，对实现保持开放。

团队对 agent 在长任务里**会需要什么**非常笃定：

- 操作状态（访问 session）；
- 计算能力（跑 sandbox）；
- 可扩展到多个大脑、多双手。

但对这些能力**长什么样、在哪、有几个**，不做任何假设。

这条原则在 API 层面有很多直接的体现：

- **Agent 是 versioned config**。更新 agent 会生成新版本，已有 session 仍然跑在它启动时 pin 的版本上——接口（agent 引用）稳定，底层实现（agent 的行为定义）可以自由演进。
- **Environment 不是写死的容器，而是模板**。同一个 agent 可以跑在不同 environment 上，换 networking、换预装包都不影响 agent 定义本身。
- **Skill 和 tool 是可加可减的资源**，不耦合进 agent 的"骨架"里。

作为应用开发者，理解这条原则有一个直接的好处：**不要把自己的应用逻辑绑死在实现细节上**。Context compaction 什么时候触发、具体怎么压缩——不要去依赖；session 在什么时候 reschedule——也不要去假设。Anthropic 保留在这些地方演进的自由度，应用只应该依赖公开的接口。

## 七、对使用者的启示

这套设计思想不只是背景知识，它决定了用 Beta API 时什么是"顺着纹路"、什么是"逆着纹路"。几条最直接的映射：

1. **Agent 一次创建、长期复用**。每次运行都 `agents.create()` 是最常见的反模式——这等于把"可演进的 config"退化成"一次性脚本参数"，浪费了整套 versioning 机制。
2. **总是通过事件流交互，不要自己造状态机**。Session 已经是外部状态了，应用层再维护一份"agent 现在在干嘛"的镜像，大概率会和真实状态漂移。断线重连走"stream + history + dedupe"的标准模式。
3. **凭证只放在 vault 或 host 端**。把 API key 塞进 system prompt、想办法注入容器环境变量——都是在绕过一条被**故意**设计成单向的边界。真需要调的服务有 MCP 就用 MCP，没有就走 custom tool。
4. **用 `callable_agents` 和 custom tools 组合多大脑、多双手**。不要试图在一个 agent 里塞所有职责；把专业化的工作拆成独立的 agent 或 host 端工具，让 coordinator 去调度——这才是整套 "many brains, many hands" 架构给到上层的自然用法。
5. **把 session 当作 durable 的历史对象看**。它不是"本次对话的临时状态"，而是一份可回放、可审计、可 resume 的日志。应用里任何需要"回到过去某个点"的场景，都应该先想想能不能用 event 历史来解决，而不是自己另存一套 snapshot。

## 八、结语：一个 meta-harness

把这些决策合在一起看，Managed Agents 并不是在提供"一个 harness"。它在提供**一组让各种 harness 都能跑起来的接口**——无论是为特定任务量身定制的 agent，还是像 Claude Code 那样的通用 agent，都能以相同的抽象模型接入。

这是一种元设计：不去替未来的 harness 做决定，而是保证无论未来 harness 怎么演进，底下的 session、sandbox、编排层都能稳稳托住。当新版本的 Claude 让今天的某段 harness 代码显得多余时，Managed Agents 希望的是——你删掉那段代码，其他一切照常工作。这套基础设施本身，就是对"模型能力会持续进步"这件事最直接的下注。
