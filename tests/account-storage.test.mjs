import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_KEY, createAccountStorage, savedAccount } from '../web/account-storage.mjs';

const account = { version: 1, token: 'fake-storage-token', store: { storeCode: 'sample', storeName: '样本门店', city: '深圳' } };

test('saved credentials retain only the token and a minimal public store identity', () => {
  assert.deepEqual(savedAccount({ ...account, token: ' Bearer fake-storage-token ', orders: ['private-order'], addresses: ['private-address'],
    store: { ...account.store, contactName: 'private-name', fullAddress: 'private-address', couponId: 'private-coupon' } }), account);
  for (const invalid of [null, { ...account, version: 2 }, { ...account, token: '' }, { ...account, token: 'bad\ntoken' }]) assert.equal(savedAccount(invalid), null);
  assert.equal(savedAccount({ ...account, store: { storeCode: 'sample' } }).store, null);
});

test('storage access is restricted before reading, survives a new adapter, and never touches sync', async () => {
  let value = {}, restricted = false;
  const area = {
    async setAccessLevel(options) { assert.deepEqual(options, { accessLevel: 'TRUSTED_CONTEXTS' }); restricted = true; },
    async get(key) { assert(restricted); assert.equal(key, ACCOUNT_KEY); return structuredClone(value); },
    async set(update) { assert(restricted); value = structuredClone(update); },
    async remove(key) { delete value[key]; },
  };
  const first = createAccountStorage({ extension: true, area });
  await first.save(account);
  const second = createAccountStorage({ extension: true, area });
  assert.deepEqual(await second.read(), account);
  await second.clear(); assert.equal(await first.read(), null);
});

test('static pages never access a provided browser store', async () => {
  const area = Object.fromEntries(['get', 'set', 'remove', 'setAccessLevel'].map((name) => [name, () => assert.fail(name)]));
  const store = createAccountStorage({ extension: false, area });
  assert.equal(store.available, false); assert.equal(await store.read(), null);
  await store.save(account); await store.clear();
});

test('a delayed credential save cannot overtake an explicit clear, and failed writes do not block later removal', async () => {
  let value = {}, completeSave;
  const area = { async setAccessLevel() {}, async get() { return value; },
    async set(update) { await new Promise((resolve) => { completeSave = resolve; }); value = update; },
    async remove(key) { delete value[key]; },
  };
  const store = createAccountStorage({ extension: true, area });
  const saving = store.save(account), clearing = store.clear();
  await new Promise((resolve) => setImmediate(resolve)); completeSave(); await Promise.all([saving, clearing]);
  assert.equal(await store.read(), null);
  area.set = async () => { throw new Error('write failed'); };
  await assert.rejects(() => store.save(account)); await store.clear(); assert.equal(await store.read(), null);
});

test('a stale tab cannot save an account after another tab revoked it', async () => {
  let value = { [ACCOUNT_KEY]: structuredClone(account) }, tail = Promise.resolve();
  const locks = { request(name, work) { assert.equal(name, ACCOUNT_KEY); const pending = tail.then(work); tail = pending.catch(() => {}); return pending; } };
  const area = { async setAccessLevel() {}, async get() { return structuredClone(value); }, async set(update) { value = update; }, async remove(key) { delete value[key]; } };
  const first = createAccountStorage({ extension: true, area, locks }), stale = createAccountStorage({ extension: true, area, locks });
  const clearing = first.clear(), saving = stale.save(account, { expectedToken: account.token });
  await clearing; await assert.rejects(() => saving, /changed/); assert.equal(await first.read(), null);
  await stale.save(account, { expectedToken: null }); assert.deepEqual(await first.read(), account, 'A new explicit opt-in can save again');
});
