# Multi-agent & Memory & Outcomes(Phase 3 协议研究计划)

> **2026-05-15 升级**:从"功能测试清单"升级到"协议研究计划"。Phase 3 启动 probe(F-0027)印证三项 preview 全开通;Batches 1-4(F-0028~F-0031)完成 21 case + 5 finding;本文档把已 done case fold-in,残留 case 按"What CMA does + What target protocol should do"重新组织。
>
> 跟 §20 一样,本文档不是"功能测试清单";是**反推 sibling notes repo 维护的跨 vendor multi-agent / memory / outcomes 协议**。CMA 是首个把 Memory + Outcomes + Multi-agent 同 stream 出来的 vendor 实现,**每条字段、每个上限、每种 verdict** 都是 v1 设计 signal。
>
> 已 done case 见 [findings/F-0027~F-0031](../../../agentmatrix-notes/research/managed-agents/findings/);Phase 3 summary 见 [phase-3-summary.md](../../../agentmatrix-notes/research/managed-agents/findings/phase-3-summary.md)。

## 范围 / 反推目标

每个 sub-section 必须回答**两类问题**(同 §20 套路):

| 类别 | 形态 |
|---|---|
| **What CMA does** | 实测客观刻画(字段 / 顺序 / 上限 / verdict / error code) |
| **What target protocol should do** | 反推决策(借鉴 / 增强 / 拒绝跟随 / 在 adapter 层补) |

第二类沉淀到 sibling notes repo `research/managed-agents/findings/` + ADR draft(`adr-drafts/`)。

## 关键不变量(三个 feature 各自一组)

### Multi-agent

| 不变量 | 验证 | Phase 3 状态 |
|---|---|---|
| coordinator.agents ≤ **20**(非 25) | F-0031 §40.1.3 | ✅ |
| Max depth = 1(create-time enforce,不是 runtime drop) | F-0031 §40.1.2 | ✅ |
| Lineage 字段不对称:`sent.to_*` / `received.from_*` | F-0030 §40.1.4 | ✅ |
| `session.status` = OR(thread.status) 聚合 | F-0030 §40.1.11 | ✅ |
| Per-thread sub-resource endpoint 全 404(未实装) | F-0030 + F-0027 | ✅(stable miss)|
| Thread message content 全量 raw(server 不 summarize) | F-0030 §40.1.5 | ✅ |
| 主 stream 同时承载 coordinator + thread events,无独立 thread stream | F-0021 + F-0030 | ✅ |
| Session 内 thread 数运行时上限(per doc 25)| **待测** Phase 4 | ⏳ |
| `session_thread_id` 在 coordinator's own `agent.message` 为 undefined | F-0030 §40.1.5 | ✅ |

### Memory

| 不变量 | 验证 | Phase 3 状态 |
|---|---|---|
| `mount_path: /mnt/memory/<store-name>` 派生自 store name | F-0027 + F-0028 §40.2.1 | ✅ |
| memory.path 是 store 内 logical(`/`-prefix);跟 mount_path 不同概念 | F-0028 §40.2.1 | ✅ |
| `read_only` mount = POSIX EROFS(非自定义 error type) | F-0028 §40.2.4 | ✅ |
| OCC: `content_sha256` precondition mismatch → 409 `memory_precondition_failed_error` | F-0028 §40.2.6 | ✅ |
| exact-match no-op(precondition sha === stored sha)→ 200(per spec) | F-0028 §40.2.6 | ✅ |
| Memory content 上限 **exactly 102400 bytes**(102401 → 400) | F-0031 §40.2.7 | ✅ |
| `resources` 上限 = 8 memory_store / session(9th → 400 invalid_request_error) | F-0028 §40.2.8 | ✅ |
| Version chain newest-first;v1(create)永留 | F-0028 §40.2.11 | ✅ |
| `operation` 枚举:`created` / `modified` / `renamed` / `deleted` / `redacted` | F-0028 §40.2.11 | ✅(前 2 实测) |
| `depth` 参数 list endpoint 强制配 `order_by=path`(SDK 未暴露此耦合) | F-0031 §40.2.2-3 | ✅ |
| Path-prefix list 工作(`path_prefix=/a/` filter)| F-0031 §40.2.2-3 | ✅ |
| `read_only` mount 是否 allow override per-credential(`access` 字段)| **待测** | ⏳ |
| 30 天历史版本承诺 | **不测**(wall-clock 过长) | ⏳ |

### Outcomes

| 不变量 | 验证 | Phase 3 状态 |
|---|---|---|
| Verdict enum 5 值:`satisfied` / `needs_revision` / `max_iterations_reached` / `failed` / `interrupted` | F-0029 + SDK doc | ✅(4/5 实测;`interrupted` 待 §40.3 残留) |
| Grader 看 deliverable files(`/mnt/session/outputs/`),**不看** agent message | F-0029 §40.3.8 | ✅(关键) |
| 三事件 schema:`span.outcome_evaluation_start` / `_end` / `_ongoing`(heartbeat 可选) | F-0029 §40.3.9 | ✅(start/end 必出;ongoing 快任务 0 个) |
| `end.usage` 字段是单独 grader 调用的 token 计费(非 agent 总账) | F-0029 §40.3.9 | ✅ |
| `max_iterations_reached` 后**还有** 1 个 final agent message turn 才到 `session.status_idle` | F-0031 §40.3.5 | ✅ |
| `revision_cycle` / `iteration` 字段 0-indexed,递增 | F-0029 §40.3.4 | ✅ |
| 一个 session 同时只一个 outcome(per doc;待测 reject 行为) | **待测** | ⏳ |
| `max_iterations` 上限 20(per doc;无实测) | **待测** | ⏳ |
| `rubric.content` 上限 262144 chars(per SDK type) | **待测** | ⏳ |

## 与目标协议的关键问题映射

实测要回答下列设计问题(每条标明对应 sub-section):

| 问题 | sub-section | 决策选项 |
|---|---|---|
| ExecutionThread 协议要 sub-resource 吗? | 40.1 | (a) 跟 CMA 一样只主 stream + thread_id filter / (b) 在 adapter 层合成 per-thread endpoint / (c) 完整 sub-resource(独立 stream + 独立 events.list) |
| Thread lineage 字段对称还是不对称? | 40.1 | CMA: sent.to_* / received.from_* — 反推 v1 是否也保持不对称,或加 `correlation_id` |
| Coordinator 自己 message 标 thread_id 吗? | 40.1 | CMA: undefined(隐含 primary)— 反推 v1 是否要 explicit primary thread |
| `session.status` 聚合规则是否明确写进协议? | 40.1 | (a) 跟 CMA 一样 OR(thread.status) / (b) 显式 max(severity) / (c) 不聚合,client 自己判 |
| Memory OCC 是 content-hash 还是 version-int? | 40.2 | CMA: content_sha256;对照 F-0002 OCC explicit version handshake(agent 用 version int)— 反推哪种 v1 用 |
| Memory list endpoint 参数耦合(depth + order_by)应当怎么表达? | 40.2 | (a) discriminated union 类型 / (b) runtime error 拒绝(CMA 做法)/ (c) 默认 order_by |
| Memory `read_only` 是 capability 还是 ACL? | 40.2 | CMA: per-mount access 字段(read_write / read_only);v1 反推是否要更细粒度(per-path?) |
| Grader 是 file-based 还是 message-based? | 40.3 | CMA: file-only — **强约束** 防 prompt injection;v1 是否扩展(支持 hybrid?) |
| Verdict enum 设计是否覆盖 v1 需求? | 40.3 | CMA 5 值 vs v1 + `cancelled` / `rejected_rubric` / `errored` 等?|
| Outcome `final ack turn` 协议化吗? | 40.3 | (a) 显式 lifecycle event(`outcome.final_ack`)/ (b) 跟 CMA 一样隐式(看 agent.message 时序)|
| Grader `usage` 字段单独归集 vs 合并到 turn usage? | 40.3 | (a) 单独(CMA — 但 audit 复杂)/ (b) 合并(简单但 grader cost 不透明)|
| Multi-agent depth limit 是 protocol level 还是 driver capability? | 40.1 | CMA: depth=1 protocol-level + 20 agents/coord — v1 是否在 DriverCapabilities 暴露 |

## 研究产物 + 证据格式

延续 §20 模式:

```
sibling notes repo (research/managed-agents/)/
├── event-corpus/                       ★ 现有 18 个 + Phase 4+ 新增
│   ├── multi-agent-thread-lineage/       (40.1.4 expand)
│   ├── memory-occ-mismatch/              (40.2.6 capture)
│   ├── outcomes-final-ack-turn/          (40.3.5 capture)
│   └── ...
├── artifacts/<date>/<run_id>/...
└── findings/
    ├── F-0027 Phase 3 startup probe        ✅ done
    ├── F-0028 Memory baseline              ✅ done
    ├── F-0029 Outcomes baseline            ✅ done
    ├── F-0030 Multi-agent depth            ✅ done
    ├── F-0031 boundary cases               ✅ done
    └── (Phase 4 残留 findings)
```

事实可信度标注:`[source: official docs | SDK type | 实测 | hypothesis]`(沿用 [`00-overview.md` §10](./00-overview.md))。

## 40.0 测试基础设施 prep

Phase 3 已 done 阶段全部 reuse Phase 2 §20.0 prep(`three-layer-collector` / `raw-sse` / `corpus`);Phase 4+ 新增需求:

| 项 | 工作 | 文件 | 状态 |
|---|---|---|---|
| `child-agent-pool` 共享 fixture | warmup 阶段预 create N 个 worker agent,缓存 id 给 §40.1 multi-agent case 复用 | `tests-cma/src/fixtures/multiagent.ts`(新增)| Phase 4 启动前补 |
| Files API helper | 40.3.10 outcome `/mnt/session/outputs/<file>` 通过 Files API 取出 | `tests-cma/src/utils/files-api.ts`(新增)| 跑 40.3.10 时补 |
| Shared filesystem probe helper | 40.1.6 两 thread 并发写同文件,检测 race / 锁 / 后写覆盖 | `tests-cma/src/utils/concurrent-fs.ts`(新增)| 跑 40.1.6 时补 |
| Memory cleanup script | 测试 leak 的 memstore + memories(metadata.test_run_id filter) | `tests-cma/scripts/cleanup-memory.ts`(新增)| Batch 5+ 启动前 |
| Outcome max_iterations runaway guard | 防止 max=20 + reasonable rubric 误烧 token | `tests-cma/src/utils/outcome-budget.ts`(新增)| 跑 40.3 残留时补 |

→ 全部增量 helper,不需要重写 Phase 2 prep;**最大单笔成本**是 Files API + concurrent-fs(各 ~30min)。

## 40.1 Multi-agent

### What CMA does(Phase 3 已 done)

**[source: 实测 F-0021/F-0030/F-0031]**

- **Hierarchy**: coordinator + N children;**N ≤ 20**(create-time validation);**depth ≤ 1**(parent create-time validation,sub-coord 单独 OK 但挂到 top-coord 时 reject)
- **Thread ID**: `sthr_*`(workspace unique);primary thread 也有 thread id 但 coordinator's own `agent.message` 不带 `session_thread_id` 字段
- **Event 类型**:
  - `session.thread_created` — 新 thread 启动
  - `session.thread_status_running / idle / rescheduled / terminated` — thread-级 4 态状态机
  - `agent.thread_message_sent` payload: `content[]` + `to_agent_name` + `to_session_thread_id`
  - `agent.thread_message_received` payload: `content[]` + `from_agent_name` + `from_session_thread_id`
- **Lineage 不对称**:sent 只 to_*,received 只 from_*;配对靠 `(thread_id, send_timestamp)` 时序,无显式 `correlation_id`
- **Content 全量 raw**:sent.content === received.content,server 不做 summarization(coordinator 自己 LLM 总结)
- **Status aggregation**:`session.status = OR(thread.status)`,任 thread running → session running
- **Per-thread sub-resource 全 404**:`threads.retrieve` / `threads.events.list` / `threads.events.stream` / `threads.interrupt` 全套 endpoint server 未实装(SDK type 暴露但 server 404)

### What target protocol should do(反推决策点)

| 决策 | 方向 |
|---|---|
| Per-thread endpoint | CMA 当前无,v1 ExecutionThread 协议**直接定义**(主 stream + thread_id filter 是 access pattern,不是 capability;driver capability flag `THREAD_SUB_RESOURCE_AVAILABLE` 已加,driver 自己决定怎么实现)|
| Lineage 字段 | 跟 CMA **保持不对称**(minimal),但 v1 加 explicit `correlation_id`(可选)给 client dedupe pair |
| Coordinator 自己 message 的 thread_id | v1 **显式 primary thread id**(不留 undefined)— 避免 client special-case |
| Status aggregation | v1 **显式定义 OR 聚合**;协议中给规则,client 不重新发明 |
| Hierarchy 上限 | v1 **driver capability 暴露**;不写死 20 / 不写死 depth=1 — kernel 根据 driver 调整 enforcement |
| Thread message content 是否 server-side compaction | **不** — 跟 CMA 一致(server 不 modify),compaction 是 agent layer concern |

### 已 done case(Phase 3)

- ✅ **40.1.4** thread message lineage 字段 schema(F-0030)
- ✅ **40.1.5** coordinator 收 full message(非 summary)(F-0030)
- ✅ **40.1.7** per-thread endpoint 404 follow-up(F-0030)
- ✅ **40.1.11** session.status OR 聚合(F-0030)
- ✅ **40.1.2** sub-coord nested → create-time reject(F-0031)
- ✅ **40.1.3** coordinator.agents 20 上限(F-0031)
- ✅ **20.8.0/1/3** F-0021 baseline(23-event coordinator+worker chain)

### 残留 case(Phase 4+)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 40.1.1 coordinator + 3 sub-agent | 多 child 同时 delegation 行为(顺序 / 并发?)| Med | ~100k |
| 40.1.6 共享 fs 并发写同文件 | 有锁 / 后写覆盖 / race?**需 child-agent-pool + concurrent-fs helper** | High(协议反推关键)| ~80k |
| 40.1.7-runtime coordinator interrupt | interrupt 时所有非 archived thread 行为(立刻 stop / drain) | High | ~50k |
| 40.1.8 thread 独立 system prompt | 每 thread system prompt 是 agent.system 还是 inject?(实测问"你是谁") | Med | ~30k |
| 40.1.9 thread 独立 tool 权限 | 每 thread tools 字段独立;coord 不能调用 worker 的 tool? | Med | ~30k |
| 40.1.10 lineage 字段重复验证 | 已 F-0030 部分覆盖;留作 catalog generator 用 | Low | — |
| 40.1.12 child idle 后 coord 再 message | 协议是否 allow / 触发新 thread / reject | Med | ~50k |
| **40.1.13** **(新增)** session 内 thread 数运行时上限 | per doc 25;需 multi-agent + 多 turn delegation 累积 thread 到 25 | Med | ~200k |
| **40.1.14** **(新增)** `agent.thread_context_compacted` event 触发条件 | per SDK type 存在但 F-0030 未观察到 | Low | ~50k |

**Top N(Phase 4 启动)**:40.1.6 共享 fs + 40.1.7 interrupt + 40.1.12 child idle 后再 message(3 case ~180k)

## 40.2 Memory

### What CMA does(Phase 3 已 done)

**[source: 实测 F-0027/F-0028/F-0031]**

- **资源 ID 体系**:`memstore_*`(store)/ `mem_*`(memory)/ `memver_*`(version)
- **Mount**:`/mnt/memory/<store-name>/`(sandbox 物理路径,由 store.name 派生 slug);跟 memory.path(store 内 logical `/`-prefix path)是两个不同概念
- **Access 模式**:`read_write` / `read_only`,server 在 fs 层 enforce(read_only mount agent 写入返 **POSIX EROFS** "Read-only file system")
- **OCC**:`memories.update({ precondition: { type: 'content_sha256', content_sha256 } })` mismatch → **409** `memory_precondition_failed_error`;exact-match no-op 仍 200
- **Limits**:
  - 8 memory_store / session.resources(9th → 400 `invalid_request_error` "resources cannot contain more than 8 memory_store entries")
  - **102400 bytes**(100 kB)/ memory.content,102401 → 400 `invalid_request_error` "Request validation failed"
- **Version chain**:全留 + newest-first 默认排序;`operation` 字段枚举(`created` / `modified` / `renamed` / `deleted` / `redacted`)
- **List endpoint**:
  - 默认 path 字典序倒序(deepest first)
  - `path_prefix` filter 工作(`/a/` 只返 `/a/file*.md`)
  - `depth` 参数**强制配 `order_by=path`**(单独传 → 400 "depth requires order_by=path")— **SDK type 不暴露此耦合**

### What target protocol should do(反推决策点)

| 决策 | 方向 |
|---|---|
| OCC 用 content-hash 还是 version-int | CMA 用 content_sha256;v1 **同款**(content-addressed 更稳,不依赖 monotonic counter);对照 F-0002 agent OCC 用 version int — 两个 service 不同 invariant |
| `read_only` 边界 | v1 用 capability + access 字段两层:**capability**(driver 是否支持 read_only mount)+ **access 字段**(per-mount)|
| Memory list 参数耦合 | v1 **discriminated union 类型表达**(typescript-level 强制配对),不依赖 runtime error |
| Mount 上限 / 单文件上限 | v1 **DriverCapabilities 暴露**(`MEMORY_MAX_BYTES_PER_OBJECT=102400` / `MEMORY_MAX_MOUNTS_PER_SESSION=8`),kernel 不写死 |
| Version chain 排序 / 保留策略 | v1 **协议级承诺 v1 永留 + newest-first**;保留时长是 driver capability(CMA 30 天)|
| `operation` 字段 enum | v1 同款 enum + 加 `pruned`(if v1 implements expiration)|
| Path namespace | v1 同款:**store 内 logical path**(/-prefix);mount path 是 sandbox concern,跟 service path 分离 |

### 已 done case(Phase 3)

- ✅ **40.2.1** mount + happy roundtrip + content_sha256 invariant(F-0028)
- ✅ **40.2.4** read_only EROFS(F-0028)
- ✅ **40.2.6** content_sha256 OCC 409(F-0028)
- ✅ **40.2.7** 100kB exact boundary(F-0031)
- ✅ **40.2.8** 8-mount limit(F-0028)
- ✅ **40.2.11** version chain newest-first + v1 全留(F-0028)
- ✅ **40.2.2/3** path_prefix list + depth coupling(F-0031)

### 残留 case(Phase 4+)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 40.2.5 content_sha256 match → write OK | F-0028 已隐含覆盖(no-op repeat);单独 case 价值低 | Low | — |
| 40.2.9-full path_prefix + depth + order_by=path | depth=1 rollup 实际返 `type: 'memory_prefix'` 节点;F-0031 未深探 | High | ~10k(pure API) |
| 40.2.10 list_versions cursor 稳定性 | quiescent 下二次拉取字节级一致?(类比 F-0014 events.list) | Med | ~10k |
| 40.2.12 redact 操作 | 保留审计 + 抹掉 content;`memoryVersions.redact()` 行为;`operation: 'redacted'` event 触发 | High(协议反推关键) | ~5k |
| 40.2.13 running session 不能 attach 新 memory_store | session.update 时 attach 是否 reject?409 / 400? | Med | ~5k |
| 40.2.14 跨 session 共享同一 memory_store | 2 session 同 memstore_id,A 写 + B 读立即可见?(no caching?) | High | ~30k |
| 40.2.15 `description` 字段是否注入 system prompt | agent.system 里直接含 description?还是另放?| Med | ~30k |
| **40.2.16**(新增)memory_path_conflict_error 触发 | 创建 memory at path X,再创建同 path → conflict?| Low | ~5k |
| **40.2.17**(新增)`depth=N` 与 `path_prefix` 组合(rollup 行为)| `memory_prefix` 节点形态;F-0031 残留 | Med | ~10k |
| **40.2.18**(新增)`view: 'basic'` vs `'full'` 差异 + 强制配对 | view=full + limit > 20 是否 reject(per SDK doc "caps limit at 20")| Med | ~5k |

**Top N(Phase 4 启动)**:40.2.12 redact + 40.2.14 跨 session 共享 + 40.2.9 path_prefix+depth rollup(3 case ~45k,几乎 pure API,no token)

## 40.3 Outcomes

### What CMA does(Phase 3 已 done)

**[source: 实测 F-0027/F-0029/F-0031]**

- **Trigger**:`send({ events: [{ type: 'user.define_outcome', description, rubric, max_iterations? }] })`
- **Schema**:
  - `description`: 任务描述(string)
  - `rubric`: `{ type: 'text', content }`(inline)或 `{ type: 'file', file_id }`(file API)
  - `max_iterations`: int(default 3,max 20)
- **Verdict enum 5 值**(SDK doc + F-0029 实测 4/5):
  - `satisfied`:criteria met,session goes idle(*final ack turn 仍发生*)
  - `needs_revision`:criteria not met,agent 再做一轮
  - `max_iterations_reached`:budget exhausted with criteria still unmet — **followed by one final ack turn**
  - `failed`:grader determined rubric doesn't apply to deliverables(未实测)
  - `interrupted`:user 发 interrupt 时(未实测)
- **三事件 schema**:
  - `span.outcome_evaluation_start` — 每 cycle 启动 grader
  - `span.outcome_evaluation_end` — 每 cycle 终态,含 `result`(verdict)+ `explanation`(string,数百字)+ `iteration`(0-indexed)+ `outcome_evaluation_start_id` + `usage`(`SpanModelUsage`)
  - `span.outcome_evaluation_ongoing` — heartbeat,**快任务时 0 个**(F-0029 max=3 50s 跑 0 个 ongoing)
- **Grader 严格隔离**:
  - 只看 `/mnt/session/outputs/` deliverable files
  - **不看** agent.message conversation
  - prompt injection via description 无效(F-0029 §40.3.8 实测 Haiku 主动 refuse)
- **`usage` 字段独立**:`end.usage` 是 grader 单独 LLM 调用的 input/output token(F-0029)— 跟 agent 主线 token 分账
- **Terminal 行为**:`max_iterations_reached` 后还有 1 个 model_request_start → agent.thinking → agent.message → model_request_end → thread_status_idle → session.status_idle(F-0031 §40.3.5)

### What target protocol should do(反推决策点)

| 决策 | 方向 |
|---|---|
| Grader file-based vs message-based | v1 **跟 CMA 一样 file-only**(强约束,防 prompt injection)— OutcomeService 协议显式说明 |
| Verdict enum 是否扩展 | v1 = CMA 5 值 + 可选加 `cancelled`(session 被强制 archive 中途)/ `errored`(grader 内部 fail);**`failed` 语义需明确** — "rubric 不适用" 是 grader 自评 vs system 判定 |
| Final ack turn 协议化 | v1 **显式 lifecycle event**(`outcome.final_ack_start / _end`)而非隐式;client 不需要看 agent message 时序猜 |
| Grader usage 分账 | v1 **同款独立**(audit 需要)+ kernel 把 grader cost 加入 session total cost 时**显式 source 标注** |
| Multi-cycle revision 协议 | v1 同款:`needs_revision` 后 server 把 control 还给 agent,agent message 内 server 应**注入 grader explanation hint**(F-0029 §40.3.8 实测 agent 第二轮 know 要写文件 — 说明 hint 被 inject) |
| `max_iterations` 上限 20 是 driver capability 还是 protocol | **driver capability**(`OUTCOMES_MAX_ITERATIONS_LIMIT=20`)— kernel 不写死 |
| Outcome cycle 内 agent 可不可以 `define_outcome` 嵌套? | **待测**(40.3 残留)— 反推 v1 是否 allow nested outcome |
| `explanation` 字段长度 | CMA 实测数百字;v1 显式 **upper bound**(protocol 级声明,如 2000 chars)避免 grader 跑飞 |

### 已 done case(Phase 3)

- ✅ **40.3.4** satisfied baseline(F-0029,verdict 流转 needs_revision→satisfied)
- ✅ **40.3.3** max_iterations_reached + unreachable rubric(F-0029)
- ✅ **40.3.8** grader 隔离 — agent refuse 诱骗(F-0029)
- ✅ **40.3.9** 三件套 schema + heartbeat 节奏 + `usage` 独立(F-0029)
- ✅ **40.3.5** max=1 final ack turn(F-0031)

### 残留 case(Phase 4+)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 40.3.1 minimal rubric=text(已 F-0027/F-0029 隐含) | — | Low | — |
| 40.3.2 rubric=file(先 upload file_id) | file rubric 行为对照 text(grader 怎么读 file?) | High | ~50k(含 file upload) |
| 40.3.6 矛盾 rubric → `failed` verdict | rubric 与 description 矛盾时 grader 是返 `failed`(rubric N/A)还是 `needs_revision`(criteria not met)?**协议层区分关键** | High | ~50k |
| 40.3.7 user.interrupt 中途打断 → `interrupted` verdict | grader 跑到一半 interrupt;event 时序 + verdict | High | ~30k |
| 40.3.10 Files API 取 `/mnt/session/outputs/` 输出 | 完整 outcome → file 拿回流程;**需 Files API helper** | High | ~80k |
| 40.3.11 同 session 串行跑两个 outcome | outcome_id 不同;state cross-pollution?| Med | ~100k |
| 40.3.12 同 session 并发 outcome → reject | 第二个 define_outcome 在第一个未 idle 时 send;reject 行为(409 / 400 / 静默接受?)| High | ~50k |
| **40.3.13**(新增)max_iterations=20 极限 | 实测 long-running outcome;heartbeat 节奏 + token 累计 + final ack 行为 | Low(token 高)| ~500k |
| **40.3.14**(新增)`rubric.content` 长度上限(262144 chars per SDK) | 边界:262143 OK / 262145 reject | Low | ~5k(pure API) |
| **40.3.15**(新增)outcome 嵌套(agent 在 outcome cycle 中调 define_outcome)| reject?静默接受?递归 grader? | Med | ~80k |
| **40.3.16**(新增)`failed` verdict 触发条件深探 | 多种 rubric/description 矛盾形态触发哪种 verdict | High | ~150k |

**Top N(Phase 4 启动)**:40.3.7 interrupt + 40.3.12 并发 reject + 40.3.10 Files API(3 case ~160k)

## Phase 4 启动决策 + Top N case 优选

### Phase 4 候选 Top 9(单 batch 启动)

按 ROI(协议反推价值 / token cost)排序:

| # | Case | Section | Token 估 |
|---|---|---|---|
| 1 | 40.2.12 redact 操作 | Memory | ~5k |
| 2 | 40.2.14 跨 session 共享 memory_store | Memory | ~30k |
| 3 | 40.2.9-full path_prefix + depth + order_by | Memory | ~10k |
| 4 | 40.3.12 并发 outcome → reject | Outcomes | ~50k |
| 5 | 40.3.7 user.interrupt → `interrupted` verdict | Outcomes | ~30k |
| 6 | 40.3.6 矛盾 rubric → `failed` verdict | Outcomes | ~50k |
| 7 | 40.1.6 共享 fs 并发写 | Multi-agent | ~80k |
| 8 | 40.1.7 coordinator interrupt 行为 | Multi-agent | ~50k |
| 9 | 40.1.12 child idle 后 coord 再 message | Multi-agent | ~50k |

**Phase 4 Batch 1 Top 9 总计 ~355k tokens / ~10 min wall-clock**(估)。**budget 健康**(Phase 3 全集 ~340k)。

### Phase 4 启动前补的 prep

| 项 | 必要性 | 责任 |
|---|---|---|
| `child-agent-pool` fixture(warmup 创 N 个 worker)| 40.1.* multi-agent 全需 | Phase 4 启动前 |
| Files API helper | 40.3.10 需 | 跑 40.3.10 时补 |
| concurrent-fs 测试 helper | 40.1.6 需 | 跑 40.1.6 时补 |
| Outcome budget guard | 40.3.13 max=20 极限测时需(其它 case 不需) | 跑 40.3.13 时补 |

→ **最小 prep**:child-agent-pool(其他都"跑到时再补")。

### 跨 batch 后续(Phase 5+ 候选)

- 40.3.13 max_iterations=20 极限(token 高,单独 batch)
- 40.1.13 session 内 thread 数 25 上限(需 multi-agent + 多 turn delegation)
- 40.2.18 view=full + limit cap edge

## Token 预算总结

| Phase / Batch | 估 token | 实际 token |
|---|---|---|
| Phase 3 Batch 1-4(已 done) | 估 780k | ~340k ✅ |
| Phase 4 Batch 1 Top 9(本 plan) | ~355k | TBD |
| Phase 5+ extreme(40.3.13 / 40.1.13) | ~700k | TBD |

→ **Phase 4 启动 token 风险低**(Phase 3 实证 Haiku 4.5 +紧凑 case 设计 token 远低于初估)。

## 留 v2 / 后期的 deferred 用例

- **Prompt injection via memory content**:agent 在 memory 写恶意 instruction,后续 turn 是否被 inject 到 system prompt(留 v2 security suite)
- **Long-running outcome 跨 session reauth**:6h reauth + outcome 仍在 evaluation(留 v3)
- **Multi-agent 跨 region failover**:coord/worker 不同 region(待 CMA 暴露 region 控制时)
- **Memory 30 天历史保留承诺**:wall-clock 测不实际,留 v2 long-running benchmark

## 引用

- [Phase 3 summary](../../../agentmatrix-notes/research/managed-agents/findings/phase-3-summary.md)
- [F-0027~F-0031](../../../agentmatrix-notes/research/managed-agents/findings/)
- [ADR drafts](../../../agentmatrix-notes/research/managed-agents/adr-drafts/)
