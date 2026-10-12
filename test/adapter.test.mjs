// adapter 单测：验证我产出的 DSH StreamChunk 协议。
//
// DSH 的消费者只认这几种 chunk（对齐 dsh-llm-pi-ai 的 switch）：
//   block-start / text-delta / block-end / tool-call-delta / reasoning-delta / usage / finish
// 关键点：tool-call 的参数必须序列化成 JSON 字符串，finish.reason 决定 DSH 下一步。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../src/adapter.mjs';
import { readToolChoice } from '../src/protocol.mjs';

const READ = {
  name: 'Read',
  description: '读文件',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
};

const CATALOG = [{
  id: 'opencode/big-pickle', name: 'Big Pickle', context: 200000, input: 200000, output: 32768,
  images: false, toolcall: true, reasoning: true, efforts: { low: 'low', high: 'high' },
}];

function makeAdapter(reply) {
  const seen = [];
  const adapter = createAdapter({
    catalog: () => CATALOG,
    log: () => {},
    reasoningVariant: (model, reasoning) => model?.efforts?.[reasoning],
    complete: async (request) => { seen.push(request); return typeof reply === 'function' ? reply(request) : reply; },
  });
  return { adapter, seen };
}

const OPTIONS = (tools = [], extra = {}) => ({
  provider: 'oc-free',
  model: 'opencode/big-pickle',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  systemPrompt: '你是编码助手。',
  tools,
  ...extra,
});

async function chunks(adapter, options) {
  const prepared = await adapter.prepareCall(options.provider, options.model);
  const list = [];
  for await (const chunk of prepared.stream(options)) list.push(chunk);
  return list;
}

test('纯文本：block-start → text-delta → block-end → usage → finish(stop)', async () => {
  const { adapter } = makeAdapter({
    envelope: { content: '你好呀', calls: [] },
    tokens: { input: 10, output: 3, cache: { read: 2, write: 0 }, total: 15 },
  });
  const list = await chunks(adapter, OPTIONS());
  assert.deepEqual(list.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.equal(list[0].blockType, 'text');
  assert.equal(list[1].text, '你好呀');
  assert.equal(list[2].block.text, '你好呀');
  assert.equal(list[3].usage.inputTokens, 12);   // 10 + 2 缓存读
  assert.equal(list[3].usage.outputTokens, 3);
  assert.equal(list[3].usage.cacheReadTokens, 2);
  assert.equal(list[4].reason.kind, 'stop');
});

test('工具调用：block-end 带 id/name/arguments(JSON 字符串)，finish=tool-calls', async () => {
  const { adapter } = makeAdapter({
    envelope: { content: '', calls: [{ id: 'call_1', name: 'Read', arguments: { file_path: 'a.txt' } }] },
    tokens: { input: 5, output: 2, total: 7 },
  });
  const list = await chunks(adapter, OPTIONS([READ]));
  const start = list.find((c) => c.type === 'block-start' && c.blockType === 'tool-call');
  const delta = list.find((c) => c.type === 'tool-call-delta');
  const end = list.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.ok(start && delta && end);
  assert.equal(delta.id, 'call_1', 'tool-call-delta 必须立刻带 id（DSH 靠它配对结果）');
  assert.equal(delta.name, 'Read');
  assert.equal(end.block.name, 'Read');
  assert.equal(end.block.id, 'call_1');
  assert.equal(typeof end.block.arguments, 'string', 'arguments 必须是 JSON 字符串');
  assert.deepEqual(JSON.parse(end.block.arguments), { file_path: 'a.txt' });
  assert.equal(list.at(-1).reason.kind, 'tool-calls');
});

test('正文与工具调用共存，且 index 互不相同', async () => {
  const { adapter } = makeAdapter({
    envelope: { content: '我来读', calls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'b' } }] },
    tokens: {},
  });
  const list = await chunks(adapter, OPTIONS([READ]));
  const textIndex = list.find((c) => c.type === 'text-delta').index;
  const callIndex = list.find((c) => c.type === 'tool-call-delta').index;
  assert.notEqual(textIndex, callIndex);
  assert.equal(list.at(-1).reason.kind, 'tool-calls');
});

test('输出被截断时报 max-tokens（否则 DSH 会当完整回答）', async () => {
  const { adapter } = makeAdapter({ envelope: { content: '半句', calls: [] }, tokens: {}, finish: 'length' });
  const list = await chunks(adapter, OPTIONS());
  assert.equal(list.at(-1).reason.kind, 'max-tokens');
});

test('空信封报 error/EMPTY_RESPONSE', async () => {
  const { adapter } = makeAdapter({ envelope: { content: '', calls: [] }, tokens: {} });
  const list = await chunks(adapter, OPTIONS());
  const finish = list.at(-1);
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE');
});

test('后端抛错 -> finish(error)，不向消费者 throw', async () => {
  const { adapter } = makeAdapter(() => { throw new Error('上游 502：模型已下线'); });
  const list = await chunks(adapter, OPTIONS());
  const finish = list.at(-1);
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.match(finish.reason.failure.message, /模型已下线/);
});

test('取消 -> finish(aborted)', async () => {
  const controller = new AbortController();
  const { adapter } = makeAdapter(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const list = await chunks(adapter, OPTIONS([], { signal: controller.signal }));
  assert.equal(list.at(-1).reason.kind, 'aborted');
});

test('每轮恰好一个 finish，且一定是最后一个', async () => {
  const { adapter } = makeAdapter({ envelope: { content: 'x', calls: [] }, tokens: {} });
  const list = await chunks(adapter, OPTIONS());
  assert.equal(list.filter((c) => c.type === 'finish').length, 1);
  assert.equal(list.at(-1).type, 'finish');
});

test('resolveModel 带上下文窗口、输出上限与推理档位', async () => {
  const { adapter } = makeAdapter({ envelope: { content: 'x', calls: [] }, tokens: {} });
  const resolved = await adapter.resolveModel('oc-free', 'opencode/big-pickle');
  assert.equal(resolved.provider, 'oc-free');
  assert.equal(resolved.context.contextWindow, 200000);
  assert.equal(resolved.defaultMaxTokens, 32768);
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['low', 'high']);
});

test('listModels 广告目录里的模型', async () => {
  const { adapter } = makeAdapter({ envelope: { content: 'x', calls: [] }, tokens: {} });
  const listed = await adapter.listModels('oc-free');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'opencode/big-pickle');
});

test('请求编译：系统提示含协议约束，工具表透传，上游 id 去前缀', async () => {
  const { adapter, seen } = makeAdapter({ envelope: { content: 'ok', calls: [] }, tokens: {} });
  await chunks(adapter, OPTIONS([READ]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].modelID, 'big-pickle');
  assert.match(seen[0].system, /你是编码助手/);
  assert.match(seen[0].system, /external client owns ALL execution/);
  assert.equal(seen[0].tools.length, 1);
  assert.match(seen[0].text, /conversation|Read|你好/);
});

test('DSH 的 assistant 连字符块名被正确还原成工具调用与推理', async () => {
  const { adapter, seen } = makeAdapter({ envelope: { content: 'ok', calls: [] }, tokens: {} });
  await chunks(adapter, {
    ...OPTIONS([READ]),
    messages: [
      { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
      { role: 'assistant', source: {}, content: [
        { type: 'reasoning', text: '我应该调用 Read' },
        { type: 'tool-call', id: 'call_x', name: 'Read', arguments: { file_path: 'a.txt' } },
      ] },
      { role: 'tool', toolCallId: 'call_x', toolName: 'Read', content: [{ type: 'text', text: '文件内容' }] },
    ],
  });
  const text = seen[0].text;
  assert.match(text, /call_x/, '工具调用 id 要保留（用于配对结果）');
  assert.match(text, /Read/);
  assert.match(text, /文件内容/);
  assert.match(text, /我应该调用 Read/);
});

test('reasoningVariant 把档位映射到 OpenCode 的 variant 名', async () => {
  const { adapter, seen } = makeAdapter({ envelope: { content: 'ok', calls: [] }, tokens: {} });
  await chunks(adapter, OPTIONS([], { reasoningEffort: 'high' }));
  assert.equal(seen[0].variant, 'high');
  const low = makeAdapter({ envelope: { content: 'ok', calls: [] }, tokens: {} });
  await chunks(low.adapter, OPTIONS([], { reasoningEffort: 'low' }));
  assert.equal(low.seen[0].variant, 'low');
});

test('tool_choice 语义被透传（none 时 choice.kind=none）', async () => {
  const { adapter, seen } = makeAdapter({ envelope: { content: 'ok', calls: [] }, tokens: {} });
  await chunks(adapter, OPTIONS([READ], { toolChoice: 'none' }));
  assert.equal(seen[0].choice.kind, 'none');
});

test('readToolChoice 与 adapter 用的是同一套判定', () => {
  assert.deepEqual(readToolChoice('none', [READ]), { kind: 'none' });
  assert.deepEqual(readToolChoice(undefined, [READ]), { kind: 'auto' });
});

// ── 模型元数据形状（src/adapter.mjs 的 describe()）─────────────────────────
// DSH 的 normalizeModelInfo() 会严格校验这些字段，违约直接抛 LlmError
// （INVALID_MODEL_CONTEXT / INVALID_MODEL_MAX_TOKENS / INVALID_MODEL_REASONING），
// 在界面上的表现就是"这个 provider 一个模型都选不了"。

function adapterWith(catalog) {
  return createAdapter({
    catalog: () => catalog,
    log: () => {},
    reasoningVariant: (model, reasoning) => model?.efforts?.[reasoning],
    complete: async () => ({ envelope: { content: '', calls: [] }, tokens: {} }),
  });
}

test('声明了 reasoning 却没有档位时，不得产出空的 efforts', async () => {
  // 这是真实存在的组合：OpenCode 报 capabilities.reasoning=true，variants 却是空的
  // （实测 opencode/big-pickle）。照抄 capabilities 就会踩 INVALID_MODEL_REASONING。
  const adapter = adapterWith([{
    id: 'opencode/x', name: 'X', input: 200000, output: 8192,
    images: false, toolcall: true, reasoning: true, efforts: {},
  }]);
  const info = await adapter.resolveModel('oc-free', 'opencode/x');
  assert.equal(info.reasoning, undefined, '没有可下发的档位，就整个不要广告 reasoning');
  assert.equal(info.context.contextWindow, 200000);
  assert.equal(info.defaultMaxTokens, 8192);
});

test('有档位时才广告 reasoning，且 defaultEffort 一定在列表里', async () => {
  const adapter = adapterWith([{
    id: 'opencode/y', name: 'Y', input: 1000, output: 100,
    images: true, toolcall: true, reasoning: true,
    efforts: { low: 'low', medium: 'medium' },
  }]);
  const info = await adapter.resolveModel('oc-free', 'opencode/y');
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'medium']);
  assert.equal(info.reasoning.defaultEffort, 'medium');
  assert.deepEqual(info.inputModalities, ['text', 'image']);
});

test('目录里没有的模型也能解析出合法元数据（DSH 允许未列出的 id 走核心路由）', async () => {
  const adapter = adapterWith([]);
  const info = await adapter.resolveModel('oc-free', 'opencode/unknown');
  assert.equal(info.provider, 'oc-free');
  assert.equal(info.id, 'opencode/unknown');
  assert.equal(info.name, 'opencode/unknown');
  assert.equal(info.reasoning, undefined);
  assert.ok(Number.isInteger(info.context.contextWindow) && info.context.contextWindow > 0);
});

test('listModels() 的 provider 字段必须是本插件的路由 id', async () => {
  const adapter = adapterWith([{ id: 'opencode/z', name: 'Z', input: 1, images: false }]);
  const models = await adapter.listModels('oc-free');
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, 'oc-free');
  assert.ok(models[0].name.length > 0, 'DSH 要求 name 非空');
});
