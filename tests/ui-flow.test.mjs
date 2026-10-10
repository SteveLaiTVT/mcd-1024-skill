import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startApp } from '../web/app.js';
import { normalizeHistory } from '../web/order-history.mjs';
import { MCPError } from '../web/mcp-client.mjs';
import { createAccountStorage, ACCOUNT_KEY } from '../web/account-storage.mjs';
import { createAgentStorage, defaultPreferences, AGENT_KEY, DEEPSEEK_KEY } from '../web/agent-memory.mjs';
import { DeepSeekError } from '../web/deepseek-client.mjs';
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns'].map(json));
const dataset = { templates, plans, offers, campaigns };
class Element {
  constructor() {
    this.children = []; this.handlers = {}; this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.textContent = '';
    const classes = new Set(); this.classList = { add: (...v) => v.forEach((c) => classes.add(c)), remove: (...v) => v.forEach((c) => classes.delete(c)), toggle: (c, v) => v ? classes.add(c) : classes.delete(c) };
  }
  append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = String(value); } addEventListener(name, handler) { this.handlers[name] = handler; }
  showModal() { this.open = true; } close() { this.open = false; this.handlers.close?.(); } focus() {}
}
function dom() {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(); node.hidden = /\bhidden\b/.test(match[0]); node.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || ''; elements.set(match[1], node);
  }
  const people = [1, 2, 3, 4].map((v) => Object.assign(new Element(), { value: String(v), checked: v === 1 }));
  const portions = [5, 7, 9].map((v) => Object.assign(new Element(), { value: String(v), checked: v === 7 }));
  const shortcuts = [20, 30, 40, 50].map((v) => Object.assign(new Element(), { dataset: { budget: String(v) } }));
  const steps = [0, 1, 2, 3].map((v) => Object.assign(new Element(), { dataset: { step: String(v) } }));
  const $ = (id) => { assert(elements.has(id), `Missing real HTML element: ${id}`); return elements.get(id); };
  const doc = { getElementById: $, createElement: () => new Element(), createElementNS: () => new Element(),
    querySelector(selector) { if (selector.includes('people')) return people.find((p) => p.checked); if (selector.includes('portion')) return portions.find((p) => p.checked); throw new Error(selector); },
    querySelectorAll(selector) {
      if (selector === '#conditions input, #conditions button') return [...people, ...portions, $('budget'), $('prepare'), ...shortcuts];
      if (selector === '#history-options button') return $('history-options').children;
      if (selector === '#store-results button, #address-results button') return [...$('store-results').children, ...$('address-results').children];
      if (selector === '#store-results button') return $('store-results').children;
      if (selector === '[data-budget]') return shortcuts;
      if (selector === '[data-step]') return steps;
      if (selector.includes('input[name=')) return [...people, ...portions];
      throw new Error(selector);
    },
  };
  const win = { handlers: {}, navigator: { clipboard: { writeText: async () => {} } }, addEventListener(name, cb) { this.handlers[name] = cb; }, matchMedia: () => ({ matches: true }), requestAnimationFrame: (cb) => cb() };
  return { doc, win, $, people };
}
const event = { preventDefault() {} };
const plan = { id: 'meal', people: 1, title: '完整套餐', wheelTitle: '鸡肉', wheelKind: '三件套餐', priceFen: 2500, basePriceFen: 3500, savingFen: 1000, withinBudget: true, couponNames: ['已持有券'], packages: [{ name: '套餐', quantity: 1 }], parts: [{ name: '主餐', quantity: 1 }, { name: '薯条', quantity: 1 }, { name: '可乐', quantity: 1 }] };
const report = { sourceKind: 'official-live-pre-wheel-pricing', checkedAt: '2026-10-10T09:00:00Z', validForSeconds: 60, counts: { ownedAssets: 1, validatedCoupons: 1 }, request: { people: 1, totalBudgetFen: 3000 }, benefits: [], claimableOffers: [{ name: '可领券', canClaim: true }], campaignEntries: [], quotedPlans: [plan], candidates: [plan], failedPlans: [], excludedPlans: [], priceComparisonComplete: true };

function localAccount(value = null) {
  const listeners = new Set(), entries = value ? { [ACCOUNT_KEY]: structuredClone(value) } : {};
  const area = { async setAccessLevel() {}, async get() { return structuredClone(entries); },
    async set(values) { for (const [key, newValue] of Object.entries(values)) { const oldValue = entries[key]; entries[key] = structuredClone(newValue); listeners.forEach((listener) => listener({ [key]: { oldValue, newValue } }, 'local')); } },
    async remove(key) { const oldValue = entries[key]; delete entries[key]; listeners.forEach((listener) => listener({ [key]: { oldValue } }, 'local')); },
  };
  const changes = { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) };
  return { entries, area, adapter: () => createAccountStorage({ extension: true, area, changes }), agentAdapter: () => createAgentStorage({ extension: true, area, changes }) };
}
function noTimers(t) { t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {}); }
const openStore = { storeCode: 'sample-store', storeName: '测试门店', address: '门店公共地址', businessStatus: true, businessStartTime: '07:00', businessEndTime: '23:00' };
const stored = { version: 1, token: 'fake-remembered-token', store: { storeCode: openStore.storeCode, storeName: openStore.storeName, city: '深圳' } };
const emptyWallet = async () => ({ offers: [], ownedCount: 0, usable: [], walletComplete: true });

test('UI gates quotes, confirms all-coupon claims, reprices, expires, and clears account data', async (t) => {
  let tick; t.mock.method(globalThis, 'setInterval', (cb) => { tick = cb; return 1; }); t.mock.method(globalThis, 'clearInterval', () => {});
  const { doc, win, $, people } = dom(); let elapsed = 0, resolveQuote, claims = 0, closes = 0;
  const client = { initialize: async () => {}, close() { closes++; },
    async call(name) {
      if (name === 'now-time-info') return { data: { datetime: '2026-10-10T17:00:00+08:00' } };
      if (name === 'query-nearby-stores') return { data: [{ storeCode: '1421180', storeName: '测试门店', address: '门店地址', businessStatus: true }] };
      throw new Error(name);
    },
    async claimAll() { claims++; return { data: { successCount: 1, failedCount: 0 } }; },
  };
  const app = await startApp({ doc, win, extension: true, dataset, clock: () => elapsed, clientFactory: (value) => { assert.equal(value, 'fake-ui-token'); return client; },
    prepareLive: async () => new Promise((r) => { resolveQuote = r; }),
    inspect: async () => ({ offers: report.claimableOffers, ownedCount: 1, usable: [{}], walletComplete: true }),
  });
  assert.equal($('spin').disabled, true); assert.equal($('claim').disabled, true);
  await $('conditions').handlers.submit(event); assert.equal($('spin').disabled, false, 'Demo is explicitly allowed as snapshot, without account calls');
  await $('spin').handlers.click(); assert.equal($('result').hidden, false); assert.match($('result-disclaimer').textContent, /历史样本价/);
  people[0].checked = false; people[1].checked = true; people[1].handlers.change();
  assert.equal($('spin').disabled, true); assert.equal($('result').hidden, true); assert.equal($('pricing').hidden, true); assert.match($('budget-total').textContent, /¥60/);
  people[1].checked = false; people[0].checked = true;
  $('token').value = 'fake-ui-token'; const connecting = $('connect-form').handlers.submit(event);
  assert.equal($('token').value, '', 'Credential input clears before any async request completes'); await connecting;
  assert.equal($('store-settings').hidden, false); assert.equal(claims, 0);
  await $('store-search').handlers.submit(event); $('store-results').children[0].handlers.click(); await new Promise((r) => setImmediate(r));
  assert.equal($('claim').disabled, false);
  const pricing = $('conditions').handlers.submit(event); assert.equal($('spin').disabled, true); assert.equal($('prepare').disabled, true);
  resolveQuote(structuredClone(report)); await pricing;
  assert.equal($('spin').disabled, false); await $('spin').handlers.click();
  assert.match($('result-price').textContent, /¥25/); assert.match($('result-benefit').textContent, /已持有券.*额外省 ¥10.*预算还剩 ¥5/);
  assert.deepEqual($('result-parts').children.map((p) => p.textContent), ['主餐 ×1', '薯条 ×1', '可乐 ×1']);
  $('claim').handlers.click(); assert.equal($('claim-dialog').open, true); assert.equal(claims, 0);
  $('cancel-claim').handlers.click(); assert.equal(claims, 0, 'Opening and cancelling confirmation never claims');
  $('claim').handlers.click(); const claiming = $('confirm-claim').handlers.click();
  await new Promise((r) => setImmediate(r)); assert.equal(claims, 1); assert.equal($('spin').disabled, true); assert.equal($('result').hidden, true);
  $('confirm-claim').handlers.click(); assert.equal(claims, 1, 'Double click cannot duplicate the write');
  resolveQuote(structuredClone(report)); await claiming;
  assert.match($('claim-message').textContent, /已领取 1 张.*套餐价格已重新查询/); assert.equal($('spin').disabled, false);
  elapsed = 60000; tick(); assert.equal($('spin').disabled, true); assert.match($('pool-status').textContent, /报价已过期/);
  $('disconnect').handlers.click(); assert.equal(closes, 1); assert.equal($('result').hidden, true); assert.equal($('claim').disabled, true); assert.equal($('owned-count').textContent, '—'); assert.equal($('token').value, '');
  app.dispose();
});

test('static preview refuses credentials, and page exit cancels a pending connection', async (t) => {
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const preview = dom(); let calls = 0;
  const app = await startApp({ ...preview, extension: false, dataset, clientFactory: () => { calls++; } });
  assert.equal(preview.$('token').disabled, true); assert.equal(preview.$('connect').disabled, true);
  await preview.$('connect-form').handlers.submit(event); assert.equal(calls, 0); app.dispose();
  const live = dom(); let resolveInit, closed = 0;
  const liveApp = await startApp({ ...live, extension: true, dataset, clientFactory: () => ({ initialize: () => new Promise((r) => { resolveInit = r; }), async call() { throw new Error('closed'); }, close() { closed++; } }) });
  live.$('token').value = 'fake-ui-token'; const pending = live.$('connect-form').handlers.submit(event);
  live.win.handlers.pagehide(); resolveInit(); await pending;
  assert(closed >= 1); assert.equal(live.$('connected-actions').hidden, true); assert.equal(live.$('token').value, ''); liveApp.dispose();
});

test('radar reads real history only on request, opens day meals, applies recent main foods, and clears on disconnect', async (t) => {
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const ui = dom(), { $, win } = ui; const calls = [];
  const mainCode = templates.mainProductCodes[0];
  const client = { initialize: async () => {}, close() {}, async call(name) {
    calls.push(name);
    if (name === 'now-time-info') return { data: { datetime: '2026-10-10T18:00:00+08:00' } };
    if (name === 'order-list') return { data: { list: [{ orderId: 'private-radar-id', createTime: '2026-10-09 12:00:00', orderStatus: '订单已完成', storeName: '我的餐厅', orderProductList: [{ productName: '熟悉套餐', quantity: 1, comboItemList: [{ productCode: mainCode, name: '主食', quantity: 1 }] }] }] } };
    throw new Error(name);
  } };
  const app = await startApp({ ...ui, extension: true, dataset, clientFactory: () => client });
  $('view-radar').handlers.click(); assert.equal($('radar-view').hidden, false); assert.equal($('wheel-view').hidden, true);
  $('radar-demo').handlers.click(); assert.equal($('radar-source').textContent, '虚构示例'); assert.equal($('radar-apply').disabled, true); assert.equal(calls.length, 0);
  await $('radar-load').handlers.click(); assert.equal($('account-dialog').open, true); assert.equal(calls.length, 0);
  $('token').value = 'fake-radar-token'; await $('connect-form').handlers.submit(event);
  assert.deepEqual(calls, ['now-time-info']);
  await $('radar-load').handlers.click(); assert.deepEqual(calls, ['now-time-info', 'now-time-info', 'order-list']);
  assert.equal($('radar-source').textContent, '我的历史记录'); assert.equal($('radar-order-count').textContent, 1);
  const cells = $('radar-grid').children.flatMap((week) => week.children);
  const day = cells.find((cell) => cell.title?.startsWith('2026-10-09'));
  day.handlers.click(); assert.match($('radar-day-title').textContent, /2026 \/ 10 \/ 09/);
  const orderNode = $('radar-orders').children[0]; assert.equal(orderNode.children[1].children[0].children[0].textContent, '熟悉套餐 ×1');
  assert(!JSON.stringify(orderNode).includes('private-radar-id'));
  const manual = $('history-options').children.find((button) => button.dataset.code !== mainCode); manual.handlers.click();
  $('radar-apply').handlers.click(); assert.equal($('radar-view').hidden, true); assert.equal($('wheel-view').hidden, false);
  assert.equal(manual['aria-pressed'], 'true');
  assert.equal($('history-options').children.find((button) => button.dataset.code === mainCode)['aria-pressed'], 'true');
  assert.match($('history-note').textContent, /前两天/); assert.equal($('spin').disabled, true);
  $('disconnect').handlers.click(); assert.equal($('radar-source').textContent, '等待读取'); assert.equal($('radar-orders').children.length, 0);
  assert.equal($('radar-order-count').textContent, '—'); assert.equal($('radar-top-foods').children.length, 0); assert.equal($('radar-apply').disabled, true);
  assert.equal(calls.length, 3); win.handlers.pagehide(); app.dispose();
});

test('late history cannot repopulate a disconnected account, and a failed refresh cannot show false zero days', async (t) => {
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const ui = dom(), { $ } = ui; let resolveRead;
  const app = await startApp({ ...ui, extension: true, dataset, clientFactory: () => ({ initialize: async () => {}, close() {}, call: async () => ({ data: { datetime: '2026-10-10T18:00:00+08:00' } }) }),
    loadHistory: async () => new Promise((resolve) => { resolveRead = resolve; }),
  });
  $('token').value = 'fake-radar-token'; await $('connect-form').handlers.submit(event);
  const pending = $('radar-load').handlers.click(); assert.equal($('prepare').disabled, true);
  $('disconnect').handlers.click(); resolveRead(normalizeHistory({ list: [] }, { now: '2026-10-10T18:00:00+08:00' })); await pending;
  assert.equal($('radar-order-count').textContent, '—'); assert.equal($('radar-source').textContent, '等待读取');
  app.dispose();
  const failing = dom();
  const badApp = await startApp({ ...failing, extension: true, dataset, clientFactory: () => ({ initialize: async () => {}, close() {}, call: async () => ({ data: { datetime: '2026-10-10T18:00:00+08:00' } }) }), loadHistory: async () => { throw new Error('private-token-from-error'); } });
  failing.$('token').value = 'fake-radar-token'; await failing.$('connect-form').handlers.submit(event); await failing.$('radar-load').handlers.click();
  assert.match(failing.$('radar-message').textContent, /读取未完成/); assert(!failing.$('radar-message').textContent.includes('private-token-from-error'));
  assert.equal(failing.$('radar-order-count').textContent, '—'); badApp.dispose();
});

test('remembering is opt-in; refresh restores credentials and revalidates the store without loading history or old prices', async (t) => {
  noTimers(t);
  const vault = localAccount(), ui = dom(), calls = [];
  const clientFactory = (token) => {
    assert.equal(token, stored.token);
    return { initialize: async () => {}, close() {}, async call(name, args) {
      calls.push({ name, args });
      if (name === 'now-time-info') return { data: {} };
      if (name === 'query-nearby-stores') return { data: [openStore] };
      throw new Error(name);
    } };
  };
  const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(), clientFactory, inspect: emptyWallet });
  assert.equal(ui.$('remember-account').checked, false);
  ui.$('token').value = stored.token; await ui.$('connect-form').handlers.submit(event);
  assert.equal(vault.entries[ACCOUNT_KEY], undefined, 'Credentials are not saved by default');
  ui.$('remember-account').checked = true; await ui.$('remember-account').handlers.change();
  await ui.$('store-search').handlers.submit(event); await ui.$('store-results').children[0].handlers.click();
  assert.deepEqual(vault.entries[ACCOUNT_KEY], stored);
  ui.win.handlers.pagehide(); app.dispose();
  assert.deepEqual(vault.entries[ACCOUNT_KEY], stored, 'Page exit must retain opted-in credentials');
  calls.length = 0;
  const refreshed = dom();
  const freshApp = await startApp({ ...refreshed, extension: true, dataset, accountStorage: vault.adapter(), clientFactory });
  assert.equal(refreshed.$('connected-actions').hidden, false); assert.equal(refreshed.$('selected-store-name').textContent, openStore.storeName);
  assert.match(refreshed.$('selected-store-status').textContent, /营业中.*07:00–23:00/);
  assert.equal(refreshed.$('token').value, ''); assert.equal(refreshed.$('remember-account').checked, true);
  assert.equal(refreshed.$('pricing').hidden, true); assert.equal(refreshed.$('spin').disabled, true); assert.equal(refreshed.$('radar-order-count').textContent, '—');
  assert.deepEqual(calls, [{ name: 'now-time-info', args: undefined }, { name: 'query-nearby-stores', args: { beType: 1, searchType: 2, city: '深圳', keyword: openStore.storeName } }]);
  await refreshed.$('disconnect').handlers.click(); assert.equal(vault.entries[ACCOUNT_KEY], undefined);
  freshApp.dispose();
});

test('turning off remembering removes disk credentials and keeps the current page connected', async (t) => {
  noTimers(t);
  const vault = localAccount({ ...stored, store: null }), ui = dom(); let closed = 0;
  const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(),
    clientFactory: () => ({ initialize: async () => {}, call: async () => ({ data: {} }), close() { closed++; } }),
  });
  ui.$('remember-account').checked = false; await ui.$('remember-account').handlers.change();
  assert.equal(vault.entries[ACCOUNT_KEY], undefined); assert.equal(closed, 0); assert.equal(ui.$('connected-actions').hidden, false);
  ui.win.handlers.pagehide(); assert.equal(closed, 1); app.dispose();
  let connected = 0; const next = dom();
  const nextApp = await startApp({ ...next, extension: true, dataset, accountStorage: vault.adapter(), clientFactory: () => { connected++; } });
  assert.equal(connected, 0); nextApp.dispose();
});

test('cancelled or failed initial connections cannot save a credential', async (t) => {
  noTimers(t);
  const vault = localAccount(), ui = dom(); let finish;
  const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(),
    clientFactory: () => ({ initialize: () => new Promise((resolve) => { finish = resolve; }), call: async () => ({ data: {} }), close() {} }),
  });
  ui.$('remember-account').checked = true; ui.$('token').value = stored.token;
  const connecting = ui.$('connect-form').handlers.submit(event); await ui.$('disconnect').handlers.click(); finish(); await connecting;
  assert.equal(vault.entries[ACCOUNT_KEY], undefined); assert.equal(ui.$('connected-actions').hidden, true); app.dispose();
  const failing = dom();
  const failedApp = await startApp({ ...failing, extension: true, dataset, accountStorage: vault.adapter(), clientFactory: () => ({ initialize: async () => { throw new Error(stored.token); }, close() {} }) });
  failing.$('remember-account').checked = true; failing.$('token').value = stored.token; await failing.$('connect-form').handlers.submit(event);
  assert.equal(vault.entries[ACCOUNT_KEY], undefined); assert(!failing.$('connect-message').textContent.includes(stored.token)); failedApp.dispose();
});

test('a failed automatic connection retains retryable credentials, while authentication rejection clears them', async (t) => {
  noTimers(t);
  for (const status of [null, 401, 403]) {
    const vault = localAccount({ ...stored, store: null }), ui = dom();
    const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(),
      clientFactory: () => ({ initialize: async () => { throw new MCPError('连接失败', { status }); }, close() {} }),
    });
    assert.equal(ui.$('connected-actions').hidden, true);
    if (status) { assert.equal(vault.entries[ACCOUNT_KEY], undefined); assert.equal(ui.$('retry-saved').hidden, true); assert.match(ui.$('connect-message').textContent, /重新填写/); }
    else { assert.equal(vault.entries[ACCOUNT_KEY].token, stored.token); assert.equal(ui.$('retry-saved').hidden, false); assert.match(ui.$('connect-message').textContent, /已保留/); }
    app.dispose();
  }
});

test('restoration cannot select a closed or unknown store, and changing stores discards the previous quote', async (t) => {
  noTimers(t);
  const vault = localAccount(stored), ui = dom();
  const changed = { ...openStore, storeCode: 'other', storeName: '另一家门店' };
  const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(), inspect: emptyWallet,
    prepareLive: async (_, __, context) => { assert.equal(context.storeCode, changed.storeCode); return structuredClone(report); },
    clientFactory: () => ({ initialize: async () => {}, close() {}, async call(name) { return name === 'query-nearby-stores' ? { data: [{ ...openStore, businessStatus: false }, { ...openStore, storeCode: 'unknown', businessStatus: 'true' }, changed] } : { data: {} }; } }),
  });
  assert.equal(ui.$('selected-store').hidden, true); assert.match(ui.$('store-search-message').textContent, /暂停营业/);
  assert.equal(ui.$('store-results').children[0].disabled, true); assert.equal(ui.$('store-results').children[1].disabled, true);
  ui.$('store-results').children[0].handlers.click(); assert.equal(ui.$('selected-store').hidden, true);
  await ui.$('store-results').children[2].handlers.click();
  assert.equal(ui.$('selected-store-name').textContent, changed.storeName); assert.equal(vault.entries[ACCOUNT_KEY].store.storeCode, changed.storeCode);
  await ui.$('conditions').handlers.submit(event); assert.equal(ui.$('spin').disabled, false);
  await ui.$('store-search').handlers.submit(event); await ui.$('store-results').children[2].handlers.click();
  assert.equal(ui.$('spin').disabled, true); assert.equal(ui.$('pricing').hidden, true); await ui.$('disconnect').handlers.click(); app.dispose();
});

test('stored addresses are read only on request, expose no contacts, and are used as the official location keyword', async (t) => {
  noTimers(t);
  const vault = localAccount(), ui = dom(), calls = [];
  const address = '广东省深圳市南山区科技园';
  const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(), clientFactory: () => ({ initialize: async () => {}, close() {}, async call(name, args) {
    calls.push({ name, args });
    if (name === 'delivery-query-addresses') return { data: { addresses: [{ fullAddress: address, contactName: 'secret-contact', phone: 'secret-phone', addressId: 'secret-id' }, { fullAddress: '科技园一号楼' }] } };
    if (name === 'query-nearby-stores') return { data: [openStore] };
    return { data: {} };
  } }) });
  ui.$('token').value = stored.token; await ui.$('connect-form').handlers.submit(event);
  assert.deepEqual(calls.map((call) => call.name), ['now-time-info']);
  await ui.$('load-addresses').handlers.click(); assert.equal(ui.$('address-results').children.length, 2);
  assert(!JSON.stringify(ui.$('address-results')).includes('secret-'));
  ui.$('address-results').children[0].handlers.click();
  assert.equal(ui.$('store-city').value, '深圳市'); assert.equal(ui.$('store-keyword').value, address);
  await ui.$('store-search').handlers.submit(event);
  assert.deepEqual(calls.at(-1), { name: 'query-nearby-stores', args: { beType: 1, searchType: 2, city: '深圳市', keyword: address } });
  assert.equal(vault.entries[ACCOUNT_KEY], undefined);
  await ui.$('load-addresses').handlers.click(); ui.$('address-results').children[1].handlers.click();
  assert.equal(ui.$('store-city').value, ''); assert.match(ui.$('address-message').textContent, /填写.*城市/);
  await ui.$('disconnect').handlers.click(); assert.equal(ui.$('address-results').children.length, 0); app.dispose();
  assert.equal(ui.$('store-keyword').value, '', 'Disconnect also removes the chosen private address from its input');
});

test('a stale startup read cannot restore credentials removed in another tab', async (t) => {
  noTimers(t);
  const vault = localAccount(stored), old = structuredClone(vault.entries), ui = dom(); let resolveRead, connects = 0;
  vault.area.get = () => new Promise((resolve) => { resolveRead = resolve; });
  const startup = startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(), clientFactory: () => { connects++; } });
  await new Promise((resolve) => setImmediate(resolve)); await vault.area.remove(ACCOUNT_KEY); resolveRead(old);
  const app = await startup; assert.equal(connects, 0); assert.equal(ui.$('remember-account').checked, false); app.dispose();
});

test('a failed credential removal keeps a visible retry and never reports success', async (t) => {
  noTimers(t);
  const vault = localAccount({ ...stored, store: null }), ui = dom();
  const app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(),
    clientFactory: () => ({ initialize: async () => {}, call: async () => ({ data: {} }), close() {} }),
  });
  vault.area.remove = async () => { throw new Error('private-error'); };
  await ui.$('disconnect').handlers.click();
  assert.equal(ui.$('connected-actions').hidden, true); assert.equal(ui.$('forget-account').hidden, false);
  assert.equal(vault.entries[ACCOUNT_KEY].token, stored.token); assert.match(ui.$('remember-status').textContent, /未能清除/); app.dispose();
});

test('a page closed while storage or address reads are pending cannot reconnect or repopulate its data', async (t) => {
  noTimers(t);
  const vault = localAccount(stored), ui = dom(); let resolveRead, connects = 0;
  vault.area.get = () => new Promise((resolve) => { resolveRead = resolve; });
  const startup = startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(), clientFactory: () => { connects++; } });
  await new Promise((resolve) => setImmediate(resolve)); ui.win.handlers.pagehide(); resolveRead(vault.entries);
  const app = await startup; assert.equal(connects, 0); assert.equal(vault.entries[ACCOUNT_KEY].token, stored.token); app.dispose();
  const addressUI = dom(); let resolveAddresses;
  const addressApp = await startApp({ ...addressUI, extension: true, dataset,
    clientFactory: () => ({ initialize: async () => {}, close() {}, call: async (name) => name === 'delivery-query-addresses' ? new Promise((resolve) => { resolveAddresses = resolve; }) : { data: {} } }),
  });
  addressUI.$('token').value = stored.token; await addressUI.$('connect-form').handlers.submit(event);
  const loading = addressUI.$('load-addresses').handlers.click(); addressUI.$('disconnect').handlers.click();
  resolveAddresses({ data: { addresses: [{ fullAddress: 'late private address' }] } }); await loading;
  assert.equal(addressUI.$('address-results').children.length, 0); addressApp.dispose();
});

test('clearing remembered credentials in one tab disconnects other tabs, and storage failures remain visible', async (t) => {
  noTimers(t);
  const vault = localAccount({ ...stored, store: null }), first = dom(), second = dom(); let closed = 0;
  const options = { extension: true, dataset, clientFactory: () => ({ initialize: async () => {}, call: async () => ({ data: {} }), close() { closed++; } }) };
  const firstApp = await startApp({ ...first, ...options, accountStorage: vault.adapter() });
  const secondApp = await startApp({ ...second, ...options, accountStorage: vault.adapter() });
  await first.$('disconnect').handlers.click(); assert.equal(closed, 2); assert.equal(second.$('connected-actions').hidden, true);
  assert.equal(second.$('remember-account').checked, false); assert.match(second.$('connect-message').textContent, /另一个应用页/);
  firstApp.dispose(); secondApp.dispose();
  const failing = localAccount(), failedUI = dom(); failing.area.set = async () => { throw new Error('secret-storage-error'); };
  const failedApp = await startApp({ ...failedUI, ...options, accountStorage: failing.adapter() });
  failedUI.$('remember-account').checked = true; failedUI.$('token').value = stored.token; await failedUI.$('connect-form').handlers.submit(event);
  assert.equal(failedUI.$('connected-actions').hidden, false); assert.equal(failing.entries[ACCOUNT_KEY], undefined); assert.match(failedUI.$('remember-status').textContent, /未能保存/);
  failedApp.dispose();
});

test('AI key retention is opt-in and independent of McD; restore does not charge or read private account data', async (t) => {
  noTimers(t);
  const vault = localAccount(), ui = dom(); let calls = 0, closed = 0;
  const options = { extension: true, dataset, agentStorage: vault.agentAdapter(), agentNow: () => new Date('2026-10-10T09:00:00Z'), agentClientFactory: (key) => {
    assert.equal(key, 'fake-deepseek-key');
    return { close() { closed++; }, async complete(_system, input) { calls++; return { choices: [{ id: input.eligibleIds[0], signals: ['balanced'] }], vibe: 'cozy' }; } };
  } };
  const app = await startApp({ ...ui, ...options });
  assert.equal(ui.$('deepseek-remember').checked, false);
  assert.equal(ui.$('agent-run').disabled, true);
  ui.$('deepseek-remember').checked = true; ui.$('deepseek-token').value = 'fake-deepseek-key';
  await ui.$('deepseek-form').handlers.submit(event);
  assert.equal(ui.$('deepseek-token').value, ''); assert.equal(calls, 0);
  assert.equal(vault.entries[DEEPSEEK_KEY].token, 'fake-deepseek-key'); assert(!vault.entries[ACCOUNT_KEY]);
  await ui.$('conditions').handlers.submit(event); await ui.$('agent-run').handlers.click();
  assert.equal(calls, 2); assert(ui.$('agent-results').children.length > 0); assert.match(ui.$('agent-status').textContent, /2 轮完成.*历史样本/);
  ui.win.handlers.pagehide(); assert.equal(vault.entries[DEEPSEEK_KEY].token, 'fake-deepseek-key'); app.dispose();
  const restored = dom(), secondApp = await startApp({ ...restored, ...options, agentStorage: vault.agentAdapter() });
  assert.equal(calls, 2); assert.equal(restored.$('deepseek-token').value, ''); assert.equal(restored.$('deepseek-remember').checked, true);
  assert.match(restored.$('deepseek-status').textContent, /恢复本机/); assert.equal(restored.$('pricing').hidden, true);
  restored.$('deepseek-remember').checked = false; await restored.$('deepseek-remember').handlers.change();
  assert(!vault.entries[DEEPSEEK_KEY]); assert.equal(restored.$('deepseek-forget').hidden, false, 'Unchecking keeps this page configured');
  await restored.$('conditions').handlers.submit(event); await restored.$('agent-run').handlers.click(); assert.equal(calls, 4);
  await restored.$('deepseek-forget').handlers.click(); assert.equal(restored.$('deepseek-forget').hidden, true); assert(closed >= 2); secondApp.dispose();
});

test('explicit meal feedback persists only after opting in, can be inspected and cleared, and never counts a reveal as eaten', async (t) => {
  noTimers(t);
  const vault = localAccount(), ui = dom();
  const options = { extension: true, dataset, agentNow: () => new Date('2026-10-10T09:00:00Z') };
  const app = await startApp({ ...ui, ...options, agentStorage: vault.agentAdapter() });
  await ui.$('conditions').handlers.submit(event); await ui.$('agent-local').handlers.click();
  const firstCard = ui.$('agent-results').children[0]; firstCard.children.at(-1).handlers.click();
  assert.equal(ui.$('result').hidden, false); assert.equal(ui.$('agent-feedback').hidden, false); assert(!vault.entries[AGENT_KEY]);
  await ui.$('agent-like').handlers.click(); assert(!vault.entries[AGENT_KEY]); assert.match(ui.$('agent-memory-status').textContent, /仅本页反馈 · 1 条/);
  ui.$('agent-personal-prompt').value = '鸡肉优先，心情不好时轻松点。'; ui.$('agent-remember-memory').checked = true;
  await ui.$('agent-preferences').handlers.submit(event);
  assert.equal(vault.entries[AGENT_KEY].feedback.length, 1); assert.match(vault.entries[AGENT_KEY].personalPrompt, /鸡肉优先/); app.dispose();
  const restored = dom(), secondApp = await startApp({ ...restored, ...options, agentStorage: vault.agentAdapter() });
  assert.match(restored.$('agent-memory-status').textContent, /本机长期记忆 · 1 条/); assert(restored.$('agent-memory-list').children.length > 0);
  assert.match(restored.$('agent-personal-prompt').value, /鸡肉优先/);
  await restored.$('conditions').handlers.submit(event); await restored.$('spin').handlers.click();
  assert.equal(vault.entries[AGENT_KEY].feedback.length, 1, 'Spinning never learns consumption or preferences');
  await restored.$('agent-clear-memory').handlers.click(); assert.equal(vault.entries[AGENT_KEY].feedback.length, 0);
  assert.match(vault.entries[AGENT_KEY].personalPrompt, /鸡肉优先/); secondApp.dispose();
});

test('AI choices are invalidated by new conditions or expired prices; late paid responses cannot reveal stale meals', async (t) => {
  noTimers(t);
  const ui = dom(); let resolve, rounds = 0, requestSignal;
  const app = await startApp({ ...ui, extension: true, dataset, agentClientFactory: () => ({ close() {}, complete(_system, input, { signal }) { rounds++; requestSignal = signal; return new Promise((done) => { resolve = () => done({ choices: [{ id: input.eligibleIds[0], signals: ['balanced'] }], vibe: 'cozy' }); }); } }) });
  ui.$('deepseek-token').value = 'fake-deepseek-key'; await ui.$('deepseek-form').handlers.submit(event);
  await ui.$('conditions').handlers.submit(event); const running = ui.$('agent-run').handlers.click();
  assert.equal(rounds, 1); ui.$('budget').value = '40'; ui.$('budget').handlers.input(); assert.equal(requestSignal.aborted, true);
  resolve(); await running; assert.equal(rounds, 1); assert.equal(ui.$('agent-results').children.length, 0); assert.equal(ui.$('result').hidden, true); app.dispose();
});

test('weather city choices are explicit and privacy-minimized; network failure keeps normal recommendation available', async (t) => {
  noTimers(t);
  const ui = dom(), requests = [];
  const weatherClient = { async search(city) { requests.push(city); return [{ name: '深圳', region: '广东', latitude: 22.5, longitude: 114 }, { name: '深圳', region: '福建', latitude: 24.8, longitude: 118.4 }]; }, async current(city) { requests.push(city.name); throw new Error('private upstream failure'); } };
  const app = await startApp({ ...ui, extension: true, dataset, weatherClient });
  ui.$('agent-city').value = '深圳'; await ui.$('agent-weather').handlers.click();
  assert.equal(requests.length, 1); assert.equal(ui.$('agent-city-choices').children.length, 2);
  await ui.$('agent-city-choices').children[0].handlers.click(); assert.match(ui.$('agent-weather-note').textContent, /天气读取未完成/);
  await ui.$('conditions').handlers.submit(event); await ui.$('agent-local').handlers.click();
  assert(ui.$('agent-results').children.length > 0); assert.match(ui.$('agent-status').textContent, /天气未知/); assert.equal(requests.length, 2); app.dispose();
});

test('DeepSeek auth revokes only its own key, preserves McD and memory, and offers a local fallback', async (t) => {
  noTimers(t);
  const vault = localAccount({ ...stored, store: null }); vault.entries[DEEPSEEK_KEY] = { version: 1, token: 'fake-deepseek-key' }; vault.entries[AGENT_KEY] = { ...defaultPreferences(), personalPrompt: '喜欢鸡肉' };
  const ui = dom(), app = await startApp({ ...ui, extension: true, dataset, accountStorage: vault.adapter(), agentStorage: vault.agentAdapter(),
    clientFactory: () => ({ initialize: async () => {}, close() {}, call: async () => ({ data: {} }) }),
    agentClientFactory: () => ({ close() {}, async complete() { throw new DeepSeekError('API key 未通过验证，请重新填写。', 'auth'); } }),
  });
  assert.equal(ui.$('deepseek-remember').checked, true);
  // Supply a public sample report independently of the restored McD credential.
  app.session.accept({ ...report, sourceKind: 'demo-snapshot' });
  await ui.$('agent-run').handlers.click();
  assert(!vault.entries[DEEPSEEK_KEY]); assert(vault.entries[ACCOUNT_KEY]); assert.equal(vault.entries[AGENT_KEY].personalPrompt, '喜欢鸡肉');
  assert.match(ui.$('agent-status').textContent, /未通过验证/); await ui.$('agent-local').handlers.click(); assert(ui.$('agent-results').children.length > 0); app.dispose();
});

test('static AI refuses keys and durable memory; cross-tab key revocation cancels old configurations', async (t) => {
  noTimers(t);
  const preview = dom(), previewApp = await startApp({ ...preview, extension: false, dataset });
  assert.equal(preview.$('deepseek-token').disabled, true); assert.equal(preview.$('agent-remember-memory').disabled, true);
  await preview.$('conditions').handlers.submit(event); await preview.$('agent-local').handlers.click(); assert(preview.$('agent-results').children.length > 0); previewApp.dispose();
  const vault = localAccount(); vault.entries[DEEPSEEK_KEY] = { version: 1, token: 'fake-deepseek-key' };
  const first = dom(), second = dom(); let closed = 0;
  const options = { extension: true, dataset, agentClientFactory: () => ({ close() { closed++; }, async complete() { throw new Error('not called'); } }) };
  const firstApp = await startApp({ ...first, ...options, agentStorage: vault.agentAdapter() });
  const secondApp = await startApp({ ...second, ...options, agentStorage: vault.agentAdapter() });
  await first.$('deepseek-forget').handlers.click(); assert.equal(second.$('deepseek-forget').hidden, true); assert.match(second.$('deepseek-status').textContent, /另一个应用页/);
  assert.equal(closed, 2); firstApp.dispose(); secondApp.dispose();
});

test('a stale DeepSeek startup read cannot restore a key revoked during page startup', async (t) => {
  noTimers(t);
  const vault = localAccount(), oldKey = { version: 1, token: 'fake-deepseek-key' };
  vault.entries[DEEPSEEK_KEY] = oldKey;
  const original = vault.area.get; let resolveKey, clients = 0;
  vault.area.get = (key) => key === DEEPSEEK_KEY ? new Promise((resolve) => { resolveKey = resolve; }) : original(key);
  const ui = dom(), startup = startApp({ ...ui, extension: true, dataset, agentStorage: vault.agentAdapter(), agentClientFactory: () => { clients++; return { close() {} }; } });
  await new Promise((resolve) => setImmediate(resolve));
  await vault.area.remove(DEEPSEEK_KEY); resolveKey({ [DEEPSEEK_KEY]: oldKey });
  const app = await startup;
  assert.equal(clients, 0); assert.equal(ui.$('deepseek-remember').checked, false); assert.equal(ui.$('deepseek-forget').hidden, true); app.dispose();
});

test('failed DeepSeek deletion keeps a visible retry but stops its active client immediately', async (t) => {
  noTimers(t);
  const vault = localAccount(); vault.entries[DEEPSEEK_KEY] = { version: 1, token: 'fake-deepseek-key' };
  const ui = dom(); let closes = 0;
  const app = await startApp({ ...ui, extension: true, dataset, agentStorage: vault.agentAdapter(), agentClientFactory: () => ({ close() { closes++; } }) });
  const remove = vault.area.remove; vault.area.remove = async () => { throw new Error('private-storage-failure'); };
  await ui.$('deepseek-forget').handlers.click();
  assert.equal(closes, 1); assert.equal(ui.$('deepseek-forget').hidden, false); assert.equal(ui.$('deepseek-remember').checked, true);
  assert(vault.entries[DEEPSEEK_KEY]); assert.match(ui.$('deepseek-status').textContent, /删除未完成/);
  vault.area.remove = remove; await ui.$('deepseek-forget').handlers.click(); assert(!vault.entries[DEEPSEEK_KEY]); app.dispose();
});
