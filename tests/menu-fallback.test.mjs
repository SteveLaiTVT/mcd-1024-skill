// Regression tests for the 2026-10-14 悦彩城 incident: all templates failed (transient
// query-meal-detail failures), and the TUI answered '预算内没有候选 / 可以提高人均预算'
// — wrong, because the cause was not budget. Price questions must also get a direct
// price lookup, not the pick flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePriceQuery } from '../tui/intent.mjs';
import { emptyCause, renderEmpty } from '../tui/menu.mjs';
import { createPalette } from '../tui/ansi.mjs';
import { TuiSession } from '../tui/session.mjs';

const P = createPalette(false);
const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));

test('price questions route to a direct lookup, pick questions do not', () => {
  assert.equal(parsePriceQuery('我想吃牛肉堡，最低的预算要多少钱')?.item, '牛肉堡');
  assert.equal(parsePriceQuery('牛肉堡多少钱')?.item, '牛肉堡');
  assert.equal(parsePriceQuery('巨无霸多少钱')?.item, '巨无霸');
  assert.equal(parsePriceQuery('有什么不错的套餐推荐一下'), null, 'a recommendation is a pick, not a price question');
  assert.equal(parsePriceQuery('现在有什么能吃的'), null, 'an open question is a pick, not a price question');
  assert.equal(parsePriceQuery('最低预算 40 看看'), null, 'setting a budget is not asking a price');
  assert.equal(parsePriceQuery('那我这个预算有什么好的套餐推荐吗'), null);
});

test('price question with sentence noise extracts only the food phrase, never the sentence', () => {
  assert.equal(parsePriceQuery('领完优惠券我也吃不了牛肉汉堡吗？我想搞个套餐的话多少钱')?.item, '牛肉汉堡');
  assert.equal(parsePriceQuery('双层吉士汉堡多少钱', new Map([['B2', '双层吉士汉堡']]))?.item, '双层吉士汉堡');
  assert.equal(parsePriceQuery('大堡口福三件套多少钱', new Map([['B4', '大堡口福']]))?.item, '大堡口福三件套');
  assert.equal(parsePriceQuery('牛肉汉堡套餐多少钱')?.item, '牛肉汉堡套餐');
});

test('emptyCause names the real cause; only budget may suggest raising the budget', () => {
  const base = { quotedPlans: [], failedPlans: [], excludedPlans: [], request: { people: 1, budgetPerPersonFen: 2500 }, menu: { ok: true, items: [] } };
  assert.equal(emptyCause({ ...base, quotedPlans: [{ fitsPortion: true, withinBudget: false, priceFen: 3000, title: 'X' }] }).cause, 'budget');
  assert.equal(emptyCause({ ...base, menu: { ok: false, error: 'timeout' }, failedPlans: [{ cause: 'api', reason: 'timeout' }] }).cause, 'api');
  assert.equal(emptyCause({ ...base, failedPlans: [{ cause: 'menu', reason: '当前门店套餐或搭配不可用' }] }).cause, 'menu');
  assert.equal(emptyCause({ ...base }).cause, 'none');

  const budgetCard = renderEmpty({ ...base, quotedPlans: [{ fitsPortion: true, withinBudget: false, priceFen: 3000, title: 'X' }] }, P);
  assert.equal(budgetCard.title, '预算不够');
  assert(budgetCard.lines.join('').includes('把预算提到'), 'budget is the only cause that suggests raising the budget');
  const apiCard = renderEmpty({ ...base, menu: { ok: false, error: 'timeout', items: [] }, failedPlans: [{ cause: 'api', reason: 'timeout' }] }, P);
  assert.equal(apiCard.title, '接口异常');
  assert(apiCard.lines.join('').includes('不是预算问题'), 'api failure must say it is not a budget problem');
  assert(!apiCard.lines.join('').includes('把预算提到'), 'api failure must never suggest raising the budget');
  const menuCard = renderEmpty({ ...base, failedPlans: [{ cause: 'menu', title: '酥脆无双套餐', reason: '当前门店套餐或搭配不可用' }] }, P);
  assert.equal(menuCard.title, '这家店查不到这些套餐');
  assert(menuCard.lines.join('').includes('提高预算也没用'), 'menu failure must say raising the budget does not help');
});

test('when every template detail call fails, the quote still returns à la carte singles (no menu fallback needed)', async () => {
  const [templates, plans, offers, campaigns] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns'].map(json));
  const dataset = { templates, plans, offers, campaigns };
  const calls = [];
  // query-meals returns a menu that HAS the template codes (so prepareWheel attempts their
  // details) plus real food items for the fallback; every query-meal-detail throws (the 10:22 transient).
  const menuMeals = { '8800001': { name: '巨无霸套餐', currentPrice: '25.00' }, '8800002': { name: '牛肉堡', currentPrice: '13.50' } };
  for (const code of [...new Set(templates.recipes.flatMap((r) => r.ingredients.map((i) => i.productCode)))]) menuMeals[code] = {};
  const factory = () => ({ initialize: async () => {}, close() {}, async call(name, args = {}) {
    calls.push(name);
    if (name === 'now-time-info') return { data: { datetime: '2026-10-14T10:30:00+08:00' } };
    if (name === 'query-my-coupons') return { data: { currentPage: 1, totalPages: 1, totalCount: 0, coupons: [] } };
    if (name === 'query-store-coupons') return { data: [] };
    if (name === 'campaign-calendar') return { data: { dailyList: [] } };
    if (name === 'available-coupons') return { data: [] };
    if (name === 'query-meals') return { data: { meals: menuMeals } };
    if (name === 'query-meal-detail') throw new Error('麦当劳未完成这次业务请求，请检查 Token 或稍后重查。');
    if (name === 'calculate-price') return { data: { price: 2200 }, datetime: '2026-10-14T10:30:00+08:00' };
    throw new Error(`Unexpected tool ${name}`);
  } });
  const session = new TuiSession({ dataset, env: { MCD_TOKEN: 'test' }, mcpFactory: factory });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const report = await session.quote();
  // The template SETS failed (query-meal-detail), but the à la carte singles price via
  // calculate-price, which does not need the set details — so the quote still has candidates.
  assert(!report.menuFallback, 'the menu fallback is not needed when singles price');
  assert(report.candidates.length > 0, 'singles must produce candidates, not an empty answer');
  assert(report.candidates.every((p) => p.kind === 'alacarte'), 'candidates come from the singles');
});

test('when template sets and singles both fail, the quote falls back to the store menu', async () => {
  const [templates, plans, offers, campaigns] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns'].map(json));
  // No template mains → no singles to price, so the store-menu fallback is the only path left.
  const dataset = { templates: { ...templates, mainProductCodes: [] }, plans, offers, campaigns };
  const menuMeals = { '8800001': { name: '巨无霸套餐', currentPrice: '25.00' }, '8800002': { name: '牛肉堡', currentPrice: '13.50' } };
  for (const code of [...new Set(templates.recipes.flatMap((r) => r.ingredients.map((i) => i.productCode)))]) menuMeals[code] = {};
  const factory = () => ({ initialize: async () => {}, close() {}, async call(name, args = {}) {
    if (name === 'now-time-info') return { data: { datetime: '2026-10-14T10:30:00+08:00' } };
    if (name === 'query-my-coupons') return { data: { currentPage: 1, totalPages: 1, totalCount: 0, coupons: [] } };
    if (name === 'query-store-coupons') return { data: [] };
    if (name === 'campaign-calendar') return { data: { dailyList: [] } };
    if (name === 'available-coupons') return { data: [] };
    if (name === 'query-meals') return { data: { meals: menuMeals } };
    if (name === 'query-meal-detail') throw new Error('麦当劳未完成这次业务请求，请检查 Token 或稍后重查。');
    if (name === 'calculate-price') return { data: { price: 2200 }, datetime: '2026-10-14T10:30:00+08:00' };
    throw new Error(`Unexpected tool ${name}`);
  } });
  const session = new TuiSession({ dataset, env: { MCD_TOKEN: 'test' }, mcpFactory: factory });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const report = await session.quote();
  assert(report.menuFallback && report.menuFallback.tried > 0, 'the menu fallback must run when no template prices');
  assert(report.candidates.length > 0, 'the menu fallback must produce candidates, not an empty answer');
  assert(report.candidates.every((p) => p.kind === 'menu'), 'fallback candidates come from the store menu');
  assert.equal(emptyCause(report).cause, 'filtered', 'with fallback candidates the report is not empty');
});
