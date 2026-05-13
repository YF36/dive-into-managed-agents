# AgentMatrix-Relevant 对照测试(Phase 5 展开)

> Phase 0 骨架。Phase 5 展开。**实测结果回写 `agentmatrix-notes` repo 的 `findings/` 子目录**,作为 AgentMatrix v1 RFC 各章节"已实测"标记的支撑材料。

## 范围

针对 AgentMatrix v1 RFC 里关键 design assumption 做实测对照——文档没说 / 我们假设的部分,实测后看是否需要更新 RFC。

## 用例分组(每条对应 AgentMatrix 文档具体章节)

### 60.1 EV §1.3.2 双相 occurrence(predicted: CMA 是单相,需 client 端补丁)

- 60.1.1 多次拉同一 user.message,观察 `processed_at` 是否真的 null → timestamp 单向变化
- 60.1.2 服务端是否在 list 响应里把同一 event 返回两次(queued + processed)
- 60.1.3 客户端实现 AgentMatrix-style 双相投影的工程难度评估
- 60.1.4 结论:AgentMatrix v1 PG 单表实现 `processed_at` 单向 UPDATE 是否在 CMA 兼容层可行

### 60.2 EV §4.2 sequence vs event_id(predicted: CMA 只有 event_id,client 去重)

- 60.2.1 模拟乱序到达:stream 收到 evt_3 在 evt_2 前的情况是否真实发生
- 60.2.2 网络抖动下 event_id 是否真的唯一(打 1000 次 user.message 快速重发,验证 id 集合大小)
- 60.2.3 服务端是否暴露任何 monotonic counter / sequence(headers / event payload 检查)
- 60.2.4 客户端按 event_id 去重的真正语义边界

### 60.3 §9 fork v0 仅 event_prefix(predicted: CMA 上 replay 不可行)

- 60.3.1 尝试 list events from session A → 在 session B create 时 replay(预期:CMA 没有此 API)
- 60.3.2 备选:fork 是否可通过 GitHub repository checkout 实现(部分文件状态可继承,event log 不能)
- 60.3.3 结论:AgentMatrix v1 fork v0 只做 lineage 标注(`forked_from_event_id` 字段),不做行为替换——CMA 实测印证

### 60.4 v1 黑盒 cheat sheet §1.4 fallback 字段(AgentMatrix EV 协议)

- 60.4.1 CMA 给的 tool lifecycle 是完整 `_started / _completed` 还是只 `_completed`(对应 AgentMatrix `partial_lifecycle` 字段必要性)
- 60.4.2 `agent.thinking` 是否 streaming(单事件 vs 流式 → 对应 AgentMatrix `thinking_delta` 必要性)
- 60.4.3 tool_use_id 命名空间:CMA 是否给平台分配的 id(`evt_*`?)还是 agent runtime 自己的(`tool_*`?)
- 60.4.4 `model_request_start/end` 是否经过 CMA 自己的 model gateway(实测 usage 字段精度)
- 60.4.5 `interrupt` 行为:graceful 还是 kill(对应 AgentMatrix `capabilities.interrupt` 三态)
- 60.4.6 Hot-reload AgentSpec:create agent → update agent → 已 running session.agent 是否变(预期 snapshot,不变)

### 60.5 RH RFC vault 物理隔离(predicted: CMA 是 platform-side proxy 注入)

- 60.5.1 完整 trace:agent 调 MCP tool → outbound request 在哪一跳被注入 Authorization
- 60.5.2 sandbox 内 process tree 检查:有没有 proxy 进程驻留(对应 AgentMatrix Harness companion 模型)
- 60.5.3 sandbox 网络配置:是否走 HTTPS_PROXY env var 还是透明代理
- 60.5.4 结论:CMA 的 proxy 注入模式作为 AgentMatrix RH §25 实证数据

### 60.6 RD RFC §3.10 reconcile 独立性(predicted: CMA 不暴露 reconcile API,但可观察行为)

- 60.6.1 `rescheduling` 状态自动重试:故意让 MCP server 5xx,数 retry 次数 + 时间间隔
- 60.6.2 重试上限触发后是否 `terminated`(还是返回 idle 等用户介入)
- 60.6.3 driver crash 模拟:网络 disconnect 后会话状态 reconcile 行为
- 60.6.4 结论:AgentMatrix reconcile loop 策略参考

### 60.7 CF RFC `max_child_sessions` 类似(predicted: CMA multi-agent 25 thread 上限)

- 60.7.1 实测 25 thread 上限错误信号(error type / status code / event payload)
- 60.7.2 上限是 hard cap 还是 soft 警告
- 60.7.3 是否在 agent.create 时就 enforce(声明 callable_agents > 25)还是 runtime
- 60.7.4 结论:AgentMatrix `max_child_sessions` budget enforcement 设计参考

### 60.8 §8.6 AgentSpec immutable I1 / I2(predicted: CMA 用 `version` 显式版本化对应 I1)

- 60.8.1 CMA Agent update 行为:body 变 → version +1;no-op → version 不变 → 印证 immutable per version
- 60.8.2 已绑定旧 version 的 session 在 agent 更新后是否真的不受影响(Session.agent snapshot)→ 印证 AgentMatrix I2 latest resolve-on-create 类似
- 60.8.3 Environment 不版本化 → AgentMatrix EnvSpec 也不版本化(I2 边界一致)
- 60.8.4 结论:AgentMatrix §8.6 I1/I2 跟 CMA 模型对齐验证

### 60.9 Audit / observability(predicted: CMA 提供 span.* + Anthropic 内部 audit)

- 60.9.1 `span.model_request_*` 是否包含 cache_read / cache_creation token 拆分
- 60.9.2 是否暴露 agent 内部 thinking trace 给客户端(security boundary)
- 60.9.3 OTel 兼容性(span 是否能 export 到 user 自己的 OTel backend)
- 60.9.4 结论:AgentMatrix Audit RFC 三类信号物理分离原则的对照

## 预估用例总数

20-30 条(Phase 5 展开)

## 回写规则

每条用例实测完成后,**回写 `agentmatrix-notes/findings/` 子目录**:

- `findings/cma-double-occurrence.md`(60.1)
- `findings/cma-event-id-only.md`(60.2)
- `findings/cma-no-replay-fork-impossible.md`(60.3)
- `findings/cma-tool-lifecycle.md`(60.4)
- `findings/cma-vault-proxy.md`(60.5)
- `findings/cma-rescheduling.md`(60.6)
- `findings/cma-thread-cap.md`(60.7)
- `findings/cma-agent-version-immutable.md`(60.8)
- `findings/cma-observability.md`(60.9)

每份 findings 文件结构:背景 → AgentMatrix RFC 预期 → 实测结果 → 是否需要更新 RFC + 具体改动。
