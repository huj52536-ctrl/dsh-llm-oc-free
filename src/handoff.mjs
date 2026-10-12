// 审批围栏的配套件：权限表、信封文本抽取、以及"被拦下的本机动作 → 外部工具调用"的映射。
//
// 执行权在 DSH 手里：模型若在本机动手，被拦下的那个动作应该直接转交给 DSH，
// 而不是让它复述一遍（"复述"恰好是模型最容易做错的一步，还多花一整轮上游调用）。

/** 本机动作一律要审批；其余原生能力直接拒绝，模型没有别的出路。 */
export const nativePermissions = {
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
};

/**
 * 信封有三种抵达方式：OpenCode 的结构化字段、已完成的 StructuredOutput 调用、纯文本。
 * 只认第一种曾把正确答案判成格式错误，所以三种都要看。
 */
export function extractEnvelopeText(response) {
  const structured = response?.info?.structured;
  if (structured !== undefined && structured !== null) return JSON.stringify(structured);
  const parts = response?.parts ?? [];
  const completed = parts.find((part) => part?.type === 'tool' && part.tool === 'StructuredOutput'
    && part.state?.status === 'completed' && part.state?.input);
  if (completed) return JSON.stringify(completed.state.input);
  const invalid = parts.find((part) => part?.type === 'tool' && part.tool === 'invalid');
  const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('');
  if (!text && invalid) {
    // 模型交了调用但参数不是合法 JSON：把真实原因带出去，而不是笼统地说"空回复"。
    const detail = invalid.state?.input?.error ?? '参数解析失败';
    return `{"__invalid_tool_arguments": ${JSON.stringify(String(detail))}}`;
  }
  return text;
}

// 本机工具名 → 目标工具名 + 字段名映射。同一个字段可能有多种目标拼写：外部工具之间并不统一。
const CATEGORIES = [
  { native: ['bash', 'shell'], targets: ['Bash', 'PowerShell'],
    fields: { command: 'command', description: 'description', timeout: 'timeout' } },
  { native: ['read'], targets: ['Read'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', offset: 'offset', limit: 'limit' } },
  { native: ['write'], targets: ['Write'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', content: 'content' } },
  { native: ['edit', 'multiedit', 'multi_edit', 'patch', 'apply_patch'], targets: ['Edit', 'MultiEdit'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path',
      oldString: 'old_string', old_string: 'old_string', newString: 'new_string', new_string: 'new_string',
      replaceAll: 'replace_all', replace_all: 'replace_all', edits: 'edits' } },
  { native: ['glob'], targets: ['Glob', 'LS'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include' } },
  { native: ['grep'], targets: ['Grep', 'Search'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include' } },
  { native: ['skill'], targets: ['Skill'],
    fields: { name: ['name', 'skill'], args: ['args', 'arguments'] } },
];

/**
 * 把被拦下的本机动作映射成外部调用。
 * 每次请求里 DSH 附带的工具表就是权威：只填目标 schema 里存在的字段，必填项凑不齐就不转交。
 */
export function buildHandoff({ native, input = {}, tools = [], choice = { kind: 'auto' } }) {
  if (choice.kind === 'none' || !tools.length) return null;
  const name = String(native ?? '').toLowerCase();
  const category = CATEGORIES.find((entry) => entry.native.includes(name));
  if (!category) return null;
  const allowed = choice.kind === 'forced' ? tools.filter((tool) => tool.name === choice.name) : tools;

  for (const target of category.targets) {
    const spec = allowed.find((tool) => tool?.name?.toLowerCase() === target.toLowerCase());
    if (!spec) continue;
    const properties = spec.parameters?.properties ?? {};
    const required = Array.isArray(spec.parameters?.required) ? spec.parameters.required : [];
    const args = {};
    for (const [key, value] of Object.entries(input)) {
      const mapped = category.fields[key];
      if (!mapped || value === undefined) continue;
      for (const candidate of Array.isArray(mapped) ? mapped : [mapped]) {
        if (args[candidate] !== undefined || !Object.hasOwn(properties, candidate)) continue;
        args[candidate] = value;
        break;
      }
    }
    if (!Object.keys(args).length) continue;
    if (!required.every((key) => args[key] !== undefined && args[key] !== null && args[key] !== '')) continue;
    return { id: `call_${globalThis.crypto.randomUUID().replaceAll('-', '')}`, name: spec.name, arguments: args };
  }
  return null;
}

/** 翻译出来的动作不享受任何信任：由接收方自己的 schema 裁决。 */
export function validateAction(candidate, tools = []) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const spec = tools.find((tool) => tool?.name?.toLowerCase() === String(candidate.name ?? '').toLowerCase());
  if (!spec) return null;
  const args = candidate.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const properties = spec.parameters?.properties ?? {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) return null;
  const required = Array.isArray(spec.parameters?.required) ? spec.parameters.required : [];
  if (!required.every((key) => args[key] !== undefined && args[key] !== null && args[key] !== '')) return null;
  return { id: candidate.id, name: spec.name, arguments: args };
}
