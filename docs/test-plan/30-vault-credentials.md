# Vault & Credentials(Phase 3+ 协议研究计划)

> **2026-05-15 升级**:从"功能测试清单"升级到"协议研究计划"。Phase 1 已 done F-0008(write-only secret + URL unique 409 + immutable + 20 cred/vault 上限)+ F-0009(`vault.delete` 不检查 active session ref);Phase 2 F-0019 印证 MCP unreachable → fast-fail single-event session.error(无 retries / rescheduled)。Phase 3 实测主体没碰 vault(Batch 4 用 boundary 替换);本文档 fold-in 已知 baseline + 把残留 case 按"What CMA does + What target protocol should do"重组。
>
> **关键依赖**:Phase 4 Vault 高级实测 80% 需要 **mock MCP server**(F-0019 印证 .invalid URL fast-fail 跳过 retry path)— 本 plan §30.0 prep 详细列 mock MCP contract。
>
> 已 done finding:[F-0008](../../../agentmatrix-notes/research/managed-agents/findings/F-0008-vault-credential-invariants.md) / [F-0009](../../../agentmatrix-notes/research/managed-agents/findings/F-0009-vault-delete-no-session-ref-check.md) / [F-0019](../../../agentmatrix-notes/research/managed-agents/findings/F-0019-mcp-unreachable-triggers-session-error.md)。

## 范围 / 反推目标

每个 sub-section 必须回答**两类问题**(同 §20 / §40 套路):

| 类别 | 形态 |
|---|---|
| **What CMA does** | 实测客观刻画(secret 字段行为 / token 注入边界 / multi-vault 顺序 / OAuth 时序) |
| **What target protocol should do** | 反推决策(借鉴 / 增强 / 拒绝跟随 / 在 adapter 层补) |

第二类沉淀到 sibling notes repo `research/managed-agents/findings/` + ADR draft。

## 关键不变量(Phase 1 + Phase 2 已 verified + Phase 4 待测)

| 不变量 | 验证 | 状态 |
|---|---|---|
| Vault create 时无 secret 字段(write-only)| F-0008 | ✅ |
| `credential.url` 在 workspace 内 unique;重复 → 409 | F-0008 | ✅ |
| Credential `mcp_server_url` 不可更新(immutable)| F-0008 | ✅ |
| Credential ≤ 20 / vault(21st → 400)| F-0008 | ✅ |
| `vault.delete` **不检查** active session 引用;session 持有 dangling vault_id | F-0009 | ✅(推翻假设)|
| `vault_id` / `credential_id` 格式校验在 lookup 前(invalid format → 400)| F-0010 | ✅ |
| MCP unreachable(`.invalid` host)→ 即 `session.error` fast-fail,**不**触发 retries / rescheduled | F-0019 | ✅ |
| Vault token plaintext **永不出现** 在 sandbox 内 env / argv / `/proc/*/environ` / 文件 / network capture | **Phase 4 待测** | ⏳ |
| `secret` 字段在 GET / list response 里:null / masked / 字段缺失 | **Phase 4 待测**(F-0008 验证 write-only,但未深探 read 返什么)| ⏳ |
| Multi-vault first-match-wins 顺序(数组 vs 创建时间 vs 字典序)| **Phase 4 待测**(需 mock MCP)| ⏳ |
| `mcp_oauth_validate` 三态(`valid` / `invalid` / `unknown`)触发条件 | **Phase 4 待测**(需真 OAuth)| ⏳ |
| 跨 workspace 引用 → 403 / 404 | **Phase 4 待测**(需 2 workspace 或 cross-token,可能 single-workspace 限制不可测)| ⏳ |
| OAuth refresh 自动 + `vault_credential.refresh_failed` webhook | **Phase 4 待测**(需 short-lived token + webhook endpoint)| ⏳ |

## 与目标 vault 协议的关键问题映射

实测要回答下列设计问题(每条对应 sub-section):

| 问题 | sub-section | 决策选项 |
|---|---|---|
| Vault token 注入是 **proxy 层** 还是 **inject 进 sandbox env**? | 30.1 | CMA: proxy-only(agent 必须经 platform proxy)— v1 跟 CMA 一致(security model 强约束) |
| Multi-vault 顺序语义 | 30.2 | CMA 文档 "first-match-wins" 模糊 — 实测 (a) 数组顺序 / (b) 创建时间 / (c) 字典序 / (d) 随机;反推 v1 是否要 explicit `priority` 字段 |
| OAuth refresh 是 driver capability 还是 protocol? | 30.3 | CMA: driver-side 自动;v1 `OAUTH_AUTO_REFRESH` capability flag 暴露 |
| `mcp_oauth_validate` 三态是否进协议? | 30.4 | v1 是否定义 `CredentialState` enum,或留 driver 各自决定 |
| Secret read response 字段策略 | 30.5 | (a) null(CMA 实测候选)/ (b) masked string(`****abc`)/ (c) 字段不存在 — 反推 v1 选哪种 |
| 跨 workspace 引用 status code | 30.6 | 404(资源不存在)vs 403(权限拒绝)— v1 协议规定 |
| `vault.delete` referential integrity | (F-0009 已答)| CMA: 不检查 — **推翻假设**;v1 是否 enforce cascade / soft-delete |
| MCP unreachable error envelope | (F-0019 已答)| CMA: fast-fail single-event;v1 同款 vs reschedule path |
| Webhook 是否进 v1 协议? | 30.3 + 30.4 | CMA: `vault_credential.refresh_failed` webhook;v1 是否定义统一 lifecycle webhook |
| OAuth `token_endpoint_auth` 三种(`none` / `client_secret_basic` / `client_secret_post`)差异 | 30.3 | 实测 refresh path 是否都通,v1 driver capability |

## 研究产物 + 证据格式

沿用 §20 / §40:

```
sibling notes repo (research/managed-agents/)/
├── event-corpus/                       ★ Phase 4+ 新增
│   ├── vault-token-injection-proxy/      (30.1 capture)
│   ├── multi-vault-first-match/          (30.2 capture)
│   ├── mcp-oauth-validate-three-state/   (30.4 capture)
│   └── ...
├── artifacts/<date>/<run_id>/...
└── findings/
    ├── F-0008 Vault baseline               ✅ done(Phase 1)
    ├── F-0009 vault.delete no ref check    ✅ done(Phase 1)
    ├── F-0019 MCP unreachable fast-fail    ✅ done(Phase 2)
    └── (Phase 4+ 残留 findings)
```

事实可信度标注:`[source: official docs | SDK type | 实测 | hypothesis]`。

## 30.0 测试基础设施 prep

§30 实测 80% 依赖外部 prep(mock MCP / OAuth dev app / webhook endpoint):

| 项 | 工作 | 文件 | 难度 / 状态 |
|---|---|---|---|
| Mock MCP server(详见 §30.0.A)| 公网 HTTPS endpoint + token validator + 配置 happy / 5xx / timeout / OAuth refresh 三种行为 | 部署独立 host(EC2 / Fly.io / Vercel)| **HIGH** — Phase 4 启动前 |
| OAuth dev app(详见 §30.0.B)| 实施 `/authorize` + `/token` + refresh endpoint;short-lived access token 用于测 refresh path | 同上 host 内 | **HIGH** |
| Webhook receiver(详见 §30.0.C)| 接 `vault_credential.refresh_failed` etc.;dump 到 file 供测试断言 | 同上 host 内 | **MED** |
| Vault sandbox probe helper(详见 §30.0.D)| agent 跑 `env / proc / ps / cat /etc/hosts / curl`,自动 redact 校验输出 | `tests-cma/src/utils/vault-probe.ts`(新增)| **LOW** — 跑 30.1 时补 |
| MCP server token log streaming(详见 §30.0.E)| mock MCP 写 access log,测试代码读 log 验证 Authorization header 实际值 | mock MCP host 内 | **MED** |
| 2 workspace fixture | §30.6 跨 workspace 测;需要 2 个 ANTHROPIC_AWS_WORKSPACE_ID(可能不可得)| n/a | **GATED** — 取决于 AWS workspace 申请 |

### 30.0.A Mock MCP server contract

**部署要求(per F-0019 已 verify)**:
- **必须公网 HTTPS reachable**(Anthropic 侧调用,loopback / VPN 不通)
- 路径需 random token 防 brute force(`/mcp/<32-char-token>`)
- **证书 valid**(Let's Encrypt 等)— self-signed 不行(Anthropic SDK 不接受)

**支持 endpoint / 行为(per MCP spec)**:
- `/mcp/echo` — 收 tool call,返 input 原样(无 OAuth,**最 minimal 验证 token injection**)
- `/mcp/5xx` — 永远返 500(测 §20.5.3 retries_exhausted)
- `/mcp/timeout` — 30s 后才返(测 timeout 行为)
- `/mcp/oauth` — 完整 OAuth dance(per §30.3)

**Authentication**:
- Header `Authorization: Bearer <vault_token>` 必带(验证 token injection)
- token validator 写 access log 含 `Authorization` value(redact 后)

**日志格式**(便于测试代码断言):
```jsonc
{
  "ts": "2026-05-15T...",
  "path": "/mcp/echo",
  "auth_header": "Bearer sk-vault-...REDACTED-LAST-4-1234",
  "request_id": "req_*",
  "client_ip": "..."
}
```

**部署文档**:留 `dive-into-managed-agents/mock-mcp/README.md` 详写部署(Phase 4 启动前补)。

### 30.0.B OAuth dev app contract

实施 OAuth 2.0 server side(`response_type=code`):
- `/oauth/authorize` — 跳一个 simple consent UI(测试自动 accept)
- `/oauth/token` — 颁发 access token + refresh token
- **Access token TTL = 60s**(快过期触发 refresh path)
- **Refresh token TTL = 24h**
- 支持 `token_endpoint_auth` 三种:`none` / `client_secret_basic` / `client_secret_post`

测试代码用 `mcp_oauth_validate` 验证三态(`valid` / `invalid` / `unknown`)。

### 30.0.C Webhook receiver contract

公网 HTTPS endpoint(可跟 mock MCP 同 host),接收:
- `vault_credential.refresh_failed`(per CMA doc)
- `vault_credential.refresh_succeeded`(假设)
- `vault_credential.expired`(假设)

存 payload 到 `webhook-log.jsonl`,测试代码 poll 读断言。

注:webhook 配置在 workspace level,需 `ANTHROPIC_AWS_WORKSPACE_ID` 有 webhook config 权限(可能 gated)。

### 30.0.D Vault sandbox probe helper contract

agent system prompt 注:"按测试代码 user.message 指令执行 shell 命令,把完整 stdout 返回。不要私自截断 / 隐藏。"

测试代码发指令(每条独立 turn 或合并):
```bash
env | sort                                            # 30.1.2
cat /proc/self/environ | tr '\0' '\n'                 # 30.1.3
ps auxe | head -20                                    # 30.1.4
cat /etc/hosts                                        # 30.1.5
curl -s -o /dev/null -w '%{http_code}' <mcp-server>   # 30.1.6
```

**自动校验**:测试代码用正则 / 字符串 contain 检查 stdout **不含** `vault_token` plaintext(测试代码自己持有 expected token 字符串,grep 之)。

### 30.0.E MCP server token log streaming

测试代码 spawn child(或 SSH tail)读 mock MCP server access log,断言 Authorization header 收到的 token 跟 vault credential `secret` 一致(测试代码持有 plaintext,跟 redacted log 比 last 4 chars)。

## 30.1 凭证物理隔离

### What CMA does(Phase 2 已 done partial)

**[source: 实测 F-0019(MCP unreachable)+ 待 Phase 4 实测]**

- **Phase 2 F-0019**:`.invalid` URL 触发 session.error fast-fail;**vault 没机会注入**(因为 MCP setup 阶段就 fail)
- 推测(待 Phase 4 实测):**proxy-only injection** — agent 在 sandbox 内通过 platform proxy 调用 MCP server,token 在 proxy 层注入 Authorization header,**plaintext 不进 sandbox process env**

### What target protocol should do

| 决策 | 方向 |
|---|---|
| 注入边界 | v1 同 CMA — **proxy-only**(agent 必须经 platform proxy 才有 token);v1 RH RFC §25 vault 物理隔离假设印证 |
| 实施层 | proxy 是 driver-level(每 driver 自管)— kernel 不直接处理 vault plaintext |
| `Authorization` header 形态 | 标准 `Bearer <token>`(per OAuth 2.0)— v1 不发明私有 scheme |

### Phase 4 case(全部 ⏳ 待测)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 30.1.1 mock MCP echo + 验证 Authorization header 实际含 token(MCP server log 比对)| proxy 注入是否真发生 | **High** | ~30k |
| 30.1.2 agent 跑 `env` — 验证 stdout 不含 vault token plaintext | env vars 边界 | **High** | ~10k |
| 30.1.3 agent 跑 `cat /proc/self/environ` — 同上 | /proc 边界 | **High** | ~10k |
| 30.1.4 agent 跑 `ps auxe` — 验证其他进程 env 也不含 | 进程间隔离 | Med | ~10k |
| 30.1.5 agent 跑 `cat /etc/hosts` — 验证不解析 MCP server host(走 proxy)| 网络层 indirection | Med | ~5k |
| 30.1.6 agent 直接 curl MCP server URL(绕 proxy)→ 期望 401(无 token)| proxy-only 强制 | **High** | ~10k |
| 30.1.7 git push/pull 用 GitHub resource — 验证 `.git/config` 不含 plaintext token | git resource(若 CMA 支持)| Low | ~30k |
| 30.1.8 prompt injection 试图让 agent 读出 vault token | v2 留 deferred(security suite)| Defer | — |

**Top N(Phase 4 启动)**:30.1.1 + 30.1.2 + 30.1.3 + 30.1.6(4 case ~60k);**需 mock MCP server + sandbox probe helper**。

## 30.2 Multi-vault first-match-wins

### What CMA does

**[source: official docs;Phase 4 实测全待]**

- 文档说"多个 vault 命中同一 MCP server URL 时 first match wins"
- **"first" 含义未文档化** — 数组顺序?创建时间?字典序?

### What target protocol should do

| 决策 | 方向 |
|---|---|
| Priority 表达 | v1 加 explicit `priority` 字段(int)或 `selection_order` enum;**不依赖** implicit order(创建时间 / 数组顺序)|
| Fallback 行为 | v1 显式:first vault token 失效 → fallback 到 second 还是 error?**协议级定义** |

### Phase 4 case(全部 ⏳ 待测,需 mock MCP)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 30.2.1 vault A 创建早于 B,`vault_ids: [A, B]` — 哪个被用? | 数组顺序 vs 创建时间 | **High** | ~30k |
| 30.2.2 `vault_ids: [B, A]`(数组反序)— 数组决定还是创建时间决定? | 区分 (a)(b) | **High** | ~30k |
| 30.2.3 单 `vault_ids: [B]` — B token 被用 | sanity | Low | ~10k |
| 30.2.4 两 vault token 不同 + 同 MCP URL — log 看哪个 | server 端 verify | Med | ~30k |
| 30.2.5 first vault token 失效 fallback 行为(error / 自动用 second / 全 fail)| fallback 协议 | High | ~30k |

**Top N(Phase 4 启动)**:30.2.1 + 30.2.2 + 30.2.5(3 case ~90k);**需 mock MCP server**。

## 30.3 OAuth refresh

### What CMA does

**[source: official docs + SDK type;Phase 4 实测全待]**

- 文档:Anthropic 自动 refresh OAuth credential(user 不介入)
- `vault_credential.refresh_failed` webhook 发(per doc)
- `token_endpoint_auth` 三种:`none` / `client_secret_basic` / `client_secret_post`

### What target protocol should do

| 决策 | 方向 |
|---|---|
| Auto refresh 是 capability 还是 protocol | `OAUTH_AUTO_REFRESH` driver capability flag — kernel 不写死 |
| Refresh failure 通知 | v1 定义统一 `credential.refresh_failed` lifecycle event + webhook(对照 ADR-0006 lifecycle taxonomy) |
| `token_endpoint_auth` 支持矩阵 | DriverCapability 暴露 supported auth methods |

### Phase 4 case(全部 ⏳ 待测,需 OAuth dev app)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 30.3.1 short-lived access token 过期 + 再调 MCP tool — 自动 refresh? | auto-refresh 行为 | **High** | ~30k |
| 30.3.2 webhook `vault_credential.refresh_failed` 实测发否 | webhook 协议 | High | ~10k |
| 30.3.3 `token_endpoint_auth` 三种各跑一次 — refresh path 都通? | auth method 矩阵 | Med | ~30k |
| **30.3.4**(新增)refresh 进行时 agent 再调 MCP tool — 阻塞 / 失败 / 队列? | concurrent refresh 行为 | Low | ~30k |

**Top N**:30.3.1 + 30.3.2(2 case ~40k);**需 OAuth dev app + webhook receiver**。

## 30.4 mcp_oauth_validate 三态

### What CMA does

**[source: SDK type;Phase 4 实测全待]**

- `mcp_oauth_validate()` 返 `valid` / `invalid` / `unknown`
- 触发条件未文档化(`unknown` 是 "never authenticated" 还是 "transient error"?)

### What target protocol should do

| 决策 | 方向 |
|---|---|
| `CredentialState` enum 进协议 | v1 显式定义 enum + 各 state 触发条件 |

### Phase 4 case

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 30.4.1 valid credential → `valid` | sanity | Low | ~5k |
| 30.4.2 expired credential → `invalid` 还是 `unknown`? | enum 语义 | **High** | ~5k |
| 30.4.3 未 authenticate(刚创建未触发 OAuth flow)→ `unknown` | 状态语义 | **High** | ~5k |

**Top N**:全 3 case ~15k(纯 API,no agent turn)。

## 30.5 Secret API 行为(Phase 1 partial done)

### What CMA does(Phase 1 已 done)

**[source: 实测 F-0008]**

- Vault create 时 `secret` 字段是 write-only — create response 不返回 plaintext
- F-0008 没单独验证 GET response 里 `secret` 字段是 null / masked / 缺失

### What target protocol should do

| 决策 | 方向 |
|---|---|
| Secret read response 字段 | (a) `secret: null`(显式 null,字段存在)/ (b) `secret: "****abc"` masked / (c) 字段不存在 — v1 选 (a)(client 知道字段存在但不可读);**实测 CMA 选哪种** |
| Update 改 secret | v1 allow(per F-0008 partial)— 但需测 mcp_server_url update reject 行为 |

### Phase 4 case(small)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 30.5.1 `vaults.credentials.retrieve(...)` — `secret` 字段形态 | null / masked / 缺失 | **High** | ~5k(pure API)|
| 30.5.2 `vaults.credentials.list(...)` — secret 字段形态 | list view 一致性 | High | ~5k |
| 30.5.3 update credential 改 secret(allow)+ 改 mcp_server_url(reject 400)| immutable 边界 | Med | ~5k |
| **30.5.4**(新增)create credential omit secret(invalid?)| required field | Low | ~5k |

**Top N**:全 4 case ~20k(纯 API)。**不依赖 mock MCP**,可独立跑。

## 30.6 跨 workspace 引用

### What CMA does

**[source: hypothesis;Phase 4 实测 gated]**

- 工 A workspace 的 vault_id 在 workspace B 创 session → 期望 403 / 404 / 其他?

### What target protocol should do

| 决策 | 方向 |
|---|---|
| status code | v1 显式 — 404(资源不存在,跨 workspace 视角)更 RESTful;403 暴露 workspace 边界泄密 |
| Workspace delete 时 vault 命运 | v1 显式 — cascade vs orphan |

### Phase 4 case(gated 依赖 2 workspace)

| Case | 研究问题 | 优先 | Token 估 |
|---|---|---|---|
| 30.6.1 workspace A vault_id 在 workspace B 创 session → status code | 跨 boundary error | High | ~5k(pure API)|
| 30.6.2 workspace delete 后 vault 命运 | cleanup behavior | Med | ~5k |

**Top N gated**:取决于是否能拿到第 2 个 workspace token(可能 single-workspace 限制不可测);若不可,加 cross-token verification 测同款(用 2 个 API key 但同 workspace)。

## Phase 4 启动决策 + Top N case 优选

### Phase 4 §30 Top N(按 ROI 排序)

| # | Case | Section | 依赖 prep | Token 估 |
|---|---|---|---|---|
| 1 | 30.5.1 secret 字段 GET 形态 | API only | 无 | ~5k |
| 2 | 30.5.2 secret 字段 list 形态 | API only | 无 | ~5k |
| 3 | 30.5.3 update secret allow + url reject | API only | 无 | ~5k |
| 4 | 30.4.1/2/3 mcp_oauth_validate 三态 | API only | 无 | ~15k |
| 5 | 30.1.6 agent 直接 curl MCP URL → 401 | sandbox | Mock MCP | ~10k |
| 6 | 30.1.1 mock MCP echo + Authorization 验证 | sandbox + MCP log | Mock MCP | ~30k |
| 7 | 30.1.2 env probe | sandbox | Mock MCP | ~10k |
| 8 | 30.1.3 /proc probe | sandbox | Mock MCP | ~10k |
| 9 | 30.2.1 multi-vault array order | sandbox + MCP log | Mock MCP | ~30k |
| 10 | 30.2.2 multi-vault reverse order | sandbox + MCP log | Mock MCP | ~30k |
| 11 | 30.2.5 fallback when first fails | sandbox + MCP log | Mock MCP | ~30k |
| 12 | 30.3.1 auto refresh | sandbox | OAuth dev app | ~30k |
| 13 | 30.3.2 refresh_failed webhook | sandbox + webhook | OAuth dev + webhook | ~10k |

**Phase 4 §30 Top 13 总计 ~220k tokens**(不含 mock MCP 部署时间)。

### 启动 phase 划分

**Phase 4 §30-A(no mock MCP dependency)**:cases #1-#4(secret API + oauth_validate),~25k tokens,**1h 内可启动**(纯 API,沿用 Phase 1 client)

**Phase 4 §30-B(mock MCP dependency)**:cases #5-#11(sandbox probe + multi-vault),需 mock MCP 部署 + sandbox probe helper,**部署后启动**

**Phase 4 §30-C(OAuth dependency)**:cases #12-#13,需 OAuth dev app + webhook receiver,**部署后启动**

### 跟 Phase 4 §40 Batch 1 的关系

§30-A 可跟 §40 Batch 1 Top 9 一起跑(都不依赖 mock MCP);§30-B / §30-C 留 §40 Batch 1 后启动(mock MCP 部署成本 ~2h,跟 §40.1.6 共享 fs / §40.3.10 Files API 可叠加复用)。

**推荐**:Phase 4 Batch 1 = §30-A(13 case API only)+ §40 Top 9 = **22 case ~380k tokens**,单 batch 启动。

## Token 预算总结

| Phase / Batch | 估 token | 实际 token |
|---|---|---|
| Phase 1 vault baseline | — | 已 done F-0008/F-0009 |
| Phase 4 §30-A(no mock MCP)| ~25k | TBD |
| Phase 4 §30-B(mock MCP)| ~140k | TBD |
| Phase 4 §30-C(OAuth)| ~40k | TBD |
| 30.6 cross-workspace(gated)| ~10k | TBD if accessible |

→ Vault 全集 §30 估 ~215k tokens(Phase 4 全启动);**比 §40 Batch 1 还便宜**(主要差异:§30 多用 pure API call,token 低)。

## 留 v2 的 deferred 用例(security suite)

- 30.1.8 Prompt injection 试图让 agent 读出 vault token
- Sandbox escape 试图通过 proxy hijack 拿 token
- 长时间 session 内 token rotation 的连贯性
- 跨 region failover 时的 vault 可用性
- Mock MCP server 5xx 注入 → retries_exhausted 路径(§20.5.3 残留)

## 引用

- [F-0008 Vault baseline](../../../agentmatrix-notes/research/managed-agents/findings/F-0008-vault-credential-invariants.md)
- [F-0009 vault.delete no ref check](../../../agentmatrix-notes/research/managed-agents/findings/F-0009-vault-delete-no-session-ref-check.md)
- [F-0019 MCP unreachable fast-fail](../../../agentmatrix-notes/research/managed-agents/findings/F-0019-mcp-unreachable-triggers-session-error.md)
- [ADR drafts](../../../agentmatrix-notes/research/managed-agents/adr-drafts/)
