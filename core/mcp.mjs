// This client sends credentials only to the official origin. No storage or proxy.
export const ENDPOINT = 'https://mcp.mcd.cn';
export const READ_TOOLS = new Set([
  'now-time-info', 'available-coupons', 'query-my-coupons', 'query-store-coupons',
  'campaign-calendar', 'query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price', 'order-list', 'delivery-query-addresses', 'query-order',
]);

export class MCPError extends Error {
  constructor(message, { ambiguous = false, status = null } = {}) {
    super(message); this.name = 'MCPError'; this.ambiguous = ambiguous; this.status = [401, 403].includes(status) ? status : null;
  }
}

export function decodeResponse(raw, id) {
  let messages;
  try { messages = [JSON.parse(raw)]; }
  catch {
    messages = []; let lines = [];
    for (const line of [...raw.split(/\r?\n/), '']) {
      if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      else if (!line && lines.length) {
        try { messages.push(JSON.parse(lines.join('\n'))); } catch { /* not a JSON event */ }
        lines = [];
      }
    }
  }
  const message = messages.find((m) => m && typeof m === 'object' && m.id === id && ('result' in m || 'error' in m));
  if (!message) throw new MCPError('官方响应不完整，请重新查询。');
  if (message.error) throw new MCPError('麦当劳 MCP 未接受这次请求。');
  return message.result;
}

export function businessResponse(result) {
  if (!result || result.isError) throw new MCPError('麦当劳未完成这次业务请求。');
  let body = result.structuredContent;
  if (body == null) {
    try { body = JSON.parse((result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')); }
    catch { throw new MCPError('官方响应缺少业务数据。'); }
  }
  if (!body || typeof body !== 'object' || !(body.success === true || (!('success' in body) && body.code === 200))) {
    throw new MCPError('麦当劳未完成这次业务请求，请检查 Token 或稍后重查。', { status: Number(body?.code) });
  }
  return body;
}

// The official business message of a refused request (e.g. "门店已打烊"), cleaned of control characters; '' if none.
export function businessMessage(result) {
  let body = result?.structuredContent, text = '';
  if (body == null) {
    text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    try { body = JSON.parse(text); } catch { body = null; }
  }
  const message = typeof body?.message === 'string' ? body.message : typeof body?.msg === 'string' ? body.msg : body == null ? text : '';
  return String(message).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120);
}

export class MCPClient {
  #token; #session = ''; #protocol = ''; #id = 0; #controllers = new Set(); #closed = false;
  constructor(token, { fetchFn = globalThis.fetch, timeoutMs = 25000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const clean = String(token || '').trim().replace(/^Bearer\s+/i, '');
    if (!clean || /[\r\n]/.test(clean)) throw new MCPError('请填写有效的 MCP Token。');
    // Window.fetch rejects a class instance as its receiver ("Illegal invocation").
    // Preserve the browser global even when invoked through this client.
    this.#token = clean; this.fetchFn = fetchFn; this.timeoutMs = timeoutMs; this.sleep = sleep;
  }
  close() {
    this.#closed = true; this.#token = ''; this.#session = ''; this.#protocol = '';
    for (const c of this.#controllers) c.abort();
    this.#controllers.clear();
  }
  async #rpc(method, params, { notification = false, retrySafe = true, signal = null } = {}) {
    if (this.#closed) throw new MCPError('连接已关闭，请重新填写 Token。');
    if (signal?.aborted) throw new MCPError('已取消。');
    const payload = { jsonrpc: '2.0', method, params };
    if (!notification) payload.id = ++this.#id;
    const attempts = retrySafe ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.#closed) throw new MCPError('连接已关闭。');
      if (signal?.aborted) throw new MCPError('已取消。');
      const controller = new AbortController(); this.#controllers.add(controller);
      // The caller's signal only cancels: it never changes retry semantics for real failures.
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let retry = false;
      try {
        const headers = { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        if (this.#session) headers['Mcp-Session-Id'] = this.#session;
        if (this.#protocol) headers['MCP-Protocol-Version'] = this.#protocol;
        const response = await this.fetchFn(ENDPOINT, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
        });
        if (!response.ok) {
          retry = retrySafe && [429, 502, 503, 504].includes(response.status) && attempt < attempts - 1;
          if (!retry) throw new MCPError(`麦当劳 MCP 返回 HTTP ${response.status}，请检查连接和 Token。`, { ambiguous: !retrySafe, status: response.status });
        } else {
          const session = response.headers.get('Mcp-Session-Id');
          if (session) this.#session = session;
          const raw = await response.text();
          if (notification && !raw.trim()) return {};
          return decodeResponse(raw, payload.id);
        }
      } catch (error) {
        if (error instanceof MCPError) throw error;
        // External cancellation is not a transport failure: never retry it, never relabel it.
        if (signal?.aborted) throw new MCPError('已取消。');
        retry = retrySafe && !this.#closed && attempt < attempts - 1;
        if (!retry) throw new MCPError(this.#closed ? '连接已关闭。' : '无法直连麦当劳。请检查网络。', { ambiguous: !retrySafe });
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', onExternalAbort); this.#controllers.delete(controller);
      }
      if (retry) await this.sleep((attempt + 1) * 700);
    }
    throw new MCPError('连接暂时不可用。');
  }
  async initialize() {
    const result = await this.#rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcd-tui', version: '2.3.0' },
    });
    if (typeof result?.protocolVersion !== 'string') throw new MCPError('麦当劳 MCP 初始化未完成。');
    this.#protocol = result.protocolVersion;
    await this.#rpc('notifications/initialized', {}, { notification: true });
    return this;
  }
  async call(name, args = {}, { signal } = {}) {
    if (!READ_TOOLS.has(name)) throw new MCPError('终端不支持该操作。');
    return businessResponse(await this.#rpc('tools/call', { name, arguments: args }, { signal }));
  }
  async claimAll() {
    // Only called after the explicitly labelled user action. Never retry this write.
    try {
      return businessResponse(await this.#rpc('tools/call', { name: 'auto-bind-coupons', arguments: {} }, { retrySafe: false }));
    } catch {
      throw new MCPError('领券结果未确认。请先刷新券包，避免重复领取。', { ambiguous: true });
    }
  }
  async createOrder(args) {
    // Real order. Only called after the terminal's typed 'yes'; never retried. A transport failure is
    // ambiguous (the order may exist); a business refusal carries the official message.
    let result;
    try { result = await this.#rpc('tools/call', { name: 'create-order', arguments: args }, { retrySafe: false }); }
    catch { throw new MCPError('下单结果未确认（连接中断或响应不完整）。请先在麦当劳 App 的订单列表核对，避免重复下单。', { ambiguous: true }); }
    try { return businessResponse(result); }
    catch (e) {
      // The one place a server message is shown (the user must know why no order was made); never with the token.
      const reason = this.#token ? businessMessage(result).split(this.#token).join('[已隐藏]') : businessMessage(result);
      // A McDonald's cart sentence is quoted with a prefix so it is not confused with the local staging list.
      const line = reason.includes('购物车') ? `麦当劳说：${reason}` : `麦当劳未创建订单：${reason}`;
      throw new MCPError(reason ? line : `麦当劳未创建订单：${e.message}`, { status: e.status });
    }
  }
}
