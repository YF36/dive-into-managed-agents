# Claude Platform on AWS · 接入与差异

> 这份文档是 AWS 接入路径的**操作手册 + 行为差异清单**。**2026-05-13 更新**:已基于实测 AWS host(`my-aws`)修正,代码侧用 `@anthropic-ai/aws-sdk` 单一路径,dual-mode 假设作废。

## 1. 路径澄清:不是经典 Bedrock

| 路径 | 运营方 | API surface | CMA 支持? |
|---|---|---|---|
| Anthropic Direct API | Anthropic | `api.anthropic.com` Messages API | ✅ |
| **Claude Platform on AWS** | **Anthropic**(AWS 只做 auth + 计费 + region)| `aws-external-anthropic.{region}.api.aws` Messages API | ✅ |
| Amazon Bedrock(经典) | AWS | `bedrock-runtime.{region}.amazonaws.com` Converse/InvokeModel | ❌ |

我们拿到的是 **Claude Platform on AWS** ——`aws-external-anthropic.ap-northeast-1.api.aws`,东京 region。

## 2. 实测确认的环境(my-aws,2026-05-13)

```bash
# /home/ubuntu/.bash_profile 配置(已就位)
export ANTHROPIC_AWS_API_KEY=<redacted>
export ANTHROPIC_AWS_WORKSPACE_ID=wrkspc_01CzSuJFbKpu5jooFEQmLiFq
export AWS_REGION=ap-northeast-1

# /home/ubuntu/hello.ts 跑通 = 端到端链路 OK
import AnthropicAws from "@anthropic-ai/aws-sdk";
const client = new AnthropicAws();
const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello!" }],
});
```

**关键观察**:
- AWS CLI **没装**,IMDS **不可达**(返回 HTML 拦截页) —— 但都不影响 CMA 调用,因为 auth 走 `ANTHROPIC_AWS_API_KEY` 而非 AWS credential chain
- `~/.aws/` 目录**不存在** —— 不需要 AWS IAM 配置
- Node v18.19.1,SDK 包 `@anthropic-ai/aws-sdk@0.3.0` + `@anthropic-ai/sdk@0.95.2` 已 npm install

## 3. SDK 决策(实测推翻 plan 假设)

| 维度 | 原 plan 假设 | 实测后 | 影响 |
|---|---|---|---|
| 包 | `@anthropic-ai/sdk` + 手动 baseURL/headers | **`@anthropic-ai/aws-sdk` v0.3.0** | 重写 client.ts |
| 凭据 | `x-api-key` 或 WIF token 二选一,配在 .env | **`ANTHROPIC_AWS_API_KEY` env**,**.bash_profile 注入,绝不入 .env** | 重写 .env.example |
| Mode | dual-mode(direct / aws-platform)| **单一路径**,只 aws-platform | 去掉所有 mode 切换代码 |
| Beta header | 手动设 `anthropic-beta` | **SDK 自动注入** `managed-agents-2026-04-01` | 删手动设头逻辑 |
| Workspace ID | 没意识到必填 | **强制必填**(env 或构造参数),SDK 构造时 assert | 测试 setup 显式 assert |
| Region | 假设 us-west-2 | **`ap-northeast-1`**(东京) | base URL 自动正确 |

`AnthropicAws extends Anthropic` —— 自动暴露 `client.beta.{agents, environments, sessions, sessions.events, vaults, vaults.credentials, skills, memoryStores, files, models, webhooks}.*` 完整 CMA surface。

**SDK 详细操作手册见独立文档**:[`../cma-aws-sdk-notes.md`](../cma-aws-sdk-notes.md)(构造选项完整表 + auth 5 级优先级源码引用 + region 解析 + `ready` Promise 语义 + 跟标准 SDK 关系 + 13 节)。

## 4. 必填环境变量(测试代码 assert)

| 变量 | 值示例 | 用途 |
|---|---|---|
| `ANTHROPIC_AWS_API_KEY` | (AWS Console 发的)| auth,SDK 走 `x-api-key` 而非 SigV4 |
| `ANTHROPIC_AWS_WORKSPACE_ID` | `wrkspc_01CzSuJFbKpu5jooFEQmLiFq` | workspace 标识 |
| `AWS_REGION` | `ap-northeast-1` | 决定 base URL 拼接(`aws-external-anthropic.{region}.api.aws`) |

**SSH 非交互式坑**:`ssh my-aws "cmd"` 默认只 source `.bashrc`,**不 source `.bash_profile`**,所以读不到 export。要么用 `ssh -t my-aws bash -lc 'cmd'` 强制 login shell,要么 SSH 进去交互式跑。

## 5. SDK auth chain(顺便理解,我们走的是第 4 步)

`AnthropicAws` 构造时的 auth 优先级(`@anthropic-ai/aws-sdk` v0.3.0 `src/client.ts`):

1. `apiKey` 构造参数 → `x-api-key`
2. `awsAccessKey` + `awsSecretAccessKey` 显式传 → SigV4
3. `awsProfile` 显式传 → 从命名 profile 加载凭据,SigV4
4. **`ANTHROPIC_AWS_API_KEY` env → `x-api-key`** ← 我们走这条
5. 默认 AWS credential chain(SigV4)→ EC2 instance / `~/.aws/credentials` / ECS task role / IMDS

第 5 条 fallback 需要 AWS CLI / `@aws-sdk/credential-providers`,我们的 host 装了包但 IMDS 不通,默认 chain 也不需要走(env var 已经在第 4 步命中)。

## 6. Region 解析与 endpoint

base URL 模板:`https://aws-external-anthropic.${awsRegion}.api.aws`(SDK hardcoded)。`awsRegion` 解析顺序:`awsRegion` 构造参数 > `AWS_REGION` env > `AWS_DEFAULT_REGION` env > `~/.aws/config` profile。

异步解析陷阱:仅靠 `~/.aws/config` 时第一次请求前 region 可能未就绪 —— **测试代码用 `await client.ready` 等所有 async resolve 完成再发请求**(`warm-up.ts` / smoke test 已遵循)。

## 7. Claude Platform on AWS vs Direct API 行为差异

| 差异点 | Direct API | Claude Platform on AWS | 测试影响 |
|---|---|---|---|
| Base URL | `api.anthropic.com` | `aws-external-anthropic.ap-northeast-1.api.aws` | SDK 自动 |
| Auth | `x-api-key` | `x-api-key`(SDK 走 `ANTHROPIC_AWS_API_KEY`) | 测试代码透明 |
| **6h reauth** | 无 | **6h 无 user event 须 reauth**(发任何 user event 即可恢复)| Phase v2 长跑 |
| Request ID | `request-id` | `request-id` + `x-amzn-requestid`(双头)| 测试代码 log 同时记 |
| Beta header | 手动设 | **SDK 自动注入** | 不变 |
| HIPAA / Admin API / OAuth user-facing / Fast mode / OpenAI-compat / workspace member / spend limit | 支持 | 不支持 | 不测 |
| `inference_geo` 参数 | 支持 | 支持,但 Sonnet 4.5 及以下 reject 400 | Phase 5 可测 |

## 8. 6h reauth 行为(v2 用例占位)

> When a session has been autonomous for over 6 hours without any user-role event, it requires reauthentication before continuing. Sending any user-role event will satisfy this requirement.

**v2 规划**:long-running outcome / multi-agent session,wall clock > 6h 后发 `user.message`,验证 stream 是否发特殊信号 / status 是否变 / reauth 后 session 继续延迟。Phase 0-5 不测。

## 9. SSH 接入 my-aws

实测可用入口:

```bash
ssh my-aws                                       # 交互式,读 .bash_profile
ssh -t my-aws bash -lc '<cmd>'                   # 非交互但 login shell,读 .bash_profile
ssh my-aws "<cmd>"                               # 非交互非 login,只读 .bashrc — **env 读不到**

# host 配置参考(~/.ssh/config):
# Host my-aws
#   HostName <ip-or-dns>
#   User ubuntu
#   IdentityFile ~/.ssh/<key>
```

**一键起步**(本地直接调,在 AWS host 上 clone+install+warmup+test):

```bash
ssh -t my-aws bash -lc '
  cd ~/proj &&
  [ -d dive-into-managed-agents ] || git clone git@github.com:YF36/dive-into-managed-agents.git &&
  cd dive-into-managed-agents &&
  git fetch && git checkout cma-tests-phase-0 && git pull &&
  cd tests-cma &&
  npm install &&
  npm run warmup &&
  npm run test
'
```

(Phase 0 时 git clone 用 `cma-tests-phase-0` 分支;merge 后切回 main。)

## 10. 错误排查 tip(实测踩过的坑)

- **`Missing required env vars`**:`ssh my-aws "cmd"` 没 source `.bash_profile` —— 改用 `ssh -t my-aws bash -lc 'cmd'`
- **`No workspace ID found`**:`ANTHROPIC_AWS_WORKSPACE_ID` 没设;同上 SSH login shell 问题
- **`401 Unauthorized`**:`ANTHROPIC_AWS_API_KEY` 错或过期;在 AWS Console 重新 generate
- **`403 Forbidden` on `agents.create`**:workspace 没开 CMA feature 或 region 跨界;查 workspace 设置
- **签名失败 / token 过期**:host 系统时钟偏差;`sudo systemctl restart systemd-timesyncd` 或 `chronyc` 同步
- **`request-id` 看不到详情**:用 `x-amzn-requestid` 查 CloudTrail(需要 AWS Console 权限)

## 11. AWS host 跑 long-running benchmark

Phase 4 起 performance test 在 AWS host 上跑(用户决策:AWS 是 long-running benchmark 常驻 host)。host 已就位(`my-aws`),Node 18.19,SDK 已 npm install。

- 跑长任务用 `tmux` / `screen` 包(SSH 断了任务不死)
- 结果落到 `tests-cma/perf-results/<date>.json`,定期 `scp` 回本地存档
