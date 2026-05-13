# cma-tests · CMA 实测套件

Claude Managed Agents 实测代码,服务于 [AgentMatrix](https://github.com/...) v1 RFC 验证。

> 测试方案文档在 `../docs/test-plan/`。**先读 `00-overview.md`**。

## Quick Start

```bash
# 1. 装依赖
npm install

# 2. 配 env
cp .env.example .env
# 编辑 .env:填 ANTHROPIC_API_KEY(direct mode)
# 或者填 AWS_ANTHROPIC_* 走 aws-platform mode

# 3. 第一次跑前 warmup(创建共享 test-agent / test-environment 并缓存 id)
npm run warmup

# 4. 跑测试
npm run test                     # 全部用例(Phase 0 只有 smoke)
npm run test -- tests/functional # 只跑功能测试
npm run test:slow                # 跑 @slow 标记的 perf 用例(默认 skip)

# 5. 收尾 cleanup(archive 测试期间创建的 ephemeral 资源)
npm run cleanup
```

## 目录结构

```
tests-cma/
├── src/
│   ├── client.ts           SDK 单例,dual-mode(direct / aws-platform)
│   ├── fixtures/           资源工厂(agent / env / session / vault)
│   └── utils/
│       ├── stream.ts       SSE consume + client-side dedupe(CMA 无 cursor 的补丁)
│       ├── timing.ts       latency / p50/p95/p99 度量
│       ├── retry.ts        529/503/504 重试封装
│       └── invariants.ts   共享断言(append-only / id 唯一 / processed_at 单调)
├── tests/
│   ├── functional/         Phase 1
│   ├── api-behavior/       Phase 1
│   ├── streaming/          Phase 2
│   ├── events/             Phase 2
│   ├── vault/              Phase 3
│   ├── multi-agent/        Phase 3(research preview)
│   ├── memory/             Phase 3
│   ├── outcomes/           Phase 3(research preview)
│   ├── performance/        Phase 4(AWS host 跑,@slow tag)
│   └── agentmatrix/        Phase 5
└── scripts/
    ├── warm-up.ts          创建 long-lived test-agent / test-environment
    └── cleanup.ts          archive 测试期间创建的所有 ephemeral 资源
```

## Mode 切换

```bash
# direct(默认,本地开发)
CMA_MODE=direct npm run test

# aws-platform(AWS host)
CMA_MODE=aws-platform npm run test
```

两个 mode 跑**同一份代码**。两 mode 结果有差异时,差异本身就是有价值的测试结果——记录到 `docs/test-plan/00-overview.md` 决策记录段。

## 资源治理

- `test-agent` / `test-environment`:long-lived,`scripts/warm-up.ts` 创建后 id 缓存到 `.warmup.json`(gitignore)
- 每个 test 创建 session 但不创建新 agent / env
- failing test 不阻塞 cleanup(`afterAll` + try/catch)
- 所有 ephemeral 资源 metadata 带 `test_run_id`,`scripts/cleanup.ts` 按这个筛选

## 跟 AgentMatrix 的关系

每完成一个 Phase 5 用例,实测结果回写到 `agentmatrix-notes/findings/cma-*.md`,作为 AgentMatrix v1 RFC 各章节"已实测"标记的支撑材料。
