// 端到端：真实 OpenCode 运行时 + 真实免费模型 + 本插件的 adapter。
// 不打桩任何一层 —— 唯一的"替身"是用本插件真实的 apply() 装配出来的对象图。
//
// 需要网络（免费模型在 opencode.ai 上）。目录为空时明确跳过，而不是假装通过。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createAdapter } from '../src/adapter.mjs';
import { OpenCodeClient } from '../src/opencode-client.mjs';
import { ensureRuntime, startOpenCode } from '../src/opencode-runtime.mjs';
import { freeModels, reasoningEfforts } from '../src/index.mjs';

const DATA_DIR = path.join(os.tmpdir(), 'dsh-oc-free-e2e');
const READ = {
  name: 'Read',
  description: 'Read a file from the external working directory.',
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path' } }, required: ['file_path'] },
};

let runtime, client, adapter, catalog = [];

before(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const selected = await ensureRuntime({ dataDir: DATA_DIR, log: (m) => console.log(`   [runtime] ${m}`) });
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
  console.log(`\n真实目录：${catalog.length} 个免费模型；首个 = ${catalog[0]?.id}`);
}, { timeout: 300000 });

after(async () => {
  client?.stopEvents();
  await runtime?.stop?.();
});

function pickModel() {
  return catalog.find((model) => model.toolcall && !model.chatOnly) ?? catalog[0];
}

/** 收 adapter 产出的 DSH StreamChunk。 */
async function collect(options) {
  const prepared = await adapter.prepareCall(options.provider, options.model);
  const chunks = [];
  for await (const chunk of prepared.stream(options)) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
const toolCalls = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block);
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish');

test('真实目录里有免费模型（否则后续无意义）', { timeout: 120000 }, () => {
  assert.ok(catalog.length > 0, '免费模型目录为空 —— 上游可能变了或网络不可达');
});

test('真实模型：纯文本一轮走通并带 usage', { timeout: 300000 }, async (t) => {
  const model = pickModel();
  if (!model) return t.skip('没有可用模型');
  const chunks = await collect({
    provider: 'oc-free', model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
    systemPrompt: '你是一个简洁的助手。',
    tools: [],
  });

  const text = textOf(chunks);
  const usage = chunks.find((c) => c.type === 'usage');
  const finish = finishOf(chunks);
  console.log(`   ${model.id} -> ${JSON.stringify(text).slice(0, 60)}  usage=${JSON.stringify(usage?.usage)}`);
  assert.ok(text.length > 0, '应当收到正文');
  assert.equal(finish?.reason?.kind, 'stop');
  assert.ok(usage?.usage?.inputTokens > 0, '应当有输入 token 统计');
});

test('真实模型：工具调用闭环（模型选 Read，转成 DSH tool-call）', { timeout: 300000 }, async (t) => {
  const model = pickModel();
  if (!model) return t.skip('没有可用模型');
  const chunks = await collect({
    provider: 'oc-free', model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '请读取文件 D:/demo/notes.txt，用 Read 工具。' }] }],
    systemPrompt: '你是一个编码助手，需要文件内容时请调用工具。',
    tools: [READ],
  });

  const calls = toolCalls(chunks);
  const finish = finishOf(chunks);
  console.log(`   ${model.id} -> tool=${calls[0]?.name} args=${calls[0]?.arguments} finish=${JSON.stringify(finish?.reason)}`);
  assert.ok(calls.length > 0, '应当收到一个 tool-call block');
  assert.equal(calls[0].name, 'Read');
  assert.equal(JSON.parse(calls[0].arguments).file_path, 'D:/demo/notes.txt');
  assert.equal(finish?.reason?.kind, 'tool-calls');
});

test('真实模型：工具结果回传后能基于结果作答', { timeout: 300000 }, async (t) => {
  const model = pickModel();
  if (!model) return t.skip('没有可用模型');
  const chunks = await collect({
    provider: 'oc-free', model: model.id,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '读一下 D:/demo/notes.txt' }] },
      { role: 'assistant', source: {}, content: [{ type: 'tool-call', id: 'call_x', name: 'Read', arguments: { file_path: 'D:/demo/notes.txt' } }] },
      { role: 'tool', toolCallId: 'call_x', toolName: 'Read', content: [{ type: 'text', text: '文件内容是：今天天气很好。' }] },
    ],
    systemPrompt: '你是一个编码助手。工具结果已经给出，请据此回答。',
    tools: [READ],
  });

  const text = textOf(chunks);
  console.log(`   ${model.id} -> text=${JSON.stringify(text).slice(0, 80)}`);
  assert.ok(text.length > 0, '应当基于工具结果给出回答');
});

test('真实模型：多轮之后仍正确（第二次请求带上完整历史）', { timeout: 300000 }, async (t) => {
  const model = pickModel();
  if (!model) return t.skip('没有可用模型');
  const chunks = await collect({
    provider: 'oc-free', model: model.id,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '记住数字 42。' }] },
      { role: 'assistant', source: {}, content: [{ type: 'text', text: '好的，我记住了 42。' }] },
      { role: 'user', content: [{ type: 'text', text: '我刚才让你记的数字是多少？只回答数字。' }] },
    ],
    systemPrompt: '你是一个助手。',
    tools: [],
  });
  const text = textOf(chunks);
  console.log(`   ${model.id} -> ${JSON.stringify(text).slice(0, 60)}`);
  assert.match(text, /42/, '应当从历史里取回 42');
});
