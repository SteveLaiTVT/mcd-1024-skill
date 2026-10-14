import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPClient, MCPError, decodeResponse, businessResponse, ENDPOINT } from '../web/mcp-client.mjs';
const fakeToken = 'test-only-token';
const reply = (payload, result, status = 200, session = null) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => session }, text: async () => payload.id == null ? '' : JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) });

test('JSON and multiline SSE select the matching request id', () => {
  assert.deepEqual(decodeResponse('{"id":3,"result":{"ok":true}}', 3), { ok: true });
  assert.deepEqual(decodeResponse('event: message\ndata: {"id":2,\ndata: "result":{"ok":true}}\n\ndata: {"id":3,"result":{}}\n\n', 2), { ok: true });
  assert.throws(() => decodeResponse('{"id":4,"result":{}}', 3));
});
test('business failures never echo raw server messages, codes, or credentials', () => {
  assert.deepEqual(businessResponse({ structuredContent: { success: true, data: [] } }).data, []);
  assert.deepEqual(businessResponse({ content: [{ type: 'text', text: '{"code":200,"data":[]}' }] }).data, []);
  assert.throws(() => businessResponse({ structuredContent: { code: 401, message: fakeToken } }), (error) => !error.message.includes(fakeToken));
});
test('initialization negotiates protocol, then sends only to the official origin with no cookies or redirects', async () => {
  const calls = [];
  const client = new MCPClient(`Bearer ${fakeToken}`, { fetchFn: async (url, options) => {
    const payload = JSON.parse(options.body); calls.push({ url, options, payload });
    return reply(payload, payload.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { structuredContent: { success: true, data: {} } }, 200, 'session-test');
  } });
  await client.initialize(); await client.call('now-time-info');
  assert.equal(calls.length, 3); calls.forEach(({ url, options }) => { assert.equal(url, ENDPOINT); assert.equal(options.headers.Authorization, `Bearer ${fakeToken}`); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer'); });
  assert.equal(calls[2].options.headers['MCP-Protocol-Version'], '2025-03-26'); assert.equal(calls[2].options.headers['Mcp-Session-Id'], 'session-test');
  assert(!JSON.stringify(client).includes(fakeToken)); client.close();
  await assert.rejects(() => client.call('now-time-info'), /连接已关闭/); assert.equal(calls.length, 3);
});
test('read-only API rejects claim, orders, payments and unknown tools', async () => {
  let calls = 0; const client = new MCPClient(fakeToken, { fetchFn: async () => { calls++; } });
  for (const tool of ['auto-bind-coupons', 'create-order', 'pay-order', 'unknown']) await assert.rejects(() => client.call(tool), /不支持/);
  assert.equal(calls, 0); client.close();
});
test('browser fetch keeps its global receiver through initialization and tool calls', async () => {
  let requests = 0;
  const client = new MCPClient(fakeToken, { sleep: async () => {}, fetchFn: function (url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(url, ENDPOINT); requests++;
    const payload = JSON.parse(options.body);
    return Promise.resolve(reply(payload, payload.method === 'initialize'
      ? { protocolVersion: '2025-03-26' }
      : { structuredContent: { success: true, data: {} } }));
  } });
  await client.initialize(); await client.call('now-time-info');
  assert.equal(requests, 3); client.close();
});
test('temporary HTTP failure retries a read, but a failed claim is exactly one write', async () => {
  let reads = 0, claims = 0;
  const client = new MCPClient(fakeToken, { sleep: async () => {}, fetchFn: async (_, options) => {
    const payload = JSON.parse(options.body);
    if (payload.params.name === 'auto-bind-coupons') { claims++; throw new TypeError(`network ${fakeToken}`); }
    reads++; return reply(payload, { structuredContent: { code: 200, data: [] } }, reads === 1 ? 503 : 200);
  } });
  await client.call('available-coupons'); assert.equal(reads, 2);
  await assert.rejects(() => client.claimAll(), (error) => error instanceof MCPError && error.ambiguous && !error.message.includes(fakeToken));
  assert.equal(claims, 1); client.close();
});
test('claim method sends only the official all-coupons tool and does not persist returned assets', async () => {
  let payload;
  const client = new MCPClient(fakeToken, { fetchFn: async (_, options) => {
    payload = JSON.parse(options.body);
    return reply(payload, { structuredContent: { code: 200, data: { successCount: 1, successCoupons: [{ couponId: 'private-claim-id' }] } } });
  } });
  assert.equal((await client.claimAll()).data.successCount, 1);
  assert.deepEqual(payload.params, { name: 'auto-bind-coupons', arguments: {} }); assert(!JSON.stringify(client).includes('private-claim-id')); client.close();
});

test('authentication failures are distinguishable from transient networking without exposing server details', async () => {
  for (const status of [401, 403, 503]) {
    const client = new MCPClient(fakeToken, { sleep: async () => {}, fetchFn: async (_, options) => reply(JSON.parse(options.body), {}, status) });
    await assert.rejects(() => client.initialize(), (error) => error.status === (status === 503 ? null : status)); client.close();
  }
  assert.throws(() => businessResponse({ structuredContent: { code: 401, message: fakeToken } }), (error) => error.status === 401 && !error.message.includes(fakeToken));
});

test('create-order is its own never-retried method: exact arguments, the official refusal message without the token, ambiguous on transport failure', async () => {
  const sent = [];
  const ok = new MCPClient(fakeToken, { fetchFn: async (_, options) => { const payload = JSON.parse(options.body); sent.push(payload.params); return reply(payload, { structuredContent: { success: true, data: { orderId: 'O1', payH5Url: 'https://pay.example/x' } } }); } });
  const args = { storeCode: 'S1', orderType: 1, beType: 1, takeWayCode: 'T1', items: [{ productCode: 'P', quantity: 1 }] };
  assert.equal((await ok.createOrder(args)).data.payH5Url, 'https://pay.example/x');
  assert.deepEqual(sent, [{ name: 'create-order', arguments: args }]); ok.close();

  const refused = new MCPClient(fakeToken, { fetchFn: async (_, options) => reply(JSON.parse(options.body), { structuredContent: { success: false, code: 500, message: `门店已打烊 ${fakeToken}` } }) });
  await assert.rejects(() => refused.createOrder(args), (e) => e instanceof MCPError && !e.ambiguous && /麦当劳未创建订单：门店已打烊/.test(e.message) && !e.message.includes(fakeToken)); refused.close();

  let attempts = 0;
  const flaky = new MCPClient(fakeToken, { sleep: async () => {}, fetchFn: async (_, options) => { attempts++; return reply(JSON.parse(options.body), {}, 503); } });
  await assert.rejects(() => flaky.createOrder(args), (e) => e.ambiguous && /未确认/.test(e.message));
  assert.equal(attempts, 1, 'a write is sent exactly once'); flaky.close();

  let name; const reader = new MCPClient(fakeToken, { fetchFn: async (_, options) => { const payload = JSON.parse(options.body); name = payload.params.name; return reply(payload, { structuredContent: { code: 200, data: { orderStatus: '1' } } }); } });
  assert.equal((await reader.call('query-order', { orderId: 'O1' })).data.orderStatus, '1'); assert.equal(name, 'query-order');
  for (const tool of ['create-order', 'cancel-order', 'mall-create-order', 'party-order-create']) await assert.rejects(() => reader.call(tool), /不支持/);
  reader.close();
});

test('address reading is permitted while address creation remains outside the read-only API', async () => {
  let name;
  const client = new MCPClient(fakeToken, { fetchFn: async (_, options) => { const payload = JSON.parse(options.body); name = payload.params.name; return reply(payload, { structuredContent: { code: 200, data: { addresses: [] } } }); } });
  assert.deepEqual((await client.call('delivery-query-addresses')).data, { addresses: [] }); assert.equal(name, 'delivery-query-addresses');
  await assert.rejects(() => client.call('delivery-create-address'), /不支持/); client.close();
});
