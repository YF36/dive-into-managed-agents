# 产出物模型(Products)

> **CMA 测试的根本目的不是验证 CMA 正确性,而是给 AgentMatrix v1 设计提供一手实证 + 提炼洞察。**
> 因此产出物(Findings / Artifacts / Decisions)才是核心交付物,assert pass/fail 只是副产品。

## 1. 心智反转

| 视角 | 旧(隐含) | 新(本模型) |
|---|---|---|
| 测试目的 | 验证 CMA 行为 | 给 AgentMatrix 提供实证 + 洞察 |
| 核心产出 | 测试报告(pass/fail) | Findings + Artifacts + Decisions |
| 测试代码 | 主体 | 产出物的**生产工具** |
| 跑完测试 | done | 产出 finding → 必要时升 ADR → 回写 AgentMatrix |

## 2. 三类产出物

### 2.1 Findings(发现)
**位置**:`agentmatrix-notes/research/managed-agents/findings/F-NNNN-<topic>.md`

每条**实测发现**一份 finding。覆盖任何"测试中观察到的具体行为",不限于"AgentMatrix 直接相关"——因为今天看似无关的行为,可能未来某个 RFC 改动突然需要。

**写 finding 的判断**:
- 跑完一个 test case,自问:**artifact 里有没有"超出 assertion 的信号"**?(比如 event 出现顺序、错误码精确值、新发现的 event type、payload 字段、latency 形态)
- 有 → 写一个 finding
- 无 → 不写

**Finding ≠ test report**。一个 case 可能产 0 个或多个 finding;一个 finding 可能引用多个 case 的 artifact。

详见 [agentmatrix-notes/research/managed-agents/findings/README.md](https://github.com/agentmatrix-labs/agentmatrix-notes/blob/main/research/managed-agents/findings/README.md) 的 workflow + template。

### 2.2 Artifacts(原始数据)
**位置**:`agentmatrix-notes/research/managed-agents/artifacts/<YYYY-MM-DD>/<run_id>/<case-id>/`(跟 finding 同 repo,**commit + push 长期保留**)

每个测试 case 跑完自动落盘,**作为不可重生的实证资产**。AWS host 环境一旦回收(VM 销毁 / quota 重置 / vendor billing 切换),raw artifact 是唯一证据,所以必须进 git。

**Recorder rootDir 解析**(优先级):
1. `CMA_ARTIFACT_ROOT` env 显式覆盖(CI / 特殊场景)
2. 自动探测 `<dive-into>/../agentmatrix-notes/research/managed-agents/artifacts/`(默认路径,sibling repo 存在则用)
3. fallback 到 `tests-cma/artifacts/`(gitignored,只在 agentmatrix-notes 没 clone 时兜底,例如新 dev 第一次跑测试)

**单 case artifact 结构**:
```
artifacts/2026-05-13/01HXX.../smoke--end-to-end-basic-turn/
├── case.md            ★ 人类可读 summary(目的 / notes / event 计数 / markers / HTTP overview / files)
├── events.jsonl       SSE stream 收到的 raw event,每行 1 个
├── http.jsonl         HTTP request/response 对(headers + URL + status + timing,无 body)
├── marks.json         timing marks(perf 测试的关键节点)
└── metadata.json      case 上下文(case_id / run_id / endpoint / notes / 自定义 metadata)
```

`case.md` 是 Recorder 自动生成 + 测试作者 `recorder.addNote(...)` 补充。**这是 finding 的轻量预报**(reviewer 可以快速浏览所有 case.md 决定哪些值得升级到独立 finding),raw 数据深挖回到 jsonl / json。

**Redaction**:Recorder 自动把已知 secret(`ANTHROPIC_AWS_API_KEY` 等)替换成 `<redacted:xxxx...xx>`,sensitive headers(authorization / x-api-key / cookie 等)整 value 替换。Artifact 因此**安全用于跨人共享 / 进 git**。

**为什么 commit 而非 gitignore**(2026-05-13 用户校准):raw 数据是不可重生的资产,AWS 环境回收后无法再产生。Phase 1+ 用例数预计 100+,每 case 50-500KB,累积 5-50MB,远低于 GitHub repo size limit;JSONL 是 text,git diff / blame 工作良好,不需要 LFS。**Finding 文档仍 inline 引用 artifact 关键片段**(快速核查),但**完整 raw 文件 commit + push**(深度回溯 / 跨人共享)。

**Commit 责任**:跑测试落盘后,**agentmatrix-notes** 那边 git add / commit / push(notes repo 允许直接 push main per `feedback_notes_repo_direct_push`)。

**重新跑 artifact**:`npm run test -- <case-pattern>` 重跑某 case 即生成新 artifact。Artifact 路径稳定(date / run_id / case-id 三段),不同 run 自然隔离。

### 2.3 Decisions(决策,ADR-style)
**位置**:`agentmatrix-notes/decisions/ADR-NNNN-<topic>.md`(复用现有 ADR 流程)

当 finding 影响 AgentMatrix RFC 假设时,开一份新 ADR。**复用现有 [ADR-0000-template.md](https://github.com/agentmatrix-labs/agentmatrix-notes/blob/main/decisions/ADR-0000-template.md)**。

ADR `References` 必须反向链接到:
- 触发 ADR 的 finding(`F-NNNN`)
- 受影响的 RFC 章节
- Raw artifact 路径(可选,审计用)

**ADR != finding**。Finding 是事实,ADR 是因事实做的决定。一份 ADR 可能引用多个 finding。

## 3. 工作流

```
test case 开发
   ↓
case 用 createRecorder(...) 启用 recorder,SDK fetch 注入,事件 / HTTP / timing 自动 capture
   ↓
跑 vitest(本地 / AWS host / CI 都行)
   ↓
artifact 自动落盘 + assert pass/fail
   ↓
case 作者审 artifact:有没有"超出 assertion 的信号"?
   ↓                                             ↓
   有                                            无
   ↓                                             ↓
开 finding F-NNNN(在 agentmatrix-notes/research/managed-agents/findings/)
inline 引用 artifact 关键片段
   ↓
finding 影响 AgentMatrix RFC?
   ↓                ↓
   是              否
   ↓                ↓
开 ADR-NNNN     done
References 列 finding id + RFC 章节 + artifact 路径
```

## 4. Phase 推进与产出物期望

| Phase | 范围 | 预期 finding 数 | 预期 ADR 数 |
|---|---|---|---|
| 0 | 骨架 + smoke + 1 个 demo finding | 1 | 0 |
| 1 | functional / api-behavior(60-80 用例) | 5-15 | 0-2 |
| 2 | streaming / events(50-70 用例) | 10-20 | 1-3 |
| 3 | vault / multi-agent / memory / outcomes(80-100 用例) | 10-20 | 2-5 |
| 4 | performance(15-25 用例) | 5-10 | 0-2 |
| 5 | AgentMatrix-relevant(20-30 用例,系统对照) | 20-30 | 5-10 |

预期 Phase 1-5 共产出 **50-95 finding + 8-22 ADR**。这些数字是**估算上限**,实际数量取决于 CMA 实测有多少"超出预期"。

## 5. 跨 repo 协作约定

| 路径 | Repo | 内容 |
|---|---|---|
| `dive-into-managed-agents/tests-cma/` | dive-into | 测试代码 + 跑测试(无持久 artifact)|
| `dive-into-managed-agents/docs/findings-index.md` | dive-into | 轻索引,列所有 finding ID + cross-link 到 agentmatrix-notes(便于跑测试时快速看"产出了什么") |
| `agentmatrix-notes/research/managed-agents/findings/` | agentmatrix-notes | finding 的权威位置 |
| `agentmatrix-notes/research/managed-agents/artifacts/` | agentmatrix-notes | **raw artifact 长期归宿**(commit + push,AWS 环境回收也不丢) |
| `agentmatrix-notes/decisions/ADR-*.md` | agentmatrix-notes | ADR(已有流程) |
| `agentmatrix-notes/architecture/` / `specs/v1/` | agentmatrix-notes | 受 ADR 影响时更新这些(权威优先级见 AGENTS.md) |

**注意**:dive-into 这边的 `tests-cma/artifacts/` 是 fallback 兜底(若 agentmatrix-notes 没 clone)+ gitignored;**正常情况下 Recorder 自动写到 agentmatrix-notes**。

## 6. 为什么这样切

**为什么 artifacts 放 agentmatrix-notes**(2026-05-13 用户校准):
- raw 数据是**不可重生的设计资产**,AWS 环境一旦回收(VM / quota / billing 切换),artifact 是唯一证据
- 跟 finding 同 repo,引用时本 repo 相对路径(不需要跨 repo)
- agentmatrix-notes 本就是 AgentMatrix 知识沉淀 repo,artifact 是 research 类资产
- 体量评估(Phase 1+ 5-50MB)远低于 GitHub limit,JSONL text 友好 git diff

**为什么 finding 放 agentmatrix-notes**:finding 是 AgentMatrix 设计的输入,跟 ADR / architecture / specs 在同一 repo 便于交叉引用。`research/managed-agents/findings/` 符合 agentmatrix-notes [AGENTS.md](https://github.com/agentmatrix-labs/agentmatrix-notes/blob/main/AGENTS.md) "external research → `research/`" 的 directory placement 约定。

**为什么没有独立 Insights 类别**(用户初次决策含 insights,后简化):
- Insights 跟 findings 边界模糊(N 条 finding 提炼 = 1 个 insight,但 single finding 也可能是 insight)
- 高价值"洞察"的正路是开 ADR 或更新 architecture/RFC,而不是单独建一份 insights 文档(否则又多一层抽象,维护成本)
- 复用 agentmatrix-notes 已有的"权威顺序"(research → ADR → architecture/specs)更清晰
