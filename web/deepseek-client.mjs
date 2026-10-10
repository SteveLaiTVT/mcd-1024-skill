import { normalizeDeepSeek } from './agent-memory.mjs';
export const DEEPSEEK_MODEL = 'deepseek-flash'; // Official alias for DeepSeek V4.1 Flash.
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export class DeepSeekError extends Error {
  constructor(message, code = 'response') { super(message); this.name = 'DeepSeekError'; this.code = code; }
}
export class DeepSeekClient {
  #token; #fetch; #requests = new Set(); #closed = false;
  constructor(token, { fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 25000 } = {}) {
    const credential = normalizeDeepSeek({ version: 1, token });
    if (!credential) throw new DeepSeekError('请填写有效的 DeepSeek API key。', 'key');
    this.#token = credential.token; this.#fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  close() { this.#closed = true; this.#token = ''; this.#requests.forEach((request) => request.abort()); }
  async complete(system, input, { signal } = {}) {
    if (this.#closed || signal?.aborted) throw new DeepSeekError('本次推荐已取消。', 'cancelled');
    const controller = new AbortController(); this.#requests.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const content = JSON.stringify(input);
      if (content.length > 28000) throw new DeepSeekError('候选内容过长，请减少这次的选餐条件。');
      const response = await this.#fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#token}` },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content }], stream: false, thinking: { type: 'disabled' }, max_tokens: 1200, temperature: 0.5, response_format: { type: 'json_object' } }),
      });
      if (!response.ok) {
        const messages = { 401: ['API key 未通过验证，请重新填写。', 'auth'], 403: ['DeepSeek 拒绝了这次访问，请检查 API key 权限。', 'auth'], 402: ['DeepSeek 余额不足，请检查官方账户。', 'balance'], 429: ['DeepSeek 暂时繁忙，稍后可手动重试。', 'rate'] };
        const [message, code] = messages[response.status] || ['DeepSeek 请求未完成，可先用本地推荐。', 'network'];
        throw new DeepSeekError(message, code);
      }
      const raw = await response.text();
      if (raw.length > 64000) throw new DeepSeekError('DeepSeek 返回内容过长，请重试。');
      let data; try { data = JSON.parse(raw); } catch { throw new DeepSeekError('DeepSeek 返回格式未通过验证，可先用本地推荐。'); }
      const choice = data.choices?.[0], message = choice?.message;
      if (!['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash'].includes(data.model) || data.choices?.length !== 1 || choice.finish_reason !== 'stop' || message?.role !== 'assistant' || message.tool_calls?.length || message.refusal || typeof message.content !== 'string') throw new DeepSeekError('模型或推荐响应未通过验证，可先用本地推荐。');
      let value; try { value = JSON.parse(message.content); } catch { throw new DeepSeekError('推荐 JSON 未通过验证，可先用本地推荐。'); }
      if (controller.signal.aborted) throw new DeepSeekError('本次推荐已取消。', 'cancelled');
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new DeepSeekError(timedOut ? '这次推荐超时，可手动重试或用本地推荐。' : '本次推荐已取消。', timedOut ? 'timeout' : 'cancelled');
      if (error instanceof DeepSeekError) throw error;
      throw new DeepSeekError('暂时连不上 DeepSeek，可先用本地推荐。', 'network');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#requests.delete(controller); }
  }
}
