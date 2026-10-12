// handoff 与运行时工具的单测（纯函数，不碰网络与 OpenCode）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, validateAction, extractEnvelopeText, nativePermissions } from '../src/handoff.mjs';
import { freeModels, reasoningEfforts, dataDirectory } from '../src/index.mjs';
import { runtimePackage, localCandidates } from '../src/opencode-runtime.mjs';

const BASH = { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } };
const READ = { name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
const AUTO = { kind: 'auto' };

test('被拦下的 bash 动作转交成 Bash 调用', () => {
  const call = buildHandoff({ native: 'bash', input: { command: 'ls -la' }, tools: [BASH], choice: AUTO });
  assert.equal(call.name, 'Bash');
  assert.deepEqual(call.arguments, { command: 'ls -la' });
  assert.match(call.id, /^call_/);
});

test('read 的 filePath 映射成 file_path', () => {
  const call = buildHandoff({ native: 'read', input: { filePath: 'D:/a.txt' }, tools: [READ], choice: AUTO });
  assert.equal(call.name, 'Read');
  assert.deepEqual(call.arguments, { file_path: 'D:/a.txt' });
});

test('必填项凑不齐就不转交（宁可回一条带原因的拒绝）', () => {
  assert.equal(buildHandoff({ native: 'bash', input: { description: '没有命令' }, tools: [BASH], choice: AUTO }), null);
  assert.equal(buildHandoff({ native: 'read', input: {}, tools: [READ], choice: AUTO }), null);
});

test('目标工具没在本次请求里提供就不转交', () => {
  assert.equal(buildHandoff({ native: 'bash', input: { command: 'ls' }, tools: [READ], choice: AUTO }), null);
});

test('tool_choice:none 时不转交任何动作', () => {
  assert.equal(buildHandoff({ native: 'bash', input: { command: 'ls' }, tools: [BASH], choice: { kind: 'none' } }), null);
});

test('强制其它工具时，不转交这个动作', () => {
  assert.equal(buildHandoff({ native: 'bash', input: { command: 'ls' }, tools: [BASH, READ], choice: { kind: 'forced', name: 'Read' } }), null);
});

test('只填目标 schema 声明的字段（未声明的键要丢掉）', () => {
  const call = buildHandoff({ native: 'read', input: { filePath: 'a.txt', secret: '不该出现' }, tools: [READ], choice: AUTO });
  assert.deepEqual(Object.keys(call.arguments), ['file_path']);
});

test('validateAction 拒绝未提供的工具与多余参数', () => {
  assert.equal(validateAction({ name: 'Bash', arguments: { command: 'ls' } }, [READ]), null);
  assert.equal(validateAction({ name: 'Read', arguments: { file_path: 'a', extra: 1 } }, [READ]), null);
  assert.equal(validateAction({ name: 'Read', arguments: {} }, [READ]), null);
  const ok = validateAction({ name: 'read', arguments: { file_path: 'a' } }, [READ]);
  assert.equal(ok.name, 'Read');
  assert.deepEqual(ok.arguments, { file_path: 'a' });
});

test('信封三种抵达方式都能取出文本', () => {
  assert.equal(extractEnvelopeText({ info: { structured: { content: 'a', calls: [] } } }), '{"content":"a","calls":[]}');
  assert.equal(extractEnvelopeText({ parts: [
    { type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input: { content: 'b', calls: [] } } },
  ] }), '{"content":"b","calls":[]}');
  assert.equal(extractEnvelopeText({ parts: [{ type: 'text', text: '{"content":"c","calls":[]}' }] }), '{"content":"c","calls":[]}');
});

test('权限表把本机动作设为 ask、其余原生能力设为 deny', () => {
  assert.equal(nativePermissions['*'], 'ask');
  for (const key of ['question', 'websearch', 'webfetch', 'task', 'todowrite']) {
    assert.equal(nativePermissions[key], 'deny', `${key} 应当被拒`);
  }
});

test('免费模型按价格字段判定，不看名字', () => {
  const providers = { all: [{ id: 'opencode', models: {
    // 名字里没有 free，但价格全零 -> 算免费
    'zero-cost': { name: 'Zero', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, capabilities: { output: { text: true }, toolcall: true }, limit: { context: 1000, output: 100 } },
    // 名字里有 free，但要钱 -> 不算
    'paid-free': { name: 'Paid Free', cost: { input: 1, output: 0, cache: { read: 0, write: 0 } }, capabilities: { output: { text: true } } },
    // 已下线 -> 排除
    'deprecated-one': { name: 'Old', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, capabilities: { output: { text: true } }, status: 'deprecated' },
    // 不输出文本 -> 排除
    'no-text': { name: 'Embed', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, capabilities: { output: { text: false } } },
    // 缓存要钱 -> 不算
    'cache-paid': { name: 'Cache', cost: { input: 0, output: 0, cache: { read: 1, write: 0 } }, capabilities: { output: { text: true } } },
  } }] };
  const found = freeModels(providers);
  assert.deepEqual(found.map((m) => m.id), ['opencode/zero-cost']);
  assert.equal(found[0].toolcall, true);
  assert.equal(found[0].context, 1000);
  assert.equal(found[0].output, 100);
});

test('只有 variants 里带 reasoningEffort 的才算可下发档位', () => {
  const efforts = reasoningEfforts({ variants: {
    low: { reasoningEffort: 'low' },
    high: { reasoningEffort: 'high' },
    default: {},
    weird: { reasoningEffort: 42 },
  } });
  assert.deepEqual(efforts, { low: 'low', high: 'high' });
});

test('数据目录按系统惯例落位，且与别的工具分开', () => {
  assert.match(dataDirectory('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me'), /dsh-llm-oc-free$/);
  assert.match(dataDirectory('darwin', {}, '/Users/me'), /Application Support\/dsh-llm-oc-free$/);
  assert.match(dataDirectory('linux', { XDG_CONFIG_HOME: '/home/me/.config' }, '/home/me'), /dsh-llm-oc-free$/);
});

test('运行时包名按平台/架构给出', () => {
  assert.deepEqual(runtimePackage('win32', 'x64'), { name: 'opencode-windows-x64', binary: 'opencode.exe' });
  assert.deepEqual(runtimePackage('darwin', 'arm64'), { name: 'opencode-darwin-arm64', binary: 'opencode' });
  assert.throws(() => runtimePackage('sunos', 'x64'), /不支持/);
});

test('启动脚本不会被当成运行时（.cmd/.bat 候选要在探测前排除）', () => {
  const candidates = localCandidates({ name: 'opencode-windows-x64', binary: 'opencode.exe' }, 'win32', { APPDATA: 'C:\\AppData' }, 'C:\\Users\\me');
  assert.ok(candidates.some((file) => file.endsWith('opencode.exe')));
  // 候选里必须不含 .cmd（npm 全局装的是包装脚本，不是真实映像）
  assert.ok(!candidates.some((file) => /\.cmd$/i.test(file)));
});
