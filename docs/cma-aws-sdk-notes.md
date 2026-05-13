# @anthropic-ai/aws-sdk · 操作 + 调研笔记

> 一手实测笔记,基于 my-aws 上 `/home/ubuntu/node_modules/@anthropic-ai/aws-sdk@0.3.0` 源码 + `/home/ubuntu/hello.ts` 跑通后整理。**这份文档跟测试方案文档独立**——用 SDK 时随手翻这一份就够,无需读 5 份 CMA 调研文档 + 7 份测试方案。

## 1. 文档定位:什么时候读这份

- 团队成员第一次用 `@anthropic-ai/aws-sdk` 写代码:看 §3-§6
- 写 CMA 测试 / AgentMatrix RuntimeDriver,需要理解 auth / region / CMA surface 怎么暴露:看 §4-§8
- 踩到 SDK 坑(workspaceId throw / region 没解析 / 401):看 §9 + §10
- 思考 AgentMatrix v1 的客户端 SDK 形态,想借鉴 / 偏离 CMA:看 §11

不需要读这份的场景:写单纯的 `client.messages.create()` 应用代码——`hello.ts` 4 行就够。

## 2. 包定位 + 版本史

| 字段 | 值 |
|---|---|
| npm name | `@anthropic-ai/aws-sdk` |
| 当前版本 | **`0.3.0`**(2026-05-11 发,**3 天前**) |
| 作者 | Anthropic,`support@anthropic.com` |
| 仓库 | `anthropics/anthropic-sdk-typescript` monorepo(跟标准 `@anthropic-ai/sdk` 同 repo) |
| License | MIT |
| 用途 | **专用于 Claude Platform on AWS**(Anthropic-operated,经 AWS marketplace 提供)。**不是** Bedrock。endpoint host `aws-external-anthropic.{region}.api.aws` |

**CHANGELOG 摘录**(本机 `node_modules/@anthropic-ai/aws-sdk/CHANGELOG.md`):

```
0.3.0  2026-05-11  Add AWS client for Claude Platform on AWS    ← 第一个真正可用版本
0.2.5  2026-04-08  internal version bump
0.2.4  2026-04-07  internal version bump
0.2.3  2026-04-07  internal version bump
0.2.2  2026-04-07  internal version bump
0.2.1  2026-04-03  internal updates
0.2.0  2026-04-01  scaffold
```

`0.1.x-0.2.5` 几乎全是 scaffold + version bump,**0.3.0 才真正加入 AWS client 实现**。我们用的版本就是它,这意味着:
- GitHub issues 几乎空白,踩坑没人帮你查
- 类型定义可能跟 `@anthropic-ai/sdk@0.95.2` 稍有出入(peer dep 是 `>=0.50.3 <1`,宽松)
- 建议在 `package.json` 里**显式 pin 版本**(`"0.3.0"` 不带 caret),避免 0.4.x 偷袭 break change

## 3. 安装 + 最小示例

```bash
npm install @anthropic-ai/aws-sdk@0.3.0 @anthropic-ai/sdk@0.95.2
```

不能只装 aws-sdk——它 peer 依赖标准 SDK 的类型 + base client。**显式 pin 两个版本**。

最小示例(my-aws 上跑通的 `/home/ubuntu/hello.ts`):

```typescript
import AnthropicAws from "@anthropic-ai/aws-sdk";

const client = new AnthropicAws();
const message = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(message);
```

**4 行能跑通的前提**(每个都不容易):
1. `ANTHROPIC_AWS_API_KEY` 在 process.env 里
2. `ANTHROPIC_AWS_WORKSPACE_ID` 在 process.env 里
3. `AWS_REGION` 在 process.env 里(或 `~/.aws/config` 有可用 profile)
4. Node ≥ 18(SDK 用 ESM dynamic import + native fetch)

缺任意一个,构造函数或第一次请求就 throw,详见 §9。

## 4. 构造选项完整表

直接来自 `node_modules/@anthropic-ai/aws-sdk/src/client.ts` 构造函数 JSDoc:

| 参数 | 类型 | 默认 | 用途 |
|---|---|---|---|
| `apiKey` | `string?` | — | x-api-key 认证(走第 1 级 auth) |
| `awsAccessKey` | `string \| null?` | `null` | SigV4(access key)|
| `awsSecretAccessKey` | `string \| null?` | `null` | SigV4(secret key);**必须跟 access key 一起传** |
| `awsSessionToken` | `string \| null?` | `null` | SigV4 临时凭据(STS) |
| `awsProfile` | `string?` | — | 从命名 profile 加载凭据 + region |
| `awsRegion` | `string?` | env / config | AWS region;决定 base URL 拼接 |
| `providerChainResolver` | `() => Promise<AwsCredentialIdentityProvider> \| null` | `null` | 自定义凭据 chain(Edge / Worker runtime 用)|
| `workspaceId` | `string?` | env | **强制必填**(除非 `skipAuth=true`);作为 `anthropic-workspace-id` header 发出 |
| `baseURL` | `string?` | env / region 拼接 | 覆盖默认 endpoint |
| `timeout` | `number?` | 600_000 (10min) | 请求超时 |
| `fetchOptions` | `RequestInit?` | — | `fetch` 额外选项 |
| `fetch` | `Fetch?` | global fetch | 自定义 fetch 实现 |
| `maxRetries` | `number?` | 2 | 自动重试次数 |
| `defaultHeaders` | `HeadersLike?` | `anthropic-workspace-id` 自动加 | 默认 header |
| `defaultQuery` | `Record?` | — | 默认 query |
| `dangerouslyAllowBrowser` | `boolean?` | `false` | 浏览器跑(不推荐)|
| `skipAuth` | `boolean?` | `false` | 跳过认证(给本地代理 gateway 场景用)|

`AwsClientOptions` 类型从 `@anthropic-ai/aws-sdk` 顶层 re-export,可 import 强类型化。

## 5. Auth 5 级优先级(源码 official 注释)

`src/client.ts:118-123` 行的 JSDoc 直接给出权威表述:

> Auth is resolved by precedence: `apiKey` constructor arg > explicit AWS credentials > `awsProfile` > `ANTHROPIC_AWS_API_KEY` env var > default AWS credential chain.

具体 5 级:

| 级 | 触发条件 | 走 auth 方式 | 我们用的? |
|---|---|---|:---:|
| 1 | 构造时传 `apiKey` | `x-api-key` header | |
| 2 | 构造时传 `awsAccessKey` + `awsSecretAccessKey`(两个都要传,只传一个 throw) | SigV4 签名 | |
| 3 | 构造时传 `awsProfile` | SigV4(从 profile 加载) | |
| 4 | `ANTHROPIC_AWS_API_KEY` env var 存在(且上面 1-3 都没命中) | `x-api-key` header | ✅ |
| 5 | 默认 AWS credential chain(`@aws-sdk/credential-providers` 的 `fromNodeProviderChain`)| SigV4 | |

第 5 级**需要**装 `@aws-sdk/credential-providers`,且能拿到默认 chain 里某个源(env / `~/.aws/credentials` / ECS task role / EC2 IMDS)。任一缺失或 import 失败,SDK 直接 throw 一个明确指向 `providerChainResolver` 的错误信息。

**判断条件**(`src/client.ts:206`):`_useSigV4 = resolvedApiKey == null`——即只要走到第 4 级且 `ANTHROPIC_AWS_API_KEY` 存在,就用 `x-api-key`;否则后续走 SigV4。

**我们的设置**:`my-aws:/home/ubuntu/.bash_profile` 配了 `ANTHROPIC_AWS_API_KEY`,所以走第 4 级,**全程不用 SigV4 / AWS chain**。这意味着:
- 不需要装 AWS CLI / 不需要 IAM role / IMDS 可不可达都无关
- 但需要保护好这个 API key(它就是凭据本身)
- AWS Console 里 rotate / revoke 这个 key 是唯一 rotation 路径

## 6. workspaceId 强制要求

`src/client.ts:196-199`:

```typescript
if (!resolvedWorkspaceId && !skipAuth) {
  throw new Errors.AnthropicError(
    'No workspace ID found. Set `workspaceId` in the constructor or the `ANTHROPIC_AWS_WORKSPACE_ID` environment variable.',
  );
}
```

resolve 顺序:`workspaceId` 构造参数 > `ANTHROPIC_AWS_WORKSPACE_ID` env var。**两个都没就直接 throw,连请求都发不出去**。

**怎么发出去**:每个请求 SDK 自动加 `anthropic-workspace-id: <id>` header(`src/client.ts:217`,`buildHeaders` 注入)。**不是签名进 SigV4**,而是普通 header。

唯一豁免:`skipAuth: true`(用于本地有 auth-handling proxy 的场景),此时 workspaceId 可省略。

我们的设置:`ANTHROPIC_AWS_WORKSPACE_ID=wrkspc_01CzSuJFbKpu5jooFEQmLiFq`。

## 7. Region 解析 + ready promise

Region resolve 顺序(`src/client.ts:151`):

1. `awsRegion` 构造参数
2. `AWS_REGION` env var
3. `AWS_DEFAULT_REGION` env var
4. `~/.aws/config` 里 profile 的 region(**异步**,通过 `@smithy/node-config-provider` `loadConfig`)

前 3 步同步;只有 1-3 全没,才走第 4 步异步 fallback。

**`client.ready` 是一个 Promise**(`src/client.ts:99-103` doc comment):

```typescript
// Awaiting this lets you fail fast if region resolution fails,
// instead of waiting for the first request.
readonly ready: Promise<void>;
```

实现:
- 同步路径(1-3 命中)→ `this.ready = Promise.resolve()`,立即 resolved
- 异步路径(走第 4 步)→ `this.ready = this._resolveRegionFromConfig(...)`,带 catch 抑制 unhandledRejection

**关键发现**(`src/client.ts:255-258`):

```typescript
protected override async prepareOptions(options: FinalRequestOptions): Promise<void> {
  await super.prepareOptions(options);
  await this.ready;     // 每个请求前自动等
}
```

**`prepareOptions` 钩子在每个请求前自动 await `this.ready`**——意味着即使你不手动 await,SDK 内部也会等 region 解析完才发请求。**手动 `await client.ready` 的唯一价值是"让 region 解析失败在 init 阶段就 surface,而不是延迟到第一次请求"**。生产代码强烈推荐手动 await;脚本性代码可以省略。

**我们的设置**:`AWS_REGION=ap-northeast-1`,走同步第 2 步;`ready` 立即 resolved。

## 8. baseURL 解析

源码 `src/client.ts:154-164`:

```typescript
const explicitBaseURL = baseURL ?? readEnv('ANTHROPIC_AWS_BASE_URL');
if (explicitBaseURL) {
  resolvedBaseURL = explicitBaseURL;
} else if (syncRegion) {
  resolvedBaseURL = `https://aws-external-anthropic.${syncRegion}.api.aws`;
} else {
  resolvedBaseURL = undefined;  // 等异步 region 解析完再拼
}
```

顺序:`baseURL` 构造参数 > `ANTHROPIC_AWS_BASE_URL` env > `https://aws-external-anthropic.{awsRegion}.api.aws`(region 同步或异步)

我们的设置:`AWS_REGION=ap-northeast-1`,自动拼成 `https://aws-external-anthropic.ap-northeast-1.api.aws`。

## 9. CMA API surface(完整继承)

`AnthropicAws extends Anthropic`(`src/client.ts`,顶部 `import { Anthropic } from "@anthropic-ai/sdk"`)。这意味着 `@anthropic-ai/sdk@0.95.2` 暴露的所有命名空间**全部自动可用**:

```typescript
const client = new AnthropicAws();

// 标准 Messages API
await client.messages.create({ ... });
await client.messages.stream({ ... });

// CMA Beta 命名空间(完整列表)
await client.beta.agents.{ create, list, retrieve, update, archive };
await client.beta.environments.{ create, list, retrieve, update, archive };
await client.beta.sessions.{ create, list, retrieve, archive, delete };
await client.beta.sessions.events.{ send, list, stream };
await client.beta.vaults.{ create, list, retrieve, update, archive, delete };
await client.beta.vaults.credentials.{ create, list, retrieve, update, archive, delete, mcpOauthValidate };
await client.beta.skills.{ ... };
await client.beta.skills.versions.{ ... };
await client.beta.memoryStores.{ ... };
await client.beta.memoryStores.memories.{ ... };
await client.beta.files.{ ... };
await client.beta.models.{ ... };
await client.beta.webhooks.{ ... };
await client.beta.userProfiles.{ ... };
await client.beta.messages.create({ ... });  // 带 betas[] 参数版本
```

**Beta header 自动注入**:每个 CMA 资源方法内部 SDK 自动加 `anthropic-beta: managed-agents-2026-04-01`(可在 `node_modules/@anthropic-ai/sdk/resources/beta/*.js` 验证)。**不需要手动加** `defaultHeaders["anthropic-beta"]`。

要叠加额外 beta(比如 `extended-cache-ttl-2025-04-11`),per-call 传 `betas: ["xxx"]`,SDK 自动合并。

## 10. 已知限制 + 踩过的坑

### 10.1 SDK 自身

| 坑 | 触发 | 解决 |
|---|---|---|
| `0.3.0` 是第一个真正版本,GitHub issues 空 | — | 踩坑时直接读源码(295 行 + auth.ts 100 行,可读) |
| peer dep `>=0.50.3 <1` 极宽松 | 装 `@anthropic-ai/sdk@0.50.3` 没有 CMA,新版可能 break type | **package.json 显式 pin** `"@anthropic-ai/sdk": "0.95.2"` |
| `awsAccessKey` 没配套 `awsSecretAccessKey`(或反之) | 单独传一个 | SDK throw 明确错误;两个一起传或都不传 |
| `workspaceId` 没传 + `skipAuth=false` | 构造函数立即 throw | 配 `ANTHROPIC_AWS_WORKSPACE_ID` env |
| Edge / Worker / browser runtime | 默认 chain 依赖 `@aws-sdk/credential-providers` import 失败 | 传 `providerChainResolver` 自定义 chain |
| SigV4 模式下系统时钟偏差 > 5min | 签名失败 401 | 同步系统时钟 |
| `client.ready` 不 await | region 异步解析的错误延迟到第一次请求才暴露 | 生产代码 `await client.ready` |

### 10.2 我们环境的坑(my-aws)

| 坑 | 触发 | 解决 |
|---|---|---|
| **SSH 非交互式不读 `.bash_profile`** | `ssh my-aws "node hello.ts"` env 全空,SDK throw `No workspace ID found` | 用 `ssh -t my-aws bash -lc 'cmd'` 强制 login shell |
| IMDS 不可达(返回 HTML 拦截页)| EC2 metadata 端点被网络配置拦 | 不影响——我们走 `ANTHROPIC_AWS_API_KEY` env(level 4),不需要 IMDS |
| AWS CLI 没装 | 走默认 chain 时找不到 | 同上 |

## 11. 跟 `@anthropic-ai/sdk` 标准 SDK 的关系

| 维度 | 标准 SDK | AWS SDK |
|---|---|---|
| 包 | `@anthropic-ai/sdk` | `@anthropic-ai/aws-sdk` |
| 入口类 | `Anthropic` | `AnthropicAws` |
| 继承关系 | base | `AnthropicAws extends Anthropic` |
| 默认 baseURL | `api.anthropic.com` | `aws-external-anthropic.{region}.api.aws` |
| Auth | `x-api-key`(`ANTHROPIC_API_KEY` env / `apiKey` 构造) | 5 级链(详见 §5) |
| `anthropic-beta` header | 手动设 / per-call `betas: []` | **自动注入** CMA beta + per-call 合并 |
| `anthropic-workspace-id` header | 不需要 | **强制**(除非 skipAuth) |
| CMA `beta.*` 命名空间 | ✅(0.50.3+) | ✅ 完全继承 |
| Streaming | ✅ `messages.stream()` | ✅ 同 |
| browser 支持 | `dangerouslyAllowBrowser: true` | 同 |
| Edge / Worker | ✅ | 需要 `providerChainResolver`(SigV4 模式)|

**重要纪律**:**不要同时 `import` 两个包的 client 类**——它们用不同 base URL 和 auth 模型,混用会导致请求乱发。但 **type-only import 是 OK 的**:

```typescript
// ✅ OK:type-only import,不引入运行时
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";

// ❌ 别这样:同时实例化两个 client
import Anthropic from "@anthropic-ai/sdk";
import AnthropicAws from "@anthropic-ai/aws-sdk";
const client1 = new Anthropic({ ... });
const client2 = new AnthropicAws({ ... });
```

## 12. 跟 AgentMatrix 设计的关系

CMA 这套 SDK 设计对 AgentMatrix v1 客户端 SDK 设计有 4 条直接借鉴:

| CMA 做法 | AgentMatrix 启发 |
|---|---|
| **`AnthropicAws extends Anthropic`,自动暴露完整能力面** | AgentMatrix 不同部署模式(self-hosted / Anthropic-hosted / AWS-hosted)用同一种 SDK,只换 base client class;不要每种模式独立 SDK |
| **Beta header 自动注入** | AgentMatrix v1 protocol version header 也应该 SDK 自动加,不要让 user 手动设 |
| **`workspaceId` 是 strong invariant**(SDK 构造时 throw) | AgentMatrix `tenant_id` / `namespace_id` 也应是构造 / 第一个请求时 fail-fast,不要等业务报错才发现 missing |
| **`ready` Promise + `prepareOptions` 自动 await** | AgentMatrix SDK 需要 async resolve 时(比如 region / capability negotiation),用同样的"显式 await 让错误前置 + 内部自动 await 兜底"模式 |

**反例**(CMA 这条我们不应该照抄):
- `peer dep >=0.50.3 <1` 太宽松 —— AgentMatrix client SDK 应当**严格 pin major + minor**(`~1.2.0`),避免上游 minor bump 破坏下游
- 4 行能跑通但 4 个隐藏前置项(env / Node / package install / IMDS reachable)—— AgentMatrix SDK 应该在 `new Client()` 那一刻就把所有前置项检查 + 友好报错,而不是让 user 自己排查

## 13. 引用 + 源码路径

源码权威路径(my-aws):

```
/home/ubuntu/node_modules/@anthropic-ai/aws-sdk/
├── package.json                       依赖声明、exports
├── CHANGELOG.md                       版本史
├── src/
│   ├── client.ts (295 行)             AnthropicAws 主类 + 构造 + auth 编排
│   └── core/auth.ts (101 行)          SigV4 签名 + AWS chain import
├── index.d.ts                         re-export entry
└── client.d.ts                        AnthropicAws 类型
```

CMA Beta 资源类型来自 `@anthropic-ai/sdk@0.95.2`:

```
/home/ubuntu/node_modules/@anthropic-ai/sdk/resources/beta/
├── agents.d.ts
├── environments.d.ts
├── sessions/
│   ├── sessions.d.ts
│   ├── events.d.ts
│   ├── resources.d.ts
│   └── threads.d.ts
├── vaults/
│   ├── vaults.d.ts
│   └── credentials.d.ts
├── skills/...
├── memory-stores/...
└── ...
```

**外部参考**:
- npm: https://www.npmjs.com/package/@anthropic-ai/aws-sdk
- repo: https://github.com/anthropics/anthropic-sdk-typescript(monorepo,搜 `aws-sdk` 子目录)
- Claude Platform on AWS 官方文档(待补 URL)
