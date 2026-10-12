// 插件的 Config 模式。
//
// 为什么需要它：DSH 的「设置 → 模型」只渲染 **已配置** 的 provider 行
// （dsh-client-ui-settings-models 的 `configured.map`），而
//   configured = 设置命名空间存在 && (settingsPath 为空 || 该路径有值)
// 命名空间又来自 settings.describe()，它只会为
//   fiber.runtime.Config 存在、且 `volatileForm(Config) !== undefined`
// 的插件产出条目。也就是说：**不导出 Config，这个 provider 在设置页里根本
// 不会出现**（`joinProviderDirectory` 会把它并成 settingsNs:"" 的行，而
// settingsPath 非空的行既不是 configured 也不进 addable，于是被静默丢掉）。
//
// 约束（都来自 cordis / dsh-settings 的实现，已逐条核对）：
//   1. resolveConfig() 会调 `Config["~standard"].validate(config)`，
//      所以 Config 必须是真正的 Standard Schema —— 不能是手写的形状对象。
//   2. settings.schema() 只认 `"toJSON" in Config` 的对象。
//   3. volatileForm() **必须**能递归到至少一个 meta.volatile 节点，
//      否则该命名空间整条被丢弃。
//   4. 被标记 volatile 的字段，其解析值会被 cosmokit 换成不透明的
//      `{ get() }` 引用（createVolatile），所以 **apply() 不能直接读它**，
//      读之前要 unwrapVolatile()。非 volatile 的兄弟字段不受影响。
//
// 因此形状与上游 @deepseek-ai/dsh-llm-pi-ai 一致：一个占位的 volatile 字典
// 承载「按 provider 的运行时覆盖」，其余字段保持普通可读。

import z from '../vendor/schemastery.mjs';
import { isVolatile } from '../vendor/cosmokit.js';

/** 解开 cosmokit 的 volatile 配置引用；普通值原样返回。 */
export function unwrapVolatile(value) {
  return isVolatile(value) ? value.get() : value;
}

/** 单个 provider 路由的运行时覆盖。 */
const routeOverride = z.object({
  modelAllowlist: z.array(z.string()).description('只保留这些模型 id；留空表示全部免费模型'),
  requestTimeoutMs: z.natural().description('单次请求超时（毫秒）'),
});

/** 插件的运行时配置模式。 */
export const Config = z.object({
  opencodePath: z.string().default('').description('自定义 opencode 可执行文件路径；留空则自动探测/下载'),
  dataDir: z.string().default('').description('插件数据目录；留空则使用系统默认位置'),
  requestTimeoutMs: z.natural().default(300000).description('单次请求超时（毫秒）'),
  modelAllowlist: z.array(z.string()).default([]).description('只保留这些模型 id；留空表示全部免费模型'),
  routes: z.dict(routeOverride).default({}).volatile().description('按 provider 的运行时覆盖（本插件只有 oc-free）'),
});
