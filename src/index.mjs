// dsh-llm-oc-free —— 把 OpenCode 的免费模型接进 DeepSeek Harness。
//
// 与"另起一个中转代理"的做法不同，本插件是一个原生 DSH Provider：
//   · 自己拉起一份隔离的 OpenCode（独立 XDG、随机口令、环境变量白名单）；
//   · 自己把 DSH 的对话与工具表编译成 OpenCode 会话，再把模型回的 JSON 信封
//     解回 DSH 的 tool-calls；
//   · 因此没有中间 HTTP 跳、没有 Electron 外壳、没有第二份模型清单要同步。
//
// 执行权始终在 DSH：模型只能回信封表达动作，本机工具一律被审批闸门拦下并转交。
//
// ⚠ 硬约束：本文件及它引用的任何 src/*.mjs **不得 import 任何 DSH 包的裸说明符**。
//   实测在 DSH 的加载器环境里，被 link 的插件无法解析 `@deepseek-ai/*`
//   （Cannot find package '@deepseek-ai/dsh-llm-pi-ai'），因此适配器与 Provider
//   都由本插件自己实现。只依赖 node: 内置模块与相对路径 —— 这样 link、拷贝、
//   npm 装在哪种方式下都能加载。唯一的例外是 vendor/ 下那两份原样副本，
//   它们正是为了「设置页要求一个真正的 Standard Schema」而用相对路径引入的，
//   见 src/config.mjs 顶部与 vendor/README.md。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createAdapter } from './adapter.mjs';
import { OpenCodeClient } from './opencode-client.mjs';
import { ensureRuntime, startOpenCode } from './opencode-runtime.mjs';
import { unwrapVolatile } from './config.mjs';

export const name = 'llm-oc-free';
export const inject = ['llm'];

// 必须导出 Config：没有它，DSH 的 settings.describe() 不会产出 llm-oc-free
// 命名空间，「设置 → 模型」里这一行就不会被渲染。详见 src/config.mjs 顶部。
export { Config } from './config.mjs';

const PROVIDER = 'oc-free';
const DISPLAY_NAME = 'OpenCode 免费模型';
const DEFAULT_TIMEOUT_MS = 300000;
const SCHEMA_DEFAULTS = { opencodePath: '', dataDir: '', requestTimeoutMs: DEFAULT_TIMEOUT_MS, modelAllowlist: [] };

/**
 * 声明给 llm.registerConfigurableProviders() 的目录条目。
 * settingsPath 留空是刻意的：设置页判定 `configured` 时，空路径直接为真，
 * 于是这一行不依赖「用户配置里恰好写了 providers.oc-free」。
 */
export const directoryEntry = {
  provider: PROVIDER,
  displayName: DISPLAY_NAME,
  settingsNs: name,
  settingsPath: [],
  declared: true,
};

/** 数据目录：与用户自己的 OpenCode、以及 DSH 的其它状态都分开。 */
export function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'dsh-llm-oc-free');
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'dsh-llm-oc-free');
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'dsh-llm-oc-free');
}

/** 免费由价格判定，不由名字判定：输入/输出/缓存读写全为 0，且未声明 deprecated。 */
export function freeModels(providers) {
  const catalog = providers?.all?.find?.((entry) => entry?.id === 'opencode');
  const models = catalog?.models ?? {};
  return Object.entries(models).filter(([, model]) => {
    const cost = model?.cost;
    return Boolean(cost)
      && cost.input === 0 && cost.output === 0
      && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0
      && model?.capabilities?.output?.text !== false
      && model?.status !== 'deprecated';
  }).map(([id, model]) => ({
    id: `opencode/${id}`,
    name: model.name || id,
    context: model.limit?.context,
    input: model.limit?.input,
    output: model.limit?.output,
    images: model.capabilities?.input?.image === true,
    toolcall: model.capabilities?.toolcall === true,
    reasoning: model.capabilities?.reasoning === true,
    variants: model.variants ?? {},
  })).sort((a, b) => a.id.localeCompare(b.id));
}

/** OpenCode 的 variants 里带 reasoningEffort 的才算真实可下发的档位。 */
export function reasoningEfforts(model) {
  const efforts = {};
  for (const [key, value] of Object.entries(model?.variants ?? {})) {
    const effort = value?.reasoningEffort ?? value?.reasoning_effort;
    if (typeof effort === 'string' && efforts[effort] === undefined) efforts[effort] = key;
  }
  return efforts;
}

export function apply(ctx, config = {}) {
  const log = (message) => {
    try { ctx.logger?.info?.(`llm-oc-free: ${message}`); }
    catch { /* 日志不该影响主流程 */ }
  };

  // cordis 会用 Config 模式校验并补默认值；这里再兜一层，方便脱离 DSH 直接调用。
  const settings = { ...SCHEMA_DEFAULTS, ...config };
  // routes 被标记为 volatile，解析值是 cosmokit 的不透明引用，读之前必须解引用。
  const route = unwrapVolatile(settings.routes)?.[PROVIDER] ?? {};
  const requestTimeoutMs = route.requestTimeoutMs ?? settings.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowlist = route.modelAllowlist ?? settings.modelAllowlist;
  const dataDir = settings.dataDir?.trim() || dataDirectory();

  let running = null;      // { runtime, client, version }
  let starting = null;     // 正在启动的 promise，避免并发重复拉起
  let catalog = [];        // 最近一次的免费模型目录（带 efforts）

  const setCatalog = (models) => {
    catalog = models.map((model) => ({ ...model, efforts: reasoningEfforts(model) }));
    return catalog;
  };

  /** 懒启动：插件加载本身是瞬时的，启动成本留到真要读目录或调用模型时。 */
  function ensureStarted(signal) {
    if (running) return Promise.resolve(running);
    if (starting) return starting;
    starting = (async () => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const selected = await ensureRuntime({ dataDir, configured: config.opencodePath, log, signal });
      log(`运行时就绪：OpenCode ${selected.version}`);
      const runtime = await startOpenCode({ binary: selected.file, dataDir, log });
      const client = new OpenCodeClient({
        base: runtime.base,
        authorization: runtime.authorization,
        log,
        requestTimeoutMs,
      });
      running = { runtime, client, version: selected.version };
      log(`隔离服务已就绪（OpenCode ${running.version}）`);
      return running;
    })().catch((error) => {
      starting = null;
      log(`启动失败：${error.message}`);
      throw error;
    });
    return starting;
  }

  /** 读一次免费模型目录（失败不抛给调用方，只是暂时没有模型）。 */
  async function refreshCatalog(signal) {
    const { client } = await ensureStarted(signal);
    const providers = await client.providers(signal);
    const found = freeModels(providers);
    const allow = Array.isArray(allowlist) ? allowlist.filter(Boolean) : [];
    const list = allow.length ? found.filter((model) => allow.includes(model.id)) : found;
    setCatalog(list);
    log(`免费模型目录：${catalog.length} 个`);
    return catalog;
  }

  const adapter = createAdapter({
    catalog: () => catalog,
    log,
    reasoningVariant: (model, reasoning) => {
      if (!reasoning || reasoning === 'off') return undefined;
      return model?.efforts?.[reasoning];
    },
    complete: async (request) => {
      const { client } = await ensureStarted(request.signal);
      const result = await client.complete(request);
      ctx.emit?.('llm/oc-free/turn', { model: request.modelID, calls: result.envelope?.calls?.length ?? 0 });
      return result;
    },
  });

  // 目录发现：DSH 的"获取可用模型"会调它。
  const discovery = ctx.llm.registerModelDiscovery?.(name, async (request, signal) => {
    const list = await refreshCatalog(signal ?? request?.signal);
    return list.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.input ?? model.context,
      maxTokens: model.output,
    }));
  });

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  const directory = ctx.llm.registerConfigurableProviders?.([directoryEntry]);

  ctx.effect(() => () => {
    discovery?.();
    directory?.();
    registration?.();
    running?.client?.stopEvents();
    return running?.runtime?.stop?.();
  }, 'llm-oc-free');

  // 后台预热：让模型选择器打开时目录已经就绪。失败只是记录，不影响插件加载。
  ensureStarted(undefined)
    .then(() => refreshCatalog(undefined))
    .catch((error) => log(`预热未完成（首次调用时会重试）：${error.message}`));

  log(`已加载；数据目录 ${dataDir}`);
}
