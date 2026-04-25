# Managed Agents 高阶 harness 模式详解

> Managed Agents 在标准 agent loop 之上开放了三个高阶特性:**Memory**(跨 session 记忆,**2026 年 4 月已升级公开 beta**)、**Define Outcomes**(目标驱动执行,**research preview**)、**Multiagent Sessions**(多 agent 协调,**research preview**)。本文对这三者做机制级分析——它们各自解决什么问题、怎么和标准 loop 协同、客户端怎么集成、以及它们揭示了什么设计哲学。
>
> **更新提示**:Memory 在 2026/04 经历了一次架构性重构——从"自动注入 6 个专用 `memory_*` tool"改为"挂载成 `/mnt/memory/` 下的文件系统目录、agent 用标准 agent toolset 操作"。如果你读过本文的旧版本(基于研究预览),§4 几乎全部需要重读。

---

## 目录

- [0. 导读:什么叫"高阶 harness 模式"](#0-导读)
- [1. 背景:从对话到工作](#1-背景从对话到工作)
- [2. Define Outcomes:目标驱动的执行](#2-define-outcomes目标驱动的执行)
- [3. Multiagent Sessions:协调与委派](#3-multiagent-sessions协调与委派)
- [4. Memory:跨 session 记忆(已升级公开 beta)](#4-memory跨-session-记忆)
- [5. 组合使用:三者的协同](#5-组合使用三者的协同)
- [6. 设计哲学观察](#6-设计哲学观察)
- [7. 生产部署考量](#7-生产部署考量)
- [8. 客户端集成骨架](#8-客户端集成骨架)
- [附录 A. 完整示例:DCF 分析 agent](#附录-a-完整示例dcf-分析-agent)
- [附录 B. 完整示例:Code review 多 agent 协同](#附录-b-完整示例code-review-多-agent-协同)
- [附录 C. 事件速查表](#附录-c-事件速查表)

---

## 0. 导读

### 什么是"高阶 harness 模式"

标准 Managed Agents(下称 **CMA**)的 agent loop 只做一件事:**消费 user.message,调用模型和工具,产出 agent.message,循环到 idle**。这是一个最小但完整的对话 harness。

"高阶"指的是**在这个 loop 之上横向扩展**出来的机制——它们并不改变底层 agent loop 的运行方式,而是:

- **Memory**:给 agent 接上一块**跨 session 的可读写记忆**——以一个挂在 `/mnt/memory/` 下的目录的形式存在,agent 用标准 read/write/edit/grep/glob/bash 工具操作。这让 agent 能**学习**。
- **Define Outcomes**:给 loop 接上一个**外部 grader**,按 rubric 评判 agent 的产出,不满意就让 agent 继续迭代。这把 agent 从"对话机"升级成"目标达成机"。
- **Multiagent Sessions**:让一个 agent 能**委派任务给其他 agent**,每个 agent 跑在独立的 context(thread)里但共享同一个容器文件系统。这把"单 agent"扩展成"团队"。

**当前状态**:三者的成熟度并不一样——

| 特性 | 状态 | Beta header | 含义 |
|---|---|---|---|
| Memory | **公开 beta** | `managed-agents-2026-04-01` | API 形态稳定,可用于生产;早期客户(Netflix / Rakuten / Wisedocs)已上线 |
| Outcomes | research preview | `managed-agents-2026-04-01-research-preview` | API 可能变;启用前先 [申请](https://claude.com/form/claude-managed-agents) |
| Multi-agent | research preview | `managed-agents-2026-04-01-research-preview` | 同上 |

任何构建生产级 CMA 应用的团队,都应该对三者有机制级的理解——Memory 已经可以放心用,Outcomes 和 Multi-agent 即使暂时不用也要看清它们的演进方向。

### 为什么 Outcomes 和 Multi-agent 还在 research preview?

两者的共性是:**行为维度远比标准 loop 丰富,正确性难以静态保证**。

- Outcomes 的成败取决于 rubric 质量 + grader 判断力;
- Multi-agent 的成败取决于 coordinator 是否能把任务切对、sub-agent 是否听话。

这些是**Claude 行为**的问题,不是工程问题。只有在真实用户反复跑之后,Anthropic 才能把默认策略、prompt、harness 决策调到让人能用的程度——所以这些特性在 research preview 阶段收集真实数据,行为可能随 Claude 版本微调。

Memory 走过了同一个 research preview 阶段(从"自动注入专用 tool"演进到"挂文件系统给标准 toolset 用"),并在 2026/04 升级到了公开 beta。这条演进路径值得在自己的产品里参考——**先用 research preview 的形态收集真实数据,等 API 形态稳了再做向后兼容承诺**。

### 本文不覆盖

- CMA 的基础概念(Agent/Environment/Session/Event)——假设已熟悉;
- 标准 agent loop 的事件协议(stream/list/send、stop_reason、consolidation 等)——假设已掌握;
- Research preview 的申请流程——找 Anthropic 的 sales/form。

---

## 1. 背景:从对话到工作

理解这三个高阶特性前,先看清标准 agent loop 的几个局限:

### 1.1 标准 loop 的隐含假设

标准 agent loop 的形态是:

```
user.message → agent.message (+ tool_use/tool_result loops) → session.status_idle(end_turn)
```

这里面有三个隐含假设:

1. **成功的标志是"agent 说完了"** (`end_turn`)——而不是"任务达成了";
2. **所有工作都在一个 agent 的 context 里**——同一个 system prompt、同一套工具、同一份对话历史;
3. **每个 session 是独立的**——session 结束,容器归档,agent 学到的任何东西都随之消失。

对于**对话式**产品(chatbot、copilot 的单轮问答),这三个假设没问题。对于**工作式**产品(生成一份 DCF 模型、多步骤 code review、跨天积累的项目记忆),假设开始露馅。

### 1.2 三个特性的对应关系

每个高阶特性精确打掉一个假设:

| 假设 | 打掉它的特性 | 新的模式 |
|---|---|---|
| 成功 = agent 说完了 | **Define Outcomes** | agent 自评 + 迭代直到 rubric satisfied |
| 单 agent 一套 context | **Multiagent Sessions** | coordinator 委派 + thread-isolated context |
| 每 session 独立 | **Memory Stores** | 跨 session 的 durable 读写记忆 |

### 1.3 共同的设计手法

这三个特性都遵循 CMA 的元设计原则("对接口 opinionated,对实现 unopinionated"):

- **都通过现有协议表面 inject**——Memory 复用了既有的 resource 系统(新增 `memory_store` resource type)+ 既有的 agent toolset(挂在 `/mnt/memory/` 下让 agent 用标准 file 工具操作),完全不引入新 event;Outcomes 和 multi-agent 在事件流里加了新 event 类型;三者都没有引入独立的 API namespace。
- **都不改变 session 的本质(durable 日志 + sandbox 容器)**——outcomes 的 grader 在独立 context 跑,memory 的内容在独立存储(以文件形式挂回容器),multi-agent 的 thread 仍然是 session 日志的子集;
- **都对客户端提供 opt-out 路径**——不想要 outcome 就不发 define_outcome,不想要 multi-agent 就不声明 callable_agents,不想要 memory 就不挂 `memory_store` resource。

这保证了:**存量 CMA 应用不会被这些特性破坏**。即使启用,默认行为依然是熟悉的 loop。

> 💡 **Memory 升级的细节值得拎出来看**:研究预览阶段 Memory 用了"自动注入 6 个专用 `memory_*` tool"的设计——挂上 store,agent 就多 6 个 schema-fixed 工具。公开 beta 阶段改成"挂个文件系统目录,让标准 read/write/edit 工具去读"——**没有引入新工具,只复用了既有 toolset**。这是 P5 原则(复杂交互 = 既有原语编排,不是新协议)的极致体现:**最好的扩展不是加新东西,而是发现已有的东西能不能再用一次**。

---

## 2. Define Outcomes:目标驱动的执行

### 2.1 核心概念

一个标准 session 是**对话**:你发 user.message,agent 回复,结束。

一个 outcome-driven session 是**工作**:你描述**结果该是什么**+**怎么评判好坏**,agent 自己迭代直到达成——或者耗尽 iteration 上限。

```
标准 session:
  user.message → agent.message + tools → idle(end_turn)

Outcome session:
  user.define_outcome(desc, rubric, max_iter=5)
    → agent 工作一轮
    → grader 按 rubric 评估 (iteration=0)
    → 未满足 → agent 再工作一轮
    → grader 评估 (iteration=1)
    → ...
    → satisfied | needs_revision 耗尽 → idle(end_turn)
```

关键在于 **grader** 的存在。这是一个**独立 context 窗口里跑的 Claude 实例**,只看 rubric + agent 产出,不看 agent 的思考过程。它的职责是冷静判断:"按这条 rubric 打分,还缺什么?"

### 2.2 Grader 的分离设计

为什么 grader 要独立 context?

- **避免同流合污**:如果评估在 agent 自己的 context 里做,agent 一方面推理实现、一方面评估自己——容易写出"差不多就行"的自评;
- **避免信息污染**:agent 的推理过程(尤其是 thinking)可能包含对 rubric 的反复重新解读,让评估失焦;
- **可替换的判断**:分离 grader 意味着未来可以把它换成不同模型、不同 prompt 策略、甚至人工介入——client 侧看到的接口不变。

这是 §6 会反复出现的"meta-harness"思路:**把一个可演进的策略藏到独立接口后面**。

### 2.3 Rubric:Outcomes 的核心输入

Rubric 是一个 markdown 文档,描述**按什么标准打分**。Rubric 好坏直接决定 outcome 好坏——含糊的 rubric 产出含糊的评估,agent 没有锚点,迭代变成绕圈。

**好 rubric 的特征**:

- **原子化**:每条标准是一个独立可判断的句子。"The CSV contains a price column with numeric values" 比 "The data looks good" 好得多。
- **可验证**:grader 能在不跑 agent 工具的前提下,从产出本身判断。"文件里有 DCF 模型"是可验证的;"模型足够精确"不可验证。
- **分层**:按 section 分类,不要堆一起。典型结构:输入合法性 → 核心计算 → 结构合规 → 输出质量。
- **显式边界**:关键常数或公式直接写清楚,不留解释空间。"Terminal growth rate does not exceed long-term GDP growth" 比 "terminal growth is reasonable" 好。

**示例**(金融建模):

```markdown
# DCF Model Rubric

## Revenue Projections
- Uses historical revenue data from the last 5 fiscal years
- Projects revenue for at least 5 years forward
- Growth rate assumptions are explicitly stated and reasonable

## Cost Structure
- COGS and operating expenses are modeled separately
- Margins are consistent with historical trends or deviations are justified

## Discount Rate
- WACC is calculated with stated assumptions for cost of equity and cost of debt
- Beta, risk-free rate, and equity risk premium are sourced or justified

## Terminal Value
- Uses perpetuity growth OR exit multiple (method stated explicitly)
- Terminal growth rate does not exceed long-term GDP growth

## Output Quality
- All figures in a single .xlsx with clearly labeled sheets
- Key assumptions on a separate "Assumptions" sheet
- Sensitivity analysis on WACC and terminal growth rate included
```

**辅助技巧**:如果你不擅长写 rubric,给 Claude 一个"已知是好的"产物,让它分析"为什么它好",再把分析转成 rubric——比从零写强。

### 2.4 Rubric 的两种传入形式

两种等价:

**Inline 文本**(一次性用):

```json
{
  "type": "user.define_outcome",
  "description": "Build a DCF model for Costco in .xlsx",
  "rubric": {"type": "text", "content": "# DCF Model Rubric\n..."},
  "max_iterations": 5
}
```

**File 引用**(跨 session 复用):

```python
# 先 upload rubric
rubric_file = client.beta.files.upload(file=Path("rubrics/dcf.md"))

# 在 define_outcome 里引用
{
  "type": "user.define_outcome",
  "description": "Build a DCF model for Costco in .xlsx",
  "rubric": {"type": "file", "file_id": rubric_file.id},
  "max_iterations": 5
}
```

**选型**:一次性任务用 inline(少一次 upload 调用)。多 session 共用同一套 rubric(比如"所有 PR review 用同一份标准")用 file——改 rubric 只改一个文件,无需改客户端代码。

### 2.5 Outcome 的事件协议

Outcome session 在标准事件之外多出这些:

**客户端发**:

| 事件 | 说明 |
|---|---|
| `user.define_outcome` | 启动一个 outcome,带 description + rubric + max_iterations |

**服务端发**:

| 事件 | 说明 |
|---|---|
| `span.outcome_evaluation_start` | 一次 grader 评估开始,带 `iteration`(0-indexed) |
| `span.outcome_evaluation_ongoing` | grader 运行中心跳(不带进度细节) |
| `span.outcome_evaluation_end` | 本次评估结束,带 `result` 和 `explanation` |
| `session.outcome_evaluated` | 整个 outcome 评估完成(所有迭代) |

**`span.outcome_evaluation_end.result` 的取值**:

| 值 | 含义 | agent 下一步 |
|---|---|---|
| `satisfied` | 所有 rubric 项满足 | session 进入 idle(end_turn) |
| `needs_revision` | 还缺什么,explanation 里说 | agent 进入新一轮迭代 |
| `max_iterations_reached` | 已经跑到上限 | agent 可能再做一轮最终修订,然后 idle |
| `failed` | rubric 根本不匹配任务(描述和 rubric 矛盾) | idle,任务无法进行 |
| `interrupted` | 你发了 `user.interrupt`,而且 evaluation_start 已经先发了 | 当前迭代中止 |

**关键观察**:evaluation 事件是 **span** 而不是 agent event——因为它不是"agent 的一次回合",而是**一段 grader 活动的观测窗口**。`ongoing` 是心跳(不暴露 grader 具体在想什么),`start`/`end` 划定边界。

### 2.6 迭代流程的完整时序

一次成功的三轮迭代大致长这样:

```
t=0    user.define_outcome(max_iterations=5) →
t=1    session.status_running
t=2    agent.tool_use(write)
t=3    agent.tool_result
t=4    agent.message("done first version")
t=5    span.outcome_evaluation_start(iteration=0)
t=6    span.outcome_evaluation_ongoing  ×N 心跳
t=7    span.outcome_evaluation_end(result=needs_revision,
              explanation="WACC section missing terminal growth rate")
t=8    agent.tool_use(edit)                 # agent 读 grader 反馈后改进
t=9    agent.message("added terminal growth rate")
t=10   span.outcome_evaluation_start(iteration=1)
t=11   span.outcome_evaluation_end(result=needs_revision,
              explanation="Sensitivity analysis missing")
t=12   agent.tool_use(edit)                 # 继续修
t=13   span.outcome_evaluation_start(iteration=2)
t=14   span.outcome_evaluation_end(result=satisfied,
              explanation="All 12 criteria met")
t=15   session.outcome_evaluated
t=16   session.status_idle(stop_reason=end_turn)
```

几个细节:
- **迭代计数从 0 开始**:iteration=0 是第一次评估,iteration=1 是第一次返工后的评估;
- **`needs_revision` 的 explanation 被 agent 读到**:agent 下一轮会按这个反馈修正,不是从头再写;
- **`satisfied` 后 agent 不再做事**:session 立即 idle;
- **Grader 失败 ≠ session 失败**:如果 grader 本身出错,客户端会看到 `session.error`,session 可能继续或进入 retries_exhausted——这是底层错误路径,不是 outcome 流程的一部分。

### 2.7 与标准 loop 的协同

Outcome session 并**不**排斥标准交互模式:

- **可以在 outcome 进行中发 `user.message`**——agent 会读到并调整工作方向(但不会跳过 grader,grader 仍按原 rubric 判);
- **可以发 `user.interrupt`**——当前 outcome 进入 `interrupted` 状态,session 恢复 idle;
- **Outcome 终止后 session 不死**——可以继续聊天(标准模式),或再发一个 `user.define_outcome` 开新 outcome。

**关键约束:同一时刻只能有一个 outcome**。发第二个 define_outcome 前,第一个必须已终止(satisfied / max_iterations_reached / failed / interrupted)。想做"串联多个目标"(先生成模型,再跑敏感度分析,最后写报告)——分三个 outcome 顺序发即可,每个前一个终止后发下一个。

### 2.8 适用场景 vs 不适用场景

**适合用 Outcomes**:

- **产出有明确形态**(一份文件、一份报告、一个可测的 artifact);
- **成功标准可以形式化**(清单式 rubric 写得出来);
- **需要自我纠错**(一次产出 80% 对,靠反馈迭代到 95%);
- **愿意付迭代成本**(每轮 iteration = 完整 agent run + 一次 grader 调用)。

**不适合用 Outcomes**:

- **开放式对话**(用户希望的就是聊,不是"达成某个目标");
- **rubric 写不出来**("做得好"是主观的、是"我见到就知道");
- **迭代成本不可接受**(比如需要极低延迟的交互);
- **任务有外部依赖反馈**(需要真实用户测试、需要和他人沟通——grader 看不到这些)。

**一个常见误判**:有人觉得"我本来就在 loop 里判 `end_turn`,然后我加个自己的判断,做得不对就再发 user.message 让它改"——这和 outcomes 看起来类似,但**grader 的独立 context 是关键区别**。自己在 user message 里 evaluate 会让 agent 反复受自己上一轮思考的影响,质量不如独立 grader。

### 2.9 客户端集成要点

**1. Beta header**

Outcomes 需要 `managed-agents-2026-04-01-research-preview`。SDK 会自动加,但你要确认 workspace 已申请 research preview 访问。

**2. 事件流消费的扩展**

你的 SessionDriver 要能处理新增的 span 事件:

```typescript
for await (const ev of stream) {
  switch (ev.type) {
    // 现有处理...

    case "span.outcome_evaluation_start":
      ui.showGraderRunning(ev.iteration);
      break;

    case "span.outcome_evaluation_ongoing":
      ui.heartbeat();
      break;

    case "span.outcome_evaluation_end":
      ui.showEvaluationResult(ev.result, ev.explanation);
      if (ev.result === "satisfied" || ev.result === "failed"
          || ev.result === "max_iterations_reached") {
        // Outcome 终止;session 即将 idle
      }
      break;

    case "session.outcome_evaluated":
      ui.showOutcomeComplete();
      break;
  }
}
```

**3. idle-break gate 不变**

`session.status_idle(stop_reason=end_turn)` 仍然是退出条件——outcome 终止后 session 自然走到 idle。不需要额外的 outcome-specific gate。

**4. Retrieving deliverables**

Outcome 产出的文件会落在 `/mnt/session/outputs/`,拉取方式和标准 session 一样:

```python
# Session idle 后拉取
files = client.beta.files.list(
    scope_id=session.id,
    betas=["files-api-2025-04-14", "managed-agents-2026-04-01-research-preview"],
)
```

注意 **double beta header**:`files.*` 自动带 `files-api-*`,你要手动加 research-preview 版本。

**5. Polling outcome 状态**

如果你想轮询(非 stream)查当前 outcome 状态:

```python
session = client.beta.sessions.retrieve(session.id)
for outcome in session.outcome_evaluations:
    print(f"{outcome.outcome_id}: {outcome.result}")
```

这返回所有已 evaluated 的 outcomes 列表(一个 session 可以顺序跑多个)。

### 2.10 陷阱与注意事项

- **Rubric 太严导致死循环**:`max_iterations` 不要设太大。20 是上限,但 3-5 通常够了。如果 agent 连 5 轮都搞不定,大概率是 rubric 或 description 有根本性问题,不是多试几次能解的。
- **Rubric 和 description 矛盾**:`failed` 状态就是为这个准备的。grader 先做一致性检查。但不是所有矛盾都能被 grader 发现——比如 description 说"用 Python",rubric 只判产物形态不判语言,agent 用 JavaScript 也可能 satisfied。写 description 时把 rubric 没覆盖的硬约束讲清楚。
- **Interrupt 时序**:`user.interrupt` 若在 `span.outcome_evaluation_start` 之前到达,interrupted 事件**不会**发出——outcome 会直接在 agent 自己的 safe boundary 停,evaluation 不启动。若在 start 之后到达,`span.outcome_evaluation_end.result = interrupted`。
- **每轮迭代 = 重跑 agent**:这不是"让 agent 修几个字",是每轮迭代让 agent 在当前 context 基础上继续工作,可能跑 tool、读文件、写 diff。**成本是 iteration 数 × 平均单轮 token**。prod 部署务必监控 token 消耗。
- **Outcome 里的 agent 仍然会 compaction**:如果 iteration 多 + context 大,可能触发 `agent.thread_context_compacted`——agent 的历史被压缩,但 rubric 和 grader 的独立 context 不受影响。

---

## 3. Multiagent Sessions:协调与委派

### 3.1 核心概念:Session Thread

标准 session 只有一个 agent 在跑,所有事件都在同一条时间线上。

Multi-agent session 里,一个 session 可以同时有**多个 agent 在跑**,每个 agent 有自己独立的"对话线程",但**共享同一个容器文件系统**。

```
         ┌──────────── Session ──────────────┐
         │                                    │
         │  Primary Thread (coordinator)     │
         │    ├─ user.message                │
         │    ├─ agent.message               │
         │    ├─ agent.tool_use(delegate)    │
         │    │                               │
         │    ├─ session.thread_created ─┐   │
         │    │                           │   │
         │  Sub-thread A (reviewer)       │   │
         │    ├─ agent.message            │   │
         │    ├─ agent.tool_use(read)     │   │
         │    └─ session.thread_idle      │   │
         │                                    │
         │  Sub-thread B (tester)         │   │
         │    ├─ agent.tool_use(bash)     │   │
         │    └─ session.thread_idle      │   │
         │                                    │
         │  所有 thread 共享 /workspace      │
         └────────────────────────────────────┘
```

### 3.2 架构模型

**Thread 的本质**:一个 thread 是一份**隔离的对话 context**——有自己的 system prompt、自己的消息历史、自己的工具权限。

**共享什么 vs 隔离什么**:

| 资源 | 是否共享 |
|---|---|
| 容器文件系统(`/workspace`) | **共享** |
| Session 级 vault(OAuth 凭证) | **共享** |
| 容器网络策略(allowed_hosts) | **共享** |
| Session 级 resources(file、repo 挂载) | **共享** |
| System prompt | **隔离**(每个 agent 自己的) |
| Model 选择 | **隔离** |
| Tools 配置 | **隔离** |
| MCP servers 配置 | **隔离** |
| Skills | **隔离** |
| 对话历史 | **隔离** |

核心设计思想:**上下文隔离,工作区共享**。

为什么这么设计?因为典型协作场景里:
- 各 agent 的**思考方式**应该独立(reviewer 不该被 coder 的思路带偏);
- 各 agent 的**工作产物**应该共享(reviewer 读 coder 写的文件,不然怎么 review);
- 各 agent 的**权限配置**可以不同(reviewer 只读,coder 可写)。

### 3.3 单层委派的约束

**关键限制:只允许一层委派**。coordinator 可以调用其他 agent,但被调的 agent 不能再调用别的 agent。

```
✅  coordinator → reviewer
    coordinator → tester
    coordinator → researcher

❌  coordinator → reviewer → grammar_checker
                              ^^^^^^^^^^^^^
                    不允许(二级 delegation)
```

为什么限这么死?

- **成本可控**:多级委派下,token 消耗呈指数增长。一层就已经是"N 倍成本";
- **复杂度可控**:多级递归时,debugging 一个错误行为几乎不可能;
- **Context 爆炸**:每一级委派都带出新的 thread,context 管理负担倍增;
- **经验使然**:Anthropic 的内部数据显示,超过一层的递归 agent 质量往往更差——LLM 在"作为专家执行专项"上比"作为管理者管理管理者"强。

这条限制让 multi-agent 的心智模型保持简单:**一个领队 + 一组专家**。

### 3.4 声明 callable_agents

在 coordinator agent 的配置里声明它能调哪些 agent:

```python
# Setup 阶段:先建好 reviewer 和 tester 两个 sub-agent
reviewer = client.beta.agents.create(
    name="Code Reviewer",
    model="claude-opus-4-7",
    system="You review code for security and style issues...",
    tools=[{
        "type": "agent_toolset_20260401",
        "default_config": {"enabled": False},
        "configs": [
            {"name": "read", "enabled": True},
            {"name": "grep", "enabled": True},
            {"name": "glob", "enabled": True},
            # 没有 write / bash:reviewer 只读
        ],
    }],
)

tester = client.beta.agents.create(
    name="Test Writer",
    model="claude-opus-4-7",
    system="You write and run pytest tests...",
    tools=[{"type": "agent_toolset_20260401"}],  # 全开
)

# 建 coordinator,声明能调上面两个
coordinator = client.beta.agents.create(
    name="Engineering Lead",
    model="claude-opus-4-7",
    system="You coordinate engineering work. Delegate code review to the "
           "reviewer agent and test writing to the test agent.",
    tools=[{"type": "agent_toolset_20260401"}],
    callable_agents=[
        {"type": "agent", "id": reviewer.id, "version": reviewer.version},
        {"type": "agent", "id": tester.id, "version": tester.version},
    ],
)
```

**注意**:
- **每个 callable agent 必须 pin 具体 version**——保证 coordinator 行为稳定,不因为 sub-agent 更新而漂移;
- **Sub-agent 和 coordinator 是独立资源**,各自有 CRUD 生命周期,archive 独立;
- **Callable agent 数量上限**:文档目前没给硬上限,但实际 3-5 个是合理范围,超过 10 个 coordinator 可能记不住谁擅长什么。

### 3.5 运行时的委派机制

Session 创建时只引用 **coordinator**:

```python
session = client.beta.sessions.create(
    agent=coordinator.id,
    environment_id=env.id,
)
```

Sub-agent 在运行时**按需**被 coordinator 唤醒——你不需要在 session 创建时显式声明。coordinator 决定什么时候调、调哪个、传什么任务。

**你发 user.message 给谁?**——给 **coordinator**(primary thread)。sub-agent 不直接接受 user.message,它们只接受 coordinator 的 thread 消息。

### 3.6 Thread 事件协议

标准 session 事件都还在。新增的事件和字段:

**Session-level 事件**(在 primary thread stream 上看到):

| 事件 | 含义 |
|---|---|
| `session.thread_created` | coordinator 派生了一个新 thread,带 `session_thread_id` 和 `model` |
| `session.thread_idle` | 某个 sub-thread 完成当前工作 |

**Agent-level 事件**(跨 thread):

| 事件 | 含义 |
|---|---|
| `agent.thread_message_sent` | 某 agent 向另一 thread 发了消息,带 `to_thread_id` 和 `content` |
| `agent.thread_message_received` | 某 agent 收到另一 thread 的消息,带 `from_thread_id` |

**Primary thread 看到什么?**

Primary thread stream (`/v1/sessions/:id/stream`)是**压缩视图**——你会看到 thread 级别的 lifecycle(create/idle)、thread 之间的消息交换,但**不会看到每个 sub-thread 内部的 tool_use 细节**。

想看某个 sub-thread 的完整 trace?用 thread-specific stream:

```python
threads = client.beta.sessions.threads.list(session.id)
for thread in threads:
    print(f"[{thread.agent_name}] {thread.status}")

# 流式消费特定 thread
with client.beta.sessions.threads.stream(
    thread_id, session_id=session.id
) as stream:
    for ev in stream:
        if ev.type == "agent.message":
            print(ev.content[0].text)
```

### 3.7 线程级 Tool 回应的路由

这是 multi-agent 最容易搞错的部分。

当 sub-thread 需要客户端回应(tool_confirmation 或 custom_tool_result)时,事件会**冒泡到 session 级 stream**,但带一个 `session_thread_id` 字段标明出处。**你的回应必须带同一个 `session_thread_id`,否则回错 thread**。

```typescript
for await (const ev of sessionStream) {
  if (ev.type === "session.status_idle"
      && ev.stop_reason.type === "requires_action") {
    for (const blockingId of ev.stop_reason.event_ids) {
      const blocking = eventsById.get(blockingId);

      if (blocking.type === "agent.custom_tool_use") {
        const result = await runHandler(blocking.name, blocking.input);

        // 关键:回 session_thread_id
        const reply: any = {
          type: "user.custom_tool_result",
          custom_tool_use_id: blocking.id,
          content: [{ type: "text", text: result }],
        };
        if (blocking.session_thread_id != null) {
          reply.session_thread_id = blocking.session_thread_id;
        }

        await client.beta.sessions.events.send(session.id, {
          events: [reply],
        });
      }
    }
  }
}
```

**路由规则**:

- `session_thread_id` **存在** → 事件来自 sub-thread → 回应必须带同样的 `session_thread_id`
- `session_thread_id` **不存在** → 事件来自 primary thread(coordinator)→ 回应不带 session_thread_id

**错误情景**:你回了 tool_confirmation 但没带 `session_thread_id`——服务端可能拒绝(因为找不到对应的等待点),或者路由到错误的 thread,造成那个 thread 收到意外消息,另一个 thread 死锁在等待。

### 3.8 适用场景

**Multi-agent 值得用的场景**:

- **任务可清晰拆解成子任务**,每个子任务用不同 prompt/工具;
  - ✅ Code review:reviewer(只读 + grep)+ writer(全工具)+ tester(跑测试)
  - ✅ Daily brief:fetcher(web)+ analyst(数据)+ writer(文稿)
  - ✅ Research:retriever(搜索)+ synthesizer(写报告)
- **并行加速**:多 agent 可同时跑(但你的客户端需要处理并发事件);
- **权限分层**:reviewer 只读、executor 可写;
- **不同 model**:coordinator 用 Opus,sub-agent 用 Haiku 省成本。

**不值得用的场景**:

- **任务内聚度高**:拆分反而损失 context;
- **延迟敏感**:多 agent 启动 + thread 消息往返增加延迟;
- **预算紧**:每个 thread 都有自己的 context overhead,累计 token 消耗大;
- **调试期**:单 agent 已经够你头疼了,multi-agent 的失败分析复杂度翻倍。

**经验法则**:**单 agent 能 80% 做好就不要引入 multi-agent**。只有当"提升质量"或"解锁能力"的收益明显大过"复杂度/成本/延迟"的代价时才用。

### 3.9 客户端集成要点

**1. Thread-aware event routing**

给你的 SessionDriver 加一层 thread 维度:

```typescript
class MultiAgentDriver extends SessionDriver {
  private threads = new Map<string, ThreadState>();

  async handleEvent(ev: any) {
    const threadId = ev.session_thread_id ?? "primary";
    const thread = this.threads.get(threadId) ?? this.createThreadState(threadId);

    switch (ev.type) {
      case "session.thread_created":
        this.threads.set(ev.session_thread_id, {
          agentName: ev.agent_name,
          status: "running",
          events: [],
        });
        break;
      case "session.thread_idle":
        thread.status = "idle";
        break;
      case "agent.thread_message_sent":
      case "agent.thread_message_received":
        // 跨 thread 通信,记录但不必 dispatch 给特定 thread UI
        this.logCrossThreadMessage(ev);
        break;
      default:
        thread.events.push(ev);
        thread.dispatch(ev);
    }
  }
}
```

**2. 决定 UI 呈现粒度**

- **简单 UI**:只看 primary thread stream,sub-thread 活动作为"agent X is working..."气泡展示;
- **详细 UI**:并排多个 thread 的 event 流,用户可以看到每个 agent 在做什么——debug 工具可以这么做,终端用户通常不需要。

**3. Tool 回应的 session_thread_id 路由**

见 §3.7 的代码模板。**这是 multi-agent 下最容易出事故的点**——把它抽成一个 helper 函数,不要在多处硬编码。

**4. 容量规划**

- Session 级限流还是 60 RPM + 5 并发 environment——和单 agent 一样;
- 但 **token 消耗随 thread 数增长**,每个 sub-thread 的 context 都单独算成本;
- **监控指标**:每个 session 的 active thread 数、thread 平均生命周期、跨 thread 消息数。

### 3.10 陷阱与注意事项

- **Thread 生命周期管理**:thread 是持久的——coordinator 可以在稍后再向同一个已经 idle 的 thread 发消息。不要假设 thread idle = 永远结束。
- **文件系统冲突**:多 agent 同时写同一文件没有锁保护。coordinator 应该明确分工("reviewer 只读,writer 只写 src/,tester 只写 tests/")。
- **Skills 共享限制**:session 级 skills 总数上限 20(跨所有 agent 共计),不是每个 agent 20。如果你的 coordinator + 3 sub-agents 各用 10 个 skill,总数 40 会被拒。
- **Cost attribution 困难**:`span.model_request_end.model_usage` 会在每个 thread 发,你要在客户端按 thread_id 分类累加才能知道哪个 agent 烧了多少——否则只能看到 session 总消耗。
- **Interrupt 行为**:发 `user.interrupt` 给 primary thread 会停 coordinator,但**不自动停 sub-threads**。sub-thread 会跑到自己的 safe boundary 才停——期间 coordinator 无法给它新任务,但事件继续发。
- **Callable_agents 的 version 锁定很重要**:coordinator 的行为对 sub-agent 版本敏感,sub-agent 更新后 coordinator 的 prompt 可能不再匹配——用 `{type, id, version}` 对象 pin,而不是字符串简写。

---

## 4. Memory:跨 session 记忆

> **2026/04 重大更新**:Memory 从 research preview 升级为**公开 beta**,同时架构发生了根本性重构——从"自动注入 6 个专用 `memory_*` tool"改为"挂载文件系统目录,让 agent 用标准 toolset 操作"。本节是按新设计写的,如果你看的是更早的 Memory 文档,以本节为准。

### 4.1 核心概念

默认情况下,session 结束 = 一切归零。Agent 学到的任何东西(用户偏好、项目规范、过往错误、领域知识)都随 session 一起被归档或删除。

**Memory store 是一个 workspace 级的文档仓库**,挂到 session 后,会作为**一个目录**出现在容器里(挂载点 `/mnt/memory/...`)。Agent 用日常的 `read` / `write` / `edit` / `glob` / `grep` / `bash` 工具操作这个目录,就像操作普通文件一样。下次同一个 store 挂到新 session,这些"文件"就还在。

核心特点:

- **Workspace 级作用域**:不绑定到特定 agent 或 session,可以被多个 session 共享;
- **以文件形式访问**:挂载到 `/mnt/memory/`,**用标准 agent toolset 读写**——不需要专用 memory API,也不需要 agent 学新工具;
- **Path 寻址**:每个 memory 在 store 里是一份带 path 的文档,API 这边可以直接通过 path 增删改查;
- **不可变版本链**:每次修改生成新 version(`memver_*`),旧 version 保留做审计、可回滚、可 redact。

> ⚠️ **必备前提:启用 agent toolset**。因为 agent 是用标准 file 工具访问 memory,所以 agent 必须启用 [`agent_toolset_20260401`](/docs/en/managed-agents/tools)(至少包含 `read` / `write` / `edit`,推荐全开)。**Agent 配置里没启用 toolset = memory 不能用**。

### 4.2 旧 vs 新:为什么这次架构重构很重要

简单对照表(给读过早期文档的人):

| 维度 | 研究预览(旧) | 公开 beta(新) |
|---|---|---|
| Agent 怎么访问 | 自动注入 6 个专用工具(`memory_list` / `memory_search` / `memory_read` / `memory_write` / `memory_edit` / `memory_delete`) | 挂载到 `/mnt/memory/` 下,agent 用标准 `read` / `write` / `edit` / `glob` / `grep` / `bash` |
| Agent 需要学新工具吗 | 是,6 个 | **不需要**——它早就会读写文件 |
| 事件流里看到什么 | `agent.tool_use(name="memory_*")` | `agent.tool_use(name="read"\|"write"\|"edit"\|...)`,只是 path 在 `/mnt/memory/` 下 |
| Beta header | `managed-agents-2026-04-01-research-preview` | `managed-agents-2026-04-01`(标准) |
| Resource attachment 字段 | `prompt`(指令) | `instructions`(同等含义,字段重命名) |
| Memory 的服务端 API | `memories.write`(upsert) | `memories.create`(不覆盖)+ `memories.update`(显式) |
| `not_exists` precondition | 有 | **移除**(`create` 自带"不覆盖"语义) |
| `content_sha256` precondition | 有 | **保留**(用于安全编辑) |

**为什么 Anthropic 做这次重构?** 我的解读:

1. **Claude 已经很会用文件系统**——再造 6 个 memory 专用工具,agent 多一份 schema 要学,而且 schema 之间还跟标准 tool 不一致;
2. **复用就是最好的扩展**——agent 已经天天 `read` / `write` 容器里的代码文件,把 memory 也变成"文件"它就**零学习成本**直接会用;
3. **客户端心智更简单**——观察 agent 在动 memory 不是看新事件类型,就是看路径前缀。

这是 CMA 元设计原则"复杂交互 = 既有原语编排,不是新协议"(P5)的极致体现。

### 4.3 早期客户的可量化收益

Anthropic 在 GA 时披露的真实部署数据(出自 [发布公告](https://claude.com/blog/claude-managed-agents-memory)):

- **Rakuten**:任务型长跑 agent 通过"持续学习",**首轮错误率下降 97%、成本下降 27%、延迟下降 34%**——结果落在 workspace 边界内可观测、可审计;
- **Wisedocs**:文档校验流程靠跨 session memory 识别反复出现的问题,**校验快 30%**,**完全不用自建 memory infra**;
- **Netflix**:agent 跨 session 保留"多轮挖出来的 insight + 人工修正",**不用反复手动更新 prompt 和 skill**;
- **Ando**(职场消息平台):捕捉组织级互动 pattern 而**不必自己造一套独立的 memory 系统**。

这组数字告诉我们一件事:**memory 的价值不在"模型变聪明",而在"省掉本来要发明轮子的工程"**——长跑 agent 不再需要自己实现"持久 KV + 召回机制"。

### 4.4 结构与组织

一个 memory store 里是很多 memory(类比:文件系统里的文件):

```
memstore_01Hx.../
  ├─ /preferences/formatting.md      ← 用户喜欢的代码风格
  ├─ /preferences/testing.md         ← 测试偏好
  ├─ /project/architecture.md        ← 项目架构概览
  ├─ /project/conventions.md         ← 命名/目录规范
  ├─ /domain/glossary.md             ← 业务术语表
  ├─ /lessons/2026-q1/migration.md   ← 过往经验
  └─ /lessons/2026-q1/perf-issue.md
```

挂到 session 后,这棵树会出现在容器里某个挂载点下(比如 `/mnt/memory/<store_name>/preferences/formatting.md`),agent 用 `glob` / `grep` / `read` 跟看普通项目代码一样浏览。

**关键约束**:

- **单 memory 上限 100 KB**(102,400 bytes,约 25K tokens)——强制你**分而治之**:小颗粒文件而不是大杂烩;
- **Path 是 memory 的主要 ID**——`memories.create(path=...)` 在已有 path 上**会失败**(不覆盖);要改用 `memories.update`;
- **Path 以 `/` 开头**(绝对路径风格)。

**组织原则**:

- **按主题分类,不按时间**:`/preferences/` vs `/lessons/`,不是 `/2026-01/` vs `/2026-02/`;
- **每个 memory 单一职责**:"用户的测试偏好"是一个 memory,不要把用户偏好、项目约定、领域知识全塞进 `/general.md`;
- **长 memory 拆成小 memory**:一个 5000 字的文档拆成 5 个 1000 字的主题文档,agent 可以按需只读取相关的几个;
- **前缀要可 grep**:`/preferences/` 下所有 memory 用同前缀,agent 用 `glob /mnt/memory/store/preferences/*.md` 一键扫到。

### 4.5 挂载到 Session

Memory store 不是 agent 级配置,而是 session 级 resource:

```python
session = client.beta.sessions.create(
    agent=agent.id,
    environment_id=env.id,
    resources=[
        {
            "type": "memory_store",
            "memory_store_id": memstore_id,
            "access": "read_write",        # 默认;或 "read_only"
            "instructions": "User preferences and project context. Check before starting any task.",
        },
    ],
)
```

**字段详解**:

- `memory_store_id`:引用 store 的 ID(`memstore_*`);
- `access`:访问级别——`read_write`(agent 可读可写,**默认**)或 `read_only`(agent 只读);
- `instructions`:session-specific 指令,最多 **4,096 字符**。会和 store 的 `name` / `description` 一起被自动加进系统 prompt——agent 看到挂载点 + 描述 + 指令,自己决定什么时候去查。

**关键限制**:

- **单 session 最多 8 个 memory store**;
- **只能在 `sessions.create` 时挂载**——session 跑起来之后**不能动态加/减** memory store;要换 store 只能起新 session;
- 仅当 agent 启用了 agent toolset 时,memory 才能被 agent 看到使用。

如果一个 session 挂了多个 store,典型结构:

- 1 个 **read-only 共享知识库**(项目架构、业务规范、领域术语)——多个 session 共用;
- 1 个 **read-write 用户/团队 store**(偏好、学到的教训)——per-user 或 per-team;
- 0-N 个 **特定上下文 store**(当前 sprint 的 context 等)。

### 4.6 Access 模式与 prompt-injection 风险

`read_write` vs `read_only` 不只是"权限"问题——**它是 prompt-injection 防御的关键**。

> ⚠️ **官方安全警告**:read_write 是默认值。如果 agent 处理不可信输入(用户提交的 prompt、抓取的网页内容、第三方 tool 输出),一次 prompt injection 就可能往 store 里写**恶意内容**——后续 session 读这个 store 时会**把恶意内容当成可信记忆**,形成跨 session 持久化的攻击。**对参考资料、共享查找表、或任何 agent 不需要修改的 store,用 `read_only`**。

具体选型:

**read_only** 用于:

- **共享参考资料**:官方 API 文档、公司内部规范、业务术语表——不希望 agent 改写;
- **审计要求严格的 store**:所有改动走人工审批;
- **Agent 处理不可信输入的场景**:抓 web、读用户上传文件、跑 MCP 调外部服务——这种 agent 接 read_write store 等于给 attacker 一条持久化通道。

**read_write** 用于:

- **个人偏好 store**:agent 可以自动记录"用户更喜欢 arrow function"之类;
- **经验积累 store**:agent 跑完任务,自动把"这次踩了什么坑"写进 `/lessons/`;
- **动态工作区**:需要跨 session 维护的状态(比如 TODO、进行中的任务);
- **前提**:agent 处理的输入是受信的(自己的内部任务流、可控的 user message)。

**组合模式**——高信任 + 低风险:给同一个 session 挂两个 store,一个 read-only 一个 read-write:

```python
resources=[
    {"type": "memory_store", "memory_store_id": company_docs.id, "access": "read_only"},
    {"type": "memory_store", "memory_store_id": user_notes.id,   "access": "read_write"},
]
```

Agent 从 company_docs 读权威知识,但只能改 user_notes——好比把"教科书"和"笔记本"分开。

### 4.7 Agent 的访问机制:文件系统挂载

挂上 memory store 后,session 容器里**多出一个目录**:

```
/mnt/memory/<store_handle>/
  ├─ preferences/
  │   ├─ formatting.md
  │   └─ testing.md
  ├─ project/
  │   ├─ architecture.md
  │   └─ conventions.md
  └─ lessons/
      └─ 2026-q1/
          ├─ migration.md
          └─ perf-issue.md
```

CMA harness 会**自动在系统 prompt 里加一段挂载说明**——挂载点路径、access 模式、store 的 `description`、attachment 时给的 `instructions`,都会让 agent 看到。Agent 读到这段,就知道有这么个目录、装的是什么、什么时候该去看。

**Access 在文件系统层面强制**:

- `read_only` 挂载点上的 `write` / `edit` 调用会**直接失败**(EROFS-like 错误)——agent 看到 tool error,自己调整;
- `read_write` 挂载点上的 `write` / `edit` 成功后,改动**异步同步回 store**,产生新的 memory version,记 session 归属。

**事件流里的样子**:agent 调 memory 完全没有"特殊事件"——只是普通的 `agent.tool_use(name="read"|"write"|"edit"|"glob"|"grep"|"bash")`,只不过 input 里的 path 落在 `/mnt/memory/` 下。客户端要识别"这是在动 memory",**靠路径前缀**。

```typescript
function isMemoryToolUse(ev: any): boolean {
  if (ev.type !== "agent.tool_use") return false;
  const path = extractPath(ev);  // 从 input 里抽 file path
  return path?.startsWith("/mnt/memory/") ?? false;
}
```

**行为模式**:

- **Session 开始时**:agent 通常会先 `glob /mnt/memory/<store>/**/*.md` 或 `read` 挂载点说的"先看 X"指定的文件;
- **做任务中**:根据需要 `read` 具体 memory 补充 context、`grep` 搜关键字;
- **Session 接近完成**:如果 store 是 read_write,agent 可能 `write` 一份新经验、或 `edit` 更新现有 memory。

**Agent 的 memory 使用不是 100% 可预测的**——是否读、读哪些、写什么,取决于 agent 当前任务的相关性判断。这也是为什么 store 的 `description` 和 attachment 的 `instructions` 很重要:**告诉 agent 这个 store 装什么、什么时候该查**,它才会在合适时机去用。

### 4.8 客户端的主动管理

除了 agent 自动用,客户端也能直接通过 API 管理 memory(seed、review、合规清理等)。**注意 API 形态在公开 beta 中已经不是"upsert write"——`create` 和 `update` 是分开的**。

**List**(返回 memory 元数据,可树形浏览):

```python
page = client.beta.memory_stores.memories.list(
    store.id,
    path_prefix="/preferences/",   # 字符串前缀匹配,带尾斜杠 = 目录范围
    order_by="path",                # 排序字段
    order="asc",                    # asc / desc
    depth=2,                        # 浏览树状结构,只展开两层
    view="basic",                   # basic 只返回 metadata;full 包含 content
)
for item in page.data:
    if item.type == "memory":
        print(item.path, item.content_size_bytes, item.content_sha256)
    elif item.type == "memory_prefix":
        print(f"[dir] {item.path}")
```

**关键点**:

- **List 返回的不是单一类型,而是 `Memory | MemoryPrefix` 的联合**。`MemoryPrefix` 只有 `type` 和 `path` 两个字段——它代表"这个前缀下还有更深的路径,但因为 `depth` 限制没展开"。客户端要 `if item.type == "memory"` 才能拿 `path` / `content_size_bytes` / `content_sha256` 等字段。**如果业务代码假设所有 item 都是 memory,接到 prefix 会炸**。
- **`view`**:默认 `basic` 只返回 metadata,**不返回 content**。要拿 content 用 `view="full"`——但要小心 list with `view=full` 会把每个 memory 的 content 都拉回来,大 store 上很贵。一般做法是 `list(view="basic")` 拿到要的 id,再单个 `retrieve(view="full")`。
- **`path_prefix` 是 raw 字符串前缀**——不是 glob,不是正则。要匹配目录范围记得带尾斜杠(比如 `/preferences/`)。该值会出现在请求 URL 里,**不要在 path 里塞 secret 或 PII**。
- **分页**:返回 `SyncPageCursor`,可以 `for item in page` 自动翻页,或手动用 `limit` + `page`(cursor token)。

**Retrieve**(返回单个 memory 的完整数据):

```python
mem = client.beta.memory_stores.memories.retrieve(
    mem_id,
    memory_store_id=store.id,
    view="full",                # retrieve 默认就给 content,显式 full 更稳妥
)
print(mem.content)              # 文本内容
print(mem.content_sha256)       # 后面 update 用得上
print(mem.content_size_bytes)   # 字节数
print(mem.memory_version_id)    # 当前 head 版本的 id —— 想 audit 时跳过 list 直接拉它
```

`memory_version_id` 这个字段挺有用——它就是"当前活的版本"的 id,用 `memory_versions.retrieve` 可以直接拉,不必先 list 历史。

**Create**(在指定 path 创建,**已存在则 409**):

```python
mem = client.beta.memory_stores.memories.create(
    store.id,
    path="/preferences/formatting.md",
    content="Always use 2-space indentation.",   # content 是可选的!
)
```

**`content` 在 create 时是 `Optional[str]`**——可以**先 create 一个空 path**,稍后让 agent 或客户端 update 填内容。这对"先把目录结构占好"很有用。

> 旧版 `memories.write`(upsert)在公开 beta 已不存在。要改既有 memory 用 `update`,要追加新的用 `create`。如果你不在乎"已存在 path"这件事,先 `try create except 409 → fallback update`(409 在 SDK 里类型化为 `BetaManagedAgentsMemoryPathConflictError`,带 `conflicting_memory_id` 字段直接告诉你冲突的那个 memory 的 id,省掉一次 list)。

**Update**(按 `mem_*` ID,可改 content、path,或两者都改):

```python
# 改 content
client.beta.memory_stores.memories.update(
    mem.id,
    memory_store_id=store.id,
    content="CORRECTED: Always use tabs.",
)

# 改 path(等于重命名)
client.beta.memory_stores.memories.update(
    mem.id,
    memory_store_id=store.id,
    path="/archive/2026_q1_formatting.md",
)
```

**Delete**(支持安全删除 precondition):

```python
# 基本删除
client.beta.memory_stores.memories.delete(
    mem.id,
    memory_store_id=store.id,
)

# 安全删除:只在 content 没被改过的情况下才删
client.beta.memory_stores.memories.delete(
    mem.id,
    memory_store_id=store.id,
    expected_content_sha256=mem.content_sha256,   # sha 不匹配就 409
)
```

`expected_content_sha256` 让你避免"我以为要删的还是当时看到的那条,但实际它已被别人改过"的并发问题。审计/合规清理脚本应该总是带上它。

**典型客户端用途**:

- **初始化 seed**:新项目建 store 时,先 seed 一批管理员准备好的内容(公司规范、架构文档);
- **Review 工作流**:定期列出 agent 写入的 memory,人工 review 后保留或删除;
- **导入导出**:从外部知识库(Confluence、Notion)同步进 memory store;
- **合规清理**:按 `path_prefix` 批量 redact 或 delete 特定类型内容。

### 4.9 并发安全:`content_sha256` precondition

多个 session 同时挂同一个 read_write store 时,写冲突可能发生。CMA 提供**乐观并发**机制——但**只有一种 precondition**了(旧的 `not_exists` 已被 `create` 不覆盖语义吸收):

```python
# 1. 先 retrieve,记下 content_sha256
mem = client.beta.memory_stores.memories.retrieve(mem_id, memory_store_id=store.id)
original_sha = mem.content_sha256

# 2. 本地修改
new_content = mem.content + "\nAlso: prefer const over let."

# 3. Update,带原 sha 做检查
client.beta.memory_stores.memories.update(
    mem_id,
    memory_store_id=store.id,
    content=new_content,
    precondition={"type": "content_sha256", "content_sha256": original_sha},
)
```

如果 store 里 memory 在你读取之后被别人改过(sha 不匹配),update 返回 **409 memory_precondition_failed**。catch 后重新 read + merge + write,避免 lost update。

**什么时候用 precondition**:

- 客户端批量写入时——always 用,防止并发客户端踩;
- Agent 自动写入时——CMA harness 内部已经处理,你不需要管;
- 单客户端 single-writer 模式——可选不用。

**防覆盖的另一条路**:用 `memories.create`。`create` 在 path 已存在时直接 409,不需要 precondition——这就是旧版 `not_exists` 的替代品。Seed 初始化时建议用 `create`,要 idempotent 的话 catch 409 跳过。

### 4.10 版本化与审计

每次 memory 修改产生一个不可变 version(`memver_*`):

- `memories.create` 新 path → version with `operation: "created"`;
- `memories.update` 改 content 或 path → version with `operation: "modified"`;
- `memories.delete` → version with `operation: "deleted"`。

**关键语义**:

- **Versions 属于 store,不属于 memory**——单个 memory 被 delete 后,它的历史 versions **仍然在 store 里**,审计链不断;
- **保留期 30 天**——超过 30 天的 version 可能被清理;但**最新版永远保留**(即使它已经超过 30 天没动过),所以低频改动的 memory 可以保有久远的历史;
- **要长期保留历史**:通过 API 主动 export(把每个 version 的 content 抓下来存外部存储)。

**查看 version 历史**(支持丰富的审计过滤):

```python
versions = client.beta.memory_stores.memory_versions.list(
    store.id,
    # 全部可选,可任意组合
    memory_id=mem.id,                  # 单个 memory 的历史
    session_id="sesn_01...",           # 这个 session 改过哪些 memory
    api_key_id="apk_01...",            # 这个 API key 改过哪些
    operation="modified",              # created / modified / deleted
    created_at_gte="2026-04-01T00:00:00Z",   # 时间窗
    created_at_lte="2026-04-30T23:59:59Z",
    view="basic",                      # basic 不带 content; full 带
)
for v in versions:
    actor = v.created_by   # ← 注意是 created_by,不是 actor
    print(f"{v.id} | {v.operation} | {actor.type} | {v.created_at}")
```

**Actor 是个 tagged union——能区分写入来源**:

```python
match v.created_by:
    case None:
        source = "(unknown)"
    case obj if obj.type == "session_actor":
        source = f"agent (session {obj.session_id})"      # 是 agent 在 session 里写的
    case obj if obj.type == "api_actor":
        source = f"api key {obj.api_key_id}"               # 是脚本/服务直接调 API 写的
    case obj if obj.type == "user_actor":
        source = f"console user {obj.user_id}"             # 是控制台里人手动改的
```

这三种 actor 类型在合规审计时极其有用——一份 memory 是"agent 自动学的"还是"管理员手动写的"还是"自动化脚本同步的",**直接从 audit 链上读出来**,不用业务层再做归属判断。

`redacted_by` 是同样的联合(redact 操作的来源),`redacted_at` 是 redact 时间——已 redact 的 version 这两个字段会有值,content 字段会为 null。

**读取某个 version 的完整 content**:

```python
v = client.beta.memory_stores.memory_versions.retrieve(
    version_id,
    memory_store_id=store.id,
    view="full",   # 默认是 full,但显式写更清楚
)
print(v.content)
print(v.path)              # version 也带 path —— 因为 update 可能改了 path
print(v.content_sha256)    # 这个版本的内容哈希
```

**回滚**(没有专门的 restore endpoint):

要回到某个 version,**手动**把它的 content 写回去——

```python
# 1. 拿到目标版本的 content
target = client.beta.memory_stores.memory_versions.retrieve(
    version_id, memory_store_id=store.id,
)

# 2. 写回(如果 memory 还存在)
client.beta.memory_stores.memories.update(
    mem_id,
    memory_store_id=store.id,
    content=target.content,
)

# 或者:如果 memory 已被 delete,改用 create
client.beta.memory_stores.memories.create(
    store.id,
    path=target.path,
    content=target.content,
)
```

**Redact**(合规用):

```python
client.beta.memory_stores.memory_versions.redact(
    version_id,
    memory_store_id=store.id,
)
```

Redact 清空 content/path,但保留审计 metadata(谁做的、什么时候做的)。用于:

- 用户删除请求(GDPR/CCPA);
- 泄露清理(发现某个 memory 不小心塞了 API key);
- 法规合规(过期数据要移除内容但保留审计链)。

> ⚠️ **Redact 限制**:**当前是 head 版本(live memory 的最新版)的 version 不能 redact**。要先 `update` 写一个新版本(让原来的版本变成"非 head"),或先 `delete` 这个 memory(让 head 不再指向),才能 redact 那个老版本。这是为了保证"现在 agent 看到的内容"和"audit log 里的内容"不会出现非预期的不一致。

### 4.11 Store 级管理

| 操作 | API | 说明 |
|---|---|---|
| Create | `client.beta.memory_stores.create(name=..., description=..., metadata=...)` | `description` 会被传给 agent,告诉 agent store 装的是什么;`metadata` 是 dict[str,str],最多 16 keys、key ≤64 字符、value ≤512 字符 |
| Retrieve | `client.beta.memory_stores.retrieve(id)` | 元数据 |
| Update | `client.beta.memory_stores.update(id, name=..., description=..., metadata=...)` | 改 name / description / metadata —— 见下方 metadata patch 语义 |
| List | `client.beta.memory_stores.list(include_archived=False, created_at_gte=..., created_at_lte=...)` | 默认排除 archived;支持时间窗过滤 |
| Archive | `client.beta.memory_stores.archive(id)` | **单向**——archived store 不能挂新 session(已挂的 session 继续可用),无 unarchive |
| Delete | `client.beta.memory_stores.delete(id)` | 永久删,带所有 memory + version |

**`metadata` patch 语义**:`update` 时传 `metadata={...}` **不是整体替换,而是 key-level merge**——

- 设 key 为字符串 → upsert 这个 key;
- 设 key 为 `None` → **删除**这个 key;
- 不传某个 key → 保留原值。

```python
# 只想加一个 key,保留其他
client.beta.memory_stores.update(
    store.id,
    metadata={"owner": "team-finance"},   # 加 owner;其他 key 不动
)

# 想删一个 key
client.beta.memory_stores.update(
    store.id,
    metadata={"deprecated_flag": None},   # null = 删除
)
```

> 生产建议:**先 archive,观察一段时间,确认无依赖再 delete**。Archive 等于"软删除"——读还能读,只是新 session 用不上了——给你一个反悔的窗口。

### 4.12 限额(公开 beta 起明确披露)

| 维度 | 上限 |
|---|---|
| Memory stores per organization | 1,000 |
| Memories per store | 2,000 |
| Total storage per store | 100 MB(104,857,600 bytes) |
| Versions per store | 250,000 |
| Size per memory | 100 kB(102,400 bytes) |
| Version history retention | 30 天(最新版永远保留) |
| Memory stores per session | 8 |
| `instructions` field per attachment | 4,096 字符 |

需要更高限额联系 [Anthropic 支持](https://support.claude.com/)。

**容量规划提示**:

- 一个**用户级 store** 假设 1,000 条 memory × 平均 2KB = 2MB,远低于 100MB 限制——一个组织 1,000 store 能服务 1,000 个用户绰绰有余;
- 一个**团队级共享 store** 假设 50 个高频文档 + 200 条经验,也远低于上限;
- **要小心的是 versions 增长**——如果 agent 频繁覆写一个文件,250,000 versions / store 在几个月内可能撞到。监控 `memory_versions.list` 的总数,定期 redact 旧的或 archive 整个 store。

### 4.13 适用场景

**Memory 值得用的场景**:

- **长期迭代项目**:agent 要在几周/几月跨度里帮同一批人做事,积累项目知识;
- **用户偏好学习**:个人化助手,要记住用户习惯;
- **团队/公司级规范**:共享的最佳实践、架构约定;
- **经验库**:过往任务里学到的教训("这个 API 有 rate limit""这个库的 bug 要绕");
- **跨 session 校正传递**:把人工纠正过的认知保留下来,避免下次重复犯错(Netflix 的经典用法);
- **降低首轮错误**:让 agent 第一次跑一个任务时,有过去类似任务的经验做参考(Rakuten 报告的 97% 改善)。

**Memory 不值得用的场景**:

- **一次性任务**:跑完就完,不需要跨 session;
- **短生命周期任务**:session 内就够用,不需要跨 session;
- **高敏感数据**:memory 是文本,任何能 list 这个 store 的 workspace 成员都能读——**不要塞 API key、密码、PII 原文**;
- **结构化数据查询**:要查询的是 DB/KV 里的数据,memory 是自然语言文档——用 custom tool 查数据库更合适;
- **快速变化的事实**:汇率、库存、实时价格不要塞 memory(会 stale)——这些走 MCP / custom tool 实时拉。

### 4.14 客户端集成要点

**1. Memory store 生命周期(setup 一次性)**

```python
import anthropic
from anthropic import APIStatusError

# 创建
store = client.beta.memory_stores.create(
    name="Team Coding Preferences",
    description=(
        "Per-user coding preferences and project context. "
        "Check before starting any coding task. "
        "Conventions: /preferences/, /project/, /lessons/"
    ),
    metadata={"team": "finance", "env": "prod"},   # 自定义标签
)

# 可选:seed 初始内容(用 create,已存在 path 直接 409,天然 idempotent)
try:
    client.beta.memory_stores.memories.create(
        store.id,
        path="/team/stack.md",
        content="We use Python 3.11, FastAPI, Postgres 16.",
    )
except APIStatusError as e:
    if e.status_code != 409:
        raise
    # 409 = path conflict,已存在,seed 跳过即可

# 存 store.id 到 config / secrets / env
```

**2. Agent 监控:识别 memory 操作**

新架构下,memory 操作就是普通 file 工具调用,客户端**靠路径前缀**识别:

```typescript
const MEMORY_MOUNT_PREFIX = "/mnt/memory/";

for await (const ev of stream) {
  if (ev.type === "agent.tool_use") {
    const path = extractFilePath(ev.input);  // 看 tool_name 抽 path
    if (path?.startsWith(MEMORY_MOUNT_PREFIX)) {
      telemetry.recordMemoryUsage({
        sessionId,
        op: ev.tool_use.name,        // "read" / "write" / "edit" / "glob" / "grep"
        path,
        timestamp: ev.processed_at,
      });
    }
  }
}
```

这让你能知道:哪些 memory 被读得多(说明有价值)、哪些从不被读(可以清理)、agent 写了什么新 memory(决定是否人工 review)。

**3. Seed / Import 工作流**

把外部知识导进 memory store 的典型流程。注意公开 beta 把 path conflict 类型化了——`BetaManagedAgentsMemoryPathConflictError` 直接带回 `conflicting_memory_id`,所以"覆盖"不需要先 list 找 id:

```python
from pathlib import Path
from anthropic import APIStatusError

def seed_from_docs(store_id: str, docs_dir: Path, overwrite: bool = False):
    for md_file in docs_dir.rglob("*.md"):
        rel_path = md_file.relative_to(docs_dir)
        content = md_file.read_text()
        if len(content.encode()) > 102_400:
            raise ValueError(f"{md_file} exceeds 100 KB limit")
        try:
            client.beta.memory_stores.memories.create(
                store_id,
                path=f"/{rel_path}",
                content=content,
            )
        except APIStatusError as e:
            if e.status_code != 409:
                raise
            if not overwrite:
                continue   # 选项 A: 跳过(idempotent seed)
            # 选项 B: 强制覆盖 —— 从错误体里直接拿到冲突的 memory id
            body = e.response.json()  # SDK 有时会自动 parse 到 e.body
            conflicting_id = body.get("error", {}).get("conflicting_memory_id")
            if not conflicting_id:
                # 兜底:按 path 找
                page = client.beta.memory_stores.memories.list(
                    store_id, path_prefix=f"/{rel_path}", view="basic",
                )
                hit = next((m for m in page.data
                            if m.type == "memory" and m.path == f"/{rel_path}"), None)
                if not hit:
                    continue
                conflicting_id = hit.id
            client.beta.memory_stores.memories.update(
                conflicting_id,
                memory_store_id=store_id,
                content=content,
            )
```

注意几处 SDK 细节:

- 100 KB 上限严格按字节算(`len(content.encode())`),不是字符数;
- list 时 `view="basic"` 只拿 metadata,不传 content,大 store 上能省巨量带宽;
- 处理 list 结果时记得 `if m.type == "memory"`——`MemoryPrefix` 没有 `path` 之外的字段。

**4. 审计 UI**

生产级 memory store 应该有一个管理 UI,让 admin:

- List 最近修改的 memory(按 updated_at 降序);
- 查看某个 memory 的 version 历史;
- Redact 敏感内容(注意 head 版本要先 update / delete 才能 redact);
- 批量 archive / delete 过期类别。

### 4.15 陷阱与注意事项

- **忘了启用 agent toolset**:agent 看不到挂载点的工具,memory 完全用不上。Setup 阶段 `tools=[{"type": "agent_toolset_20260401"}]` 是前提。
- **`prompt` vs `instructions` 用错字段**:旧版字段名是 `prompt`,公开 beta 改成 `instructions`。SDK 旧版本可能还接受 `prompt`,但要按新字段写。
- **`memories.create` 期望"upsert"行为**:旧 `write` 是 upsert,新 `create` 不是。"path 已存在 = 409"会让旧代码炸——迁移时要在 catch 里加 fallback `update`。
- **100 KB 上限触发的分裂**:memory 增长接近 100 KB 时,客户端要主动拆分,或者在 agent instructions 里约束"每个 memory 只记一件事"。
- **过多 memory 影响性能**:agent 会 `glob` 挂载点决定读哪些。store 里 10,000 个 memory 时,glob 结果本身就占 context。保持 store 规模合理(几百到 2,000 上限以内)。
- **命名不规范后期难治理**:agent 乱写 path 后梳理成本高。在 store `description` 和 attachment `instructions` 里明确路径规范:"When writing memory, use paths like `/lessons/{topic}/{title}.md`"。
- **并发写入 race**:多 session 同时挂同一个 read_write store,agent 并行写同一 path 会互相覆盖。要么用 precondition,要么让不同 session 写不同 path 前缀(`/session-{id}/...` 或 `/user-{uid}/...`)。
- **Redact 不可 undo**:一旦 redact,content 永久丢失。审慎使用,配合人工审核。
- **Head version 不能 redact**:要先 `update` 让它变成历史版,或 `delete` 让 memory 不再指向它。
- **Memory store 的 archive/delete**:store 级别的删除是单向的。要考虑"先 archive 观察 → 确认无依赖 → 再 delete"的流程。
- **Prompt-injection 攻击面**:接不可信输入的 agent 不要挂 read_write store——见 §4.6 的安全警告。

### 4.16 SDK 速查:关键类型与易错字段名

把 Python SDK 上几个客户端代码必碰的细节集中在这里——大多数实现 bug 都来自把字段名记错。

**`Memory` 对象**(`BetaManagedAgentsMemory`):

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `str` | `mem_*` |
| `type` | `Literal["memory"]` | 用于和 `MemoryPrefix` 联合的辨识 |
| `path` | `str` | 绝对路径,以 `/` 开头 |
| `content` | `Optional[str]` | **只在 `view="full"` 时有值**,否则为 None |
| `content_sha256` | `str` | 内容哈希,做 precondition 用 |
| `content_size_bytes` | `int` | **不是 `size_bytes`**,字段名带 `content_` 前缀 |
| `memory_store_id` | `str` | 反向引用 |
| `memory_version_id` | `str` | 当前 head 版本的 id —— 直接拉 version 用 |
| `created_at` / `updated_at` | `datetime` | RFC 3339 |

**`MemoryPrefix` 对象**(`BetaManagedAgentsMemoryPrefix`):

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `Literal["memory_prefix"]` | |
| `path` | `str` | 前缀路径(代表"这底下还有更深的项,因为 depth 限制没展开") |

`memories.list` 返回 `Memory | MemoryPrefix` 联合——**消费方必须先 type narrow**。

**`MemoryVersion` 对象**(`BetaManagedAgentsMemoryVersion`):

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `str` | `memver_*` |
| `memory_id` / `memory_store_id` | `str` | 反向引用 |
| `operation` | `Literal["created", "modified", "deleted"]` | |
| `content` | `Optional[str]` | view="full" 时有值;**redacted 之后永远为 None** |
| `content_sha256` / `content_size_bytes` | `Optional[...]` | redacted 之后为 None |
| `path` | `Optional[str]` | redacted 之后为 None |
| `created_by` | `Optional[Actor]` | **不是 `actor`** |
| `created_at` | `datetime` | |
| `redacted_by` | `Optional[Actor]` | redact 操作的来源,未 redact 则为 None |
| `redacted_at` | `Optional[datetime]` | 同上 |

**`Actor` 联合类型**(`BetaManagedAgentsActor`):

```python
# tagged union,根据 .type 分流
SessionActor:  type="session_actor", session_id="sesn_..."  # agent 在 session 里写的
APIActor:      type="api_actor",     api_key_id="apk_..."   # 直接调 API 写的
UserActor:     type="user_actor",    user_id="user_..."     # console 里人手写的
```

**典型错误名速查**(我自己写代码时踩过):

| 错的 | 对的 |
|---|---|
| `mem.size_bytes` | `mem.content_size_bytes` |
| `version.actor` | `version.created_by`(或 `version.redacted_by`) |
| `prompt:` (resource attachment) | `instructions:` |
| `client.beta.memory_stores.memories.write(...)` | `create()` 或 `update()`,看语义 |
| `precondition: {type: "not_exists"}` | 改用 `create()`(已存在自动 409) |

**错误类型**(SDK 端类型化的两个 conflict 情况):

- `BetaManagedAgentsMemoryPathConflictError`:create 时 path 已存在。带 `conflicting_memory_id` 和 `conflicting_path`,直接告诉你冲突的那个 memory 的 id;
- `BetaManagedAgentsMemoryPreconditionFailedError`:update / delete 时 `content_sha256` 或 `expected_content_sha256` 不匹配。重读 + 重试。

两者 HTTP 都是 409,在 Python SDK 里都被映射成 `APIStatusError`,通过 `e.response.json()` 拿 typed error body。

---

## 5. 组合使用:三者的协同

三个高阶特性是**正交**的——可以独立使用,也可以组合。组合后的产品形态能力更强但复杂度也更高。

### 5.1 Outcome + Memory

**场景**:DCF 分析 agent。每次跑一个公司的 DCF 都用 outcome(有明确 rubric),同时挂 memory store 存"上次针对这个公司/这个行业学到的建模经验"。

**协同**:

- Agent session 开始时 `read /mnt/memory/finance/companies/{ticker}.md` 看过往经验;
- 跑 outcome 流程,grader 按 rubric 评估;
- Satisfied 后 agent `write /mnt/memory/finance/companies/{ticker}.md` 记录这次的发现;
- 下次同公司或同行业的 DCF 直接受益。

**注意 beta header 不一样**:Memory 用 `managed-agents-2026-04-01`(标准),Outcomes 还在 research preview。同一个 session 同时启用两者时,要带上 `managed-agents-2026-04-01-research-preview` header(它是标准 header 的超集)。

**获得的能力**:短期工作精度(outcome)+ 长期知识累积(memory)。

### 5.2 Multi-agent + Memory

**场景**:多 agent code review 团队。reviewer、tester、security analyst 三个 agent 分工协作。

**协同**:

- Memory store 挂到 session 级别,三个 agent(coordinator + 各 sub-agent thread)**都能通过共享文件系统**访问 `/mnt/memory/<store>/...`;
- Security analyst 发现一个安全 pattern,`write /mnt/memory/<store>/patterns/auth.md`;
- 下次 reviewer 看到类似代码,`grep -r auth /mnt/memory/<store>/patterns/` 能找到 security analyst 留下的建议;
- Agent 之间通过 memory 异步传递知识,不需要在同一个 session 里显式沟通。

**关键配置**:

```python
session = client.beta.sessions.create(
    agent=coordinator.id,
    environment_id=env.id,
    resources=[
        {"type": "github_repository", "url": repo_url, "authorization_token": pat},
        {"type": "memory_store", "memory_store_id": team_memory.id, "access": "read_write"},
    ],
)
```

所有 sub-thread 自动继承 memory store 访问权(共享 session resource)。

### 5.3 三合一:自主研究员

**场景**:一个长期运行的"研究员" agent,每天接一个新的研究主题。

**配置**:
- **Outcome**:每次研究有明确 rubric——覆盖 N 个来源、对比 M 个观点、给出结论;
- **Multi-agent**:retriever(web 搜索)、reader(深读长文)、synthesizer(写综述);
- **Memory**:跨天积累——`/topics/ai-safety/`、`/sources/known-reliable/`、`/lessons/search-tricks/`。

**一天的流程**:

1. 客户端建 session,挂 memory store,agent=coordinator(研究员);
2. 发 `user.define_outcome(description="Review latest papers on X", rubric=...)`;
3. Coordinator 查 memory 看之前研究过的相关话题;
4. 派 retriever 去搜索(sub-thread);
5. Retriever 返回链接列表,coordinator 派 reader 去深读(新 sub-thread);
6. Reader 返回摘要;coordinator 派 synthesizer 写报告;
7. Grader 评估,如果缺什么继续迭代;
8. Satisfied 后,coordinator 让各 agent 写 memory 更新学到的东西;
9. Session archive,明天继续。

这是 CMA 能力的上限展示——**一个真正能学习、能自主、能达成目标的 agent 产品**。

### 5.4 组合使用的边界

不是所有组合都有意义:

- **Outcome + Multi-agent 并发限制**:outcome 里每轮 iteration 都要跑 sub-thread,成本加倍。如果 max_iterations=5,multi-agent 的每个 sub-thread 都会被重跑 5 次——预算爆炸;
- **Memory + 频繁迭代**:agent 每轮 iteration 都可能读写 memory,如果迭代多就有大量 memory 版本,清理负担重;
- **三者全用 + prod**:调试难度 × 复杂度 × 成本三者相乘。建议分阶段上线——先单项,稳定后再加组合。

---

## 6. 设计哲学观察

这三个特性放在一起看,能更清楚地看出 CMA 的"meta-harness"设计思想。

### 6.1 共性:事件流注入,不改核心

三个特性都通过**新增 event 类型 + 新增配置字段**接入,没有一个改变底层:

- Outcomes:新 event `user.define_outcome`、`span.outcome_evaluation_*`;
- Multi-agent:新 event `session.thread_*`、`agent.thread_message_*` + 新字段 `callable_agents`、`session_thread_id`;
- Memory:新 resource type `memory_store` —— **甚至连新 event / 新 tool 都没有**,挂上就是 `/mnt/memory/` 下多个目录,agent 用既有 file 工具访问。

**没有一个需要新 API namespace**——都是在现有 `sessions.events.*`、`agents.*`、`resources` 基础上扩展。这让升级路径清晰:

- 不用高阶特性的客户端完全不受影响;
- 用了的客户端只需要处理新事件类型(Outcomes / Multi-agent)或新路径前缀(Memory)——标准 idle-break gate 等逻辑不需要改。

> 三者中 Memory 的设计最 minimal——它走完了 research preview 阶段后被**反向简化**:从"6 个新 tool + 新事件"瘦身到"复用 file toolset + 复用 `agent.tool_use` 事件"。这是 P5 原则的演进示范:**等真实流量数据回来后,你会发现某些"必须的"协议层抽象其实可以拆掉**。

### 6.2 共性:把策略藏在独立 context 后面

- Outcomes 的 **grader 在独立 context 跑**——核心 agent loop 不知道 grader 长什么样;
- Multi-agent 的 **sub-thread 是独立 context**——coordinator 和 sub-agent 互相隔离;
- Memory 的 **外部 store 独立于 agent context**——agent 用工具访问,不是把 memory 常驻在 context 里。

这是同一个模式的三次实践:**需要让某件事独立演进时,把它隔到独立 context/存储/进程里,只通过明确接口通信**。未来 Anthropic 换 grader 算法、换 thread 调度策略、换 memory 存储引擎——客户端都不需要改。

### 6.3 共性:明确的终止条件

三者都明确回答了"什么时候停":

- Outcome:`satisfied` / `max_iterations_reached` / `failed` / `interrupted`;
- Multi-agent:primary thread 的 idle + 所有 sub-thread 的 idle;
- Memory:同步接口(立即返回)+ 异步 agent 自主使用(跟 session idle)。

这避免了 harness 开放式特性常见的"跑飞"问题。每个高阶特性都带边界。

### 6.4 共性:客户端的 opt-in

三者都是**opt-in 特性**——不主动启用就和标准 loop 一样:

- 不发 `user.define_outcome` → 就是标准对话;
- Agent config 不声明 `callable_agents` → 就是单 agent;
- Session 不挂 memory store → agent 没有 memory 工具。

这符合 CMA 的元原则:**默认极简,需要什么显式启用**。不让未使用的特性污染行为。

### 6.5 对客户端工程师的启示

如果你在设计自己产品内部的扩展机制(比如 agent 框架、工作流引擎),这三个特性提供了三个模板:

1. **需要"自验证"时**,做独立 grader 机制(outcomes 模式)——不要让主 agent 自己判对错;
2. **需要"专业化分工"时**,做 thread 隔离 + 共享工作区(multi-agent 模式)——不要让一个 agent 塞所有职责;
3. **需要"跨会话状态"时**,做外部存储 + 自动工具(memory 模式)——不要塞进 prompt。

这三个模式互相正交,可以独立应用到任何 agent 产品里。

---

## 7. 生产部署考量

### 7.1 Beta 状态

三者目前的成熟度不一致(2026/04 起):

| 特性 | 状态 | Beta header |
|---|---|---|
| Memory | **公开 beta** | `managed-agents-2026-04-01` |
| Outcomes | research preview | `managed-agents-2026-04-01-research-preview` |
| Multi-agent | research preview | 同上 |

意味着:

- **Memory**:API 形态稳定,可放心写进 prod。但**默认行为**(agent 在什么时机读写 memory、`description` / `instructions` 的解释)仍可能随 Claude 模型版本微调——业务代码不要硬依赖"agent 一定会先读 X 再写 Y"这种行为细节。
- **Outcomes / Multi-agent**:API 形态可能在未来变化——客户端要做好 adapter 封装,不让业务代码直接依赖具体字段。default 行为(grader 判断标准、coordinator 的 delegation 习惯)同样会调整。
- **混合启用**:同时用 Memory 和 Outcomes/Multi-agent 时,带 `managed-agents-2026-04-01-research-preview`(它是标准 header 的超集)。

**操作建议**:

- 把启用 research preview 的 session 标记在 metadata 里,便于追踪——GA 后的迁移能精准定位;
- 把 Memory 相关代码用 `MemoryStoreClient` 封装(见 §8.3),即使 Memory API 在 GA 之后又微调,业务代码也只需要改一处;
- 注意 Memory 在研究预览阶段使用过的 `memory_*` 6 个专用工具**已不存在**——如果你用的是更早的代码,迁移成 `agent_toolset_20260401` + `/mnt/memory/` 路径即可。

### 7.2 成本模型

**Outcomes**:

- 每个 iteration = 一次 agent run(full tool loop) + 一次 grader 调用;
- max_iterations=N 的 outcome 最坏情况是 N × single_run_cost;
- Grader 本身消耗 input_tokens(rubric + artifact + 标准 grader prompt)+ output_tokens(evaluation result)。

**Multi-agent**:

- 每个 sub-thread 独立累积 token;
- Thread 间消息(`thread_message_sent/received`)在双方 context 都算;
- Coordinator 的 context 里会看到每个 sub-thread 的返回值(但不是它们的完整内部 trace)——所以 coordinator 自己的 context 增长比单 agent 快。

**Memory**:

- 写入不产生 model 调用(纯存储);
- 读取产生 model 调用的 context(agent 读了的内容会进下一次 model 调用);
- 版本历史不影响运行时成本(只占存储)。

**监控建议**:分维度上报——`outcome_iteration_count`、`thread_count`、`memory_read_tokens`——出问题时能快速定位是哪一层爆炸。

### 7.3 可观测性

三者产生的新事件都要在 client 的 observability 管道里被归类:

```
# 推荐的标签维度
session_id
thread_id (null for primary)        ← multi-agent
outcome_id (null if no outcome)     ← outcomes
outcome_iteration                    ← outcomes
memory_store_id (null if not used) ← memory
model_request_source (agent | grader)  ← outcomes
```

这让 observability dashboard 能回答"outcome iteration 平均几次"、"哪个 sub-thread 最贵"、"memory 读取命中率"等问题。

### 7.4 稳定性

**Outcomes 可能引入的不稳定**:

- Grader 本身出错(rare,但发生);
- Rubric 和 description 矛盾导致永远 needs_revision;
- Max iterations 被撞上,但最后一轮 revision 引入新问题。

**Multi-agent 可能引入的不稳定**:

- Sub-thread 卡住(等 custom_tool_result 永远不来)——要给 sub-thread 级别的超时;
- Coordinator 反复派同一任务给 sub-agent——prompt 设计要明确什么时候该 stop delegating;
- Thread 间竞争文件系统——约定好写入路径。

**Memory 可能引入的不稳定**:

- Memory 内容"污染"——agent 写错了东西进去,后续 session 被误导;
- 过大 store 拖慢 list 操作;
- 并发 race(如果没用 precondition)导致数据丢失。

**普遍建议**:prod 启用前先在 staging 环境跑过至少 100 次真实负载,观察 `session.error` 和 `retries_exhausted` 的频率。

---

## 8. 客户端集成骨架

这一节给出把三个高阶特性接入 SessionDriver 的扩展思路。

### 8.1 Outcome-aware SessionDriver

扩展标准 SessionDriver,加 outcome 支持:

```typescript
interface OutcomeConfig {
  description: string;
  rubric: { type: "text"; content: string } | { type: "file"; file_id: string };
  maxIterations?: number;   // default 3
}

class OutcomeDriver extends SessionDriver {
  async runWithOutcome(sessionId: string, config: OutcomeConfig): Promise<{
    outcomeId: string;
    result: "satisfied" | "max_iterations_reached" | "failed" | "interrupted";
    iterations: number;
  }> {
    const stream = await this.client.beta.sessions.events.stream(sessionId);

    // 发 define_outcome 而不是 user.message
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{
        type: "user.define_outcome",
        description: config.description,
        rubric: config.rubric,
        max_iterations: config.maxIterations ?? 3,
      }],
    });

    let outcomeId = "";
    let lastResult: string = "";
    let iterations = 0;

    for await (const ev of stream) {
      await this.onEvent(ev);

      if (ev.type === "user.define_outcome" && ev.processed_at != null) {
        outcomeId = ev.outcome_id;
      }
      if (ev.type === "span.outcome_evaluation_end") {
        iterations = ev.iteration + 1;
        lastResult = ev.result;
      }
      if (ev.type === "session.status_terminated") break;
      if (ev.type === "session.status_idle"
          && ev.stop_reason.type !== "requires_action") break;
    }

    return { outcomeId, result: lastResult as any, iterations };
  }
}
```

### 8.2 Thread-aware 事件路由

Multi-agent 场景的关键扩展——把事件按 thread 分流,并正确路由 tool 回应:

```typescript
class MultiAgentDriver extends SessionDriver {
  private threads = new Map<string, ThreadState>();

  protected async dispatchEvent(ev: any): Promise<void> {
    const threadKey = ev.session_thread_id ?? "primary";
    const thread = this.getOrCreateThread(threadKey);
    thread.events.push(ev);

    // 特殊处理 thread lifecycle
    if (ev.type === "session.thread_created") {
      this.threads.set(ev.session_thread_id, {
        agentName: ev.agent_name,
        events: [],
        status: "running",
      });
    }
    if (ev.type === "session.thread_idle") {
      thread.status = "idle";
    }

    // 交给上层业务
    await this.onThreadEvent(threadKey, ev);
  }

  protected async respondToTool(
    sessionId: string,
    triggerEvent: any,
    response: any,
  ): Promise<void> {
    // 自动附加 session_thread_id(如果需要)
    const payload = { ...response };
    if (triggerEvent.session_thread_id != null) {
      payload.session_thread_id = triggerEvent.session_thread_id;
    }
    await this.client.beta.sessions.events.send(sessionId, {
      events: [payload],
    });
  }
}
```

关键点:**`respondToTool` 一定要自动处理 session_thread_id**,不要让业务代码记得加——会忘。

### 8.3 Memory 管理模块

把 memory store 的 CRUD 封装成独立模块,便于复用。**注意公开 beta 把 `memories.write`(upsert)拆成了 `memories.create`(不覆盖)+ `memories.update`(显式)**,seed 流程要改用 try-catch 模式:

```typescript
class MemoryStoreClient {
  constructor(
    private client: Anthropic,
    private memoryStoreId: string,
  ) {}

  async seed(entries: Array<{ path: string; content: string }>): Promise<void> {
    // 用 create 而不是 write —— path 已存在直接 409,天然 idempotent
    for (const entry of entries) {
      try {
        await this.client.beta.memoryStores.memories.create(this.memoryStoreId, {
          path: entry.path,
          content: entry.content,
        });
      } catch (err: any) {
        if (err.status === 409) continue;   // already exists,跳过
        throw err;
      }
    }
  }

  async listByPrefix(prefix: string, opts?: { depth?: number; withContent?: boolean }) {
    return this.client.beta.memoryStores.memories.list(this.memoryStoreId, {
      path_prefix: prefix,
      order_by: "path",
      view: opts?.withContent ? "full" : "basic",   // basic 默认,大 store 上要明确传
      ...(opts?.depth !== undefined && { depth: opts.depth }),
    });
    // 注意返回 item 是 Memory | MemoryPrefix 联合;消费方要 if (item.type === "memory")
  }

  async safeUpdate(memId: string, updater: (old: string) => string): Promise<void> {
    // 乐观并发:retrieve → modify → update with content_sha256
    for (let attempt = 0; attempt < 3; attempt++) {
      const mem = await this.client.beta.memoryStores.memories.retrieve(memId, {
        memory_store_id: this.memoryStoreId,
      });
      try {
        await this.client.beta.memoryStores.memories.update(memId, {
          memory_store_id: this.memoryStoreId,
          content: updater(mem.content),
          precondition: {
            type: "content_sha256",
            content_sha256: mem.content_sha256,
          },
        });
        return;
      } catch (err: any) {
        if (err.status === 409) continue;   // 有人先改了,重试
        throw err;
      }
    }
    throw new Error("Update failed after 3 retries");
  }

  async upsert(path: string, content: string): Promise<void> {
    // 业务上的"upsert" 现在要客户端自己做:先 create,409 就 update
    try {
      await this.client.beta.memoryStores.memories.create(this.memoryStoreId, {
        path,
        content,
      });
    } catch (err: any) {
      if (err.status !== 409) throw err;
      // 已存在:list 找到 id 再 update
      const found = await this.listByPrefix(path);
      const existing = found.data.find((m: any) => m.path === path);
      if (!existing) throw err;
      await this.client.beta.memoryStores.memories.update(existing.id, {
        memory_store_id: this.memoryStoreId,
        content,
      });
    }
  }

  async redactMatching(predicate: (mem: any) => boolean): Promise<void> {
    // 合规清理:找匹配条件的 memory 并 redact 所有非-head version
    // 注意:head version (current live) 不能直接 redact ——
    // 要么先 update 让它变成历史版,要么先 delete memory
    const memories = await this.listByPrefix("/");
    for (const mem of memories.data) {
      if (mem.type !== "memory") continue;   // 跳过 MemoryPrefix
      if (!predicate(mem)) continue;
      // 先 delete memory,这样所有 version 都不再是 head
      await this.client.beta.memoryStores.memories.delete(mem.id, {
        memory_store_id: this.memoryStoreId,
        expected_content_sha256: mem.content_sha256,   // 安全删除:并发改过就 409
      });
      const versions = await this.client.beta.memoryStores.memoryVersions.list(
        this.memoryStoreId,
        { memory_id: mem.id },
      );
      for (const v of versions) {
        if (v.redacted_at) continue;   // 已经 redact 过的跳过(操作不幂等)
        await this.client.beta.memoryStores.memoryVersions.redact(v.id, {
          memory_store_id: this.memoryStoreId,
        });
      }
    }
  }

  // 审计:列出某个 session 在 store 上做过的所有改动
  async auditSession(sessionId: string) {
    return this.client.beta.memoryStores.memoryVersions.list(this.memoryStoreId, {
      session_id: sessionId,
    });
  }

  // 审计:某段时间窗内、agent 自动写入的所有改动(不含管理员手动操作)
  async listAgentChanges(since: Date, until: Date) {
    const changes: any[] = [];
    const versions = await this.client.beta.memoryStores.memoryVersions.list(
      this.memoryStoreId,
      {
        created_at_gte: since.toISOString(),
        created_at_lte: until.toISOString(),
      },
    );
    for await (const v of versions) {
      if (v.created_by?.type === "session_actor") {
        changes.push(v);   // agent 在 session 里写的
      }
    }
    return changes;
  }
}
```

这个模块可以独立于 SessionDriver 使用——比如在管理后台里让 admin 直接操作 memory。

> ⚠️ **从研究预览版本迁移**:如果你的现有代码用的是 `memories.write`(upsert)+ `precondition: not_exists`,迁移到公开 beta 时:
>
> - `memories.write(...)` → 拆成 `memories.create(...)`(新 path)和 `memories.update(...)`(已有 memory)。两个语义不能用一个调用;
> - `precondition: { type: "not_exists" }` → 移除。`memories.create` 在 path 已存在时直接 409,等价语义;
> - `precondition: { type: "content_sha256", ... }` → 保留,用法不变;
> - Resource attachment 的 `prompt` 字段 → `instructions`(只是字段重命名)。

---

## 附录 A. 完整示例:DCF 分析 agent

```python
"""
一个完整的"按 outcome 做 DCF 分析 + 跨公司 memory"的 agent。
"""

import anthropic
from pathlib import Path

client = anthropic.Anthropic()

# === Setup(一次性)===

env = client.beta.environments.create(
    name="finance-analyst-env",
    config={
        "type": "cloud",
        "packages": {"pip": ["pandas", "numpy", "openpyxl"]},
        "networking": {"type": "unrestricted"},
    },
)

agent = client.beta.agents.create(
    name="Financial Analyst",
    model="claude-opus-4-7",
    system=(
        "You are a financial analyst who builds DCF models. "
        "Before starting, check memory for prior work on the same company or industry. "
        "After completing, record learnings in memory."
    ),
    tools=[{"type": "agent_toolset_20260401"}],
    skills=[{"type": "anthropic", "skill_id": "xlsx"}],
)

memory = client.beta.memory_stores.create(
    name="Finance Team Memory",
    description=(
        "Shared knowledge about companies, industries, and modeling techniques. "
        "Paths: /companies/{ticker}.md, /industries/{sector}.md, /techniques/{name}.md"
    ),
)

# === Runtime(每次分析一个公司)===

def run_dcf_analysis(ticker: str):
    # 挂 memory + 上传 rubric
    rubric = Path("rubrics/dcf.md").read_text()

    session = client.beta.sessions.create(
        agent={"type": "agent", "id": agent.id, "version": agent.version},
        environment_id=env.id,
        resources=[{
            "type": "memory_store",
            "memory_store_id": memory.id,
            "access": "read_write",
            "instructions": "Check /companies/ and /industries/ for prior work before starting.",
        }],
        title=f"DCF-{ticker}",
    )

    # 发 outcome
    with client.beta.sessions.events.stream(session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{
                "type": "user.define_outcome",
                "description": f"Build a 5-year DCF model for {ticker} in .xlsx, save to /mnt/session/outputs/{ticker}_dcf.xlsx",
                "rubric": {"type": "text", "content": rubric},
                "max_iterations": 5,
            }],
        )

        iterations = 0
        final_result = None
        for ev in stream:
            if ev.type == "span.outcome_evaluation_end":
                iterations = ev.iteration + 1
                final_result = ev.result
                print(f"Iteration {iterations}: {ev.result}")
                print(f"  Explanation: {ev.explanation}")
            if ev.type == "session.status_terminated":
                break
            if ev.type == "session.status_idle":
                if ev.stop_reason.type != "requires_action":
                    break

    # 拉 outputs
    import time
    for _ in range(10):
        if client.beta.sessions.retrieve(session.id).status != "running":
            break
        time.sleep(0.2)

    files = client.beta.files.list(
        scope_id=session.id,
        betas=["managed-agents-2026-04-01-research-preview"],
    )
    for f in files.data:
        content = client.beta.files.download(f.id)
        content.write_to_file(f"./outputs/{f.filename}")

    # 清理
    client.beta.sessions.archive(session.id)

    return {
        "ticker": ticker,
        "result": final_result,
        "iterations": iterations,
    }

# 跑一次
result = run_dcf_analysis("COST")
print(result)
```

---

## 附录 B. 完整示例:Code review 多 agent 协同

```python
"""
三 agent code review:coordinator + reviewer + tester
"""

import anthropic
import os

client = anthropic.Anthropic()

# === Setup(一次性)===

env = client.beta.environments.create(
    name="code-review-env",
    config={"type": "cloud", "networking": {"type": "unrestricted"}},
)

# Reviewer:只读工具
reviewer = client.beta.agents.create(
    name="Code Reviewer",
    model="claude-opus-4-7",
    system=(
        "You review code for:\n"
        "- Security (SQL injection, XSS, unsafe deserialization)\n"
        "- Correctness (logic errors, edge cases)\n"
        "- Style (naming, structure)\n"
        "Report findings as a structured list. Do not modify code."
    ),
    tools=[{
        "type": "agent_toolset_20260401",
        "default_config": {"enabled": False},
        "configs": [
            {"name": "read", "enabled": True},
            {"name": "grep", "enabled": True},
            {"name": "glob", "enabled": True},
        ],
    }],
)

# Tester:可执行
tester = client.beta.agents.create(
    name="Test Writer",
    model="claude-opus-4-7",
    system="You write pytest tests for Python code and run them. Report pass/fail.",
    tools=[{"type": "agent_toolset_20260401"}],
)

# Coordinator:能调上面两个
coordinator = client.beta.agents.create(
    name="Engineering Lead",
    model="claude-opus-4-7",
    system=(
        "You coordinate code review for PRs. Your team:\n"
        "- Reviewer: delegates code review findings\n"
        "- Tester: delegates test writing and execution\n"
        "Always delegate parallel work when possible. Summarize all findings for the user."
    ),
    tools=[{"type": "agent_toolset_20260401"}],
    callable_agents=[
        {"type": "agent", "id": reviewer.id, "version": reviewer.version},
        {"type": "agent", "id": tester.id, "version": tester.version},
    ],
)

# === Runtime:review 一个 PR ===

def review_pr(repo_url: str, branch: str, pr_number: int):
    session = client.beta.sessions.create(
        agent=coordinator.id,
        environment_id=env.id,
        resources=[{
            "type": "github_repository",
            "url": repo_url,
            "authorization_token": os.environ["GITHUB_TOKEN"],
            "checkout": {"type": "branch", "name": branch},
        }],
        title=f"PR-{pr_number}",
    )

    events_by_id = {}
    thread_events = {}   # thread_id → list of events

    with client.beta.sessions.events.stream(session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{
                "type": "user.message",
                "content": [{"type": "text", "text":
                    f"Review PR #{pr_number}. The repo is mounted at /workspace. "
                    f"Delegate review and testing, then summarize."}],
            }],
        )

        for ev in stream:
            events_by_id[ev.id] = ev

            # 按 thread 分流
            thread_key = getattr(ev, "session_thread_id", None) or "primary"
            thread_events.setdefault(thread_key, []).append(ev)

            # Primary thread 的 agent.message 直接打印(最终总结)
            if thread_key == "primary" and ev.type == "agent.message":
                for block in ev.content:
                    if block.type == "text":
                        print(block.text, end="")

            # Thread lifecycle
            if ev.type == "session.thread_created":
                print(f"\n[Thread created: {ev.agent_name}]")
            if ev.type == "session.thread_idle":
                print(f"\n[Thread idle]")

            if ev.type == "session.status_terminated":
                break
            if ev.type == "session.status_idle":
                if ev.stop_reason.type != "requires_action":
                    break

    # 清理
    import time
    for _ in range(10):
        if client.beta.sessions.retrieve(session.id).status != "running":
            break
        time.sleep(0.2)
    client.beta.sessions.archive(session.id)

    return {
        "primary_events": len(thread_events.get("primary", [])),
        "sub_threads": {
            k: len(v) for k, v in thread_events.items() if k != "primary"
        },
    }

# 跑一次
stats = review_pr("https://github.com/myorg/myrepo", "feature/auth", 42)
print(stats)
```

---

## 附录 C. 事件速查表

### Outcome 相关

| 事件 | 方向 | 字段 |
|---|---|---|
| `user.define_outcome` | 客户端 → 服务端 | `description`、`rubric`、`max_iterations` |
| `span.outcome_evaluation_start` | 服务端 → 客户端 | `outcome_id`、`iteration` |
| `span.outcome_evaluation_ongoing` | 服务端 → 客户端 | 心跳 |
| `span.outcome_evaluation_end` | 服务端 → 客户端 | `result`、`explanation`、`iteration`、`usage` |
| `session.outcome_evaluated` | 服务端 → 客户端 | 整个 outcome 完成 |

`result` 取值:`satisfied` / `needs_revision` / `max_iterations_reached` / `failed` / `interrupted`

### Multi-agent 相关

| 事件 | 方向 | 字段 |
|---|---|---|
| `session.thread_created` | 服务端 → 客户端 | `session_thread_id`、`agent_name`、`model` |
| `session.thread_idle` | 服务端 → 客户端 | `session_thread_id` |
| `agent.thread_message_sent` | 服务端 → 客户端 | `to_thread_id`、`content` |
| `agent.thread_message_received` | 服务端 → 客户端 | `from_thread_id`、`content` |
| 所有 `user.*` / `agent.*` 事件 | 双向 | 可能带 `session_thread_id`(sub-thread)或不带(primary) |

**Tool 回应路由**:回 `user.tool_confirmation` / `user.custom_tool_result` 时,带上触发事件的 `session_thread_id`(如果有)。

### Memory 相关

公开 beta 起,Memory **不再有专用事件类型**。Agent 用标准 file 工具操作挂载点,事件就是普通的 `agent.tool_use` / `agent.tool_result`,**靠路径前缀识别**:

| 事件 | 方向 | 怎么识别"在动 memory" |
|---|---|---|
| `agent.tool_use(name="read"\|"write"\|"edit"\|"glob"\|"grep"\|"bash")` | 服务端 → 客户端 | `input` 里的 path 落在 `/mnt/memory/...` 下 |
| `agent.tool_result` | 服务端 → 客户端 | 配对的 tool_use 是 memory 操作 |

```typescript
// 客户端识别 memory 操作的标准做法
const MEMORY_PREFIX = "/mnt/memory/";
function classifyToolUse(ev: any): "memory" | "regular" {
  const path = extractPathFromInput(ev.tool_use);   // 看 tool name 抽 path
  return path?.startsWith(MEMORY_PREFIX) ? "memory" : "regular";
}
```

**研究预览阶段**(已淘汰)曾经存在专用事件 `agent.tool_use(name="memory_list" | "memory_search" | "memory_read" | "memory_write" | "memory_edit" | "memory_delete")` —— 如果你的客户端代码在匹配这些 name,**需要迁移到路径前缀检测**。

### 限额速查表(Memory 公开 beta)

| 维度 | 上限 |
|---|---|
| Memory stores per organization | 1,000 |
| Memories per store | 2,000 |
| Total storage per store | 100 MB |
| Versions per store | 250,000 |
| Size per memory | 100 kB |
| Version history retention | 30 天(最新版永久保留) |
| Memory stores per session | 8 |
| `instructions` field per attachment | 4,096 字符 |

### API Endpoint 速查

**Memory Stores**:

| Method | Path | 说明 |
|---|---|---|
| POST | `/v1/memory_stores` | Create store |
| GET | `/v1/memory_stores` | List stores(支持 `include_archived` / `created_at_gte` / `created_at_lte` / `limit` / `page`) |
| GET | `/v1/memory_stores/{store_id}` | Retrieve store |
| POST | `/v1/memory_stores/{store_id}` | Update store(name / description / metadata-patch;**注意 update 是 POST 不是 PATCH**) |
| POST | `/v1/memory_stores/{store_id}/archive` | Archive(单向) |
| DELETE | `/v1/memory_stores/{store_id}` | Delete(永久) |
| GET | `/v1/memory_stores/{store_id}/memories` | List memories(支持 `path_prefix` / `order_by` / `order` / `depth` / `view` / `limit` / `page`)。返回 `Memory \| MemoryPrefix` 联合 |
| POST | `/v1/memory_stores/{store_id}/memories` | **Create**(`path` 必需、`content` 可选;path 已存在 → 409 `memory_path_conflict_error`) |
| GET | `/v1/memory_stores/{store_id}/memories/{mem_id}` | Retrieve memory(`view=full` 默认带 content) |
| POST | `/v1/memory_stores/{store_id}/memories/{mem_id}` | **Update**(content / path / 两者;支持 `precondition: content_sha256`) |
| DELETE | `/v1/memory_stores/{store_id}/memories/{mem_id}` | Delete(支持 `expected_content_sha256` query 参数做安全删除) |
| GET | `/v1/memory_stores/{store_id}/memory_versions` | List versions(可按 `memory_id` / `session_id` / `api_key_id` / `operation` / `created_at_gte` / `created_at_lte` 过滤) |
| GET | `/v1/memory_stores/{store_id}/memory_versions/{ver_id}` | Retrieve version(`view=full` 带 content,redacted 后 content 永远 null) |
| POST | `/v1/memory_stores/{store_id}/memory_versions/{ver_id}/redact` | Redact(head version 不能 redact,要先 update / delete 让它降级) |

**Multi-agent Threads**:

| Method | Path |
|---|---|
| GET | `/v1/sessions/{session_id}/threads` |
| GET | `/v1/sessions/{session_id}/threads/{thread_id}/stream` |
| GET | `/v1/sessions/{session_id}/threads/{thread_id}/events` |

**Outcomes**:没有独立 endpoint——都通过 session events 接口。

---

## 尾声

这三个高阶特性共同勾画出 CMA 的未来形态——一个能**有目标、有团队、有记忆**的 agent 平台。

- **Memory**(已公开 beta)让 agent 从"每次从零"变成"持续学习";
- **Outcomes**(research preview)让 agent 从"说完就完"变成"达成才停";
- **Multi-agent**(research preview)让 agent 从"全能选手"变成"团队协作"。

Memory 在 2026/04 升级为公开 beta 的同时,经历了一次**反向简化**——从研究预览的"6 个专用工具 + 新事件类型"瘦身到现在的"挂载文件系统 + 复用既有 toolset"。这次重构本身就是一个**值得学习的教训**:研究预览阶段把抽象做得偏厚一点不要紧,关键是收集到真实流量后**敢于把它瘦下来**。Outcomes 和 Multi-agent 在它们 GA 时大概率也会经历类似的演进——所以今天用它们的代码要做好"未来要改"的封装。

对客户端开发者,理解这三者不仅是为了"今天能不能用",更是为了**设计能承接它们的应用架构**——当 Outcomes 和 Multi-agent 也 GA 时,你的 SessionDriver、事件处理、成本控制、可观测性都应该能平滑吸纳,而不是推倒重来。

每一个高阶特性都在重申同一件事:**CMA 对接口 opinionated,对实现 unopinionated**——你今天按标准 loop 写的代码,明天直接能接上 Memory(已经可以)或 Outcomes / Multi-agent(还在演进)带来的产能倍增,而不必改架构。
