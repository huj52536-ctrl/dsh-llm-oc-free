# vendor/ — 为什么这里躺着两份 DSH 内部包的副本

本插件的一条硬约束是：**`src/*.mjs` 只能 import `node:*` 和相对路径**。
被 `link:` 进 DSH profile 的插件，其模块真实路径在 DSH 安装目录之外，
Node 的 ESM 解析从**导入方自己的 realpath** 往上找 `node_modules`，
所以 `@deepseek-ai/*` 这类裸说明符在插件里一律解析失败
（`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm-pi-ai'`）。

而「设置 → 模型」要求插件导出一个真正的 Config 模式：
cordis 会调 `Config["~standard"].validate(config)`，dsh-settings 会调
`Config.toJSON()` 并用 `new z(json)` 重建它。手写的形状对象满足不了
Standard Schema 协议，也不保证 `toJSON()` 的输出能被宿主的 schemastery 读回。

所以这里把上游这两个文件原样搬进来，只改一处 import：

| 文件 | 来源 | 改动 |
| --- | --- | --- |
| `cosmokit.js` | `@deepseek-ai/cosmokit@1.8.5` `lib/index.js` | 无（本身零依赖、零 import） |
| `schemastery.mjs` | `@deepseek-ai/schemastery@3.18.4` `lib/index.mjs` | 唯一的裸 import 改为 `./cosmokit.js` |

两者都是 MIT，许可证随文件放在同目录。摘取方式（只读，不碰 DSH 安装）——
`<安装目录>` 换成你的 DSH 安装位置；`asar.mjs` 是一个十几行的只读 asar 解析器：

```powershell
node asar.mjs '<安装目录>\resources\app.asar' `
  'dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs' > vendor/schemastery.mjs
```

升级 DSH 后若 `dsh-settings` 的判定逻辑有变，`test/settings-contract.test.mjs`
会先失败——那边复刻的就是它的判定。
