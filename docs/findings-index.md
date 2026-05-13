# Findings Index(跨 repo 轻索引)

> Finding 的权威位置在 [agentmatrix-notes/research/managed-agents/findings/](https://github.com/agentmatrix-labs/agentmatrix-notes/tree/main/research/managed-agents/findings)。这份索引列**本 repo 测试用例产出的所有 finding ID + topic**,便于跑测试时不切 repo 就能看"产出了什么"。
>
> 详细的 finding 工作流和 template:[`PRODUCTS.md`](./PRODUCTS.md) + agentmatrix-notes 的 findings/ README。

## Index(Phase 推进时追加)

| ID | Topic | Triggered by case | Affects AgentMatrix RFC? | Status |
|---|---|---|---|---|
| F-0001 | Session lifecycle event 顺序 | `tests-cma/tests/functional/smoke.test.ts` | EV §1.3.2 / §5.2 / §6.1 / §6.2 / §8 | **Verified** — 9 events / user.message 单 occurrence / Haiku 默认发 agent.thinking / CMA 即使单 agent 也发 thread events;run `01KRG59Y75YAB7G6T768BYQ0PS`(2026-05-13) |

(Phase 1+ 用例会追加更多 finding)

## 怎么找 finding 内容 + raw artifact

```bash
# agentmatrix-notes repo(finding 正文 + raw artifact 长期归宿)
cd ../agentmatrix-notes/research/managed-agents/findings/
ls F-*.md

cd ../artifacts/<date>/<run_id>/<case-id>/
# events.jsonl / http.jsonl / marks.json / metadata.json

# 本 repo(测试代码)
cd dive-into-managed-agents/tests-cma/
# tests-cma/artifacts/ 是 fallback(若 agentmatrix-notes 没 clone),gitignored
```

**为什么 artifact 在 agentmatrix-notes**:见 [`PRODUCTS.md` §6](./PRODUCTS.md#6-为什么这样切)——raw 数据是不可重生的设计资产,AWS 回收后丢了就丢了,必须 commit 到 knowledge base repo。
