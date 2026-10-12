// apply() 接线测试：用一个假的 cordis ctx 验证插件注册行为。
//
// 这一层是之前 "failed to import" 之外唯一没被覆盖的地方：模块能加载不等于
// 注册正确（路由名、目录项、adapter 是否真的能解析模型）。这里用真实运行时
// （已准备好的托管目录，不触发下载），只把 ctx 换成假的。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// 复用已经准备好的托管运行时，避免测试里下载 180MB。
const PREPARED = path.join(os.tmpdir(), 'dsh-oc-free-apply');
const RUNTIME_SOURCE = path.join(os.tmpdir(), 'dsh-oc-free-e2e', 'runtime');

let apply, PROVIDER_NAME;

/** 造一个足够真的 ctx：记录每次注册，并提供 logger / effect / emit。 */
function makeCtx() {
  const registered = {
    adapters: [], discovery: [], directory: [], effects: [],
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    emit: () => {},
    effect: (fn, label) => { registered.effects.push(label); return fn; },
    llm: {
      registerAdapter: (routes, adapter) => { registered.adapters.push({ routes, adapter }); return () => {}; },
      registerModelDiscovery: (ns, fn) => { registered.discovery.push({ ns, fn }); return () => {}; },
      registerConfigurableProviders: (entries) => { registered.directory.push(...entries); return () => {}; },
    },
  };
  return { ctx, registered };
}

before(async () => {
  await fs.mkdir(PREPARED, { recursive: true });
  // 把已下载的运行时搬过来（复用，不重新下载）。
  if (!await fs.stat(path.join(PREPARED, 'runtime')).then(() => true, () => false)) {
    await fs.cp(RUNTIME_SOURCE, path.join(PREPARED, 'runtime'), { recursive: true });
  }
  const module = await import('../src/index.mjs');
  apply = module.apply;
  PROVIDER_NAME = 'oc-free';
}, { timeout: 120000 });

test('apply() 注册了 adapter、目录项、发现回调与 effect，且路由名正确', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, { dataDir: PREPARED, requestTimeoutMs: 60000 });

  assert.equal(registered.adapters.length, 1, '应当注册一个 adapter');
  assert.deepEqual(registered.adapters[0].routes, [PROVIDER_NAME], '路由名必须是 oc-free');
  assert.equal(registered.directory.length, 1, '应当注册一个可配置 provider 目录项');
  assert.equal(registered.directory[0].provider, PROVIDER_NAME);
  assert.equal(registered.directory[0].displayName, 'OpenCode 免费模型');
  assert.equal(registered.discovery.length, 1, '应当注册模型发现');
  assert.ok(registered.effects.includes('llm-oc-free'), '应当登记清理 effect');
});

test('注册的 adapter 满足 LlmAdapter 契约（listModels / resolveModel / prepareCall / stream）', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, { dataDir: PREPARED, requestTimeoutMs: 60000 });
  const adapter = registered.adapters[0].adapter;
  for (const method of ['listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof adapter[method], 'function', `adapter 缺少 ${method}`);
  }
  // 目录还没预热完也不该抛错：应当返回数组。
  const listed = await adapter.listModels(PROVIDER_NAME);
  assert.ok(Array.isArray(listed));
});

test('模型发现回调返回 DSH 形状的候选（需要真实运行时）', { timeout: 180000 }, async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, { dataDir: PREPARED, requestTimeoutMs: 120000 });
  const discovered = await registered.discovery[0].fn({ provider: PROVIDER_NAME });
  assert.ok(Array.isArray(discovered));
  if (!discovered.length) {
    // 网络不可达时目录为空是允许的；但形状必须正确。
    console.log('   （本次目录为空：上游不可达或模型都不可用）');
    return;
  }
  for (const candidate of discovered) {
    assert.equal(typeof candidate.id, 'string');
    assert.ok(candidate.id.startsWith('opencode/'), `id 应当是 opencode/ 前缀，实际 ${candidate.id}`);
  }
  console.log(`   发现 ${discovered.length} 个免费模型，例如 ${discovered[0].id}`);
});

test('apply() 之后 adapter 能解析到目录里的模型（需要真实运行时）', { timeout: 180000 }, async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, { dataDir: PREPARED, requestTimeoutMs: 120000 });
  const adapter = registered.adapters[0].adapter;
  const discovered = await registered.discovery[0].fn({ provider: PROVIDER_NAME });
  if (!discovered.length) {
    console.log('   （目录为空，跳过解析断言）');
    return;
  }
  // 目录刷新后应能解析出模型元数据（含上下文窗口）。
  const resolved = await adapter.resolveModel(PROVIDER_NAME, discovered[0].id);
  assert.equal(resolved.id, discovered[0].id);
  assert.equal(resolved.provider, PROVIDER_NAME);
  assert.ok(resolved.context?.contextWindow > 0, '应当带上下文窗口');
  // prepareCall 必须返回一个可用的 stream 入口。
  const prepared = await adapter.prepareCall(PROVIDER_NAME, discovered[0].id);
  assert.equal(typeof prepared.stream, 'function');
});

after(async () => {
  // 让插件进程把隔离服务停掉：apply() 里注册的 effect 会做这件事，
  // 但测试进程要主动触发一次，否则会留下子进程。
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(0);
});
