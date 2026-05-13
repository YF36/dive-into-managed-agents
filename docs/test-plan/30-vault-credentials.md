# Vault & Credentials(Phase 3 展开)

> Phase 0 骨架。Phase 3 展开。**非破坏性测试**——不做 prompt injection,留 v2 独立 security suite。

## 范围

- 凭证注入边界(token 物理不进 sandbox)
- 多 vault first-match-wins 顺序语义
- OAuth refresh 自动机制
- `mcp_oauth_validate` 三态
- secret write-only 在 GET 响应里的实际形态
- 跨 workspace 引用

## 关键不变量

- vault token plaintext **永不出现** 在 sandbox 内任何可见处(env / argv / `/proc/*/environ` / 文件 / network capture)
- vault secret 字段在 GET 响应里 **不返回 plaintext**(具体是 null / masked / 缺字段待测)
- 跨 workspace 引用一律 reject
- `mcp_server_url` immutable

## 用例分组(Phase 3 展开)

### 30.1 凭证注入物理隔离(预计 6-8 条)

非破坏性方式(不做 prompt injection,只问 agent 自己看到什么):

- 30.1.1 起一个 echo MCP server,验证 agent 调用时 Authorization header 实际含 vault token(server 端 log)
- 30.1.2 agent 在 sandbox 内跑 `env`,验证输出不含 vault token plaintext
- 30.1.3 agent 跑 `cat /proc/self/environ`,同上
- 30.1.4 agent 跑 `ps auxe`,验证其他进程环境也不含
- 30.1.5 agent 跑 `cat /etc/hosts`,验证不解析 MCP server 的 host(走 proxy)
- 30.1.6 agent 用 curl 直接打 MCP server URL,验证不带 Authorization 时 401(只有走 platform proxy 才注入)
- 30.1.7 git push/pull 用 GitHub resource:验证 git remote 不含 token(`.git/config` 应该不含 plaintext)
- 30.1.8 prompt injection v2 占位(详见 v2 security suite)

### 30.2 多 vault first-match-wins(预计 4-6 条)

文档说"多个 vault 命中同一 MCP server URL 时 first match wins",但**没说 "first" 指什么**:

- 30.2.1 vault A 创建早于 vault B,session 创建时 `vault_ids: [A, B]`,验证用 A 的 token
- 30.2.2 同上但 `vault_ids: [B, A]`,验证是数组顺序决定还是创建时间决定
- 30.2.3 用 `vault_ids: [B]` 只引 B,验证 B 的 token 被用
- 30.2.4 两个 vault token 不同但都 valid,验证哪个被用(MCP server 端 log)
- 30.2.5 first vault token 失效,fallback 行为(error / 自动用 second / 全 fail)

### 30.3 OAuth refresh 自动机制(预计 3-4 条)

- 30.3.1 配 short-lived refresh token,等过期后再调 MCP tool,验证 Anthropic 自动 refresh(无需 user 介入)
- 30.3.2 refresh 失败的事件:文档说"emits `vault_credential.refresh_failed` webhook" —— 验证是否真发(若 webhook 配了 endpoint)
- 30.3.3 `token_endpoint_auth.type` 三种(`none` / `client_secret_basic` / `client_secret_post`)各跑一次,验证 refresh path 都通

### 30.4 `mcp_oauth_validate` 三态(预计 3 条)

- 30.4.1 valid credential → `valid`
- 30.4.2 expired credential → `invalid`(还是 `unknown`?实测)
- 30.4.3 未 authenticate 的 credential(刚创建未触发 OAuth flow)→ `unknown`

### 30.5 Secret write-only(预计 3 条)

- 30.5.1 GET credential 后 `token` 字段:null / masked / 字段缺失,实测
- 30.5.2 list credentials 时 secret 字段同样不返回
- 30.5.3 update credential 改 secret(允许)+ 改 mcp_server_url(reject)

### 30.6 跨 workspace 引用(预计 2-3 条)

- 30.6.1 workspace A 的 vault_id 在 workspace B 创 session,期望 403 / 404
- 30.6.2 workspace 删除后 vault 的命运(文档未明说)

## 预估用例总数

25-35 条(Phase 3 展开)

## 留 v2 的 deferred 用例(security suite)

- Prompt injection 试图让 agent 读出 vault token
- Sandbox escape 试图通过 proxy hijack 拿 token
- 长时间 session 内 token rotation 的连贯性
- 跨 region failover 时的 vault 可用性
