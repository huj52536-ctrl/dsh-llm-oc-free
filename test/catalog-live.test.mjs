// 目录契约：DSH 会严格校验适配器交出来的模型元数据，任一条不满足就抛 LlmError
// （INVALID_CATALOG / INVALID_MODEL_CONTEXT / INVALID_MODEL_MAX_TOKENS /
//   INVALID_MODEL_REASONING），在界面上的表现就是"这个 provider 一个模型都选不了"。
//
// 这里逐条复刻 dsh-llm/lib/index.js 的 listModels() 与 normalizeModelInfo()，
// 拿**真实的** OpenCode 免费模型目录过一遍，而不是等重启后到界面上撞。
//
// 需要网络；目录为空时明确跳过，而不是假装通过。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createAdapter } from '../src/adapter.mjs';
import { OpenCodeClient } from '../src/opencode-client.mjs';
import { ensureRuntime, startOpenCode } from '../src/opencode-runtime.mjs';
import { freeModels, reasoningEfforts } from '../src/index.mjs';

const PROVIDER = 'oc-free';
const DATA_DIR = path.join(os.tmpdir(), 'dsh-oc-free-catalog');

let runtime, client, adapter, catalog = [];

before(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const selected = await ensureRuntime({ dataDir: DATA_DIR, log: () => {} });
  runtime = await startOpenCode({ binary: selected.file, dataDir: DATA_DIR, log: () => {} });
  client = new OpenCodeClient({ base: runtime.base, authorization: runtime.authorization, requestTimeoutMs: 180000 });

  const providers = await client.providers();
  catalog = freeModels(providers).map((model) => ({ ...model, efforts: reasoningEfforts(model) }));

  adapter = createAdapter({
    catalog: () => catalog,
    log: () => {},
    reasoningVariant: (model, reasoning) => model?.efforts?.[reasoning],
    complete: (request) => client.complete(request),
  });
  console.log(`\n真实目录：${catalog.length} 个免费模型`);
}, { timeout: 900000 });

after(async () => {
  client?.stopEvents();
  await runtime?.stop?.();
});

const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;

/** 复刻 dsh-llm 的 listModels() 校验。 */
function validateCatalogEntries(provider, models) {
  const seen = new Set();
  for (const model of models) {
    const who = model?.id ?? '(缺 id)';
    assert.equal(model.provider, provider, `listModels() 的 provider 必须是 "${provider}"，实际 "${model.provider}"（${who}）`);
    assert.ok(typeof model.id === 'string' && model.id.length > 0, 'model.id 必须是非空字符串');
    assert.ok(typeof model.name === 'string' && model.name.length > 0, `model.name 必须是非空字符串（${who}）`);
    assert.ok(!seen.has(model.id), `模型 id 重复：${who}`);
    assert.ok(model.description === undefined || typeof model.description === 'string', `model.description 类型不对（${who}）`);
    assert.ok(model.inputModalities === undefined || Array.isArray(model.inputModalities), `model.inputModalities 类型不对（${who}）`);
    seen.add(model.id);
  }
  return seen;
}

/** 复刻 dsh-llm 的 normalizeModelInfo() 校验。 */
function validateModelInfo(provider, model, resolved) {
  const who = `${provider}/${model}`;
  assert.ok(resolved !== undefined && resolved !== null, `${who}：resolveModel 没有返回值`);
  assert.equal(resolved.provider, provider, `${who}：resolved.provider 不匹配`);
  assert.equal(resolved.id, model, `${who}：resolved.id 必须等于请求的模型 id`);
  assert.ok(typeof resolved.name === 'string' && resolved.name.length > 0, `${who}：resolved.name 必须是非空字符串`);

  const context = resolved.context;
  if (context !== undefined) {
    assert.ok(
      Number.isInteger(context.contextWindow) && context.contextWindow > 0,
      `${who}：context.contextWindow 必须是正整数，实际 ${JSON.stringify(context.contextWindow)}（DSH 会抛 INVALID_MODEL_CONTEXT）`,
    );
  }
  if (resolved.defaultMaxTokens !== undefined) {
    assert.ok(
      isPositiveInt(resolved.defaultMaxTokens),
      `${who}：defaultMaxTokens 必须是正安全整数，实际 ${JSON.stringify(resolved.defaultMaxTokens)}（DSH 会抛 INVALID_MODEL_MAX_TOKENS）`,
    );
  }

  const reasoning = resolved.reasoning;
  if (reasoning === undefined) return;
  assert.ok(Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0, `${who}：reasoning.efforts 不能为空`);
  const seen = new Set();
  for (const effort of reasoning.efforts) {
    assert.ok(typeof effort.id === 'string' && effort.id.length > 0, `${who}：effort.id 必须是非空字符串`);
    assert.ok(typeof effort.name === 'string' && effort.name.length > 0, `${who}：effort.name 必须是非空字符串`);
    assert.ok(!seen.has(effort.id), `${who}：effort.id 重复：${effort.id}`);
    seen.add(effort.id);
  }
  if (reasoning.defaultEffort !== undefined) {
    assert.ok(seen.has(reasoning.defaultEffort), `${who}：defaultEffort "${reasoning.defaultEffort}" 不在 efforts 里`);
  }
}

test('真实免费模型目录能被 DSH 接受', (t) => {
  if (catalog.length === 0) return t.skip('目录为空（无网络或上游没有免费模型）');
  assert.ok(catalog.length > 0);
});

test('listModels() 的每一条都通过 DSH 的目录校验', async (t) => {
  if (catalog.length === 0) return t.skip('目录为空');
  const models = await adapter.listModels(PROVIDER);
  assert.equal(models.length, catalog.length, 'listModels() 应与目录等长');
  const seen = validateCatalogEntries(PROVIDER, models);
  assert.equal(seen.size, catalog.length);
});

test('resolveModel() 的每一条都通过 DSH 的模型信息校验', async (t) => {
  if (catalog.length === 0) return t.skip('目录为空');
  for (const model of catalog) {
    const resolved = await adapter.resolveModel(PROVIDER, model.id);
    validateModelInfo(PROVIDER, model.id, resolved);
  }
});

test('目录里的上下文/输出上限都是正整数（否则界面直接不可选）', (t) => {
  if (catalog.length === 0) return t.skip('目录为空');
  const bad = catalog.filter((model) => {
    const window = model.input ?? model.context;
    return window !== undefined && !isPositiveInt(window);
  });
  assert.deepEqual(
    bad.map((model) => `${model.id}: input=${model.input} context=${model.context}`),
    [],
    'OpenCode 报的 limit.input/limit.context 不是正整数，describe() 会原样传给 DSH',
  );

  const badOutput = catalog.filter((model) => model.output !== undefined && !isPositiveInt(model.output));
  assert.deepEqual(
    badOutput.map((model) => `${model.id}: output=${model.output}`),
    [],
    'OpenCode 报的 limit.output 不是正整数',
  );
});
