// OpenCode 会话客户端：把一次 pi-ai 请求翻译成 OpenCode 的会话调用，并把响应解回信封。
//
// 这一层有三个必须做对的地方：
//  1) 工具调用只能以"数据"表达（JSON 信封）—— OpenCode 不接受客户端注入的工具定义；
//  2) 模型若试图调用本机工具，会被审批闸门拦下；我们拒绝它，并尽量把那个动作转交给 DSH；
//  3) 出错要区分"模型不守格式"（值得纠正一次）与"上游/网络问题"（直接失败）。
//
// 关键实现细节：审批载荷里**没有**工具名（只有 callID），工具名只出现在事件流的
// message.part.updated 里。所以要转交动作就必须订阅 /event —— 这是唯一的可靠来源。

import { decodeEnvelope, ProtocolError } from './protocol.mjs';
import { extractEnvelopeText, buildHandoff, nativePermissions } from './handoff.mjs';

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
  if (signal?.aborted) return onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
});

export class OpenCodeClient {
  #base; #authorization; #log; #timeout;
  #events = null;          // 事件流控制器
  #toolParts = new Map();  // callID -> { tool, input }
  #pending = new Map();    // permissionID -> permission 载荷
  #usage = new Map();      // sessionID -> tokens

  constructor({ base, authorization, log = () => {}, requestTimeoutMs = 300000 }) {
    this.#base = base;
    this.#authorization = authorization;
    this.#log = log;
    this.#timeout = requestTimeoutMs;
  }

  async #request(route, { method = 'GET', body, signal, timeoutMs } = {}) {
    const timeout = timeoutMs === undefined ? this.#timeout : timeoutMs;
    const signals = [];
    if (signal) signals.push(signal);
    if (timeout) signals.push(AbortSignal.timeout(timeout));
    const response = await fetch(`${this.#base}${route}`, {
      method,
      headers: { Authorization: this.#authorization, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenCode HTTP ${response.status}: ${text.slice(0, 400)}`);
      error.status = response.status;
      throw error;
    }
    if (!text) return undefined;
    try { return JSON.parse(text); }
    catch { throw new Error('OpenCode 返回了非 JSON 响应'); }
  }

  providers(signal) { return this.#request('/provider', { signal, timeoutMs: 30000 }); }

  // ---- 事件流：工具名与参数的唯一来源 ----
  #ensureEvents() {
    if (this.#events) return;
    const controller = new AbortController();
    this.#events = controller;
    (async () => {
      while (!controller.signal.aborted) {
        try { await this.#streamEvents(controller.signal); }
        catch (error) { if (controller.signal.aborted) return; this.#log(`事件流中断：${error.message}`); }
        await delay(1000, controller.signal).catch(() => {});
      }
    })().catch(() => {});
  }

  stopEvents() { this.#events?.abort(); this.#events = null; }

  async #streamEvents(signal) {
    const response = await fetch(`${this.#base}/event`, {
      headers: { Authorization: this.#authorization, Accept: 'text/event-stream' }, signal,
    });
    if (!response.ok) throw new Error(`事件流 HTTP ${response.status}`);
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try { this.#handleEvent(JSON.parse(line.slice(5).trim())); } catch { /* 单条坏事件不该中断流 */ }
      }
    }
  }

  #handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper;
    const type = event?.type;
    const properties = event?.properties ?? {};
    if (type === 'permission.asked' || type === 'permission.updated') {
      if (properties.id) this.#pending.set(properties.id, properties);
    }
    if (type === 'permission.replied') this.#pending.delete(properties.requestID);
    if (type === 'message.part.updated') {
      const part = properties.part;
      if (part?.type === 'tool' && part.callID) {
        this.#toolParts.set(part.callID, { tool: part.tool, input: part.state?.input ?? {} });
        if (this.#toolParts.size > 100) this.#toolParts.delete(this.#toolParts.keys().next().value);
      }
    }
    if (type === 'message.updated') {
      const info = properties.info;
      if (info?.role === 'assistant' && info.tokens) this.#usage.set(info.sessionID, info.tokens);
    }
  }

  /** 审批载荷里只有 callID；工具名与参数要等事件流补上，最多等约 500ms。 */
  async #blockedAction(callID, signal) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const part = this.#toolParts.get(callID);
      if (part?.tool) return part;
      await delay(100, signal).catch(() => {});
    }
    return this.#toolParts.get(callID) ?? null;
  }

  /** 一轮推理。返回信封（content + calls），或在转交成功时返回转交出来的那个调用。 */
  async complete({ modelID, variant, system, text, images, tools, choice, parallel, signal, onProgress = () => {} }) {
    const session = await this.#request('/session', {
      method: 'POST',
      body: {
        title: 'oc-free',
        permission: Object.entries(nativePermissions).map(([permission, action]) => ({ permission, pattern: '*', action })),
      },
      signal, timeoutMs: 20000,
    });
    const route = `/session/${encodeURIComponent(session.id)}`;
    this.#ensureEvents();

    const controller = new AbortController();
    const guard = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const rejected = new Set();
    let handedOff = null;

    // 审批监视器与推理并行跑：只负责拒绝本机动作，并把能表达的那个动作捞出来转交。
    const watcher = (async () => {
      while (!guard.aborted && !handedOff) {
        const pending = [...this.#pending.values()].filter((permission) => permission.sessionID === session.id);
        for (const permission of pending) {
          if (rejected.has(permission.id)) continue;
          rejected.add(permission.id);
          const callID = permission.tool?.callID;
          const action = callID ? await this.#blockedAction(callID, guard) : null;
          const handoff = action?.tool ? buildHandoff({ native: action.tool, input: action.input ?? {}, tools, choice }) : null;
          await this.#reject(permission.id, handoff
            ? 'This native action is executed by the external client instead.'
            : rejectReason(action, callID), guard);
          if (handoff) { handedOff = handoff; return; }
        }
        await delay(250, guard).catch(() => {});
      }
      return null;
    })();

    const payload = {
      model: { providerID: 'opencode', modelID },
      ...(variant ? { variant } : {}),
      system: `${system}\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.`,
      format: { type: 'json_schema', retryCount: 0, schema: envelopeSchema(tools, choice, parallel) },
      parts: [{ type: 'text', text }, ...(images ?? [])],
    };

    try {
      onProgress('waiting');
      let lastError;
      // 最多三轮：首轮 + 一次格式纠正 + 一次压缩重发。信封格式问题值得给模型一次机会。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await Promise.race([
          watcher.then((handoff) => ({ handoff })),
          this.#request(`${route}/message`, { method: 'POST', body: payload, signal, timeoutMs: this.#timeout }),
        ]);
        onProgress('checking');

        const handoff = response?.handoff ?? handedOff;
        if (handoff) {
          await this.#request(`${route}/abort`, { method: 'POST', signal, timeoutMs: 5000 }).catch(() => {});
          return { envelope: { content: '', calls: [handoff] }, tokens: await this.#usageOf(session.id), handoff: true };
        }

        // 上游自身的错误（额度、鉴权、下线）直接失败，不重试。
        if (response?.info?.error) {
          const info = response.info.error;
          const error = new ProtocolError(info.data?.message || info.message || info.name || '上游模型错误', 'model_error');
          error.status = info.data?.statusCode;
          throw error;
        }
        if (response?.info?.finish === 'length') {
          lastError = new ProtocolError('模型输出被长度上限截断', 'output_truncated');
          payload.parts = [{ type: 'text', text: 'Your previous reply was cut off before the envelope closed. Send it again, much more compactly.' }];
          continue;
        }

        this.#assertNoNativeTools(response, rejected);
        const envelopeText = extractEnvelopeText(response);
        try {
          const envelope = decodeEnvelope(envelopeText, tools, choice);
          return { envelope, tokens: response?.info?.tokens ?? await this.#usageOf(session.id), text: envelopeText };
        } catch (error) {
          if (!(error instanceof ProtocolError) || !['invalid_model_output', 'invalid_tool_call'].includes(error.code)) throw error;
          lastError = error;
          if (attempt === 0) {
            payload.parts = [{ type: 'text', text: 'Your previous reply failed the adapter JSON check. Nothing was executed. Return exactly {"content":"string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields required; use [] when no tool is needed. Do not call native tools.' }];
          }
        }
      }
      throw lastError ?? new ProtocolError('模型没有返回可用的信封', 'invalid_model_output');
    } finally {
      controller.abort();
      await watcher.catch(() => {});
      for (const [id, permission] of this.#pending) if (permission.sessionID === session.id) this.#pending.delete(id);
      this.#usage.delete(session.id);
      await this.#request(`${route}/abort`, { method: 'POST', signal, timeoutMs: 5000 }).catch(() => {});
      await this.#request(route, { method: 'DELETE', signal, timeoutMs: 10000 }).catch(() => {});
    }
  }

  async #usageOf(sessionID) {
    const fromEvents = this.#usage.get(sessionID);
    if (fromEvents) return fromEvents;
    return undefined;
  }

  async #reject(permissionID, message, signal) {
    return this.#request(`/permission/${encodeURIComponent(permissionID)}/reply`, {
      method: 'POST', body: { reply: 'reject', message }, signal, timeoutMs: 5000,
    }).catch(() => {});
  }

  /** 被拦下的本机工具活动若出现在 parts 里，说明围栏没兜住 —— 这一轮必须失败。 */
  #assertNoNativeTools(response, rejected) {
    const offending = (response?.parts ?? []).find((part) => part?.type === 'tool'
      && !['StructuredOutput', 'invalid'].includes(part.tool) && !rejected.has(part.callID));
    if (offending) throw new ProtocolError(`模型试图调用本机工具 ${offending.tool}，已拒绝`, 'native_tool_activity');
  }
}

function rejectReason(action, callID) {
  if (!callID) return 'This approval carries no call ID, so it cannot be matched to an external tool. Return the action inside the JSON envelope instead.';
  if (!action?.tool) return 'The blocked call could not be read back from the session. Return the action inside the JSON envelope instead.';
  return `Native tool "${action.tool}" is forbidden here, and its arguments could not be mapped onto the external tools offered in this request. Return the intended action inside the JSON envelope instead.`;
}

/** calls 的 schema 由本次工具表生成：可选的名字被 const 锁死。 */
export function envelopeSchema(tools, choice, parallel) {
  const items = tools.map((tool) => ({
    type: 'object',
    properties: {
      name: { type: 'string', const: tool.name },
      arguments: tool.parameters ?? { type: 'object', properties: {} },
    },
    required: ['name', 'arguments'],
    additionalProperties: false,
  }));
  return {
    type: 'object',
    properties: {
      content: { type: 'string' },
      calls: {
        type: 'array',
        ...(parallel ? {} : { maxItems: 1 }),
        ...(choice.kind === 'required' || choice.kind === 'forced' ? { minItems: 1 } : {}),
        ...(items.length ? { items: { anyOf: items } } : { maxItems: 0, items: { type: 'object' } }),
      },
    },
    required: ['content', 'calls'],
    additionalProperties: false,
  };
}
