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
import { createFakeLlm } from './fake-llm.mjs';

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
  slots: { budget_yuan: null, want: null, store_kw: null, ...slots }, answer: null,
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
    return { json: { kind: 'order', candidate_index: null, ref: null, slots: { budget_yuan: null, want: null, store_kw: null }, answer: null }, toolCalls: [], content: '', message: { role: 'assistant', content: '' } };
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
