# Claude Platform on AWS · 接入与差异

> 这份文档是 AWS 接入路径的**操作手册 + 行为差异清单**,Phase 0 就写满,因为 AWS 前置项需要用户配合,且容易踩坑。

## 1. 路径澄清:你拿到的不是经典 Bedrock

| 路径 | 运营方 | API surface | CMA 支持? |
|---|---|---|---|
| Anthropic Direct API | Anthropic | `api.anthropic.com` Messages API | ✅ 全支持 |
| **Claude Platform on AWS** | **Anthropic**(AWS 只做 auth + 计费 + region)| `aws-external-anthropic.{region}.api.aws` Messages API | ✅ **全支持** |
| Amazon Bedrock(经典) | AWS | `bedrock-runtime.{region}.amazonaws.com` Converse/InvokeModel | ❌ **不支持** |

团队拿到的 AWS 访问几乎肯定是 **Claude Platform on AWS**——它跟 Bedrock 共用 AWS IAM + 计费,但 API surface / 协议 / `anthropic-beta` header 跟 Anthropic Direct API 一致,CMA 全功能可用。

**判断方法**:base URL 长什么样。`aws-external-anthropic.*` 是 Claude Platform on AWS,`bedrock-runtime.*` 是 Bedrock。

## 2. 前置 checklist(用户负责)

逐项打勾:

- [ ] **AWS workspace 建好**:在 AWS Console 进 Claude Platform 入口,workspace 绑定一个 AWS region(workspace 一旦绑定 region 就不能跨 region 用)
- [ ] **outbound web identity federation 已启用**:
  ```bash
  aws iam enable-outbound-web-identity-federation
  ```
  没做这步会一直 401 / 403,且错误信息可能不指向这里。**先做这步**。
- [ ] **凭据决策**(二选一):
  - (a) AWS Console → Claude Platform → API keys → Generate API key(注意:**不是 console.anthropic.com 那个**,是 AWS Console 里的)
  - (b) 用 token generator lib 走 WIF(`token-generator-for-aws-external-anthropic-{js,python,java}`,12h TTL)
- [ ] **IAM principal 权限**:测试用 IAM user/role 有 ManagedAgents 调用权限(具体 IAM policy action 待 Anthropic 文档明示;若 401 时回查这里)
- [ ] **本地 / AWS host 时间同步**:SigV4 / WIF 都对系统时钟敏感,偏差 > 5 分钟会签名失败
- [ ] **research preview access**(若要测 Outcomes / Multi-agent):https://claude.com/form/claude-managed-agents — 这是独立批准流程,跟 AWS 入口无关

## 3. 测试代码里的 dual-mode 切换

`tests-cma/src/client.ts` 支持两个 mode,通过 env 切换:

```bash
# direct(本地开发默认)
CMA_MODE=direct
ANTHROPIC_API_KEY=sk-ant-...

# aws-platform(AWS host 上跑)
CMA_MODE=aws-platform
AWS_ANTHROPIC_BASE_URL=https://aws-external-anthropic.us-west-2.api.aws
AWS_ANTHROPIC_API_KEY=...        # AWS Console 发的
# 或 WIF token
AWS_ANTHROPIC_WIF_TOKEN=...
```

两个 mode **跑同一份测试代码**——意外发现的行为差异本身就是有价值的测试结果。

## 4. Claude Platform on AWS vs Direct API 的行为差异

| 差异点 | Direct API | Claude Platform on AWS | 测试影响 |
|---|---|---|---|
| Base URL | `api.anthropic.com` | `aws-external-anthropic.{region}.api.aws` | `client.ts` 切 baseURL |
| Auth | `x-api-key` | `x-api-key` 或 `Authorization: Bearer <WIF>` | client 双 mode |
| **6h reauth** | 无 | **6h 无 user event 须 reauth**(发任何 user event 即可恢复)| Phase v2 长跑;Phase 0-5 不实测 |
| Request ID | `request-id`(Anthropic)| `request-id` + `x-amzn-requestid`(双头)| 测试代码 log 同时记录两个 |
| Beta header | 支持 `managed-agents-2026-04-01` | **支持**(Bedrock 不支持,但 Claude Platform on AWS 支持)| 不变 |
| HIPAA | 支持(BAA 客户)| 不支持 | 不测 |
| Admin API | 支持 | 不支持 | 不测 |
| OAuth user-facing | 支持 | 不支持 | 不测 |
| Fast mode | 支持 | 不支持 | 不测 |
| OpenAI-compatible endpoint | 支持 | 不支持 | 不测 |
| Workspace member 管理 | 支持 | 不支持(IAM 接管)| 不测 |
| Spend limit | 支持 | 不支持(AWS 计费接管)| 不测 |
| `inference_geo` 参数 | 支持(`us` / `global`)| 支持;Opus/Sonnet 4.5 及以下 reject 400 | Phase 5 可测 |

## 5. 6h reauth 行为(v2 用例占位)

文档原文:

> When a session has been autonomous for over 6 hours without any user-role event, it requires reauthentication before continuing. Sending any user-role event(`user.message` / `user.tool_confirmation` / `user.custom_tool_result` / `user.define_outcome` / `user.interrupt`)will satisfy this requirement and allow the session to continue.

**v2 用例规划**:跑一个 long-running outcome / multi-agent session,wall clock > 6h 后发 `user.message`,验证:
- session 是否真的卡在某个状态等 user event
- 错误 / 提示信号(stream 上是否发 `session.error`?status 是否变 `idle` 带特殊 stop_reason?)
- reauth 后 session 继续的延迟

Phase 0-5 不测,记录在此防止后续遗忘。

## 6. 错误排查 tip(踩过坑可补充)

- **`401 Unauthorized` 无具体 message**:八成是 federation 没启;查 step 2.2
- **`403 Forbidden` on `agents.create`**:IAM principal 缺权限,查 IAM policy
- **签名失败 / token 过期**:系统时钟偏差 > 5 分钟;`sudo sntp -sS time.apple.com`(mac)同步
- **`request-id` 看不到详情**:Direct API 用 `request-id` 查 Anthropic 支持;AWS 路径用 `x-amzn-requestid` 查 CloudTrail
- **base URL 写错**:`aws-external-anthropic.{region}.api.aws` 注意 region 跟 workspace 绑定 region 一致;跨 region 会路由失败

## 7. AWS host 跑 long-running benchmark

Phase 4 起 performance test 在 AWS host 上跑(用户决策:AWS 是 long-running benchmark 常驻 host)。建议 host 配置:

- 至少 2 vCPU / 4G RAM(测试代码本身轻量,主要是 Node + SDK)
- 跟 workspace 同 region 部署(降低 base URL 到 AWS API endpoint 的延迟)
- 装好 Node 20+ / npm / git / 测试 repo(`git clone git@github.com:YF36/dive-into-managed-agents.git`)
- 环境变量通过 `.env` 注入(不要写到 systemd unit / 仓库 config)
- 跑测试用 `nohup` / `tmux` / `screen` 包,避免 SSH 断了任务死

用户给到 AWS 入口后,本文档第 8 节填具体登陆方式 + 一键起步脚本。

## 8. AWS host 登陆与运行(待填)

> 用户提供 AWS host 登陆方式后填写这里:
> - SSH key / Bastion / SSM Session Manager
> - 一键运行脚本 `ssh ... && cd ... && npm run test`
