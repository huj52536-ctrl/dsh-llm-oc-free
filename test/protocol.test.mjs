// 协议层单测：信封解码、工具选择语义、对话压缩、用量换算。
// 全部是纯函数，不碰网络也不碰 OpenCode。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEnvelope, readToolChoice, readTranscript, conversationToText, adapterPrompt, toUsage } from '../src/protocol.mjs';

const READ = { name: 'Read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
const AUTO = { kind: 'auto' };

test('tool_choice 三种语义都能识别', () => {
  assert.deepEqual(readToolChoice('auto', [READ]), { kind: 'auto' });
  assert.deepEqual(readToolChoice('none', [READ]), { kind: 'none' });
  assert.deepEqual(readToolChoice('required', [READ]), { kind: 'required' });
  assert.deepEqual(readToolChoice({ function: { name: 'Read' } }, [READ]), { kind: 'forced', name: 'Read' });
});

test('标准信封解码成 content + calls', () => {
  const result = decodeEnvelope('{"content":"我来看一下","calls":[{"name":"Read","arguments":{"file_path":"a.txt"}}]}', [READ], AUTO);
  assert.equal(result.content, '我来看一下');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'Read');
  assert.deepEqual(result.calls[0].arguments, { file_path: 'a.txt' });
  assert.match(result.calls[0].id, /^call_/);
});

test('容忍 Markdown 围栏与前后杂句', () => {
  const fenced = decodeEnvelope('```json\n{"content":"ok","calls":[]}\n```', [READ], AUTO);
  assert.equal(fenced.content, 'ok');
  const chatty = decodeEnvelope('好的，这是结果：{"content":"ok","calls":[]} 希望有帮助', [READ], AUTO);
  assert.equal(chatty.content, 'ok');
});

test('content 为 null / calls 缺席都按文档语义补齐', () => {
  const onlyCalls = decodeEnvelope('{"content":null,"calls":[{"name":"Read","arguments":{"file_path":"a"}}]}', [READ], AUTO);
  assert.equal(onlyCalls.content, '');
  assert.equal(onlyCalls.calls.length, 1);
  const onlyText = decodeEnvelope('{"content":"只有文字"}', [READ], AUTO);
  assert.deepEqual(onlyText.calls, []);
  assert.equal(onlyText.content, '只有文字');
});

test('OpenAI 风格 tool_calls 是等价表达', () => {
  const result = decodeEnvelope(JSON.stringify({
    content: '', tool_calls: [{ type: 'function', function: { name: 'Read', arguments: '{"file_path":"b"}' } }],
  }), [READ], AUTO);
  assert.equal(result.calls[0].name, 'Read');
  assert.deepEqual(result.calls[0].arguments, { file_path: 'b' });
});

test('二次 JSON 编码的 calls 会被解开', () => {
  const result = decodeEnvelope(JSON.stringify({ content: '', calls: JSON.stringify([{ name: 'Read', arguments: { file_path: 'c' } }]) }), [READ], AUTO);
  assert.equal(result.calls[0].name, 'Read');
});

test('未提供的工具名必须被拒（不放宽可执行范围）', () => {
  assert.throws(
    () => decodeEnvelope('{"content":"","calls":[{"name":"Bash","arguments":{"command":"rm -rf /"}}]}', [READ], AUTO),
    (error) => error.code === 'invalid_tool_call' && /did not offer/.test(error.message),
  );
});

test('tool_choice:none 时模型仍然提议工具 -> 拒绝', () => {
  assert.throws(
    () => decodeEnvelope('{"content":"","calls":[{"name":"Read","arguments":{"file_path":"a"}}]}', [READ], { kind: 'none' }),
    (error) => error.code === 'invalid_tool_call',
  );
});

test('tool_choice:required 时模型不给调用 -> 拒绝', () => {
  assert.throws(
    () => decodeEnvelope('{"content":"没有工具"}', [READ], { kind: 'required' }),
    (error) => error.code === 'invalid_tool_call',
  );
});

test('强制某个工具时，换成别的也要被拒', () => {
  const WRITE = { name: 'Write', parameters: { type: 'object', properties: {} } };
  assert.throws(
    () => decodeEnvelope('{"content":"","calls":[{"name":"Write","arguments":{}}]}', [READ, WRITE], { kind: 'forced', name: 'Read' }),
    (error) => error.code === 'invalid_tool_call',
  );
});

test('非 JSON、空回复、数组信封都是格式错误', () => {
  for (const bad of ['', '   ', 'not json at all', '[1,2,3]', 'null']) {
    assert.throws(() => decodeEnvelope(bad, [READ], AUTO), (error) => error.code === 'invalid_model_output', `应拒绝：${bad}`);
  }
});

test('readTranscript 还原 systemPrompt 与工具表（pi-ai 会把它们折进 messages）', () => {
  const { system, tools, conversation } = readTranscript([
    { role: 'system', content: '你是编码助手。', toolsAdded: [READ], timestamp: 0 },
    { role: 'user', content: [{ type: 'text', text: '读一下 a.txt' }] },
  ]);
  assert.equal(system, '你是编码助手。');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].role, 'user');
});

test('readTranscript 处理 toolsRemoved 与后置 system 段', () => {
  const WRITE = { name: 'Write', parameters: { type: 'object', properties: {} } };
  const { system, tools } = readTranscript([
    { role: 'system', content: '基础提示', toolsAdded: [READ, WRITE], timestamp: 0 },
    { role: 'user', content: 'hi' },
    { role: 'system', content: '补充段落', toolsRemoved: [{ name: 'Write' }], sections: { todo: '记得写测试' } },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
  assert.match(system, /基础提示/);
  assert.match(system, /补充段落/);
  assert.match(system, /记得写测试/);
});

test('conversationToText 保留工具调用与工具结果，供模型回放', () => {
  const text = conversationToText([
    { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
    { role: 'assistant', content: [
      { type: 'text', text: '好的' },
      { type: 'thinking', thinking: '我应该调用 Read' },
      { type: 'toolCall', id: 'call_1', name: 'Read', arguments: { file_path: 'a.txt' } },
    ] },
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'Read', content: [{ type: 'text', text: '文件内容' }] },
  ]);
  const parsed = JSON.parse(text);
  assert.equal(parsed[0].content, '读 a.txt');
  assert.equal(parsed[1].tool_calls[0].name, 'Read');
  assert.equal(parsed[1].reasoning, '我应该调用 Read');
  assert.equal(parsed[2].tool_call_id, 'call_1');
  assert.equal(parsed[2].content, '文件内容');
  assert.equal(parsed[2].role, 'tool_result');
});

test('适配器系统指令包含四条硬约束', () => {
  const prompt = adapterPrompt({ tools: [READ], choice: AUTO });
  assert.match(prompt, /external client owns ALL execution/i);
  assert.match(prompt, /ONLY native tool you may invoke is StructuredOutput/);
  assert.match(prompt, /Choose actions ONLY from the external tools/);
  assert.match(prompt, /no Markdown fence/);
  assert.match(prompt, /"Read"/);
});

test('没有可用工具时明确要求 calls 为空', () => {
  const prompt = adapterPrompt({ tools: [], choice: AUTO });
  assert.match(prompt, /calls MUST be empty/);
});

test('usage 把缓存与推理并进总账（OpenAI 口径）', () => {
  const usage = toUsage({ input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 }, total: 21 });
  assert.equal(usage.input, 13);   // 10 + 2 + 1
  assert.equal(usage.output, 8);   // 5 + 3
  assert.equal(usage.cacheRead, 2);
  assert.equal(usage.totalTokens, 21);
  assert.equal(usage.cost.total, 0);
  assert.equal(toUsage(undefined), undefined);
});
