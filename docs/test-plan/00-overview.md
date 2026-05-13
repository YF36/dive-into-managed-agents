# CMA 测试方案 · Overview

> Phase 0 ship 版本。后续 Phase 1-5 完成时此文档应同步更新决策记录段。

## 1. 测试目标

按重要性排序:

1. **验证文档承诺的行为** —— 官方文档里所有 "must / will / returns" 字样的承诺,挑高频路径实测一遍
2. **探测"文档没说"的灰色地带** —— 调研阶段已识别 30+ 条 unknown 行为,实测填补,是本测试最大产出
3. **沉淀 raw artifact + finding** —— 作为不可重生的实证资产长期保留;产出物 workflow 在 sibling notes repo 维护(本机维护者详见 `INTERNAL.md`)

**不是目标**:为团队"用好" CMA;给 Anthropic 产品提 bug;做安全 audit。

## 2. 调研已确定的关键事实(测试方案的设计前提)

| 维度 | CMA 现状 | 对测试方案的影响 |
|---|---|---|
| 接入路径 | Claude Platform on AWS(Anthropic-operated),host `my-aws`,region `ap-northeast-1` | `90-aws-platform-notes.md` 描述前置项 |
| Bedrock 经典 | **不支持 CMA** | 本任务不测 |
| **SDK 包** | **`@anthropic-ai/aws-sdk` v0.3.0**(AnthropicAws extends Anthropic,自动暴露 `beta.*` 全 CMA surface)| 单一路径,无 dual-mode |
| **凭据** | `ANTHROPIC_AWS_API_KEY` env(配在 `.bash_profile`)+ `ANTHROPIC_AWS_WORKSPACE_ID` env + `AWS_REGION` env | **绝不进 `.env` 文件** |
| Event 类型数量 | ~30 种(从 SDK 类型 union 抓出)`[source: official docs + SDK type;详见 §10 + 20-streaming §20.7 stable/gated 分类]` | `20-streaming-and-events.md` 全覆盖(Phase 2 协议研究计划)|
| Session 状态机 | 4 态(`idle / running / rescheduling / terminated`)`[source: Phase 1 F-0006 实测 — archive 同时改 status=terminated,推翻"archive 仅 metadata flag"假设]` | Phase 2 进一步刻画 status 字段与 lifecycle event 的投影 |
| Reconnect 协议 | 无 cursor / 无 `Last-Event-ID`;推荐客户端 stream + list + 客户端去重 | **两种 dedupe 模式**:UI consolidation 按 id 合并;transport/recovery 必须 occurrence-preserving(20-streaming §20.4)|
| events.send | 批量数组 `{events: []}`,**未文档化 idempotency-key** | 重要测试边界:重 POST 同 payload 行为(20-streaming §20.4.6)|
| `processed_at` | 单字段,null → timestamp 单向变化 | **Append-only 两层不变量**:logical 字段恒定 + processed_at 允许 null→timestamp;Phase 2 §20.3 实测 stream / list / send response 三路对比 |
| Rate limit | org 级 create 300 rpm / read 600 rpm | **不打这个上限** |
| Pause / resume / checkpoint | **不存在** | 跨 vendor 兼容层若依赖这些字段需 client 端模拟或 stub |

## 3. In-scope / Out-of-scope

### In-scope(Phase 0-5 覆盖)

- Agent / Environment / Session / Vault CRUD + lifecycle
- API request/response 详细行为(status code、error union、validation 边界)
- SSE wire 协议探测 + reconnect 三种模式
- 30+ event 类型触发场景 + payload schema 断言
- Vault 凭证注入非破坏性验证(token 物理隔离边界)
- Multi-agent / Memory / Outcomes 三个 research preview(需 access 批准后)
- 低成本 performance 基线(latency p50/p95/p99,不打 rate limit)
- 跨 vendor 设计假设的对照实测(具体清单维护在 sibling notes repo,详见 `INTERNAL.md`)

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
| 1 | `10-functional-and-api` 全集 + tests | 60-80 用例 AWS endpoint 全绿 | 2-3 |
| 2 | `20-streaming-and-events` + tests | 50-70 用例 | 2-3 |
| 3 | `30-vault` + `40-multi-agent-memory-outcomes` + tests | 80-100 用例,RP 占位 | 3-4 |
| 4 | `50-performance` + tests(AWS host 跑)| baseline 数据出来 | 1-2 |
| 5 | 跨 vendor RFC 对照清单(sibling notes repo 维护)+ tests + 回写 finding | RFC 假设逐条 verified | 1-2 |

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

**Cleanup 范围**:`scripts/cleanup.ts` 列 metadata 带 `test_run_id=<本次 run id>` 的资源并 archive。**Phase 0 实现只覆盖 session + vault**(用例只创建这两类 ephemeral);Phase 1+ 扩展到 agents / environments / memory_stores / files / credentials,届时一并补 cleanup 实现。`test_run_id` 由 `tests-cma/.run.json` 持久化(`npm run test` 自动建,`npm run cleanup` 自动删),让两个独立进程读到同一 id。

## 6. 不变量库索引

测试代码里的可复用断言(`src/utils/invariants.ts`),所有 test file 应通过这些 helper 而非散落的 expect:

| 断言函数 | 适用场景 |
|---|---|
| `assertEventLogAppendOnly(events)` | `created_at` 单调不降(**不**校验 id 唯一—— CMA user.* 双相 occurrence 合法,详见 M1 修复)|
| `assertEventIdsUnique(events)` | 显式 id 唯一(明确单 occurrence 场景用,如纯 agent.* 流)|
| `assertProcessedAtMonotonic(snapshots)` | 同 id 多 snapshot,`processed_at` 状态机:`null → timestamp → 同一 timestamp`,不能回退到 null(M2 修复)|
| `assertProcessedAtMonotonicInStream(events)` | 混合 stream 自动 groupByEventId 后逐组跑 `assertProcessedAtMonotonic` |
| `groupByEventId(events)` | helper:返回 `Map<id, occurrences[]>`,给 UI consolidation / 上面的断言用 |
| `assertSseListConsistency(stream, list)` | stream / list 双通道事件集合一致(stream ⊆ list)|
| `assertSchemaForType(event)` | 按 event type 校验 payload 必填字段(Phase 2 实装)|
| `assertNoSecretLeak(text, knownSecrets)` | 输出文本不含已知 vault secret 字面值 |

## 7. AWS 接入前置 checklist

(本节内容跟 `90-aws-platform-notes.md` 详尽版互为补充,这里只列 checklist。**2026-05-13 已确认 host `my-aws` 全部就位**。)

- [x] Claude Platform on AWS workspace 已建(`wrkspc_01CzSuJFbKpu5jooFEQmLiFq`,region `ap-northeast-1`)
- [x] `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION` 已写入 `/home/ubuntu/.bash_profile`
- [x] Node 18.19 + `@anthropic-ai/aws-sdk@0.3.0` + `@anthropic-ai/sdk@0.95.2` 已 npm install
- [x] `hello.ts` 端到端跑通(`client.messages.create` 返回正常)
- [ ] research preview access 申请(若要测 Outcomes / Multi-agent):https://claude.com/form/claude-managed-agents

## 8. Quick Start(在 AWS host 上跑)

**重要**:`ANTHROPIC_AWS_API_KEY` 等凭据在 `~/.bash_profile`,SSH 必须用 login shell 才能读到。

```bash
# SSH 进交互式 shell(简单做法)
ssh my-aws
cd ~/proj/dive-into-managed-agents/tests-cma
npm install
npm run warmup        # 创建 long-lived test-agent / test-environment,id 缓存
npm run test          # Phase 0 只有 smoke
npm run cleanup       # archive 测试期间创建的 ephemeral 资源
```

**一键远程跑**(本地 mac 直接调):

```bash
ssh -t my-aws bash -lc 'cd ~/proj/dive-into-managed-agents/tests-cma && npm run test'
```

**只跑某类**:

```bash
npm run test -- tests/functional        # 只跑功能
npm run test -- tests/streaming         # 只跑流
npm run test:slow                       # 跑 @slow tag(默认 skip)
```

**坑**:`ssh my-aws "cmd"`(不带 `-t bash -lc`)默认只 source `.bashrc`,**读不到 `.bash_profile` 的 env**,测试代码会 throw `Missing required env vars`。详见 `90-aws-platform-notes.md` §9。

## 9. 决策记录(随测试推进追加)

> 这一节记录测试过程中"实测推翻了文档预期"或"做了重大方案调整"的事项。

| 日期 | Phase | 决策 | 触发证据 | 影响 |
|---|---|---|---|---|
| 2026-05-13 | 0 | **改用 `@anthropic-ai/aws-sdk` v0.3.0,放弃 `@anthropic-ai/sdk` + 手动 baseURL/auth 的 dual-mode 设计** | AWS host `my-aws:/home/ubuntu/hello.ts` 实测确认用 aws-sdk;调研发现 `AnthropicAws extends Anthropic`,自动暴露 `beta.*` 完整 CMA surface(详见 [`../cma-aws-sdk-notes.md`](../cma-aws-sdk-notes.md))| `client.ts` 简化为单一路径;`package.json` 改依赖;`.env.example` 移除所有凭据字段;`90-aws-platform-notes.md` 重写 §3 / §4 |
| 2026-05-13 | 0 | **凭据从系统 env 读,不进 `.env`** | 用户明示;AWS host 已把 `ANTHROPIC_AWS_API_KEY` 等配在 `.bash_profile` | `client.ts` 移除 `loadDotenv()`;测试代码 `assertRequiredEnv()` 严格 fail-fast |
| 2026-05-13 | 0 | **SSH 必须用 login shell 才能读到 env**(`ssh -t my-aws bash -lc` 或交互式) | 非交互式 `ssh my-aws "node hello.ts"` 实测失败,env 全空 | Quick Start + 90 §9 写明 |

## 10. 事实可信度 source taxonomy

文档里的 fact / 不变量 / event 类型清单等,**每条都该带 source 标注**,让 reviewer 一眼看到可信度。Phase 0 review M5 揭示的根问题:`session.deleted` 起初是我从 SDK 类型 union 抄的,没在官方 docs cross-check;**2026-05-13 round-2 review 时官方 API ref 已经能找到** session.deleted 条目,这条事实从 `[source: SDK type, unverified]` 升级到 `[source: official docs + SDK type]`。这种 "二手汇编混进未验证条目"的风险需要从源头隔离,因此保留下面的 taxonomy。

**`API ref` 不是独立分类**,它属于 `official docs` 的子集(Anthropic 官方 API reference 页面)— 引用时直接用 `[source: official docs]`,需要更细可在 message 里注明"per API ref"。

**四级 taxonomy**(优先级从高到低):

| 标签 | 含义 | 取信度 | 何时用 |
|---|---|:---:|---|
| `[source: official docs]` | Anthropic 官方文档明确列出 | ★★★ | 直接引用文档原文或 schema |
| `[source: SDK type]` | 从 `@anthropic-ai/sdk` / `@anthropic-ai/aws-sdk` 类型导出 | ★★ | 文档没列但 SDK 类型 union 有的事件 / 字段 |
| `[source: 实测]` | Phase 0-5 用例运行结果 | ★★★ | 跑过的具体行为(error code / latency / event 出现条件) |
| `[source: hypothesis]` | 设计假设 / 我们推测 | ★ | 尚未验证的判断,等 Phase 1+ 实测确认 |

**两种联合标注**(实际很常见):

- `[source: official docs + SDK type]` — 两边都有,最稳
- `[source: SDK type, unverified in official docs]` — SDK 暴露但官方 docs 找不到,**重点测试目标**(API ref 属于 official docs 子集,不再用 "official API ref" 这个旧叫法)

**Phase 1 计划**:跑脚本从 SDK 类型 union 生成 `event-catalog.generated.md`,本仓库所有文档引用 generated 文档而非手写 — 消除"二手汇编漂移"风险。Phase 0 文档先手动标 source,Phase 1+ retrofit 自动化。
