# cma-tests · CMA 实测套件

Claude Managed Agents 实测代码,服务于 [AgentMatrix](https://github.com/...) v1 RFC 验证。

> 测试方案文档在 `../docs/test-plan/`。**先读 `00-overview.md`**。

## 实测决策(2026-05-13)

- SDK 用 **`@anthropic-ai/aws-sdk` v0.3.0**(`AnthropicAws extends Anthropic`,自动暴露完整 `beta.*` CMA surface)。**不再有 direct vs aws-platform dual-mode** —— 测试只跑 Claude Platform on AWS 这一条路径。
- 凭据来自**系统环境变量**(`ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION`),由 `.bash_profile` 注入,**不写入 .env**。
- AWS host 端 region 实测是 `ap-northeast-1`(东京);base URL 自动 `aws-external-anthropic.ap-northeast-1.api.aws`。

## Quick Start(在 AWS host 上跑)

```bash
# SSH 必须用交互式 login shell,才能读到 .bash_profile 的 env
ssh -t my-aws bash -lc 'cd ~/proj/dive-into-managed-agents/tests-cma && npm install'

# 然后:
ssh -t my-aws bash -lc 'cd ~/proj/dive-into-managed-agents/tests-cma && npm run warmup'
ssh -t my-aws bash -lc 'cd ~/proj/dive-into-managed-agents/tests-cma && npm run test'
ssh -t my-aws bash -lc 'cd ~/proj/dive-into-managed-agents/tests-cma && npm run cleanup'
```

或者 SSH 进去后交互式跑:

```bash
ssh my-aws       # 进交互式 shell,自动 source .bash_profile
cd ~/proj/dive-into-managed-agents/tests-cma
npm install
npm run warmup   # 第一次跑前:创建 long-lived test-agent / test-environment 并缓存 id
npm run test                        # Phase 0 只有 smoke
npm run test -- tests/functional    # 只跑功能测试
npm run test:slow                   # 跑 @slow 标记的 perf 用例(默认 skip)
npm run cleanup  # 收尾:archive 测试期间创建的 ephemeral 资源
```

**本地 mac 跑测试**(需要前置准备):

把 AWS host 上的 3 个 env 在本地 shell 里 export 一遍(`ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION`),然后跟 AWS 上一样跑。Cmd 跨网络出口走默认 HTTPS,不需要 AWS IMDS / IAM。

## 必须存在的系统 env

- `ANTHROPIC_AWS_API_KEY` —— AWS Console 发的 API key(**不是** `sk-ant-...` 那种)
- `ANTHROPIC_AWS_WORKSPACE_ID` —— `wrkspc_*`,workspace 标识
- `AWS_REGION` —— e.g. `ap-northeast-1`

SDK 构造时会 assert 这 3 个,缺一直接 throw。

## 目录结构

```
tests-cma/
├── src/
│   ├── client.ts             AnthropicAws 工厂(单一路径,无 dual-mode)
│   ├── fixtures/             资源工厂(agent / env / session / vault)
│   └── utils/
│       ├── stream.ts         SSE consume + client-side dedupe(CMA 无 cursor 的补丁)
│       ├── timing.ts         latency p50/p95/p99 度量
│       ├── retry.ts          529/503/504 重试封装
│       └── invariants.ts     共享断言(append-only / id 唯一 / processed_at 单调)
├── tests/
│   ├── functional/           Phase 1
│   ├── api-behavior/         Phase 1
│   ├── streaming/            Phase 2
│   ├── events/               Phase 2
│   ├── vault/                Phase 3
│   ├── multi-agent/          Phase 3(research preview)
│   ├── memory/               Phase 3
│   ├── outcomes/             Phase 3(research preview)
│   ├── performance/          Phase 4(AWS host 跑,@slow tag)
│   └── agentmatrix/          Phase 5
└── scripts/
    ├── warm-up.ts            创建 long-lived test-agent / test-environment
    └── cleanup.ts            archive 测试期间创建的所有 ephemeral 资源
```

## 资源治理

- `test-agent` / `test-environment`:long-lived,`scripts/warm-up.ts` 创建后 id 缓存到 `.warmup.json`(gitignore)
- 每个 test 创建 session 但不创建新 agent / env
- failing test 不阻塞 cleanup(`afterAll` + try/catch)
- 所有 ephemeral 资源 metadata 带 `test_run_id`,`scripts/cleanup.ts` 按这个筛选

## SSH 注意事项

SSH **非交互式**模式(`ssh my-aws "command"`)默认只跑 `.bashrc`,**不跑 `.bash_profile`**,所以读不到 export 的 env。两个解决方案:

1. **`ssh -t my-aws bash -lc 'command'`** — 强制 login shell,source `.bash_profile`
2. **把 export 移到 `.bashrc`** — 不推荐,改用户配置
3. **用 systemd / launchd 单元** — 长期 host 推荐

## 跟 AgentMatrix 的关系

每完成一个 Phase 5 用例,实测结果回写到 `agentmatrix-notes/findings/cma-*.md`,作为 AgentMatrix v1 RFC 各章节"已实测"标记的支撑材料。
