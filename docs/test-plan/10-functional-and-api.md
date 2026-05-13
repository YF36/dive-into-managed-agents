# Functional & API Behavior(Phase 1 展开)

> Phase 0 骨架。Phase 1 时把每个 section 展开成完整用例表。

## 范围

- 4 大资源 CRUD:Agent / Environment / Session / Vault(+ credential 子资源)
- 每个 endpoint 的 happy path / 边界 / 错误
- HTTP status code 实测(对比文档预期)
- request/response schema 不变量

## 关键不变量(覆盖所有 case)

- `Agent.version` 单调递增 + no-op update **不增**
- `Environment` **不版本化**(对比:Agent 有显式 `version` 字段,Environment 没有)
- `Session.agent` 是 snapshot(创建后修改 agent 不影响 session)
- `Vault credential` 的 secret 字段 **write-only**(GET 返回什么?待测)
- Archive 不可逆(`active → archived`,无 unarchive)
- Hard delete:仅 `vault` / `session`;`agent` / `environment` 只 archive
- 跨 workspace 引用一律 reject

## 用例分组(Phase 1 展开)

### 10.1 Agent CRUD(预计 12-15 条)

- 10.1.1 create with minimal fields(`model` + `name`)
- 10.1.2 create with all fields(system / tools / mcp_servers / skills / multiagent)
- 10.1.3 list + pagination cursor
- 10.1.4 retrieve specific version(query `?version=N`)
- 10.1.5 update body → version +1
- 10.1.6 no-op update → version 不变
- 10.1.7 update with stale version → 期望 409 / 412
- 10.1.8 archive → archived_at 非 null
- 10.1.9 archived agent 不能创建新 session(具体错误码待测)
- 10.1.10 metadata 上限(16 keys / 64 / 512)边界值
- 10.1.11 mcp_servers 上限 20 边界
- 10.1.12 tools 上限 128 边界
- 10.1.13 multiagent depth > 1 行为(被 reject 还是被静默 ignore)

### 10.2 Environment CRUD(预计 8-10 条)

- 10.2.1 create with `unrestricted` networking
- 10.2.2 create with `limited` networking + allow_mcp_servers / allowed_hosts
- 10.2.3 packages 字段(apt / cargo / gem / go / npm / pip)
- 10.2.4 update 部分字段(omitted 字段保留)
- 10.2.5 archive
- 10.2.6 archived env 不能创建新 session,但已 running session 继续(实测维持多久)
- 10.2.7 name 在 workspace 内唯一性
- 10.2.8 metadata 边界

### 10.3 Session CRUD(预计 12-15 条)

- 10.3.1 create with minimal(agent string + environment_id)
- 10.3.2 create with pinned agent version(`{type:"agent", id, version}`)
- 10.3.3 create with vault_ids + resources(memory_store / file / github_repository)
- 10.3.4 list + filter by status
- 10.3.5 retrieve 包含 `stats` / `usage` 字段
- 10.3.6 archive(`status` 不变,只 metadata flag)
- 10.3.7 archive 后再发 user event 的 status code
- 10.3.8 delete running session → 期望 409
- 10.3.9 delete idle session → 200 + stream close 信号
- 10.3.10 delete archived session
- 10.3.11 跨 workspace 引用 vault_id / environment_id 的错误码
- 10.3.12 Session.agent snapshot 验证(create 后 update agent,session.agent 不变)
- 10.3.13 invalid agent_id / environment_id

### 10.4 Vault + Credential CRUD(预计 15-20 条)

- 10.4.1 vault create / list / retrieve / update / archive / delete
- 10.4.2 vault archive 后再创 credential 行为
- 10.4.3 vault delete 时仍被 active session 引用 → 期望 409
- 10.4.4 credential create `mcp_oauth` 类型
- 10.4.5 credential create `static_bearer` 类型
- 10.4.6 mcp_server_url 同 vault 内唯一(冲突 409)
- 10.4.7 mcp_server_url immutable(update 改它的错误码)
- 10.4.8 secret 字段 write-only:GET 返回什么(null / masked / 不存在)
- 10.4.9 credential 上限 20/vault 边界
- 10.4.10 `mcp_oauth_validate` 三态 valid / invalid / unknown 的触发条件
- 10.4.11 archive credential
- 10.4.12 delete credential
- 10.4.13 跨 workspace 引用 vault

### 10.5 错误响应统一 schema(预计 8-10 条)

- 10.5.1 400 invalid_request_error envelope
- 10.5.2 401 authentication_error
- 10.5.3 402 billing_error
- 10.5.4 403 permission_error
- 10.5.5 404 not_found_error
- 10.5.6 413 request_too_large
- 10.5.7 429 rate_limit_error(单次触发,**不打 sustained**)
- 10.5.8 500 / 504 / 529 模拟(挑能复现的)
- 10.5.9 `request_id` 字段在 error response 里始终非空
- 10.5.10 AWS path `x-amzn-requestid` 同时出现

## 预估用例总数

60-80 条(Phase 1 一次性 ship)
