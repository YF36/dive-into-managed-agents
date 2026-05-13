# CMA 测试方案 · Overview

> Phase 0 ship 版本。后续 Phase 1-5 完成时此文档应同步更新决策记录段。

## 1. 测试目标

按重要性排序:

1. **验证文档承诺的行为** —— 官方文档里所有 "must / will / returns" 字样的承诺,挑高频路径实测一遍,避免对错误的假设建 AgentMatrix RFC
2. **探测"文档没说"的灰色地带** —— 调研阶段已识别 30+ 条 unknown 行为(详见 `60-agentmatrix-relevant.md`),实测填补,是本测试最大产出
3. **给 AgentMatrix v1 设计提供一手数据** —— CMA 是 v1 RuntimeDriver 主要黑盒托管对象之一,kernel 设计大量决策依赖 CMA 真实行为

**不是目标**:为团队"用好" CMA;给 Anthropic 产品提 bug;做安全 audit。

## 2. 调研已确定的关键事实(测试方案的设计前提)

| 维度 | CMA 现状 | 对测试方案的影响 |
|---|---|---|
| 接入路径 | Claude Platform on AWS(Anthropic-operated)| `90-aws-platform-notes.md` 描述前置项 |
| Bedrock 经典 | **不支持 CMA** | 本任务不测 |
| Event 类型数量 | ~30 种(含 `session.thread_*` ×4 + `span.outcome_evaluation_*` ×3 + `session.deleted`)| `20-streaming-and-events.md` 全覆盖 |
| Session 状态机 | 4 态(`idle / running / rescheduling / terminated`)| 无 paused / archived(archive 是 metadata flag)|
| Reconnect 协议 | 无 cursor / 无 `Last-Event-ID`;推荐客户端 stream + list + event_id 去重 | 测试代码必须实现客户端去重逻辑 |
| events.send | 批量数组 `{events: []}`,**未文档化 idempotency-key** | 重要测试边界:重 POST 同 payload 行为 |
| `processed_at` | 单字段,null → timestamp 单向变化 | 跟 AgentMatrix 双相 occurrence 模型有差异,需测兼容层 |
| Rate limit | org 级 create 300 rpm / read 600 rpm | **不打这个上限** |
| Pause / resume / checkpoint | **不存在** | AgentMatrix v1 黑盒托管时这些字段都得 client 端模拟或 stub |

## 3. In-scope / Out-of-scope

### In-scope(Phase 0-5 覆盖)

- Agent / Environment / Session / Vault CRUD + lifecycle
- API request/response 详细行为(status code、error union、validation 边界)
- SSE wire 协议探测 + reconnect 三种模式
- 30+ event 类型触发场景 + payload schema 断言
- Vault 凭证注入非破坏性验证(token 物理隔离边界)
- Multi-agent / Memory / Outcomes 三个 research preview(需 access 批准后)
- 低成本 performance 基线(latency p50/p95/p99,不打 rate limit)
- AgentMatrix RFC 关心的对照点实测

### Out-of-scope(明确不做,留 v2)

| 项 | 不做原因 | v2 触发条件 |
|---|---|---|
| Rate limit 压测 | org 级共享,影响其他成员 | 单独 API key,独立 workspace |
| 6h reauth 边界 | wall clock 太长 | 长跑机器就位 + 业务真实需求 |
| Outcome `max_iterations=20` | 烧 token 太多 | 团队 token budget 批准 |
| Prompt injection 破坏性 | 安全 audit 独立 suite | 单独立项 + Anthropic 沟通 |
| Hard delete vault / agent | 误删生产风险 | 隔离测试 workspace 就位 |
| SDK 单元测试 / mock-only | 不验证真实 endpoint 行为 | 不规划 |
| Bedrock 经典路径 | 不支持 CMA | 永不规划 |

## 4. 实施次序(5 Phase)

| Phase | 范围 | 完工标志 | 预估天数(自然天)|
|---|---|---|---|
| 0 | 骨架 + overview + 7 份骨架 + smoke test | 本地 smoke test 1 个 pass | 0.5 |
| 1 | `10-functional-and-api` 全集 + tests | 60-80 用例 direct mode 全绿 | 2-3 |
| 2 | `20-streaming-and-events` + tests | 50-70 用例 | 2-3 |
| 3 | `30-vault` + `40-multi-agent-memory-outcomes` + tests | 80-100 用例,RP 占位 | 3-4 |
| 4 | `50-performance` + tests(AWS host 跑)| baseline 数据出来 | 1-2 |
| 5 | `60-agentmatrix-relevant` + tests + 回写 AgentMatrix notes | RFC 各章节加"已实测"标记 | 1-2 |

**每个 Phase 完工打 git tag** `cma-test-phase-N`,便于回滚 + 按 phase review。

## 5. 测试资源治理

| 资源 | 生命周期 | 治理 |
|---|---|---|
| `test-agent`(共享 minimal agent) | long-lived | `scripts/warm-up.ts` 创建,id 缓存到 `.warmup.json`(gitignore)|
| `test-environment`(共享 cloud env) | long-lived | 同上 |
| 测试用 `vault` | per-suite | `beforeAll` 创建,`afterAll` archive |
| `session` | per-test | 每个 test 创建,test 结束 archive(失败不阻塞 cleanup)|
| `memory_store` | per-suite | 同 vault |
| `credential` | per-suite | 同 vault |

**Cleanup 兜底**:`scripts/cleanup.ts` 列出所有 metadata 带 `test_run_id=<本次 run uuid>` 的资源,统一 archive。CI / 本地都跑。

## 6. 不变量库索引

测试代码里的可复用断言(`src/utils/invariants.ts`),所有 test file 应通过这些 helper 而非散落的 expect:

| 断言函数 | 适用场景 |
|---|---|
| `assertEventLogAppendOnly(events)` | 同 session 内 event 数组 id 唯一 + 时间单调 |
| `assertProcessedAtMonotonic(eventsOverTime)` | 多次拉同一 event,processed_at 单向 null→timestamp |
| `assertSseListConsistency(stream, list)` | stream / list 双通道事件集合一致 |
| `assertSchemaForType(event)` | 按 event type 校验 payload 必填字段(规范来自 SDK 类型 + 实测补丁)|
| `assertNoSecretLeak(text, knownSecrets)` | 输出文本不含已知 vault secret 字面值 |

## 7. AWS 接入前置 checklist

(本节内容跟 `90-aws-platform-notes.md` 详尽版互为补充,这里只列 checklist)

- [ ] Claude Platform on AWS workspace 已建,region 已选
- [ ] `aws iam enable-outbound-web-identity-federation` 已执行
- [ ] AWS Console 已 generate API key(注意不是 Claude Console 那个),或 WIF token-generator 已配
- [ ] IAM principal 具备 ManagedAgents 调用权限
- [ ] research preview access 申请(若要测 Outcomes / Multi-agent):https://claude.com/form/claude-managed-agents

未拿到时,可先以 direct API key 跑 Phase 0-3(direct mode);Phase 4 必须 AWS。

## 8. Quick Start

```bash
cd dive-into-managed-agents/tests-cma
cp .env.example .env                          # 填 ANTHROPIC_API_KEY
npm install
npm run warmup                                # 创建 test-agent / test-environment,id 缓存
npm run test                                  # 跑全部已有用例(Phase 0 阶段只有 smoke)
npm run cleanup                               # archive 测试期间创建的 ephemeral session
```

**只跑某类**:

```bash
npm run test -- tests/functional                # 只跑功能
npm run test -- tests/streaming                 # 只跑流
npm run test:slow                               # 跑 @slow tag(默认 skip)
```

## 9. 决策记录(随测试推进追加)

> 这一节记录测试过程中"实测推翻了文档预期"或"做了重大方案调整"的事项。Phase 1 跑完时第一次填充。

| 日期 | Phase | 决策 | 触发证据 | 影响 |
|---|---|---|---|---|
| (TBD) | | | | |
