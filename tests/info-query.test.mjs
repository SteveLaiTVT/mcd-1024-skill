// Issue #2: info questions ('这个有牛肉吗' / '随心配有什么' / '有什么料').
// Local rules and a fake MCP only. No MCD_TOKEN, no live store, no #3 chitchat / #5 prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInfoQuery, meatsInName, parsePriceQuery, parseBuyIntent } from '../tui/intent.mjs';
import { describeDetail, demoDetail, answerIngredients, answerMeat, renderInfoAnswer } from '../tui/info.mjs';
import { runInfoFlow } from '../tui/agent-flow.mjs';
import { TuiSession } from '../tui/session.mjs';
import { createUI } from '../tui/ui.mjs';
import { createShell } from '../tui/shell.mjs';
import { createPalette, stripAnsi } from '../tui/ansi.mjs';
import { helpLines } from '../tui/render.mjs';
import { QR_LABEL } from '../tui/receipt.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns, packages, menu] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns', 'packages', 'menu'].map(json));
const dataset = { templates, plans, offers, campaigns, menu, packages };
const P = createPalette(false);
const now = '2026-10-13T12:00:00+08:00';
const env = { MCD_TOKEN: 'test-only-mcd-token-0001', DEEPSEEK_API_KEY: 'test-only-deepseek-key-0002' };
const NO_PICK = '还没有挑出这一餐。先说"预算 30 来一份"，或直接问具体的，比如"巨无霸有牛肉吗"';

const namesOf = (extra = []) => [...dataset.plans.plans.flatMap((p) => p.parts.map((x) => x.name)), ...(menu.items || []).map((i) => i.name), ...extra];

function sink() {
  const chunks = [];
  return { columns: 100, isTTY: false, write(s) { chunks.push(s); return true; }, text: () => stripAnsi(chunks.join('')) };
}
function fakeDeepSeek() {
  const calls = [];
  return { calls, factory: () => ({ close() {}, async complete(system, input) { calls.push({ system, input }); return {}; } }) };
}
function fakeMcp({ meals, detail } = {}) {
  const calls = [];
  const factory = () => ({ initialize: async () => {}, close() {},
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === 'now-time-info') return { data: { datetime: now } };
      if (name === 'query-nearby-stores') return { data: [{ storeCode: 'S1', storeName: '测试餐厅', businessStatus: true }] };
      if (name === 'query-meals') return { data: meals ?? { meals: { F1: { name: '中薯条', currentPrice: '8' } } } };
      if (name === 'query-meal-detail') {
        if (detail === 'throw') throw new Error('连接中断');
        return { data: typeof detail === 'function' ? detail(args) : (detail ?? { code: args.code, name: '餐品', rounds: [] }) };
      }
      if (name === 'calculate-price') return { data: { price: 2500 }, datetime: now };
      if (name === 'query-store-coupons') return { data: [] };
      throw new Error(`Unexpected tool ${name}`);
    } });
  return { calls, factory };
}
function sessionOf(opts = {}) {
  return new TuiSession({ dataset: opts.dataset ?? dataset, env: opts.env ?? {}, demo: opts.demo ?? false, mcpFactory: opts.mcp?.factory, deepseekFactory: opts.deepseek?.factory,
    random: () => 0.99, now: () => new Date(now) });
}
async function ask(session, line) {
  const out = sink();
  const ui = createUI({ output: out, palette: P, redact: (t) => session.redact(t) });
  const shell = createShell({ session, ui, ask: async () => null, autoConnect: false });
  await shell.run(line);
  return out.text();
}

test('parseInfoQuery hits meat, parts and ingredients, and leaves pick / price sentences alone', () => {
  const names = ['随心配', '双层吉士汉堡'];
  const hit = (t) => parseInfoQuery(t, names);
  assert.deepEqual(hit('这个有牛肉吗'), { kind: 'meat', meat: '牛肉', confirm: 'has', target: { ref: 'pick', implicit: false } });
  assert.deepEqual(hit('它是牛肉的吗'), { kind: 'meat', meat: '牛肉', confirm: 'has', target: { ref: 'pick', implicit: false } });
  assert.deepEqual(hit('含不含猪肉'), { kind: 'meat', meat: '猪肉', confirm: null, target: { ref: 'pick', implicit: true } });
  assert.equal(hit('双层吉士汉堡是牛肉吗').target.item, '双层吉士汉堡');
  assert.equal(hit('这个没有牛肉吧').confirm, 'not');
  assert.deepEqual(hit('这个套餐里有什么'), { kind: 'parts', target: { ref: 'pick', implicit: false } });
  assert.deepEqual(hit('里面有什么'), { kind: 'parts', target: { ref: 'pick', implicit: false } });
  assert.equal(hit('随心配有什么').target.item, '随心配');
  assert.deepEqual(hit('有什么东西'), { kind: 'parts', target: { ref: 'pick', implicit: true } });
  assert.equal(hit('双层吉士汉堡有什么料').kind, 'ingredients');
  assert.equal(hit('双层吉士汉堡有什么料').target.item, '双层吉士汉堡');
  assert.equal(hit('这个里面有牛肉吗').kind, 'meat');
  assert.equal(parseInfoQuery('随心配有什么', []), null, 'a bare 随心配 is a product only when that name is known');
  for (const t of ['有什么好吃的', '有什么', '早餐有什么', '套餐有什么', '不要牛肉', '有牛肉的吗', '有没有不含牛肉的套餐', '我想吃牛肉堡', '牛肉堡多少钱，有牛肉吗', '有什么活动', '就吃这个了', '预算30不要牛肉']) {
    assert.equal(parseInfoQuery(t, names), null, t);
  }
  assert.equal(parseInfoQuery('牛肉堡多少钱，有牛肉吗', names), null);
  assert.equal(parsePriceQuery('牛肉堡多少钱，有牛肉吗')?.item, '牛肉堡');
  assert.equal(parsePriceQuery('巨无霸多少钱')?.item, '巨无霸');
  assert.equal(parseBuyIntent('好的'), null);
  assert.deepEqual(parseBuyIntent('就吃这个了'), { delivery: false, takeWay: null });
});

test('meatsInName keeps the known 吉士 false positive', () => {
  assert.deepEqual(meatsInName('巨无霸'), ['牛肉']);
  assert.deepEqual(meatsInName('麦辣鸡腿汉堡'), ['鸡肉']);
  assert.deepEqual(meatsInName('吉士猪柳蛋麦满分'), ['牛肉', '猪肉']);
});

test('describeDetail reads rounds and removable extras, and skips mutex prep options', () => {
  const pkg = packages.packages[0];
  const detail = describeDetail(pkg);
  assert.equal(detail.plain, false);
  assert.ok(detail.rounds.length >= 1);
  assert.equal(detail.rounds[0].name, '麦辣鸡腿汉堡');
  const chicken = detail.rounds[0].choices.find((c) => c.name === '麦辣鸡腿汉堡');
  assert.ok(chicken.extras.includes('麦香鸡酱'));
  assert.ok(chicken.extras.includes('切块生菜'));
  const everyExtra = [...detail.extras, ...detail.rounds.flatMap((r) => r.choices.flatMap((c) => c.extras))];
  for (const ice of ['标准', '去冰', '多冰', '少冰']) assert.ok(!everyExtra.includes(ice), ice);
  const plain = describeDetail({ code: '1', name: '单品', rounds: [] });
  assert.equal(plain.plain, true);
  assert.deepEqual(plain.rounds, []);

  const single = describeDetail(demoDetail(packages, '1440', '麦辣鸡腿汉堡'));
  assert.equal(single.plain, true);
  assert.deepEqual(single.extras, ['麦香鸡酱', '切块生菜']);
  const card = renderInfoAnswer(answerIngredients({ name: '麦辣鸡腿汉堡', detail: single }), P).join('\n');
  assert.match(card, /不是完整配料表/);
  assert.match(card, /麦香鸡酱/);
  assert.match(card, /切块生菜/);
  assert.doesNotMatch(card, /去冰/);
  const bare = renderInfoAnswer(answerIngredients({ name: '巨无霸', detail: describeDetail({ code: 'x', name: '巨无霸', rounds: [] }) }), P).join('\n');
  assert.match(bare, /接口没给单品配料明细/);
  assert.match(bare, /按产品名判定含牛肉/);
  assert.doesNotMatch(bare, /不是完整配料表/);
});

test('help lists the info examples and still has no new slash command', () => {
  const help = helpLines(P).join('\n');
  assert.match(help, /这个有牛肉吗/);
  assert.match(help, /随心配里有什么/);
  assert.match(help, /一次问一件事/);
  assert.doesNotMatch(help, /checkout/);
});

test('demo: 麦辣鸡腿汉堡有什么料 uses the sample package choice, not an invented recipe', async () => {
  const session = sessionOf({ demo: true });
  const text = await ask(session, '麦辣鸡腿汉堡有什么料');
  const flat = text.replace(/[│╭╮╰╯─\s]/g, '');
  assert.match(flat, /不是完整配料表/);
  assert.match(flat, /麦香鸡酱/);
  assert.match(flat, /切块生菜/);
  assert.doesNotMatch(text, /去冰/);
  assert.doesNotMatch(text, /这一餐就吃/);
  assert.equal(session.lastDetails, null);
});

test('no receipt + 这个有牛肉吗 is only the info prompt, and an omitted subject still picks', async () => {
  const mcp = fakeMcp();
  const session = sessionOf({ demo: true, mcp });
  const text = await ask(session, '这个有牛肉吗');
  assert.match(text, new RegExp(NO_PICK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(text, /这一餐就吃/);
  assert.equal(mcp.calls.length, 0);
  assert.equal(session.lastReceipt, null);

  const picked = sessionOf({ demo: true });
  const meal = await ask(picked, '含不含猪肉');
  assert.doesNotMatch(meal, /还没有挑出这一餐/);
  assert.match(meal, /这一餐就吃/);
  assert.ok(picked.lastDetails, 'an omitted subject with no receipt is a pick');
});

test('after a pick, 这个有牛肉吗 stays on the receipt: no pick card, no price tools, no DeepSeek, no receipt drop', async () => {
  const mcp = fakeMcp();
  const deepseek = fakeDeepSeek();
  const session = sessionOf({ mcp, deepseek, env });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  session.lastPick = { title: '麦香鸡随心配' };
  session.lastReceipt = { title: '麦香鸡随心配', storeName: '测试餐厅', parts: [{ name: '麦香鸡', quantity: 1 }, { name: '无糖可口可乐中杯', quantity: 1 }],
    buy: { storeCode: 'S1', takeWayCode: 'TW', takeWays: [], items: [{ productCode: '9900001', quantity: 1 }] } };
  session.lastDetails = { query: '预算30', lines: ['过程保留'] };
  const receipt = structuredClone(session.lastReceipt);
  const details = structuredClone(session.lastDetails);
  const pick = session.lastPick;
  const before = mcp.calls.length;
  const text = await ask(session, '这个有牛肉吗');
  assert.match(text, /牛肉/);
  assert.match(text, /按产品名判定/);
  assert.match(text, /麦香鸡/);
  assert.doesNotMatch(text, /这一餐就吃/);
  assert.doesNotMatch(text, new RegExp(QR_LABEL));
  assert.deepEqual(session.lastReceipt, receipt);
  assert.deepEqual(session.lastDetails, details);
  assert.equal(session.lastPick, pick);
  assert.equal(deepseek.calls.length, 0);
  const added = mcp.calls.slice(before).map((c) => c.name);
  assert.deepEqual(added, []);
  assert.ok(!added.includes('calculate-price') && !added.includes('query-store-coupons'));
});

test('allergy is recorded, then 这个 still answers from lastReceipt after invalidate clears lastPick', async () => {
  const session = sessionOf({ demo: true });
  await session.quote();
  session.recordPick(session.report.candidates[0]);
  const receipt = structuredClone(session.lastReceipt);
  assert.ok(session.lastPick);
  const text = await ask(session, '我对牛肉过敏，这个有牛肉吗');
  assert.ok(session.allergies.includes('牛肉'));
  assert.equal(session.lastPick, null);
  assert.deepEqual(session.lastReceipt, receipt);
  assert.match(text, /已记录过敏：牛肉/);
  assert.match(text, /你记录了对牛肉过敏/);
  assert.match(text, /按产品名判定/);
  assert.doesNotMatch(text, /这一餐就吃/);
});

test('随心配有什么 calls only query-meals and query-meal-detail', async () => {
  const detail = { code: 'SX1', name: '随心配', rounds: [{ name: '小食', quantity: 1, choices: [
    { name: '中薯条', isDefault: 1, quantity: 1, diffPrice: '+ ¥0' },
    { name: '麦乐鸡-5块', isDefault: 0, quantity: 0, diffPrice: '+ ¥2' }] }] };
  const mcp = fakeMcp({ meals: { meals: { SX1: { name: '随心配', currentPrice: '25' } } }, detail });
  const data = { ...dataset, menu: { ...menu, items: [...menu.items, { productCode: 'SX1', name: '随心配' }] } };
  const session = sessionOf({ dataset: data, mcp, env: { MCD_TOKEN: env.MCD_TOKEN } });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const before = mcp.calls.length;
  const text = await ask(session, '随心配有什么');
  assert.deepEqual(mcp.calls.slice(before).map((c) => c.name), ['query-meals', 'query-meal-detail']);
  assert.match(text, /中薯条/);
  assert.match(text, /麦乐鸡-5块/);
  assert.doesNotMatch(text, /这一餐就吃/);
  assert.equal(session.lastDetails, null);
});

test('a detail failure says the interface failed, and a menu miss names the menu', async () => {
  const mcp = fakeMcp({ meals: { meals: { B: { name: '双层吉士汉堡', currentPrice: '22' } } }, detail: 'throw' });
  const session = sessionOf({ mcp, env: { MCD_TOKEN: env.MCD_TOKEN } });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const failed = await ask(session, '双层吉士汉堡有什么料');
  assert.match(failed, /接口出错/);
  assert.match(failed, /query-meal-detail/);
  assert.match(failed, /连接中断/);
  assert.doesNotMatch(failed, /预算/);
  assert.doesNotMatch(failed, /这一餐就吃/);

  const missMcp = fakeMcp({ meals: { meals: { C: { name: '板烧鸡腿堡', currentPrice: '15' }, D: { name: '中薯条', currentPrice: '8' } } } });
  const miss = sessionOf({ mcp: missMcp, env: { MCD_TOKEN: env.MCD_TOKEN } });
  await miss.connect();
  miss.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const missing = await ask(miss, '巨无霸有牛肉吗');
  assert.match(missing, /菜单里没找到/);
  assert.match(missing, /巨无霸/);
  assert.doesNotMatch(missing, /预算/);
  assert.doesNotMatch(missing, /这一餐就吃/);
});

test('a mixed price question stays a price answer, activity stays /activity, and 就吃这个了 still buys', async () => {
  const session = sessionOf({ demo: true });
  const price = await ask(session, '牛肉堡多少钱，有牛肉吗');
  assert.match(price, /多少钱|菜单样本价|最低预算/);
  assert.doesNotMatch(price, /只按产品名判定/);
  assert.doesNotMatch(price, /这一餐就吃/);

  const activity = sessionOf({ demo: true });
  const act = await ask(activity, '有什么活动');
  assert.match(act, /项活动/);
  assert.doesNotMatch(act, /这一餐就吃/);
  assert.equal(activity.lastDetails, null);

  const buyer = sessionOf({ demo: true });
  await buyer.quote();
  buyer.recordPick(buyer.report.candidates[0]);
  const bought = await ask(buyer, '就吃这个了');
  assert.match(bought, /演示模式不下真实订单/);
  assert.match(bought, /没有调用 create-order/);

  const peanut = sessionOf({ demo: true });
  const lunch = await ask(peanut, '我对花生过敏，来份午饭');
  assert.ok(peanut.allergies.includes('花生'));
  assert.ok(peanut.lastDetails, 'the rest of an allergy sentence still enters the meal flow');
  assert.doesNotMatch(lunch, /还没有挑出这一餐/);
  assert.match(lunch, /这一餐就吃|没挑出来|预算/);
});

test('有什么好吃的 is a pick, not a parts question', async () => {
  assert.equal(parseInfoQuery('有什么好吃的', namesOf(['随心配'])), null);
  const session = sessionOf({ demo: true });
  const text = await ask(session, '有什么好吃的');
  assert.match(text, /这一餐就吃/);
  assert.ok(session.lastReceipt);
});

test('里 inside an ordinary statement is not a composition question', () => {
  const names = namesOf(['随心配', '双层吉士汉堡']);
  for (const t of ['家里有小孩，清淡点', '我都有点饿了', '公司里加班']) assert.equal(parseInfoQuery(t, names), null, t);
  assert.equal(parseInfoQuery('我们都有什么优惠', names), null);
  assert.equal(parseInfoQuery('你们有什么东西', names), null);
  assert.equal(parseInfoQuery('牛肉汉堡里有什么', names).kind, 'parts');
});

test('这个/那个 plus a food kind refers to the current pick', () => {
  const names = namesOf(['随心配']);
  const beef = parseInfoQuery('这是牛肉吗', names);
  assert.equal(beef.kind, 'meat');
  assert.equal(beef.meat, '牛肉');
  assert.deepEqual(beef.target, { ref: 'pick', implicit: false });
  const burger = parseInfoQuery('这个汉堡有牛肉吗', names);
  assert.equal(burger.kind, 'meat');
  assert.equal(burger.meat, '牛肉');
  assert.deepEqual(burger.target, { ref: 'pick', implicit: false });
  const parts = parseInfoQuery('那个套餐里有什么', names);
  assert.equal(parts.kind, 'parts');
  assert.deepEqual(parts.target, { ref: 'pick', implicit: false });
});

test('不是 and 不带 are a negative meat question', () => {
  const names = namesOf();
  const notBeef = parseInfoQuery('这个不是牛肉吧', names);
  assert.equal(notBeef.kind, 'meat');
  assert.equal(notBeef.meat, '牛肉');
  assert.equal(notBeef.confirm, 'not');
  assert.deepEqual(notBeef.target, { ref: 'pick', implicit: false });
  const notPork = parseInfoQuery('这不带猪肉吧', names);
  assert.equal(notPork.kind, 'meat');
  assert.equal(notPork.meat, '猪肉');
  assert.equal(notPork.confirm, 'not');
  assert.equal(notPork.target.ref, 'pick');
});

test('allergy warnings follow meat labels and quote the original record', () => {
  const card = (allergies, meat) => renderInfoAnswer(answerMeat({ names: ['巨无霸'], meat, confirm: 'has' }), P, { allergies }).join('\n');
  assert.doesNotMatch(card(['牛奶'], '牛肉'), /过敏/);
  assert.doesNotMatch(card(['鸡蛋'], '鸡肉'), /过敏/);
  assert.match(card(['牛肉'], '牛肉'), /你记录了对牛肉过敏/);
  const mixed = renderInfoAnswer(answerMeat({ names: ['麦辣鸡腿汉堡'], meat: '鸡肉', confirm: 'has' }), P, { allergies: ['鸡蛋、鸡肉'] }).join('\n');
  assert.match(mixed, /过敏/);
});

test('confirm not answers 对 or 不对, and 羊肉 is unknown', () => {
  const denied = renderInfoAnswer(answerMeat({ names: ['巨无霸'], meat: '牛肉', confirm: 'not' }), P).join('\n');
  assert.match(denied, /不对，含牛肉/);
  const accepted = renderInfoAnswer(answerMeat({ names: ['麦辣鸡腿汉堡'], meat: '牛肉', confirm: 'not' }), P).join('\n');
  assert.match(accepted, /对，按产品名没看到牛肉/);
  const asked = parseInfoQuery('这个有羊肉吗', []);
  assert.equal(asked.meat, '羊');
  const lamb = answerMeat({ names: ['板烧鸡腿堡'], meat: asked.meat });
  assert.equal(lamb.unknown, true);
  const lambCard = renderInfoAnswer(lamb, P).join('\n');
  assert.match(lambCard, /只能按名称识别牛\/鸡\/鱼\/猪\/虾/);
  assert.match(lambCard, /没看到"羊"/);
});

test('pick with two single items calls pickDetail: plain false, receipt title, extras keep where', async () => {
  const detail = (args) => ({
    A1: { code: 'A1', name: '麦辣鸡腿汉堡', rounds: [], modification: { items: [{ minValues: 0, maxValues: 2, values: [{ name: '麦香鸡酱', selectedQuantity: 1, unselectedKey: 'off' }] }] } },
    B1: { code: 'B1', name: '双层吉士汉堡', rounds: [], modification: { items: [{ minValues: 0, maxValues: 2, values: [{ name: '酸黄瓜', selectedQuantity: 1, unselectedKey: 'off' }] }] } },
  }[args.code] || { code: args.code, name: '餐品', rounds: [] });
  const mcp = fakeMcp({ detail });
  const session = sessionOf({ mcp, env: { MCD_TOKEN: env.MCD_TOKEN } });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const receipt = { title: '双拼小食', storeName: '测试餐厅', parts: [{ name: '麦辣鸡腿汉堡', quantity: 1 }, { name: '双层吉士汉堡', quantity: 1 }],
    buy: { storeCode: 'S1', items: [{ productCode: 'A1', quantity: 1 }, { productCode: 'B1', quantity: 1 }] } };
  session.lastReceipt = receipt;
  const out = sink();
  const ui = createUI({ output: out, palette: P, redact: (t) => session.redact(t) });
  const names = [...session.mainNames.values(), ...session.packageNames.values()];
  const before = mcp.calls.length;
  const parts = await runInfoFlow(session, '这个套餐里有什么', parseInfoQuery('这个套餐里有什么', names), ui);
  assert.deepEqual(mcp.calls.slice(before).map((c) => [c.name, c.args.code]), [['query-meal-detail', 'A1'], ['query-meal-detail', 'B1']]);
  assert.equal(parts.status, 'answered');
  assert.equal(parts.answer.plain, false);
  assert.equal(parts.answer.name, receipt.title);
  assert.doesNotMatch(out.text(), /这是单品，不是套餐/);
  const ing = await runInfoFlow(session, '这个有什么料', parseInfoQuery('这个有什么料', names), ui);
  assert.deepEqual(ing.answer.extras.map((r) => ({ where: r.where, names: r.names })), [
    { where: '麦辣鸡腿汉堡', names: ['麦香鸡酱'] },
    { where: '双层吉士汉堡', names: ['酸黄瓜'] },
  ]);
  const merged = answerIngredients({ detail: { name: '双拼', extras: [
    { where: '麦辣鸡腿汉堡', names: ['麦香鸡酱'] },
    { where: '麦辣鸡腿汉堡', names: ['切块生菜', '麦香鸡酱'] },
  ] } });
  assert.deepEqual(merged.extras, [{ where: '麦辣鸡腿汉堡', names: ['麦香鸡酱', '切块生菜'] }]);
});
