// DSH 的 LLM 适配器实现。
//
// 为什么自己实现，而不是复用 dsh-llm-pi-ai 的 PiAiAdapter：
//   实测（见 .fixtures/diag-probe 的诊断报告）在 DSH 的加载器环境里，
//   从被 link 的插件目录**无法解析** `@deepseek-ai/*` 裸说明符：
//     Cannot find package '@deepseek-ai/dsh-llm-pi-ai' imported from .../src/index.mjs
//   只有不 import 任何 DSH 包，插件才能在任何安装方式下稳定加载。
//   代价是要自己产出 DSH 的 StreamChunk，但那份协议很小、也很稳定。
//
// 本文件因此不 import 任何外部包 —— 这也是它唯一的硬约束。

import { readTranscript, conversationToText, adapterPrompt, readToolChoice, toUsage } from './protocol.mjs';

const PROVIDER = 'oc-free';

/** DSH 的 StreamChunk 协议（来自 dsh-llm-pi-ai 的消费者 switch，逐条对齐）。 */
function* toChunks(result) {
  const { envelope } = result;
  // opencode-client 给的是 OpenCode 的 token 计数；这里换算成 DSH 的口径。
  const usage = result.usage ?? toUsage(result.tokens);
  const calls = envelope?.calls ?? [];
  const content = envelope?.content ?? '';
  let index = 0;

  if (content) {
    yield { type: 'block-start', index, blockType: 'text' };
    yield { type: 'text-delta', index, text: content };
    yield { type: 'block-end', index, block: { type: 'text', text: content } };
    index += 1;
  }

  for (const call of calls) {
    yield { type: 'block-start', index, blockType: 'tool-call' };
    // id 必须立刻可见：DSH 靠它把后续的 tool result 配对回来。
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: '' };
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    };
    index += 1;
  }

  if (usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        totalTokens: usage.totalTokens,
        ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
        ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
      },
    };
  }

  // 结束原因决定 DSH 如何继续：tool-calls 会去执行工具，stop 会收尾这一轮。
  const lengthCapped = result.finish === 'length';
  yield {
    type: 'finish',
    reason: lengthCapped
      ? { kind: 'max-tokens' }
      : calls.length
        ? { kind: 'tool-calls' }
        : content
          ? { kind: 'stop' }
          : { kind: 'error', failure: { message: '模型返回了空回复', code: 'EMPTY_RESPONSE' } },
  };
}

/** 把 DSH 的持久消息压平成模型能读的 JSON，并拼出完整的 system。 */
function transcriptText(messages, systemPrompt, tools, choice) {
  const { conversation } = readTranscript(messages);
  // DSH 把系统提示与工具表放在 options 上；补一段等效的 system 段，
  // 让 readTranscript 的累积语义（toolsAdded / 后置 system）保持不变。
  const shaped = systemPrompt || tools?.length
    ? [{ role: 'system', content: systemPrompt ?? '', ...(tools?.length ? { toolsAdded: tools } : {}), timestamp: 0 }, ...conversation]
    : conversation;
  const { system: externalSystem, tools: declared, conversation: real } = readTranscript(shaped);

  // 适配器的协议约束必须真的进 system：否则模型不知道"执行权在外部、只能回信封"，
  // 就会开始假装执行或乱编工具名。外部指令在前，协议约束在后。
  const protocol = adapterPrompt({ tools: declared, choice });
  const system = externalSystem ? `${externalSystem}\n\n${protocol}` : protocol;
  return { system, tools: declared, text: conversationToText(real) };
}

/** DSH 的 assistant 内容块用连字符命名（tool-call / reasoning），与 pi-ai 的驼峰不同。 */
function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.role !== 'assistant') return message;
    const blocks = Array.isArray(message.content) ? message.content : [];
    return {
      ...message,
      content: blocks.map((block) => {
        if (block?.type === 'tool-call') return block;
        if (block?.type === 'toolCall') {
          return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments };
        }
        if (block?.type === 'thinking') return { type: 'reasoning', text: block.thinking ?? block.text ?? '' };
        return block;
      }),
    };
  });
}

/**
 * 创建一个 DSH LLM 适配器。
 * @param {object} deps
 * @param {() => Array} deps.catalog     当前可用的免费模型
 * @param {Function} deps.complete       执行一次推理（见 opencode-client）
 * @param {Function} deps.reasoningVariant
 * @param {Function} deps.log
 */
export function createAdapter({ catalog, complete, reasoningVariant, log = () => {} }) {
  const findModel = (id) => catalog().find((model) => model.id === id);

  function describe(provider, model) {
    const found = findModel(model);
    const levels = Object.keys(found?.efforts ?? {});
    // 只有真的能下发档位时才广告 reasoning。DSH 会拒绝 efforts 为空的元数据
    // （INVALID_MODEL_REASONING），而 OpenCode 里确实存在
    // `capabilities.reasoning === true` 却没有任何 variants 的模型
    // （实测：opencode/big-pickle）—— 照抄 capabilities 会让它整个不可选。
    const reasoning = found?.reasoning && levels.length
      ? {
        efforts: levels.map((level) => ({ id: level, name: level })),
        defaultEffort: levels.includes('medium') ? 'medium' : levels[0],
      }
      : undefined;
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: found?.images ? ['text', 'image'] : ['text'],
      context: { contextWindow: found?.input ?? found?.context ?? 262144 },
      ...(found?.output ? { defaultMaxTokens: found.output } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  async function* streamFor(options) {
    const model = options.model;
    const messages = normalizeMessages(options.messages);
    const choice = readToolChoice(options.toolChoice ?? 'auto', options.tools ?? []);
    const { system, tools, text } = transcriptText(messages, options.systemPrompt, options.tools, choice);
    const parallel = options.parallelToolCalls !== false;
    const found = findModel(model);

    const request = {
      modelID: String(model).replace(/^opencode\//, ''),
      variant: reasoningVariant?.(found, options.reasoningEffort),
      system,
      text,
      images: [],
      tools,
      choice,
      parallel,
      signal: options.signal,
    };

    let result;
    try {
      result = await complete(request);
    } catch (error) {
      const aborted = options.signal?.aborted === true
        || error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR';
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } }
          : { kind: 'error', failure: { message: String(error?.message ?? error), code: error?.code ?? 'PI_AI_ERROR' } },
      };
      return;
    }

    yield* toChunks(result);
  }

  return {
    providerInfo: (provider) => ({ id: provider, name: 'OpenCode 免费模型' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => catalog().map((model) => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: model.images ? ['text', 'image'] : ['text'],
    })),
    resolveModel: async (provider, model) => describe(provider, model),
    // prepareCall 把"模型元数据 + 这一次的 stream 入口"绑定在同一代目录上，
    // 这样设置变更不会让一次请求用上一代的模型信息配下一代的端点。
    prepareCall: async (provider, model) => ({
      model: describe(provider, model),
      stream: (options) => streamFor(options),
    }),
    stream: (options) => streamFor(options),
  };
}
