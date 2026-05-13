# Multi-agent & Memory & Outcomes(Phase 3 展开)

> Phase 0 骨架。Phase 3 展开。**三个 feature 都需 research preview access** —— 申请:https://claude.com/form/claude-managed-agents

## 范围

CMA 的三个 research preview feature:
- Multi-agent(coordinator + sub-agents)
- Memory(persistent filesystem mount)
- Outcomes(rubric-driven evaluation)

未拿到 access 前测试 skip(`CMA_RESEARCH_PREVIEW=false` 默认)。

## 关键不变量

- **Multi-agent**:thread 数 ≤ 25;coordinator 深度仅 1 级;sub-agent context 隔离但 filesystem 共享
- **Memory**:`read_only` mount 写入 fs-level reject;`content_sha256` precondition 保证乐观并发;最近版本永远保留 + 历史版本 30 天
- **Outcomes**:grader 独立 context;一个 session 同时只一个 outcome;max_iterations ≤ 20

## 用例分组(Phase 3 展开)

### 40.1 Multi-agent(预计 10-12 条)

- 40.1.1 coordinator + 3 sub-agent 最小 happy path
- 40.1.2 sub-agent 内声明 callable_agents → 文档说 "depth > 1 ignored",实测是 reject 还是 silently drop
- 40.1.3 thread 数 25 上限:第 26 个 thread 创建的错误码
- 40.1.4 thread message 流 schema(`agent.thread_message_sent` / `agent.thread_message_received` payload + `from_session_thread_id` / `to_session_thread_id` lineage)`[source: SDK type;`agent.delegation` 是早期二手汇编误称,SDK union 未列,Phase 3 实测确认 multi-agent 委派的实际事件流形态]`
- 40.1.5 sub-agent return summary,验证 coordinator 拿到的不是详细 history
- 40.1.6 共享 filesystem 并发:两 sub-agent 同时写 `/work/result.json`,验证有无锁(预期无;应用层自己协调)
- 40.1.7 coordinator interrupt 时所有非 archived thread 行为
- 40.1.8 thread 独立 system prompt 验证(分别问 "你是谁")
- 40.1.9 thread 独立 tool 权限验证
- 40.1.10 `agent.thread_message_sent` / `agent.thread_message_received` 显式 lineage 字段
- 40.1.11 session.status 是所有 thread 状态的 OR 聚合验证
- 40.1.12 子线程 idle 后 coordinator 能否再发 message 给已 idle 的子线程

### 40.2 Memory(预计 10-15 条)

- 40.2.1 create memory_store + 挂载到 session(`/mnt/memory/<store>/`)
- 40.2.2 agent 通过标准 file tool 读 memory(read / glob / grep)
- 40.2.3 agent 通过标准 file tool 写 memory(write / edit)
- 40.2.4 read_only mount 写入:fs error 类型(EROFS / EACCES / 自定义)
- 40.2.5 `content_sha256` precondition match → write OK
- 40.2.6 `content_sha256` precondition mismatch → 期望 409 或自定义
- 40.2.7 单文件大小 100kB 上限边界
- 40.2.8 `memstore` 8/session 上限,第 9 个挂载错误码
- 40.2.9 path_prefix 列表 / depth 浏览
- 40.2.10 memory version 列表(`list_versions`)
- 40.2.11 最近版本永留承诺(改 N+1 次,看是否第 1 版立刻消失;**不测 30 天**)
- 40.2.12 redact 操作(保留审计 + 抹掉 content)
- 40.2.13 running session 不能 attach 新 memory_store(预期)
- 40.2.14 跨 session 共享同一 memory_store 的可见性
- 40.2.15 `description` 字段是否被注入到 system prompt(实测验证)

### 40.3 Outcomes(预计 10-12 条)

- 40.3.1 `user.define_outcome` 最小用例,rubric=text
- 40.3.2 rubric=file(先上传 file,引用 file_id)
- 40.3.3 max_iterations=1 + rubric 故意不可达 → result `max_iterations_reached`
- 40.3.4 max_iterations=3 + 简单 rubric → result `satisfied`
- 40.3.5 "may run one final revision" 边界:max=1 时是否真的额外跑一轮
- 40.3.6 rubric 与 description 故意矛盾 → result `failed`
- 40.3.7 user.interrupt 中途打断 outcome → result `interrupted`
- 40.3.8 grader 独立 context 验证:agent message 偷偷写 "我已经完成" 不能骗 grader
- 40.3.9 `span.outcome_evaluation_*` 三事件 schema + heartbeat 节奏
- 40.3.10 outcome 跑完后 `/mnt/session/outputs/` 输出文件可通过 Files API 取
- 40.3.11 同一 session 串行跑两个 outcome
- 40.3.12 同一 session 并发跑两个 outcome → 预期 reject(文档说一次只一个)

## 预估用例总数

30-40 条(Phase 3 展开)

## Token 成本估算

每个 Multi-agent 完整 run ~50-200k tokens;每个 Outcomes max=3 ~30-100k tokens;Memory 单测低成本。Phase 3 总 token 预算约 ~3-5M(具体看 model 选择,推荐 Haiku 4.5 / Sonnet 4.5 跑大多数 case 降本)。
