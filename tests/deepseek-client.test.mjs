import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient, DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL } from '../core/llm.mjs';
const completion = (extra = {}) => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"choices":[],"vibe":"cozy"}' } }], ...extra });
test('DeepSeek sends a bounded non-thinking JSON request only to the official endpoint without cookies or tools', async () => {
  const requests = [], client = new DeepSeekClient('Bearer fake-deepseek-key', { fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(completion())); } });
  await client.complete('output JSON', { candidates: [] });
  const [{ url, options }] = requests, body = JSON.parse(options.body);
  assert.equal(url, DEEPSEEK_ENDPOINT); assert.equal(options.headers.Authorization, 'Bearer fake-deepseek-key');
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, undefined); assert.equal(options.referrerPolicy, undefined);
  assert.equal(body.model, DEEPSEEK_MODEL); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 1200); assert.equal(body.stream, false); assert(!('tools' in body)); assert(!JSON.stringify(body).includes('fake-deepseek-key'));
  client.close(); await assert.rejects(client.complete('JSON', {}), (e) => e.code === 'cancelled');
});
test('authentication, balance and rate errors never expose raw provider details or automatically retry', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [402, 'balance'], [429, 'rate'], [500, 'network']]) {
    let count = 0;
    const client = new DeepSeekClient('fake-deepseek-key', { fetchImpl: async () => { count++; return new Response('private-provider-key-and-error', { status }); } });
    await assert.rejects(client.complete('JSON', {}), (e) => e.code === code && !e.message.includes('private-provider'));
    assert.equal(count, 1);
  }
});
test('wrong models, truncated responses, tool calls, and invalid JSON fail closed', async () => {
  for (const data of [completion({ model: 'another-model' }), completion({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] }), completion({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{ name: 'create-order' }] } }] }), completion({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not-json' } }] })]) {
    const client = new DeepSeekClient('fake-deepseek-key', { fetchImpl: async () => new Response(JSON.stringify(data)) });
    await assert.rejects(client.complete('JSON', {}));
  }
});
test('timeouts, user cancellation and page closure abort active requests', async () => {
  const pending = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const timeout = new DeepSeekClient('fake-deepseek-key', { fetchImpl: pending, timeoutMs: 5 });
  await assert.rejects(timeout.complete('JSON', {}), (e) => e.code === 'timeout');
  const client = new DeepSeekClient('fake-deepseek-key', { fetchImpl: pending });
  const controller = new AbortController(), cancelled = client.complete('JSON', {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled, (e) => e.code === 'cancelled');
  const closing = client.complete('JSON', {}); client.close(); await assert.rejects(closing, (e) => e.code === 'cancelled');
});
