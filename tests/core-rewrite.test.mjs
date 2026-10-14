// Acceptance checks for the core rewrite: read-only tools, hub degradation, the 10s fuse,
// the eligibility gate, the confirm gate, allergy audit, coupons, rank, blind box, retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPalette, stripAnsi } from '../tui/ansi.mjs';
import { createUI } from '../tui/app.mjs';
import { TuiSession } from '../tui/session.mjs';
import { createExecutor, couponPriceLine } from '../tui/executor.mjs';
import { decide, unknownIntent } from '../core/hub.mjs';
import { DeepSeekError } from '../core/llm.mjs';
import { TOOLS, TOOL_NAMES, assertReadOnlyTools, toolToMcp } from '../core/tools.mjs';
import { admit, applyGate, skipLine, allOut } from '../core/eligibility.mjs';
import { rankCandidates, blindboxPick } from '../core/pick.mjs';
import { reRank } from '../core/memory.mjs';
import { valueCoupons } from '../core/coupons.mjs';
import { buildTurnContext } from '../core/context.mjs';
import { stripAllergyText } from '../core/memory.mjs';
import { canRetry, recordAttempt, classifyFailure, retryOrder, RETRY_PHRASE } from '../core/order.mjs';
import { createFakeLlm, intentFor } from './fake-llm.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns'].map(json));
const dataset = { templates, plans, offers, campaigns };
const P = createPalette(false);

function sink() {
  const chunks = [];
  return { columns: 100, isTTY: false, write(s) { chunks.push(s); return true; }, text: () => stripAnsi(chunks.join('')) };
}
function uiOf(out = sink()) {
  return { out, ui: createUI({ output: out, palette: P, redact: (t) => t }) };
}
const intent = (kind, slots = {}) => ({
  kind, candidate_index: null, ref: null,
  slots: { budget_yuan: null, want: null, store_kw: null, item: null, ...slots }, answer: null,
});

test('tool schemas are read-only: claim and create-order are not callable by the model', () => {
  const names = assertReadOnlyTools(TOOLS);
  assert.deepEqual(names, [...TOOL_NAMES]);
  for (const banned of ['auto-bind-coupons', 'create-order', 'auto_bind_coupons', 'create_order', 'claim', 'order']) {
    assert.equal(toolToMcp(banned, {}), null, banned);
    assert(!names.includes(banned), banned);
  }
  assert.equal(toolToMcp('search_stores', { city: '深圳', keyword: '黄贝岭' })[0], 'query-nearby-stores');
  const priced = toolToMcp('calculate_price', { storeCode: 'S', items: [], couponIds: ['secret'] });
  assert.equal(priced[0], 'calculate-price');
  assert.equal(priced[1].couponIds, undefined, 'coupon ids are not forwarded on this read');
});

test('hub: a tool round then a JSON answer; invalid JSON degrades to unknown', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  const seen = [];
  let n = 0;
  const llm = { async chat() {
    n += 1;
    if (n === 1) return { json: null, toolCalls: [{ id: 't1', name: 'search_stores', arguments: { city: '深圳', keyword: '黄贝岭' } }], content: '', message: { role: 'assistant', content: '' } };
    return { json: intent('recommend'), toolCalls: [], content: '{}', message: { role: 'assistant', content: '{}' } };
  } };
  const ok = await decide({ session, text: '附近有什么', llm, runTool: async (name, args) => { seen.push([name, args]); return { data: { ok: true } }; } });
  assert.equal(ok.kind, 'recommend');
  assert.equal(seen[0][0], 'query-nearby-stores');
  assert.equal(n, 2);

  const writes = [];
  const bad = { async chat() {
    writes.push('chat');
    return { json: null, toolCalls: [{ id: 'w', name: 'create_order', arguments: { storeCode: 'S' } }], content: '', message: { role: 'assistant', content: '' } };
  } };
  let rounds = 0;
  const refused = await decide({
    session, text: '下单', llm: { async chat() {
      rounds += 1;
      if (rounds === 1) return bad.chat();
      return { json: { kind: 'confirm_pick', extra: true }, toolCalls: [], content: '{}', message: { role: 'assistant', content: '{}' } };
    } },
    runTool: async (name) => { writes.push(name); return { data: {} }; },
  });
  assert.equal(refused.kind, 'unknown');
  assert.equal(refused.degraded, 'invalid');
  assert.deepEqual(writes, ['chat']);
  assert.equal(unknownIntent('invalid').kind, 'unknown');
});

test('hub validation failure is an honest 没理解, not a new pick', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: { async chat() {
    return { json: { kind: 'order', candidate_index: null, ref: null, slots: { budget_yuan: null, want: null, store_kw: null, item: null }, answer: null }, toolCalls: [], content: '', message: { role: 'assistant', content: '' } };
  } } });
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => '不是', message: (e) => e.message });
  await exec.handleText('随便说一句');
  assert.match(out.text(), /没理解，能再说一遍吗/);
  assert.doesNotMatch(out.text(), /编号推荐/);
});

test('a 6s-per-call mock hits the 10s fuse: at most 2 model calls, and the card says 按本地规则', { timeout: 20000 }, async () => {
  let calls = 0;
  const llm = { async chat(_messages, { signal } = {}) {
    calls += 1;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 6000);
      const abort = () => { clearTimeout(timer); reject(new DeepSeekError('这轮超时，按本地规则没有完成。', 'timeout')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (calls === 1) return { json: null, toolCalls: [{ id: 't', name: 'campaign_calendar', arguments: {} }], content: '', message: { role: 'assistant', content: '' } };
    return { json: intent('recommend'), toolCalls: [], content: '{}', message: { role: 'assistant', content: '{}' } };
  } };
  const session = new TuiSession({ dataset, env: {}, demo: true, llm });
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => null, message: (e) => e.message });
  await exec.handleText('来份午饭', { signal: AbortSignal.timeout(10000) });
  assert(calls <= 2, `model calls ${calls}`);
  assert.match(out.text(), /按本地规则/);
  assert.match(out.text(), /这轮超时/);
  assert.doesNotMatch(out.text(), /编号推荐/);
});

test('eligibility: ¥0, a missing cart and a failed quote are out, in the §7.2 words', () => {
  const zero = { id: 'z', title: '零元鸡腿', priceFen: 0, parts: [{ name: '鸡腿', quantity: 1 }] };
  const cart = { id: 'c', title: '做不出', cartError: 'no', priceFen: 1000 };
  const quote = { id: 'q', title: '没价', priceError: true, priceFen: null };
  const ok = { id: 'a', title: '麦香鸡', priceFen: 1390, parts: [{ name: '麦香鸡', quantity: 1 }], mainCodes: ['1450'] };
  assert.equal(admit(zero).reason, 'zero');
  assert.match(skipLine('零元鸡腿', 'zero'), /「零元鸡腿」价格异常（¥0），已跳过/);
  assert.match(skipLine('做不出', 'cart'), /这家店现在做不出来，已跳过/);
  assert.match(skipLine('没价', 'quote'), /问不到价，已跳过/);
  const gated = applyGate([zero, cart, quote, ok]);
  assert.deepEqual(gated.kept.map((c) => c.id), ['a']);
  const ranked = rankCandidates([zero, ok, { ...ok, id: 'dear', title: '贵的', priceFen: 9000 }], { budgetFen: 2500 });
  assert.deepEqual(ranked.ranked.map((c) => c.id), ['a']);
  assert.match(ranked.skipped.map((s) => s.line).join('\n'), /零元鸡腿/);
  assert.match(allOut(3), /3 个候选都没通过检查/);
});

test('confirm_pick asks 是这家店吗; ten refusals never claim or order', async () => {
  const writes = { claimAll: 0, createOrder: 0 };
  const llm = { async chat() { return { json: intent('confirm_pick', {}), toolCalls: [], content: '', message: { role: 'assistant', content: '' } }; } };
  // The fake above spreads slots wrong if I pass {}. intent() already fills slots. confirm_pick via createFakeLlm is enough.
  const session = new TuiSession({ dataset, env: {}, demo: false, llm: createFakeLlm(() => intent('confirm_pick')) });
  session.lastReceipt = { title: '麦香鸡', priceFen: 1390, storeName: '测试餐厅', parts: [{ name: '麦香鸡', quantity: 1 }], couponNames: [], at: new Date().toISOString() };
  session.lastPick = { id: 'a', title: '麦香鸡', priceFen: 1390, parts: [{ name: '麦香鸡', quantity: 1 }] };
  session.buyPreview = async () => ({ demo: false, claimable: [{ name: '立减券' }], receipt: session.lastReceipt, storeName: '测试餐厅', used: [], context: { storeCode: 'S1' }, takeWay: { code: '1', title: '堂食' } });
  session.buyClaim = async () => { writes.claimAll += 1; return { claimed: 1 }; };
  session.buyReprice = async () => { writes.reprice = (writes.reprice || 0) + 1; return { priceFen: 1000, items: [], couponNames: [], takeWay: { code: '1' } }; };
  session.buyPlace = async () => { writes.createOrder += 1; return { order: { orderId: '1' } }; };
  const { out, ui } = uiOf();
  const asked = [];
  const exec = createExecutor({ session, ui, ask: async (q) => { asked.push(q); return '不是'; }, message: (e) => e.message });
  for (let i = 0; i < 10; i++) await exec.handleText('吃这个');
  assert.equal(asked.length, 10);
  assert.match(asked[0], /是这家店吗/);
  assert.equal(writes.claimAll, 0);
  assert.equal(writes.createOrder, 0);
  assert.match(out.text(), /已取消，没下单/);
  assert.doesNotMatch(out.text(), /编号推荐/);
  void llm;
});

test('allergy words never enter the prompt or tool arguments', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm() });
  session.addAllergies(['花生', '芒果']);
  const clean = stripAllergyText('不要花生，来份午饭', session.allergies);
  session.noteTurn(clean);
  const ctx = buildTurnContext(session, clean);
  for (const word of ['花生', '芒果', '虾']) assert(!ctx.prompt.includes(word), word);
  assert.match(ctx.prompt, /有忌口（详情本地）/);
  const seen = [];
  await decide({
    session, text: clean, llm: { async chat(messages) {
      seen.push(JSON.stringify(messages));
      return { json: null, toolCalls: [{ id: 't', name: 'query_meals', arguments: { storeCode: 'S1' } }], content: '', message: { role: 'assistant', content: '' } };
    } },
    runTool: async (name, args) => { seen.push(JSON.stringify({ name, args })); return { data: {} }; },
    maxToolRounds: 1,
  });
  const blob = seen.join('\n');
  for (const word of ['花生', '芒果']) assert(!blob.includes(word), word);
});

test('coupon valuation matches the calculate-price delta and the card says 券后', async () => {
  const client = { async call(_name, args) {
    const used = (args.items || []).some((i) => i.couponId);
    return { data: { price: used ? 1900 : 2500 } };
  } };
  const coupon = { name: '立减券', couponId: 'C', couponCode: 'C', productCodes: new Set(['1450']) };
  const rows = await valueCoupons(client, { storeCode: 'S', orderType: 1, beType: 1 }, [coupon], [{ title: '麦香鸡', items: [{ productCode: '1450', quantity: 1 }] }]);
  assert.equal(rows[0].saveYuan, 6);
  assert.equal(rows[0].afterYuan, 19);
  assert.equal(rows[0].applicable, true);
  assert.equal(couponPriceLine({ priceFen: 1900, savingFen: 600 }), '券后 ¥19.00（省 ¥6.00）');
});

test('numbered candidates follow taste, and a blind box stays in budget and eligible', () => {
  const beef = { id: 'b', title: '巨无霸', priceFen: 2000, savingFen: 0, parts: [{ name: '巨无霸', quantity: 1 }], mainCodes: ['1'] };
  const chicken = { id: 'c', title: '麦香鸡', priceFen: 1200, savingFen: 0, parts: [{ name: '麦香鸡', quantity: 1 }], mainCodes: ['2'] };
  const zero = { id: 'z', title: '零元鸡腿', priceFen: 0, parts: [{ name: '鸡腿', quantity: 1 }], mainCodes: ['3'] };
  const dear = { id: 'd', title: '安格斯', priceFen: 8000, parts: [{ name: '安格斯厚牛堡', quantity: 1 }], mainCodes: ['4'] };
  const taste = { meats: ['牛肉'], likes: [{ name: '巨无霸' }], less: [] };
  const ranked = reRank([chicken, beef], { taste, meatOf: (n) => n.includes('巨无霸') ? ['牛肉'] : n.includes('鸡') ? ['鸡肉'] : [] });
  assert.equal(ranked[0].id, 'b');
  const pool = [zero, dear, chicken, beef];
  for (let i = 0; i < 10; i++) {
    const drawn = blindboxPick(pool, { taste, budgetFen: 2500, random: () => i / 10 });
    assert(drawn.plan, 'a draw exists');
    assert(drawn.plan.priceFen > 0 && drawn.plan.priceFen <= 2500, drawn.plan.title);
    assert.notEqual(drawn.plan.id, 'z');
    assert.notEqual(drawn.plan.id, 'd');
  }
});

test('reRank: the current turn want outranks history and price', () => {
  const beef = { id: 'b', title: '双层吉士汉堡', priceFen: 2000, parts: [{ name: '双层吉士汉堡', quantity: 1 }] };
  const chicken = { id: 'c', title: '麦香鸡', priceFen: 1390, parts: [{ name: '麦香鸡', quantity: 1 }] };
  const meatOf = (n) => n.includes('吉士') ? ['牛肉'] : n.includes('鸡') ? ['鸡肉'] : [];
  // New user, no taste: without want the cheaper chicken wins (the old bug).
  assert.equal(reRank([chicken, beef], { meatOf })[0].id, 'c');
  // want=牛肉 (+3) puts the beef first even though the chicken is cheaper.
  assert.equal(reRank([chicken, beef], { meatOf, wantMeats: ['牛肉'] })[0].id, 'b');
  // The current turn want (+3) beats a history taste (+2) pointing the other way.
  const ranked = reRank([chicken, beef], { taste: { meats: ['鸡肉'], likes: [], less: [] }, meatOf, wantMeats: ['牛肉'] });
  assert.equal(ranked[0].id, 'b');
});

test('hub: info intents carry the named item slot', async () => {
  const { validateHubIntent } = await import('../core/hub.mjs');
  const v = validateHubIntent({ kind: 'info_ingredients', candidate_index: null, ref: null, slots: { budget_yuan: null, want: null, store_kw: null, item: '双层吉士汉堡' }, answer: null });
  assert.equal(v.slots.item, '双层吉士汉堡');
  // The old 3-key shape no longer validates.
  assert.equal(validateHubIntent({ kind: 'info_ingredients', candidate_index: null, ref: null, slots: { budget_yuan: null, want: null, store_kw: null }, answer: null }), null);
});

test('fake-llm extracts a named item for info intents; a deictic falls back to lastPick', () => {
  const named = intentFor('本轮：双层吉士汉堡有什么料呢');
  assert.equal(named.kind, 'info_ingredients');
  assert.equal(named.slots.item, '双层吉士汉堡');
  assert.equal(named.ref, null);
  const deictic = intentFor('本轮：这个有什么料呢');
  assert.equal(deictic.kind, 'info_ingredients');
  assert.equal(deictic.slots.item, null);
  assert.equal(deictic.ref, 'lastPick');
  const parts = intentFor('本轮：双层吉士随心配里有什么');
  assert.equal(parts.kind, 'info_parts');
  assert.equal(parts.slots.item, '双层吉士随心配');
  const meat = intentFor('本轮：双层吉士汉堡有牛肉吗');
  assert.equal(meat.kind, 'info_meat');
  assert.equal(meat.slots.item, '双层吉士汉堡');
  assert.equal(meat.slots.want, '牛肉');
});

test('指名问配料答的是指名餐品，不是上一餐', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm() });
  session.lastPick = { title: '麦香鸡', priceFen: 1390, parts: [], orderItems: [{ productCode: 'C1' }] };
  session.detailCache = {
    C1: { code: 'C1', name: '麦香鸡', parts: [], removable: [], complete: false, unknown: true },
    B1: { code: 'B1', name: '双层吉士汉堡', parts: [{ name: '双层吉士汉堡', qty: 1 }], removable: ['吉士', '酸黄瓜'], complete: false, unknown: false },
  };
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => '不是', message: (e) => e.message });
  await exec.handleText('双层吉士汉堡有什么料呢');
  const text = out.text();
  assert.match(text, /双层吉士汉堡/);
  assert.match(text, /吉士/);
  assert.doesNotMatch(text, /配料未知/);
  assert.doesNotMatch(text, /麦香鸡/);
});

test('指名问配料但菜单和缓存都没有时诚实说没查到', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm() });
  session.lastPick = { title: '麦香鸡', priceFen: 1390, parts: [], orderItems: [] };
  session.detailCache = {};
  session.menu = { storeCode: 'S', items: [{ code: 'C1', name: '麦香鸡', priceFen: 1390 }], shape: '' };
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => '不是', message: (e) => e.message });
  await exec.handleText('巨无霸有什么料呢');
  assert.match(out.text(), /没查到「巨无霸」/);
});

test('「创建」retries a failed order and does not pick again; the 4th retry and an unclear failure do not', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm() });
  session.lastReceipt = { title: '麦香鸡', priceFen: 1390, storeName: '样本门店', parts: [], couponNames: [], at: new Date().toISOString(), sample: true };
  session.lastPick = { title: '麦香鸡', priceFen: 1390, parts: [] };
  session.lastOrderAttempt = recordAttempt(null, classifyFailure(new Error('门店拒单')));
  const { out, ui } = uiOf();
  let asks = 0;
  const exec = createExecutor({ session, ui, ask: async () => { asks += 1; return '不是'; }, message: (e) => e.message });
  await exec.handleText('创建');
  assert.match(out.text(), /按上次失败的这一单重试/);
  assert.match(out.text(), /是这家店吗|已取消/);
  assert.doesNotMatch(out.text(), /编号推荐/);
  assert.equal(asks, 1);
  assert.equal(RETRY_PHRASE.test('创建'), true);

  session.lastOrderAttempt = recordAttempt(null, { status: 'failed', reason: '门店拒单' });
  session.lastOrderAttempt.retries = 3;
  const blocked = sink();
  const exec2 = createExecutor({ session, ui: createUI({ output: blocked, palette: P }), ask: async () => '是', message: (e) => e.message });
  await exec2.handleText('重试');
  assert.match(blocked.text(), /这单一直创不出来（门店拒单）/);
  assert.doesNotMatch(blocked.text(), /编号推荐/);

  session.lastOrderAttempt = recordAttempt(null, { status: 'failed', reason: '超时', ambiguous: true });
  assert.equal(session.lastOrderAttempt.status, 'unknown');
  assert.equal(canRetry(session.lastOrderAttempt).ok, false);
  const unclear = sink();
  const exec3 = createExecutor({ session, ui: createUI({ output: unclear, palette: P }), ask: async () => '是', message: (e) => e.message });
  await exec3.handleText('再试一次');
  assert.match(unclear.text(), /结果不明确/);
  assert.doesNotMatch(unclear.text(), /编号推荐/);

  const dup = recordAttempt(null, classifyFailure(new Error('订单已存在')));
  assert.equal(canRetry(dup).ok, false);
  await assert.rejects(() => retryOrder({ attempt: dup, confirmed: false, place: async () => ({}) }), /确认/);
});

test('source checks: no web import, no intent regex, no random receipt', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const grep = (pattern, path) => spawnSync('grep', ['-rEn', pattern, path], { cwd: root, encoding: 'utf8' });
  const webImport = grep("from '\\.\\./web/", 'tui');
  assert.equal(webImport.stdout, '');
  const intent = grep('parseBuyIntent|parsePriceQuery|parseInfoQuery|PARTS_HINT|DEICTIC|MEAT_ASK', 'tui');
  assert.equal(intent.stdout, '');
  const receipt = grep('maybeReceipt|shouldPrintReceipt|随手掉落', 'tui');
  assert.equal(receipt.stdout, '');
});

test('source checks: build scripts only handle the receipt card, never web/', async () => {
  const build = await readFile(new URL('../scripts/build_frontend.mjs', import.meta.url), 'utf8');
  assert(!build.includes('web/'), 'build script must not reference web/');
  assert(!build.includes('ENOENT'), 'ENOENT must not be swallowed');
  assert(build.includes('receipt-card.html') && build.includes("'receipt', 'index.html'"));
});

// Fix #1: auth/balance/rate/network degrade with the real message; only bad JSON says 没理解.
test('hub: model-side failures degrade with message, bad JSON stays 没理解', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  for (const code of ['auth', 'balance', 'rate', 'network']) {
    const llm = { async chat() { throw new DeepSeekError(`${code} exploded`, code); } };
    const out = await decide({ session, text: '来一份', llm, runTool: async () => ({}) });
    assert.equal(out.kind, 'unknown');
    assert.equal(out.degraded, 'degraded', code);
    assert.match(out.errorMessage, new RegExp(code), code);
  }
  const badLlm = { async chat() { return { json: { kind: 'nope' }, toolCalls: [], content: '', message: {} }; } };
  const bad = await decide({ session, text: 'x', llm: badLlm, runTool: async () => ({}) });
  assert.equal(bad.degraded, 'invalid');
});

test('executor: degraded hub intent shows the error and falls back to local picks', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => '不是', message: (e) => e.message });
  await exec.runIntent({ ...intent('unknown'), degraded: 'degraded', errorMessage: '余额不足' }, { query: '来一份' });
  assert.match(out.text(), /余额不足/);
  assert.match(out.text(), /本地模式/);
  assert.match(out.text(), /编号推荐/);
});

// Fix #2: budget from the model only applies to recommend/blindbox, and only when changed.
test('budget is ignored for non-pick intents and when unchanged', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => null, message: (e) => e.message });
  session.lastPick = { id: 'p1', title: '双层吉士汉堡', parts: [{ name: '双层吉士汉堡' }], priceFen: 1490, orderItems: [] };
  const before = session.request.budgetPerPersonFen;
  await exec.runIntent(intent('info_meat', { budget_yuan: 50 }), { query: '有牛肉吗' });
  assert.equal(session.request.budgetPerPersonFen, before, 'info intent must not touch budget');
  assert.equal(session.lastPick.title, '双层吉士汉堡', 'pick must survive');
});

// Fix #3: "有什么料" with no code match says 没查到 instead of answering another meal.
test('info_ingredients never answers with an unrelated cached meal', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  session.lastPick = { id: 'pick-1', title: 'A餐', parts: [], orderItems: [{ productCode: 'CODE-A' }] };
  session.detailCache = { other: { code: 'CODE-B', name: 'B餐', parts: [], removable: ['生菜'], meatKind: [], complete: false, unknown: false } };
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => null, message: (e) => e.message });
  exec.infoFromCache('info_ingredients');
  assert.match(out.text(), /没查到/);
  assert.doesNotMatch(out.text(), /生菜/);
});

// Fix #4: prefetch targets candidate product codes, not the menu at large.
test('prefetchCandidateDetails fetches the candidates own codes', async () => {
  const { prefetchCandidateDetails } = await import('../core/menu.mjs');
  const seen = [];
  const client = { async call(name, args) {
    assert.equal(name, 'query-meal-detail');
    seen.push(args.code);
    return { data: { code: args.code, name: `餐${args.code}` } };
  } };
  const candidates = [
    { id: 'c1', title: '套餐1', orderItems: [{ productCode: 'P1' }, { productCode: 'P2' }] },
    { id: 'c2', title: '套餐2', orderItems: [{ productCode: 'P1' }] },
  ];
  const cache = await prefetchCandidateDetails(client, {}, candidates);
  assert.ok(cache.P1 && cache.P2, 'candidate product codes fetched');
  assert.equal(new Set(seen).size, seen.length, 'no duplicate fetches');
  assert(!seen.includes('UNRELATED'), 'menu-wide items are not fetched');
  assert(!seen.includes('c1') && !seen.includes('c2'), 'synthetic candidate ids are not query-meal-detail codes');
});

test('infoFromCache prefers a known productCode detail over the synthetic id and an unknown entry', () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  session.lastPick = { id: 'c1', title: 'A餐', parts: [], orderItems: [{ productCode: 'P1' }] };
  session.detailCache = {
    synth: { code: 'c1', name: 'A餐', parts: [], removable: ['合成酱'], meatKind: [], complete: false, unknown: false },
    bad: { code: 'P1', name: 'A餐', parts: [], removable: ['失败酱'], meatKind: [], complete: false, unknown: true },
    good: { code: 'P1', name: 'A餐', parts: [], removable: ['生菜'], meatKind: [], complete: true, unknown: false },
  };
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => null, message: (e) => e.message });
  exec.infoFromCache('info_ingredients');
  assert.match(out.text(), /生菜/);
  assert.doesNotMatch(out.text(), /合成酱|失败酱/);
});

test('quote pricing forwards signal and does not swallow an abort', async () => {
  const { prepareWheel } = await import('../core/pricing.mjs');
  const { liveAlaCarte } = await import('../tui/pricing.mjs');
  const { liveMenuPlans } = await import('../tui/menu.mjs');
  const context = { storeCode: 'S', orderType: 1, beType: 1 };
  const request = { people: 1, budgetPerPersonFen: 3000, avoidMainCodes: [] };
  const signal = AbortSignal.abort();
  const seen = [];
  const client = { async call(name, _args, opts) { seen.push({ name, signal: opts?.signal }); throw new Error('已取消。'); } };
  await assert.rejects(() => prepareWheel(client, { recipes: [{ id: 'r', people: 1, title: '套餐', ingredients: [] }], mainProductCodes: [] }, context, request, () => {}, { signal }));
  assert.equal(seen[0].name, 'now-time-info');
  assert.equal(seen[0].signal, signal);
  seen.length = 0;
  await assert.rejects(() => liveAlaCarte(client, context, [{ code: 'P1', name: '巨无霸' }], request, [], () => {}, { signal }));
  assert.equal(seen[0].name, 'query-meal-detail');
  assert.equal(seen[0].signal, signal);
  seen.length = 0;
  await assert.rejects(() => liveMenuPlans(client, context, [{ code: 'P1', name: '巨无霸' }], request, [], new Set(), () => {}, { signal }));
  assert.equal(seen[0].name, 'query-meal-detail');
  assert.equal(seen[0].signal, signal);
});

// Fix #5: the numbered card renders the coupon value table.
test('numbered card shows 券折算 rows', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  session.couponTable = [{ name: '测试券', applicable: true, saveYuan: 5, ratio: null, afterYuan: 10, note: '' }];
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => null, message: (e) => e.message });
  exec.showNumbered([{ id: 't1', title: '测试餐', priceFen: 1500, savingFen: 500, parts: [], couponNames: [] }], { query: 't' });
  assert.match(out.text(), /券折算/);
  assert.match(out.text(), /测试券/);
  assert.match(out.text(), /省 ¥5\.00/);
});

// Fix #6: an aborted signal cancels the MCP call without retrying.
test('MCPClient.call with an aborted signal throws 已取消 without retry', async () => {
  const { MCPClient } = await import('../core/mcp.mjs');
  let calls = 0;
  const client = new MCPClient('test-token-12345678', {
    fetchFn: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5000)); throw new Error('hang'); },
    timeoutMs: 1000, sleep: async () => {},
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.call('query-meals', {}, { signal: controller.signal }), /已取消/);
  assert.equal(calls, 0, 'no fetch attempt on an already-aborted signal');
});

// Fix #7: retry uses the failed receipt snapshot, not a later pick.
test('retry uses the failed order snapshot even after a new pick', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm() });
  const failedReceipt = { title: '旧餐', priceFen: 2000, storeName: '店', parts: [], couponNames: [], at: new Date().toISOString(), sample: true };
  session.lastOrderAttempt = recordAttempt(null, { status: 'failed', reason: '拒单', receiptSnapshot: failedReceipt });
  session.lastReceipt = { title: '新餐', priceFen: 1500, storeName: '店', parts: [], couponNames: [], at: new Date().toISOString(), sample: true };
  session.lastPick = { title: '新餐' };
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => '不是', message: (e) => e.message });
  await exec.retry();
  assert.equal(session.lastReceipt.title, '旧餐', 'retry must restore the failed snapshot');
  assert.match(out.text(), /按上次失败的这一单重试/);
});

// Fix #9: register_allergy is honest about /allergy being the entry point.
test('register_allergy points to /allergy', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  const { out, ui } = uiOf();
  const exec = createExecutor({ session, ui, ask: async () => null, message: (e) => e.message });
  await exec.runIntent(intent('register_allergy'), { query: '我花生过敏' });
  assert.match(out.text(), /\/allergy/);
});

// Abort mid-quote: prepareWheel returns the finished quotes as a partial report,
// it does not throw the whole recommendation away.
test('prepareWheel: abort during candidate quoting returns a partial report', async () => {
  const { prepareWheel } = await import('../core/pricing.mjs');
  const context = { storeCode: 'S', orderType: 1, beType: 1 };
  const request = { people: 1, budgetPerPersonFen: 3000, avoidMainCodes: [] };
  const controller = new AbortController();
  const recipes = ['r1', 'r2', 'r3'].map((id) => ({ id, people: 1, title: `套餐${id}`, ingredients: [{ productCode: 'P1', quantity: 1 }] }));
  let priceCalls = 0;
  const client = {
    async call(name, args, opts) {
      if (opts?.signal?.aborted) throw new Error('已取消。');
      switch (name) {
        case 'now-time-info': return { data: { datetime: '2026-10-14 12:00:00' } };
        case 'available-coupons': return { data: [] };
        case 'query-my-coupons': return { data: { currentPage: 1, coupons: [], totalCount: 0, totalPages: 1 } };
        case 'query-store-coupons': return { data: [] };
        case 'campaign-calendar': return { data: { dailyList: [] } };
        case 'query-meals': return { data: { meals: [] } };
        case 'query-meal-detail':
          return { data: { code: 'P1', name: '套餐一', rounds: [{ id: '1', quantity: 1, choices: [{ code: 'C1', name: '主食', quantity: 1, isDefault: true }] }] } };
        case 'calculate-price': {
          priceCalls++;
          const n = priceCalls;
          await new Promise((r) => setTimeout(r, 30));
          if (opts?.signal?.aborted) throw new Error('已取消。');
          if (n === 1) {
            // First quote finishes; the abort lands right after so the rest die mid-loop.
            queueMicrotask(() => controller.abort());
            return { data: { price: 1500 }, datetime: '2026-10-14 12:00:00' };
          }
          throw new Error('已取消。');
        }
        default: throw new Error(`unexpected call ${name}`);
      }
    },
  };
  const report = await prepareWheel(client, { recipes, mainProductCodes: ['C1'] }, context, request, () => {}, { signal: controller.signal });
  assert.equal(report.partial, true);
  assert.match(report.partialNote, /2 个候选未核完/);
  assert.equal(report.quotedPlans.length, 1, 'keeps the finished quote');
  assert.equal(report.candidates.length, 1, 'the finished quote still becomes a candidate');
});

// quoteBest quotes coupon variants in parallel and takes the minimum cart along.
test('quoteBest quotes coupon variants in parallel and takes the minimum', async () => {
  const { quoteBest } = await import('../core/pricing.mjs');
  const items = [{ productCode: 'P1', quantity: 1 }];
  const mkCoupon = (id) => ({ couponId: id, couponCode: `CODE-${id}`, name: `券${id}`, productCodes: new Set(['P1']), expiresAt: Date.now() + 86400000 });
  let inflight = 0, maxInflight = 0;
  const client = {
    async call(name, args) {
      assert.equal(name, 'calculate-price');
      const tagged = (args.items || []).find((i) => i.couponId);
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight--;
      const price = !tagged ? 2000 : tagged.couponId === 'c1' ? 1800 : 1500;
      return { data: { price }, datetime: '2026-10-14 12:00:00' };
    },
  };
  const q = await quoteBest(client, { storeCode: 'S', orderType: 1, beType: 1 }, items, [mkCoupon('c1'), mkCoupon('c2')], 64, {});
  assert.equal(maxInflight, 2, 'variant quotes run in parallel, not serially');
  assert.equal(q.basePriceFen, 2000);
  assert.equal(q.priceFen, 1500);
  assert.equal(q.savingFen, 500);
  assert.deepEqual(q.couponNames, ['券c2']);
  assert.equal(q.orderItems.find((i) => i.couponId)?.couponId, 'c2');
  assert.equal(q.successfulCouponQuotes, 2);
});

// Abort lands in liveAlaCarte (after prepareWheel finished 2/2): the quote must keep
// prepareWheel's candidates as a partial report instead of dying with 已取消.
test('quote: abort in liveAlaCarte returns prepareWheel candidates as partial', async () => {
  const templates = {
    recipes: [
      { id: 'r1', people: 1, title: '套餐一', ingredients: [{ productCode: 'P1', quantity: 1 }] },
      { id: 'r2', people: 1, title: '套餐二', ingredients: [{ productCode: 'P2', quantity: 1 }] },
    ],
    mainProductCodes: ['M1', 'M2', 'M3'],
  };
  const plans = { plans: [{ parts: [{ code: 'M1', name: '主食一' }, { code: 'M2', name: '主食二' }, { code: 'M3', name: '主食三' }] }] };
  const dataset = { templates, plans, offers: {}, campaigns: {}, menu: { items: [] } };
  const controller = new AbortController();
  let mDetailCalls = 0;
  const factory = () => ({ initialize: async () => {}, close() {}, async call(name, args = {}, opts = {}) {
    if (opts?.signal?.aborted) throw new Error('已取消。');
    switch (name) {
      case 'now-time-info': return { data: { datetime: '2026-10-14 12:00:00' } };
      case 'available-coupons': return { data: [] };
      case 'query-my-coupons': return { data: { currentPage: 1, coupons: [], totalCount: 0, totalPages: 1 } };
      case 'query-store-coupons': return { data: [] };
      case 'campaign-calendar': return { data: { dailyList: [] } };
      case 'query-meals': return { data: { meals: [] } };
      case 'query-meal-detail': {
        const code = args.code;
        if (templates.mainProductCodes.includes(code)) {
          mDetailCalls++;
          // Abort lands on the 2nd à la carte main: M1 quoted, M2 dies mid-detail.
          if (mDetailCalls === 2) { controller.abort(); throw new Error('已取消。'); }
          return { data: { code, name: `主食${code}` } };
        }
        // Choice code must be a mainProductCode or buildCart rejects the recipe.
        return { data: { code, name: `套餐${code}`, rounds: [{ id: '1', quantity: 1, choices: [{ code: 'M1', name: '主食', quantity: 1, isDefault: true }] }] } };
      }
      case 'calculate-price': return { data: { price: 2000 }, datetime: '2026-10-14 12:00:00' };
      default: throw new Error(`unexpected call ${name}`);
    }
  } });
  const session = new TuiSession({ dataset, env: { MCD_TOKEN: 'test' }, mcpFactory: factory });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const report = await session.quote(() => {}, { signal: controller.signal });
  assert.equal(report.partial, true, 'abort becomes partial, the flow does not die');
  assert.match(report.partialNote, /单点主食核价未完成/);
  assert(report.candidates.length >= 2, 'prepareWheel candidates survive the abort');
  assert(report.candidates.every((p) => p.priceFen > 0), 'survivors are quotable');
});

// Stage priority: prepareWheel already quoted ≥5 → liveAlaCarte (nice-to-have) is skipped,
// saving its 8+ MCP calls. Asserted by counting à la carte detail calls.
test('quote: liveAlaCarte skipped when prepareWheel already quoted 5+', async () => {
  const templates = {
    recipes: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id, i) => ({ id, people: 1, title: `套餐${i + 1}`, ingredients: [{ productCode: `P${i + 1}`, quantity: 1 }] })),
    mainProductCodes: ['M1', 'M2', 'M3'],
  };
  const plans = { plans: [{ parts: [{ code: 'M1', name: '主食一' }, { code: 'M2', name: '主食二' }, { code: 'M3', name: '主食三' }] }] };
  const dataset = { templates, plans, offers: {}, campaigns: {}, menu: { items: [] } };
  let mDetailCalls = 0;
  const factory = () => ({ initialize: async () => {}, close() {}, async call(name, args = {}, opts = {}) {
    if (opts?.signal?.aborted) throw new Error('已取消。');
    switch (name) {
      case 'now-time-info': return { data: { datetime: '2026-10-14 12:00:00' } };
      case 'available-coupons': return { data: [] };
      case 'query-my-coupons': return { data: { currentPage: 1, coupons: [], totalCount: 0, totalPages: 1 } };
      case 'query-store-coupons': return { data: [] };
      case 'campaign-calendar': return { data: { dailyList: [] } };
      case 'query-meals': return { data: { meals: [] } };
      case 'query-meal-detail': {
        const code = args.code;
        if (templates.mainProductCodes.includes(code)) mDetailCalls++;
        // Choice code must be a mainProductCode or buildCart rejects the recipe.
        return { data: { code, name: `品${code}`, rounds: [{ id: '1', quantity: 1, choices: [{ code: 'M1', name: '主食', quantity: 1, isDefault: true }] }] } };
      }
      case 'calculate-price': return { data: { price: 2000 }, datetime: '2026-10-14 12:00:00' };
      default: throw new Error(`unexpected call ${name}`);
    }
  } });
  const session = new TuiSession({ dataset, env: { MCD_TOKEN: 'test' }, mcpFactory: factory });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const report = await session.quote(() => {}, {});
  assert.equal(mDetailCalls, 0, 'liveAlaCarte skipped: no à la carte detail calls');
  assert(!report.partial, 'no abort, no partial');
  assert(report.candidates.length >= 5, 'prepareWheel candidates are enough on their own');
});
