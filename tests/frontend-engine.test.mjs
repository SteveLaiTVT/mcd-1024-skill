import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { budgetFen, buildCart, couponVariants, eligibleCoupons, couponTimeStatus, constrainCoupons, publicCalendar, prepareWheel, quoteBest, wallet, WheelSession } from '../core/pricing.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const templates = await json('plan-recipes'), packages = await json('packages'), snapshots = await json('meal-plans');
const details = Object.fromEntries(packages.packages.map((p) => [p.productCode, { code: p.productCode, name: p.name, rounds: p.rounds }]));
const now = '2026-10-10T17:00:00+08:00';
const context = { storeCode: '1421180', storeName: '测试门店', beType: 1, orderType: 1 };
const asset = { id: 'private-asset-A', code: 'private-rule-A', title: '同名优惠券', enable: 1, tradeStartDate: '2026-10-10', tradeEndDate: '2026-10-11' };
const storeCoupon = { couponId: asset.id, couponCode: asset.code, title: asset.title, products: [{ productCode: '9900005453', productName: '麦香鸡套餐' }] };
function mockClient({ owned = [asset], store = [storeCoupon], baseline = 3500, discounted = 2500, failDiscount = false, calendar = { dailyList: [] } } = {}) {
  const calls = [];
  return { calls, async call(name, args = {}) {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'now-time-info') return { data: { datetime: now } };
    if (name === 'available-coupons') return { data: [{ couponName: '名称写着 9.9 元的券', couponStatus: 'CAN_GET', label: '可领取' }] };
    if (name === 'query-my-coupons') return { data: { currentPage: Number(args.page), totalPages: 1, totalCount: owned.length, coupons: owned } };
    if (name === 'query-store-coupons') return { data: store };
    if (name === 'campaign-calendar') return { data: calendar };
    if (name === 'query-meals') return { data: { meals: Object.fromEntries(Object.keys(details).map((c) => [c, {}])) } };
    if (name === 'query-meal-detail') return { data: details[args.code] };
    if (name === 'calculate-price') {
      const couponed = args.items.some((i) => i.couponId);
      if (couponed && failDiscount) throw new Error('coupon rejected');
      return { data: { price: couponed ? discounted : baseline }, datetime: now };
    }
    throw new Error(`Unexpected tool: ${name}`);
  } };
}
const oneTemplate = { ...templates, recipes: templates.recipes.filter((r) => r.id === 'chicken-normal-1') };

test('money parses decimal text into exact fen and rejects ambiguous inputs', () => {
  assert.equal(budgetFen('20.29'), 2029); assert.equal(budgetFen('0.01'), 1); assert.equal(budgetFen('0'), 0);
  for (const input of ['NaN', 'Infinity', '-1', '1e3', '1.001', '', '9007199254740991']) assert.throws(() => budgetFen(input));
});
test('all 50 recipes expand to the authoritative snapshot, including share quantities and modifications', () => {
  for (const recipe of templates.recipes) {
    const cart = buildCart(recipe, details, new Set(templates.mainProductCodes));
    const plan = snapshots.plans.find((p) => p.id === recipe.id);
    assert.deepEqual(cart.packages, plan.packages, recipe.id); assert.deepEqual(cart.parts, plan.parts, recipe.id);
    assert(cart.parts.filter((p) => cart.mainCodes.includes(p.code)).reduce((s, p) => s + p.quantity, 0) >= recipe.people);
  }
  const cart = buildCart(templates.recipes.find((r) => r.id === 'chicken-normal-2'), details, new Set(templates.mainProductCodes));
  assert.equal(cart.items[0].quantity, 2); assert.equal(cart.items[0].roundList[0].comboItemList[0].quantity, 1);
  assert(cart.items[0].roundList.some((r) => r.comboItemList.some((c) => c.modification)));
});
test('two same-name coupon assets can each cover one portion, without reusing or losing portions', () => {
  const coupons = ['A', 'B'].map((id) => ({ couponId: id, couponCode: id, name: '同名券', productCodes: new Set(['P']), expiresAt: 1 }));
  const base = [{ productCode: 'P', quantity: 2, roundList: [{ round: '1', comboItemList: [{ code: 'MAIN', quantity: 1 }] }] }];
  const { variants } = couponVariants(base, coupons);
  assert(variants.some((v) => v.filter((i) => i.couponId).length === 2));
  for (const v of variants) {
    assert.equal(v.reduce((s, i) => s + i.quantity, 0), 2);
    const bound = v.filter((i) => i.couponId); assert.equal(new Set(bound.map((i) => i.couponId)).size, bound.length);
    bound.forEach((i) => assert.equal(i.quantity, 1));
    assert.deepEqual(v[0].roundList, base[0].roundList);
  }
  assert.equal(base[0].quantity, 2); assert.equal(couponVariants(base, coupons, 2).truncated, true);
});
test('coupon needs both owned asset and explicit current-store mapping', () => {
  assert.equal(eligibleCoupons([], [storeCoupon], Date.parse(now)).eligible.length, 0);
  assert.equal(eligibleCoupons([{ ...asset, enable: 0 }], [storeCoupon], Date.parse(now)).eligible.length, 0);
  assert.equal(eligibleCoupons([asset], [{ ...storeCoupon, products: [] }], Date.parse(now)).eligible.length, 0);
  assert.equal(eligibleCoupons([asset], [storeCoupon], Date.parse(now)).eligible.length, 1);
});
test('weekday and overnight campaign windows constrain quotes to the active cutoff', () => {
  const time = Date.parse('2026-10-10T23:58:00+08:00');
  const info = { couponId: 'A', tradeStartDate: '2026-10-01', tradeEndDate: '2026-10-30', weekdays: [7], isAllTradeTime: 0, tradeTimePeriods: [{ startTime: '22:00', endTime: '00:01' }] };
  assert.equal(couponTimeStatus(info, time), 'valid'); assert.equal(couponTimeStatus({ ...info, weekdays: [1] }, time), 'outside');
  assert.equal(couponTimeStatus({ ...info, isAllTradeTime: null }, time), 'unknown');
  const output = constrainCoupons([{ couponId: 'A', couponCode: 'B', name: '夜间券' }], { dailyList: [{ events: [{ couponInfo: info }] }] }, time);
  assert.equal(output.cutoffs[0], Date.parse('2026-10-11T00:01:00+08:00'));
});
test('article price zero is never a free-food price; private calendar identifiers are removed', () => {
  const entries = publicCalendar({ dailyList: [{ date: '2026-10-10', events: [{ eventType: 4, price: 0, id: 'private-event', articleDto: { title: '优惠文章', body: 'private-body' } }] }] }, Date.parse(now));
  assert.equal(entries[0].priceDisplay, null); assert.equal(entries[0].priceUse, 'information-only-no-price-rule');
  assert(!JSON.stringify(entries).includes('private-'));
});
test('over-budget baseline is quoted with coupons before budget filtering', async () => {
  const client = mockClient();
  const report = await prepareWheel(client, oneTemplate, context, { people: 1, portion: 7, budgetPerPersonFen: 3000, avoidMainCodes: [] });
  assert.equal(report.candidates.length, 1); assert.equal(report.candidates[0].basePriceFen, 3500); assert.equal(report.candidates[0].priceFen, 2500); assert.equal(report.candidates[0].savingFen, 1000);
  assert.equal(client.calls.filter((c) => c.name === 'calculate-price').length, 2);
  assert.equal(client.calls.some((c) => c.name === 'auto-bind-coupons'), false);
  assert(!JSON.stringify(report).includes('private-asset')); assert(!JSON.stringify(report).includes('private-rule'));
});
test('unclaimed offers do not lower prices or cause automatic claiming', async () => {
  const client = mockClient({ owned: [], store: [] });
  const report = await prepareWheel(client, oneTemplate, context, { people: 1, portion: 7, budgetPerPersonFen: 3000, avoidMainCodes: [] });
  assert.equal(report.candidates.length, 0); assert.equal(report.quotedPlans[0].priceFen, 3500);
  assert.equal(client.calls.filter((c) => c.name === 'calculate-price').length, 1); assert.equal(client.calls.some((c) => c.name === 'auto-bind-coupons'), false);
});
test('zero is a legitimate verified coupon quote; failed quotes retain baseline with incomplete comparison', async () => {
  const cart = buildCart(oneTemplate.recipes[0], details, new Set(templates.mainProductCodes));
  const usable = eligibleCoupons([asset], [storeCoupon], Date.parse(now)).eligible;
  const free = await quoteBest(mockClient({ discounted: 0 }), context, cart.items, usable); assert.equal(free.priceFen, 0);
  const rejected = await quoteBest(mockClient({ failDiscount: true }), context, cart.items, usable);
  assert.equal(rejected.priceFen, 3500); assert.equal(rejected.failedCouponQuotes, 1); assert.equal(rejected.comparisonComplete, false);
});
test('wallet deduplicates by asset id, and caps incomplete paging at five pages', async () => {
  let calls = 0;
  const result = await wallet({ async call(_, args) { calls++; return { data: { currentPage: Number(args.page), totalPages: 10, totalCount: 10, coupons: [{ ...asset, id: String(args.page) }] } }; } });
  assert.equal(calls, 5); assert.equal(result.owned.length, 5); assert.equal(result.complete, false);
});
test('wheel excludes seen plans, rejects stale live prices, and keeps demo explicitly separate', () => {
  let elapsed = 0; const session = new WheelSession(() => elapsed), random = { getRandomValues(v) { v[0] = 0; } };
  assert.throws(() => session.choose(random));
  session.accept({ sourceKind: 'official-live-pre-wheel-pricing', validForSeconds: 60, candidates: [{ id: 'A' }, { id: 'B' }] });
  assert.equal(session.choose(random).plan.id, 'A'); assert.equal(session.choose(random).plan.id, 'B'); assert.throws(() => session.choose(random));
  session.accept({ sourceKind: 'official-live-pre-wheel-pricing', validForSeconds: 60, candidates: [{ id: 'A' }] });
  elapsed = 60000; assert.equal(session.remaining().length, 0); assert.throws(() => session.choose(random));
  session.invalidate(); assert.equal(session.report, null);
});
