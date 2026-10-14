// DeepSeek client. Model is fixed to deepseek-v4.1-flash (alias deepseek-flash).
// The caller owns the turn budget via AbortSignal. No browser fetch options.
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODELS = ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash'];

export class DeepSeekError extends Error {
  constructor(message, code = 'response') { super(message); this.name = 'DeepSeekError'; this.code = code; }
}

export const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

const cleanToken = (token) => {
  const value = String(token || '').trim().replace(/^Bearer\s+/i, '');
  return /^[A-Za-z0-9._-]{8,512}$/.test(value) ? value : '';
};

export class DeepSeekClient {
  #token; #fetch; #requests = new Set(); #closed = false;
  constructor(token, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    const credential = cleanToken(token);
    if (!credential) throw new DeepSeekError('请填写有效的 DeepSeek API key。', 'key');
    this.#token = credential; this.#fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  close() { this.#closed = true; this.#token = ''; this.#requests.forEach((request) => request.abort()); }

  // JSON completion. Unexpected tool calls fail closed. Pass `tools` only through chat().
  async complete(system, input, { signal, exactKeys: keys } = {}) {
    const message = await this.#send([{ role: 'system', content: system }, { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }], { signal, json: true, tools: null });
    if (message.tool_calls?.length) throw new DeepSeekError('模型或推荐响应未通过验证，可先用本地推荐。');
    let value; try { value = JSON.parse(message.content); } catch { throw new DeepSeekError('推荐 JSON 未通过验证，可先用本地推荐。'); }
    if (keys && !exactKeys(value, keys)) throw new DeepSeekError('推荐 JSON 未通过验证，可先用本地推荐。');
    return value;
  }

  // Tool-calling turn. Returns { json, toolCalls, content, message }.
  async chat(messages, { signal, tools, json = false, toolChoice } = {}) {
    const message = await this.#send(messages, { signal, json, tools, toolChoice });
    const toolCalls = (message.tool_calls || []).map((call) => ({
      id: call.id, name: call.function?.name, arguments: parseArgs(call.function?.arguments),
    }));
    let value = null;
    if (!toolCalls.length && typeof message.content === 'string' && message.content.trim()) {
      try { value = JSON.parse(message.content); } catch { value = null; }
    }
    return { json: value, toolCalls, content: message.content, message };
  }

  async #send(messages, { signal, json, tools, toolChoice }) {
    if (this.#closed) throw new DeepSeekError('本次推荐已取消。', 'cancelled');
    if (signal?.aborted) throw new DeepSeekError(signal.reason?.name === 'TimeoutError' ? '这轮超时，按本地规则没有完成。' : '本次推荐已取消。', signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
    const controller = new AbortController(); this.#requests.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const body = {
        model: DEEPSEEK_MODEL, messages, stream: false, thinking: { type: 'disabled' }, max_tokens: 1200, temperature: 0.3,
      };
      if (json) body.response_format = { type: 'json_object' };
      if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice || 'auto'; }
      const content = JSON.stringify(body);
      if (content.length > 28000) throw new DeepSeekError('候选内容过长，请减少这次的选餐条件。');
      const response = await this.#fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#token}` },
        body: content,
      });
      if (!response.ok) {
        const messagesByStatus = { 401: ['API key 未通过验证，请重新填写。', 'auth'], 403: ['DeepSeek 拒绝了这次访问，请检查 API key 权限。', 'auth'], 402: ['DeepSeek 余额不足，请检查官方账户。', 'balance'], 429: ['DeepSeek 暂时繁忙，稍后可手动重试。', 'rate'] };
        const [message, code] = messagesByStatus[response.status] || ['DeepSeek 请求未完成，可先用本地推荐。', 'network'];
        throw new DeepSeekError(message, code);
      }
      const raw = await response.text();
      if (raw.length > 64000) throw new DeepSeekError('DeepSeek 返回内容过长，请重试。');
      let data; try { data = JSON.parse(raw); } catch { throw new DeepSeekError('DeepSeek 返回格式未通过验证，可先用本地推荐。'); }
      const choice = data.choices?.[0], message = choice?.message;
      const toolOk = Boolean(message?.tool_calls?.length);
      if (!MODELS.includes(data.model) || data.choices?.length !== 1 || !['stop', 'tool_calls'].includes(choice.finish_reason) || message?.role !== 'assistant' || message.refusal) throw new DeepSeekError('模型或推荐响应未通过验证，可先用本地推荐。');
      if (!toolOk && typeof message.content !== 'string') throw new DeepSeekError('模型或推荐响应未通过验证，可先用本地推荐。');
      if (controller.signal.aborted) throw new DeepSeekError(timedOut ? '这轮超时，按本地规则没有完成。' : '本次推荐已取消。', timedOut ? 'timeout' : 'cancelled');
      return message;
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      const timed = timedOut || signal?.reason?.name === 'TimeoutError';
      if (controller.signal.aborted || signal?.aborted) throw new DeepSeekError(timed ? '这轮超时，按本地规则没有完成。' : '本次推荐已取消。', timed ? 'timeout' : 'cancelled');
      throw new DeepSeekError('暂时连不上 DeepSeek，可先用本地推荐。', 'network');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#requests.delete(controller); }
  }
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}
