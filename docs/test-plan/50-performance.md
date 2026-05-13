# Performance(Phase 4 展开)

> Phase 0 骨架。Phase 4 展开。**在 AWS host 上跑**(用户决策:AWS 是 long-running benchmark 常驻 host)。**低成本前提**:token 单次 < 1k,wall clock < 30s,不打 rate limit。

## 范围

- API endpoint 延迟基线(p50 / p95 / p99)
- SSE TTFE(time to first event)
- 端到端 turn latency(user.message → agent.message_complete)
- events.list 分页性能
- 客户端去重的 CPU / 内存开销
- 冷启动 vs 热启动差异

## 关键不变量

- SSE TTFE 在 simple prompt 下 < 2s(p50);< 5s(p95)
- events.list cursor 分页延迟 O(1)(不随 offset 增长)
- 同 endpoint 在冷启动 / 热启动 / SDK retry 触发等条件下,延迟分布无系统性退化(p99 不该突然 10x p50)

## 对比维度(AWS endpoint 内部 — 不再有 dual-mode 对比)

- **Region**:本次 host (`ap-northeast-1`) 单 region。v2+ 跨 region 对比需要额外 host(留 v2)
- **冷启动 vs 热启动**:同 session 复用 vs 每次 create,sandbox 是否预热
- **SDK retry**:529 / 503 / 504 触发时,SDK auto-retry 的实际延迟开销
- **Host 网络**:`ping aws-external-anthropic.{region}.api.aws` 抖动 baseline,排除网络噪音
- **批 size**:`events.list` limit=10/50/100 各档延迟形态

## 测试方法

### 51. 测量框架

- `src/utils/timing.ts` 提供 `measureLatency(fn, n=100)` helper,返回 p50/p95/p99/mean/std(用 nearest-rank,见 L2 修复)
- 每个 case 跑 100 次取分布,warm-up 5 次丢弃
- 同 case 跨"对比维度"(见上 region / 冷热 / retry / 批 size)跑出多份分布,记录对比
- 跑出来的数据写到 `tests-cma/perf-results/<date>.json`,长期对比追踪

### 52. 跑环境

- AWS host,跟 workspace 同 region
- 跑前确认网络稳定(`ping api.anthropic.com` 抖动 < 10ms)
- 跑前 cleanup 所有 ephemeral test resource(避免影响 SDK fixture)

## 用例分组(Phase 4 展开)

### 50.1 API endpoint 延迟基线(预计 8-12 条)

- 50.1.1 `agents.list` n=100,记录 p50/p95/p99
- 50.1.2 `agents.retrieve`(已存在)
- 50.1.3 `agents.create` n=20(create 限制 300 rpm,n 不能太大)
- 50.1.4 `environments.create` n=20
- 50.1.5 `sessions.create` n=50
- 50.1.6 `sessions.retrieve` n=100
- 50.1.7 `sessions.events.send` n=100(发 user.message + ack timing)
- 50.1.8 `sessions.events.list` limit=10 n=100
- 50.1.9 `sessions.events.list` limit=100 n=100
- 50.1.10 vault create / retrieve / list 各 n=50

### 50.2 SSE TTFE 与端到端 latency(预计 5-8 条)

- 50.2.1 TTFE:`stream.open()` → 第一个 event 的时间(空 prompt)
- 50.2.2 TTFE:open → `session.status_running` 的时间(send user.message 后)
- 50.2.3 端到端 simple turn:user.message → agent.message → status_idle 总时长(prompt = "ping",no tool)
- 50.2.4 端到端 with bash tool:agent 跑 `echo hello` 工具的延迟
- 50.2.5 端到端 with MCP tool:agent 调用 echo MCP server 的延迟
- 50.2.6 token 流的 inter-event interval(agent.message 多个 block 之间)
- 50.2.7 大 prompt(10k tokens)的 TTFE 差异
- 50.2.8 长输出(2k tokens)的总延迟

### 50.3 events.list 分页性能(预计 4-6 条)

- 50.3.1 准备:跑一个 ~500 event 的 session(简短消息循环)
- 50.3.2 limit=10 全分页拉取的总延迟
- 50.3.3 limit=50 全分页
- 50.3.4 limit=100 全分页
- 50.3.5 cursor 跳到第 10 / 50 / 100 页的单次 latency 是否一致(O(1) 验证)
- 50.3.6 desc order 跟 asc order 的性能差异

### 50.4 客户端去重 CPU/内存开销(预计 3-4 条)

模拟 reconnect 时按 event_id 维护 Set 的开销:

- 50.4.1 1k events:Set 维护 + dedupe 总 CPU 时间
- 50.4.2 10k events:同上
- 50.4.3 100k events:Set 内存 footprint
- 50.4.4 用 Bloom filter / LRU 替代 Set 的取舍(Phase 5 可选优化)

### 50.5 冷启动 vs 热启动(预计 3-5 条)

- 50.5.1 同 agent 反复 create session,第 1 / 2 / 5 / 10 次 sandbox cold start 是否复用
- 50.5.2 第一个 user.message 的 TTFE 在冷 / 热下差异
- 50.5.3 sandbox 是否预热(create session 后立即发 user vs 等 30s 再发)

## 预估用例总数

15-25 条(Phase 4 展开)

## 默认 skip 与显式触发

所有 perf test 加 `@slow` tag。本地默认不跑。在 AWS host 上显式触发:

```bash
npm run test:slow                              # 跑 tests/performance
# 或
vitest run tests/performance --reporter=verbose
```

## 结果存档

- `tests-cma/perf-results/<YYYY-MM-DD>-<region>-<dimension>.json`(按 region / 对比维度分文件,例 `2026-05-13-apne1-cold.json` vs `2026-05-13-apne1-warm.json`)
- 长期对比可用 simple Python / TS 脚本画图(Phase 5+ 考虑)
