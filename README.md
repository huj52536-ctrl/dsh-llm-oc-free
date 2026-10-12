# dsh-llm-oc-free

把 **OpenCode 的免费模型**作为 DeepSeek Harness 的一个原生 Provider。

它不是一个"中转代理"，而是 DSH 的 Provider 插件：自己在插件内拉起一份**隔离的 OpenCode**，
自己把 DSH 的对话与工具表编译成 OpenCode 会话，再把模型回的 JSON 信封解回 DSH 的
`tool-call`。因此**没有中间 HTTP 跳、没有 Electron 外壳、没有第二份需要手工同步的模型清单**。

## 与"搭一个代理再接进来"的区别

| | 代理方案（OC Ferry / ow-lite 等） | 本插件 |
|---|---|---|
| 形态 | 独立进程 + 常驻托盘应用 | DSH 的一个 Provider |
| 中间层 | DSH → HTTP → 代理 → OpenCode | DSH → 适配器 → OpenCode |
| 模型清单 | 存在代理的配置里，DSH 侧要手工同步 | 直接读 OpenCode 目录 |
| 额外常驻 | ~800 MB（Electron + 运行时） | 只有隔离的 OpenCode 本身 |
| 协议转换 | 代理内做，DSH 只当它是 OpenAI 端点 | 插件直接产出 DSH 的 StreamChunk |
| 身份提示 | 写死在代理里（可能自称别的产品） | 由 DSH 提供，不伪造身份 |

## 安装

```powershell
dsh plugin --profile desktop add <本目录的绝对路径>
```

装完**完整退出并重启 DSH**。之后 **设置 → 模型** 里会出现 `OpenCode 免费模型`。

> 注意：只改动插件源码后，用 `plugin_manager` 把它禁用再启用**不足以**让改动生效。
> 实测那条 HMR 路径会重新跑一遍 `apply()`（隔离的 OpenCode 确实被重启了），
> 但模块实例仍来自加载器的缓存 —— 宿主看到的 `Config` 状态依旧是 `absent`。
> 要让新代码真正生效，必须重启 DSH 进程。

## 它是怎么工作的

```
DSH agent 循环
   │  工具表 + 对话历史（systemPrompt / messages / tools）
   ▼
src/adapter.mjs ── 编译成 OpenCode 会话请求
   │  系统提示 = 外部指令 + 适配器协议约束
   │  calls 的 schema 由本次工具表生成（工具名用 const 锁死）
   ▼
隔离的 opencode serve（独立 XDG、随机口令、环境变量白名单）
   │  模型只能输出一个 JSON 信封
   ▼
{"content":"…","calls":[{"name":"Read","arguments":{…}}]}
   │  adapter 解成 DSH 的 StreamChunk：block-start → tool-call-delta → block-end
   ▼
DSH 执行工具 → 结果回到下一轮
```

**执行权始终在 DSH**：OpenCode 的会话权限表把所有本机动作设为 `ask`，插件只**拒绝**、
从不批准；如果那个动作能映射成 DSH 提供的工具，插件会把它直接转交出去，
否则回一条点名工具与原因的拒绝，让模型改用信封表达。

## 一个必须遵守的硬约束：只 import 相对路径

本插件的 `src/*.mjs` 只 import `node:*` 内置模块与相对路径，**不 import 任何 DSH 包**
（`vendor/` 下有两份 DSH 内部包的副本，见下）。

原因（实测，不是推测）：插件以 `link:` 装进 profile 后，Node 按 realpath 从插件目录向上
找 `node_modules`，而 `@deepseek-ai/*` 这类 peer 在**普通 Node 解析下不可达**：

```
Cannot find package '@deepseek-ai/dsh-llm-pi-ai' imported from …/src/index.mjs
```

DSH 自己的加载器能解析它们，但那只对"已被加载器接管的模块"成立；插件模块自身在
真实路径上被 `import()` 时拿不到这份映射。因此本插件把 Provider 与适配器都自己实现了
（`src/adapter.mjs`），代价是要手写 DSH 的 StreamChunk 协议 —— 那份协议很小，
换来的是**在任何安装方式下都能稳定加载**。

`vendor/` 是这条约束的例外写法：不解析裸说明符，而是把 `@deepseek-ai/schemastery` 与
`@deepseek-ai/cosmokit` 两个文件原样拷进来、只把那一行 import 改成相对路径。它们只为
下面那条"设置页契约"服务，仍然**零外部依赖**。

## 设置页契约：为什么必须导出 `Config`

如果插件不导出 `Config`，它注册的 provider 在 **设置 → 模型** 里**根本不会显示**。
这不是 UI 的小毛病，而是 `@deepseek-ai/dsh-client-ui-settings-models` 的硬判定：

```js
// 只有 configured 为真的行会被渲染
configured = 命名空间存在 && (settingsPath 为空 || 该路径有值)
```

命名空间来自 `@deepseek-ai/dsh-settings` 的 `describe()`，而它只认满足三件事的插件：

1. `fiber.runtime.Config` 存在，且 `'toJSON' in Config`；
2. `volatileForm(Config) !== undefined` —— 即模式里**至少有一个 `meta.volatile` 节点**；
3. `entry.fiber.state === 2`（插件在运行）。

同时 `@deepseek-ai/cordis` 的 `resolveConfig()` 会调
`Config['~standard'].validate(config)`，所以 `Config` 必须是**真正的 Standard Schema**，
不能是手写的形状对象。`src/config.mjs` 因此用 vendored 的 schemastery 构造模式，
形状与上游 `dsh-llm-pi-ai` 一致（一个 volatile 字典承载按 provider 的覆盖）。

还有一个反直觉的细节：**被标记 volatile 的字段，其解析值会被 cosmokit 换成不透明的
`{ get() }` 引用**，直接读属性会得到 `undefined`。所以 `apply()` 里读 `config.routes`
必须先过 `unwrapVolatile()` —— `src/config.mjs` 导出了这个辅助函数，
`test/settings-contract.test.mjs` 则把上述整条判定复刻成断言，防止上游改逻辑后静默失效。

## 关键实现约束（都经过实测）

- **`prepareCall` 必须返回 `{ model, stream }`**：DSH 用它把"这一次的模型元数据"和
  "这一次的 stream 入口"绑在同一代目录上；`stream(options)` 收到的是
  `{ provider, model, messages, systemPrompt, tools, ... }`，**不是**合起来的 context。
- **DSH 的助手内容块用连字符命名**：`tool-call` / `reasoning`（pi-ai 是驼峰 `toolCall` /
  `thinking`）；工具结果的 role 是 `tool`，字段 `toolCallId` / `toolName`。两套都要认。
- **StreamChunk 协议**：`block-start` / `text-delta` / `block-end` / `tool-call-delta` /
  `usage` / `finish`。`block-end.block.arguments` 必须是 **JSON 字符串**；
  `tool-call-delta` 必须**立刻带 id**（DSH 靠它配对工具结果）。
- **`finish.reason.kind`** 决定 DSH 下一步：`tool-calls` 去执行工具，`stop` 收尾，
  `max-tokens` 表示被截断，`aborted` 表示用户取消，`error` 带上 `failure.code`。
- **错误码要落在 DSH 的重试表里**：`dsh-llm` 的默认 `DEFAULT_RETRYABLE_CODES` 是
  `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`。本插件把免费模型偶发的
  空回复报成 `EMPTY_RESPONSE`，于是已启用的 `dsh-llm-retry` 会自动退避重试
  （默认 5 次）—— 这正是 `providerRetryPolicy()` 返回 `undefined`（用默认策略）的原因。
- **信封的 calls schema 由本次工具表生成**，`tool_choice: none` 时数组上限归零。
  约束靠 schema，不靠提示词自觉。

## 配置

在 `cordis.patch.yml` 里覆盖本行：

```yaml
- id: llm-oc-free
  name: 'dsh-llm-oc-free'
  config:
    opencodePath: ''          # 指定已有的 opencode；留空则自动发现/下载
    dataDir: ''               # 数据目录；留空按系统惯例
    requestTimeoutMs: 300000  # 单次推理上限（免费模型排队时可能很慢）
    modelAllowlist: []        # 空 = 目录里全部免费模型
    routes:                   # 按 provider 的运行时覆盖，设置页里可改
      oc-free:
        modelAllowlist: []    # 只保留这些模型 id；留空 = 全部
        requestTimeoutMs: 300000
```

`routes` 是模式里唯一被标记 `volatile` 的字段（设置页要求至少有一个），
所以它的解析值是不透明引用，读之前必须过 `unwrapVolatile()`。

数据目录：Windows `%APPDATA%\dsh-llm-oc-free`，macOS
`~/Library/Application Support/dsh-llm-oc-free`，Linux `$XDG_CONFIG_HOME/dsh-llm-oc-free`。
里面是 `runtime/<版本>/opencode`（托管运行时）与 `opencode/`（隔离实例的 XDG 目录）。
**与你自己装的 OpenCode 完全分开**：独立配置、独立登录态、独立项目目录。

首次启动会自动把官方 npm 包（回退 npmmirror）下载到托管目录，用 SHA-512 校验后
只解出那一个二进制。约 180 MB，只需一次。

## 免费模型怎么筛

看价格，不看名字：

```
cost.input === 0 && cost.output === 0 && cost.cache.read === 0 && cost.cache.write === 0
&& capabilities.output.text !== false && status !== 'deprecated'
```

## 开发

```powershell
npm run check      # 对 src/ 与 test/ 全部 .mjs 做语法检查
npm test           # 60 项单测（协议 / 交接 / 适配器 / 设置页契约），不访问网络
npm run test:live  # 真实 OpenCode + 真实免费模型的端到端与目录契约（需要网络）
node test/real-tarball.mjs   # 用真实的 opencode-ai tarball 校验 tar 提取器
```

`npm test` 的依赖为零：只跑本仓库与 Node 内置模块。
`npm run test:live` 首次会在临时目录里准备一份托管运行时（约 180 MB，之后复用）。

## 已知边界

- 免费模型与额度由上游决定，随时可能变化；目录为空或某模型不可用属正常现象。
- 免费模型有排队，响应可能从数秒到一两分钟，偶发空回复（由 `dsh-llm-retry` 自动重试）。
  端到端测试直接调适配器、不过重试层，所以它偶尔会看到那次原始的空回复。
- 适配器的协议约束会占固定 prompt 开销（实测约 4–5K tokens/请求），这是"用信封表达工具调用"的代价。
- 只支持文本；图片输入尚未接通。
- 推理档位只广告 OpenCode `variants` 里真实带 `reasoningEffort` 的那些。

## License

MIT
