import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createPalette, textWidth, fit, box, stripAnsi } from '../tui/ansi.mjs';
import { renderHeatmap, renderRecentEats, isDrink, renderAllergyScreen, renderActivities, renderPick, COMMAND_HELP } from '../tui/render.mjs';
import { parseAllergyStatement, stripAllergyText, applyAllergyFilter, defaultProfilePath, ALLERGEN_KEYWORDS } from '../tui/allergy.mjs';
import { alaCartePlan, mergeAlaCarte, applyUpgrades, upgradeText } from '../tui/pricing.mjs';
import { activitiesFromCalendar, classifyActivities, NO_REGISTER_NOTE, OFFICIAL_PATH } from '../tui/activity.mjs';
import { TuiSession } from '../tui/session.mjs';
import { createUI, runTui } from '../tui/app.mjs';
import { demoHistory } from '../core/history.mjs';
import { defaultPreferences, learnFeedback } from '../core/pick.mjs';
import { receiptFrom, renderReceipt, QR_LABEL } from '../tui/receipt.mjs';
import { cardUrl, decodeCard, CARD_BASE_URL } from '../tui/card.mjs';
import { encodeQR, utf8, QR_MAX_BYTES } from '../tui/qr.mjs';
import { loadOrders, defaultOrdersPath, CART_NOTE, EMPTY_CART, NO_PICK } from '../tui/orders.mjs';
import { createFakeLlm } from './fake-llm.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns, packages, menu] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns', 'packages', 'menu'].map(json));
const dataset = { templates, plans, offers, campaigns };
const details = Object.fromEntries(packages.packages.map((p) => [p.productCode, { code: p.productCode, name: p.name, rounds: p.rounds }]));
const env = { MCD_TOKEN: 'test-only-mcd-token-0001', DEEPSEEK_API_KEY: 'test-only-deepseek-key-0002' };
const now = '2026-10-13T12:00:00+08:00';
const singles = plans.plans.filter((p) => p.people === 1 && p.portion === 7);
const avoidCode = singles[0].mainCodes[0], otherCode = singles.find((p) => !p.mainCodes.includes(avoidCode)).mainCodes[0];
const mainNames = new Map(plans.plans.flatMap((p) => p.parts.filter((x) => templates.mainProductCodes.includes(x.code)).map((x) => [x.code, x.name])));

// A package code that some 1-person 7分饱 carts contain, so a held coupon can apply to it.
const couponPkg = templates.recipes.find((r) => r.people === 1 && r.portion === 7).ingredients[0].productCode;
const HELD = [{ id: 'COUPON-ID-SECRET-1', enable: 1, code: 'COUPON-CODE-SECRET-1', tradeStartDate: '2026-10-01', tradeEndDate: '2026-10-14', title: '快过期立减券' },
  { id: 'COUPON-ID-SECRET-2', enable: 1, code: 'COUPON-CODE-SECRET-2', tradeStartDate: '2026-10-01', tradeEndDate: '2026-12-31', title: '年底甜品券' }];
const STORE_COUPONS = [{ couponId: HELD[0].id, couponCode: HELD[0].code, title: HELD[0].title, products: [{ productCode: couponPkg, productName: '套餐' }] },
  { couponId: HELD[1].id, couponCode: HELD[1].code, title: HELD[1].title, products: [{ productCode: 'NOT-IN-ANY-CART', productName: '甜品' }] }];

function fakeMcp({ coupons = false } = {}) {
  const calls = [], tokens = [];
  const order = (id, status, code, time = '2026-10-12 12:30:00') => ({ orderId: id, orderStatus: status, createTime: time, storeName: '测试餐厅', orderProductList: [{ productName: '套餐', productCode: 'pkg', quantity: 1, comboItemList: [{ name: mainNames.get(code), productCode: code, quantity: 1 }, { name: '可乐', productCode: 'drink', quantity: 1 }] }] });
  const factory = (token) => {
    tokens.push(token);
    return { calls, initialize: async () => {}, close() {}, async claimAll() { calls.push({ name: 'auto-bind-coupons' }); return { data: { successCount: 2, failedCount: 0 } }; },
      async call(name, args = {}) {
        calls.push({ name, args });
        if (name === 'now-time-info') return { data: { datetime: now } };
        if (name === 'query-nearby-stores') return { data: [{ storeCode: 'CLOSED', storeName: '暂停餐厅', businessStatus: false }, { storeCode: 'S1', storeName: '测试餐厅', address: '测试路 1 号', businessStatus: true, businessStartTime: '07:00', businessEndTime: '23:00' }] };
        if (name === 'order-list') return { data: { list: [order('a', '订单已完成', avoidCode), order('b', '7', otherCode), order('c', '订单已完成', otherCode, '2026-10-09 12:00:00')] } };
        if (name === 'available-coupons') return { data: [{ couponName: '写着 9.9 元的券', couponStatus: 'CAN_GET', label: '可领取' }] };
        if (name === 'query-my-coupons') return { data: { currentPage: Number(args.page), totalPages: 1, totalCount: coupons ? HELD.length : 0, coupons: coupons ? HELD : [] } };
        if (name === 'query-store-coupons') return { data: coupons ? STORE_COUPONS : [] };
        if (name === 'campaign-calendar') return { data: { dailyList: [] } };
        if (name === 'query-meals') return { data: { meals: Object.fromEntries(Object.keys(details).map((c) => [c, {}])) } };
        if (name === 'query-meal-detail') return { data: details[args.code] };
        if (name === 'calculate-price') return { data: { price: args.items.some((i) => i.couponId) ? 2200 : 2500 }, datetime: now };
        throw new Error(`Unexpected tool ${name}`);
      } };
  };
  return { calls, tokens, factory };
}
function fakeDeepSeek(intent) {
  const calls = [];
  return { calls, factory: (key) => ({ key, close() {}, async complete(system, input) {
    calls.push({ system, input });
    if ('instruction' in input) return intent;
    return { choices: [{ id: input.eligibleIds.at(-1), signals: ['balanced'] }], vibe: 'cozy' };
  } }) };
}
function sink() { const chunks = []; return { chunks, columns: 100, isTTY: false, write(s) { chunks.push(s); return true; }, text: () => stripAnsi(chunks.join('')) }; }

test('intent regexes are gone; the hub rejects a JSON object with extra keys', async () => {
  const { validateHubIntent } = await import('../core/hub.mjs');
  const ok = { kind: 'recommend', candidate_index: null, ref: null, slots: { budget_yuan: 30, want: null, store_kw: null, item: null }, answer: null };
  assert.equal(validateHubIntent(ok).kind, 'recommend');
  assert.equal(validateHubIntent({ ...ok, extra: 1 }), null);
  assert.equal(validateHubIntent({ ...ok, kind: 'order' }), null);
});

test('terminal helpers measure CJK width and the heatmap renders fictional history with a clear label', () => {
  assert.equal(textWidth('麦麦ab'), 6); assert.equal(textWidth(createPalette(true).red('麦')), 2);
  assert.equal(textWidth(fit('麦当劳麦当劳麦当劳', 7)), 7);
  assert(box('标题', ['麦麦'], { width: 30 }).split('\n').every((l) => textWidth(l) === 30));
  const lines = renderHeatmap(demoHistory(), createPalette(false), { mode: 'recent' });
  assert.match(lines[0], /虚构示例/); assert.equal(lines.filter((l) => /^[日一二三四五六] /.test(l)).length, 7);
  assert(renderHeatmap(demoHistory(), createPalette(false), { mode: 'year' }).some((l) => /常点餐品：.+×/.test(l)));
});

test('recent eats collapse identical day + time + items into one line without changing the header count', () => {
  const order = (time, drink) => ({ day: '2026-10-09', time, items: [{ name: '巨无霸套餐', quantity: 1, parts: [{ name: '巨无霸', quantity: 1, parts: [] }, { name: drink, quantity: 1, parts: [] }] }] });
  const history = { sourceKind: 'mcp', orders: [order('18:20', '可乐'), order('18:20', '可乐'), order('18:20', '可乐'), order('18:20', '雪碧'), order('12:20', '可乐')] };
  const lines = renderRecentEats(history, createPalette(false));
  assert.match(lines[0], /最近 5 笔/);
  assert.equal(lines.filter((l) => /^10-09 周五 18:20 .*喝：可乐/.test(l)).length, 1);
  assert.equal(lines.length, 4);
});

test('coffee drinks classify as drinks while combo and wrap names stay food', () => {
  for (const name of ['鲜萃冰咖', '小杯鲜萃咖啡', '麦咖啡™冰美式中杯', '麦咖啡™热奶铁中杯']) assert(isDrink(name), name);
  for (const name of ['生菜蛋沙拉叠叠卷组合', '培根蔬萃双层牛堡', '培根蔬萃双层牛堡三件套']) assert(!isDrink(name), name);
});

test('a sentence ends in a numbered card; the model never receives the token', async () => {
  const session = new TuiSession({ dataset, env, demo: true, llm: createFakeLlm() });
  const input = new PassThrough(), out = sink();
  input.end('人均30\n/why\n/quit\n');
  await runTui({ input, output: out, color: false, env: {}, dataset, session, autoConnect: false });
  const text = out.text();
  for (const s of ['编号推荐', '券后 ¥', '理由：', '门店：', '/why 看挑选过程', '挑选过程']) assert(text.includes(s), s);
  for (const s of ['推荐 Agent', '优化 Agent', '1/6 理解需求', '随手掉落', env.MCD_TOKEN]) assert(!text.includes(s), s);
  assert.equal(session.redact(`x ${env.MCD_TOKEN} y`), 'x [已隐藏] y');
});

test('defaults: ¥25, and /store without arguments searches Huangbeiling', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true });
  assert.equal(session.request.people, 1);
  assert.equal(session.request.budgetPerPersonFen, 2500);
  session.setProfile({ budgetPerPersonFen: 3500 });
  assert.equal(session.request.budgetPerPersonFen, 3500);
  const mcp = fakeMcp();
  const live = new TuiSession({ dataset, env: { MCD_TOKEN: env.MCD_TOKEN }, mcpFactory: mcp.factory });
  await live.connect();
  const input = new PassThrough(), out = sink();
  input.end('/store\n/quit\n');
  await runTui({ input, output: out, color: false, env: {}, dataset, session: live, autoConnect: false });
  assert.deepEqual(mcp.calls.find((c) => c.name === 'query-nearby-stores').args, { beType: 1, searchType: 2, city: '深圳', keyword: '黄贝岭地铁站' });
});

test('quotes expire after five minutes and block the wheel', async () => {
  let clock = 0;
  const mcp = fakeMcp(), session = new TuiSession({ dataset, env: { MCD_TOKEN: env.MCD_TOKEN }, mcpFactory: mcp.factory });
  session.wheel.now = () => clock;
  await session.connect(); session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  await session.quote(); assert.equal(session.remainingSeconds(), 300);
  assert(session.spin().plan);
  clock = 300001;
  assert.throws(() => session.spin(), /5 分钟/);
});

test('claiming coupons needs an explicit typed yes and the agent can never claim', async () => {
  const mcp = fakeMcp(), session = new TuiSession({ dataset, env, mcpFactory: mcp.factory, deepseekFactory: fakeDeepSeek({}).factory });
  await assert.rejects(session.claim(), /明确确认/);
  const run = async (answer) => {
    const input = new PassThrough(), out = sink();
    input.end(`/claim\n${answer}\n/quit\n`);
    await runTui({ dataset, input, output: out, env: {}, color: false, session });
    return out.text();
  };
  assert.match(await run('y'), /已取消，未领取/);
  assert.equal(mcp.calls.filter((c) => c.name === 'auto-bind-coupons').length, 0);
  assert.match(await run('yes'), /已领取 2 张/);
  assert.equal(mcp.calls.filter((c) => c.name === 'auto-bind-coupons').length, 1);
});

test('piped smoke run: demo mode renders a numbered card, shows radar, and exits cleanly', async () => {
  const input = new PassThrough(), out = sink();
  input.end('/help\n人均30\n/why\n/wheel\n/radar\n/radar apply\n/like\n/status\n/quit\n');
  await runTui({ dataset, input, output: out, env: {}, demo: true, color: false, llm: createFakeLlm() });
  const text = out.text();
  for (const s of ['麦麦饱饱盘 · 终端版', '非麦当劳官方产品', '编号推荐', '券后 ¥', '转盘揭晓', '虚构示例', '虚构示例不能导入最近主食', '已记住喜欢', '样本模式', '再见']) assert(text.includes(s), s);
  for (const s of ['/buddy', '这一餐就吃', '6/6', '随手掉落']) assert(!text.includes(s), s);
});

test('piped demo run with no location and no budget uses the defaults and radar lists recent eats and drinks', async () => {
  const input = new PassThrough(), out = sink();
  input.end('来份午饭\n/why\n/radar\n/quit\n');
  await runTui({ dataset, input, output: out, env: {}, demo: true, color: false });
  const text = out.text();
  for (const s of ['默认选店区域：深圳市罗湖区黄贝街道黄贝岭地铁站', '默认预算：¥25', '本地模式', '编号推荐', '最近吃了啥 / 喝了啥（虚构示例', '麦当劳雷达', '再见']) assert(text.includes(s), s);
  assert.match(text, /10-09 周五 12:20 +吃：.+ +喝：(?:可乐|无糖可乐)/);
  assert(!text.includes('4/6'));
});

test('missing token fails gracefully with a clear message instead of prompting', async () => {
  const input = new PassThrough(), out = sink();
  input.end('来份午饭\n');
  await runTui({ dataset, input, output: out, env: {}, color: false });
  const text = out.text();
  assert.match(text, /MCD_TOKEN：未设置/);
  assert.match(text, /请先 export MCD_TOKEN/);
  assert.match(text, /还没选门店/);
});

test('a numbered card shows the post-coupon price, and the profile line never names an allergen', async () => {
  const text = await pipe('人均30\n/quit\n', { demo: true, llm: createFakeLlm() });
  assert.match(text, /券后 ¥/);
  assert.match(text, /（省 ¥/);
  const { profileSummary } = await import('../core/memory.mjs');
  const line = profileSummary({ taste: { meats: ['牛肉'], likes: [{ name: '巨无霸' }], less: [] }, hasAllergy: true });
  assert.match(line, /有忌口（详情本地）/);
  assert.match(line, /巨无霸/);
  assert.doesNotMatch(line, /花生|过敏原/);
  assert.equal(learnFeedback(defaultPreferences(), singles[0], 'like', templates.mainProductCodes, '2026-10-13').feedback.at(-1).vote, 'like');
});

test('receipt: the QR is a meal-card URL (delimited UTF-8 in the fragment) that always fits version ≤ 10, with the disclaimers', () => {
  const plan = { ...singles[0], savingFen: 300, couponNames: ['快过期立减券'] };
  const r = receiptFrom(plan, { storeName: '麦当劳深圳黄贝岭地铁站很长很长的名字餐厅', at: new Date(now), report: { request: { people: 1 }, sourceKind: 'official-live-pre-wheel-pricing' } });
  assert.equal(CARD_BASE_URL, 'https://stevelaitvt.github.io/mcd-1024-skill/receipt/');
  const card = cardUrl(r, { note: '少冰' });
  assert(card.url.startsWith(`${CARD_BASE_URL}#`)); assert(utf8(card.url).length <= QR_MAX_BYTES);
  assert(encodeQR(card.url).version <= 10);
  const data = decodeCard(card.url.split('#')[1]);
  assert.equal(data.p, plan.priceFen); assert.equal(data.at, '10-13 12:00'); assert.deepEqual(data, card.data);
  assert(data.t.startsWith([...plan.title].slice(0, 2).join('')), 'title kept (maybe trimmed)');
  // Short picks keep everything; an empty note is omitted.
  const short = cardUrl({ title: '麦辣鸡腿堡', priceFen: 1990, storeName: '麦当劳黄贝岭餐厅', at: '2026-10-13T04:00:00.000Z', parts: [{ name: '麦辣鸡腿堡', quantity: 1 }] });
  assert.deepEqual(short.dropped, []);
  assert.deepEqual(decodeCard(short.url.split('#')[1]), { t: '麦辣鸡腿堡', p: 1990, s: '黄贝岭', at: '10-13 12:00', items: [{ n: '麦辣鸡腿堡', q: 1 }] });
  // Too long: items go first, then the note, then store and title are trimmed — never an oversized QR.
  const long = { title: '超级无敌豪华分享桶双人套餐'.repeat(3), priceFen: 9900, storeName: '麦当劳很长很长很长很长的门店名字餐厅'.repeat(2), at: now,
    parts: Array.from({ length: 6 }, (_, i) => ({ name: `很长的餐品名字${i}`, quantity: 2 })), sample: true };
  const trimmed = cardUrl(long, { note: '多加番茄酱谢谢' });
  assert.deepEqual(trimmed.dropped.slice(0, 2), ['餐品明细', '备注']);
  assert(!('items' in trimmed.data) && !('note' in trimmed.data)); assert.equal(trimmed.data.sp, 1);
  assert(utf8(trimmed.url).length <= QR_MAX_BYTES); assert.equal(encodeQR(trimmed.url).version, 10);
  assert.throws(() => cardUrl(r, { base: `https://example.invalid/${'x'.repeat(220)}` }), /过长/);

  const text = stripAnsi(renderReceipt(r, createPalette(false), { note: '少冰' }).join('\n'));
  for (const s of [QR_LABEL, '卡片链接：https://stevelaitvt.github.io/mcd-1024-skill/receipt/#', '备注：少冰', '非官方产品', '想买就说 就吃这个了', '时间：2026-10-13 12:00', '券已省', '¥3.00', '快过期立减券', plan.title]) assert(text.includes(s), s);
  assert.equal(QR_LABEL, '扫码查看套餐卡片');
  assert(!/(?<!不是)付款码|扫码(?:支付|付款)|支付码/.test(text));
  // Square modules when the terminal is wide enough, half blocks otherwise.
  const qrLines = (columns) => stripAnsi(renderReceipt(r, createPalette(false), { columns }).join('\n')).split('\n').filter((l) => /[█▀▄]/.test(l));
  assert(qrLines(200).every((l) => !/[▀▄]/.test(l))); assert(qrLines(80).some((l) => /[▀▄]/.test(l)));
  assert(!text.includes('随手掉落'));
});

test('the static card page is self-contained: decodes the fragment, shows the disclaimers, and makes no network requests', async () => {
  const html = await readFile(new URL('../static/receipt-card.html', import.meta.url), 'utf8');
  for (const s of ['麦麦饱饱盘 · 选餐卡片', '非官方产品 · 参赛者独立开发 · 只记录这次的选择', '请在麦当劳官方渠道下单', '这张卡片不是订单，也不是付款码', '链接里没有订单数据',
    'https://github.com/SteveLaiTVT/mcd-1024-skill', "default-src 'none'", 'location.hash', 'textContent', 'v1~', 'decodeURIComponent']) assert(html.includes(s), s);
  for (const banned of [/fetch\(/, /XMLHttpRequest/, /sendBeacon/, /innerHTML/, /<img/i, /<link[^>]+stylesheet/i, /analytics|gtag/i, /麦当劳官方(?:网站|页面)|official site/i]) assert(!banned.test(html), String(banned));
  const build = await readFile(new URL('../scripts/build_frontend.mjs', import.meta.url), 'utf8');
  assert(build.includes("'receipt-card.html'") && build.includes("'receipt', 'index.html'"), 'npm run build ships it as receipt/index.html');
});

test('piped demo smoke: a pick, /receipt, /radar, /quit; nothing prints a receipt on its own', async () => {
  const run = async (lines) => {
    const input = new PassThrough(), out = sink();
    input.end(lines);
    await runTui({ dataset, input, output: out, env: {}, demo: true, color: false, random: () => 0 });
    return out.text();
  };
  const receipts = (text) => text.split(QR_LABEL).length - 1;
  const text = await run('/receipt\n人均30\n/receipt\n/radar\n/quit\n');
  assert.match(text, /还没有挑出的套餐/);
  for (const s of ['编号推荐', '理由：', '麦麦饱饱盘 · 选餐小票', '非官方产品', '想买就说 就吃这个了', '麦当劳雷达', '再见']) assert(text.includes(s), s);
  assert.equal(receipts(text), 1, 'only the explicit /receipt prints a card');
  const spins = await run('人均30\n/wheel\n/wheel\n/quit\n');
  assert.equal(receipts(spins), 0, 'the wheel does not drop a receipt');
  assert(!spins.includes('随手掉落'));
});

const pipe = async (lines, options) => {
  const input = new PassThrough(), out = sink();
  input.end(lines);
  await runTui({ input, output: out, color: false, env: {}, dataset, ...options });
  return out.text();
};

test('allergy statements are parsed locally; allergy clauses and allergen names are stripped from agent text', () => {
  assert.deepEqual(parseAllergyStatement('我对花生过敏'), { allergens: ['花生'], rest: '' });
  assert.deepEqual(parseAllergyStatement('我花生过敏').allergens, ['花生']);
  assert.deepEqual(parseAllergyStatement('我对花生和虾过敏，来份午饭'), { allergens: ['花生', '虾'], rest: '来份午饭' });
  assert.deepEqual(parseAllergyStatement('我不过敏，来份午饭').allergens, []);
  assert.equal(parseAllergyStatement('来份午饭'), null);
  assert.equal(stripAllergyText('我对花生过敏，来份午饭，不要花生', ['花生']), '来份午饭，不要');
});

test('allergy memory: add / list / remove persist only to the local profile file, and a broken file is never overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcd-tui-test-')), file = join(dir, 'mcd-tui', 'profile.json');
  assert.equal(defaultProfilePath('/home/someone'), '/home/someone/.config/mcd-tui/profile.json');
  const open = () => new TuiSession({ dataset, env: {}, demo: true, profilePath: file });
  const first = open();
  assert.deepEqual(first.allergies, []);
  assert.deepEqual(first.addAllergies(['花生', '虾']), { added: ['花生', '虾'], existing: [], saved: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, allergies: ['花生', '虾'] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const second = open();
  assert.deepEqual(second.allergies, ['花生', '虾'], 'persists across sessions');
  assert.deepEqual(second.addAllergies(['花生']).added, []);
  assert.deepEqual(second.removeAllergies(['花生']), { removed: ['花生'], saved: true });
  assert.deepEqual(open().allergies, ['虾']);

  writeFileSync(file, 'not json');
  const broken = open();
  assert.match(broken.profileError, /格式无效/);
  assert.equal(broken.addAllergies(['蛋']).saved, false);
  assert.deepEqual(broken.allergies, ['蛋'], 'still applies for this session');
  assert.equal(readFileSync(file, 'utf8'), 'not json');

  const uiFile = join(dir, 'ui', 'profile.json');
  const text = await pipe('/allergy 花生 虾\n/allergy\n我花生过敏\n/allergy-clear 花生\n/allergy-clear 芒果\n/quit\n', { demo: true, profilePath: uiFile });
  for (const s of [`已记录过敏：花生、虾（已保存到本机 ${uiFile}）`, '不会发送给 DeepSeek 或 MCP', '花生 → 关键词：花生、花生酱、花生碎', '已在过敏记录中：花生',
    '已删除过敏记录：花生', '过敏记录里没有：芒果']) assert(text.includes(s), s);
  assert.deepEqual(JSON.parse(readFileSync(uiFile, 'utf8')).allergies, ['虾']);
});

test('allergy screening excludes by visible keywords, flags unknown composition, and says which allergen excluded what', () => {
  const plan = (id, title, parts) => ({ id, title, packages: [], parts: parts.map((name, i) => ({ code: `${id}${i}`, name, quantity: 1 })), mainCodes: [], priceFen: 1000, withinBudget: true });
  const quoted = [plan('a', '麦香鱼套餐', ['麦香鱼', '可乐']), plan('b', '鸡块套餐', ['麦乐鸡', '可乐']), plan('c', '随心配', ['随心配']), plan('d', '神秘套餐', [])];
  const report = { quotedPlans: quoted, candidates: [...quoted], excludedPlans: [], failedPlans: [] };
  assert.equal(applyAllergyFilter({ ...report, candidates: [...quoted] }, []).allergy, null);
  applyAllergyFilter(report, ['鱼']);
  assert.deepEqual(report.candidates.map((p) => p.id), ['b']);
  assert.deepEqual(report.excludedPlans.map((p) => p.reason), ['含过敏原 鱼（鱼），已排除', '成分不明，已排除', '成分不明，已排除']);
  const lines = renderAllergyScreen(report.allergy, createPalette(false));
  assert(lines.includes('· 鱼 → 已排除：麦香鱼套餐（鱼）'), lines.join('\n'));
  assert(lines.includes('· 成分不明，已排除：随心配、神秘套餐'), lines.join('\n'));
  assert(ALLERGEN_KEYWORDS.花生.includes('花生') && ALLERGEN_KEYWORDS.虾.includes('虾'));
});

test('the allergy list never reaches the model prompt or MCP, even when stated in the instruction', async () => {
  const mcp = fakeMcp({ coupons: true });
  const llm = createFakeLlm();
  const session = new TuiSession({ dataset, env, mcpFactory: mcp.factory, llm, random: () => 0.99 });
  const text = await pipe('我对芒果过敏，来份午饭\n/allergy 花生\n不要花生，来份午饭\n/quit\n', { session, autoConnect: false });
  assert.match(text, /已记录过敏：芒果/);
  assert.match(text, /已记录过敏：花生/);
  const sent = JSON.stringify(llm.calls);
  for (const s of ['芒果', '花生']) assert(!sent.includes(s), s);
  assert(!/芒果|花生/.test(JSON.stringify(mcp.calls)));
  assert.match(session.profileLine, /有忌口（详情本地）/);
  assert.doesNotMatch(session.profileLine, /芒果|花生/);
});

test('cheapest wins across à la carte and set meals; a wanted main upgrades to a set only when it is the same price or a little more', () => {
  const names = new Map([['1600', '麦香鱼']]);
  const run = ({ singleFen, setFen, want = true, budgetFen = 3000 }) => {
    const request = { people: 1, budgetPerPersonFen: budgetFen, wantMainCodes: want ? ['1600'] : [] };
    const set = { id: 'set-fish', title: '麦香鱼套餐', wheelKind: '套餐', people: 1, packages: [], mainCodes: ['1600'], basePriceFen: setFen, priceFen: setFen, savingFen: 0, couponNames: [],
      parts: [{ code: '1600', name: '麦香鱼', quantity: 1 }, { code: 'f', name: '薯条', quantity: 1 }, { code: 'd', name: '可乐', quantity: 1 }], withinBudget: setFen <= budgetFen };
    const single = alaCartePlan({ code: '1600', name: '麦香鱼' }, request, { basePriceFen: singleFen, priceFen: singleFen, savingFen: 0, couponNames: [] }, '菜单样本价');
    const report = { request, quotedPlans: [set], candidates: set.withinBudget ? [set] : [], excludedPlans: [], failedPlans: [] };
    applyUpgrades(mergeAlaCarte(report, { plans: [single] }), names);
    return { report, set, single, ids: report.candidates.map((p) => p.id) };
  };
  const plus = run({ singleFen: 2000, setFen: 2300 });
  assert.deepEqual(plus.ids, ['set-fish']);
  assert.equal(upgradeText(plus.set.upgrade), '单点麦香鱼 ¥20.00，+¥3.00 可得套餐（含薯条+可乐）');
  assert(plus.report.excludedPlans.some((p) => p.reason === '你点名的主食：套餐只多 ¥3.00，推荐套餐'));
  const same = run({ singleFen: 2000, setFen: 2000, want: false });
  assert.deepEqual(same.ids, ['set-fish']); assert.equal(upgradeText(same.set.upgrade), '单点麦香鱼 ¥20.00，同价可得套餐（含薯条+可乐）');
  const cheaper = run({ singleFen: 2000, setFen: 2300, want: false });
  assert.deepEqual(cheaper.ids, ['alacarte-1600', 'set-fish'], 'à la carte strictly cheaper stays first; sets are never forced');
  assert.match(upgradeText(cheaper.set.upgrade), /；单点更省$/);
  const far = run({ singleFen: 2000, setFen: 2800 });
  assert.equal(far.ids[0], 'alacarte-1600'); assert.match(upgradeText(far.set.upgrade), /超过升级线（\+¥5\.00），单点更省/);
  const over = run({ singleFen: 2000, setFen: 3100 });
  assert.deepEqual(over.ids, ['alacarte-1600'], 'a set over budget is never recommended'); assert.equal(over.set.upgrade, undefined);

  const P = createPalette(false), withCoupon = { ...plus.single, basePriceFen: 2000, priceFen: 1800, savingFen: 200, couponNames: ['立减券'] };
  const lines = renderPick(withCoupon, P, { report: plus.report }).join('\n');
  assert.match(lines, /比无券基准少 ¥2\.00/); assert.match(lines, /省了 ¥2\.00/);
});

test('activities: MCP participation only via a claimable coupon, everything else info-only with rules, dates and the official path', () => {
  const nowMs = Date.parse('2026-10-13T12:00:00+08:00');
  const calendar = { dailyList: [
    { date: '2026-10-13', events: [{ activityTitle: '免费脆薯饼', eventType: 2, activitySubTitle: '每日限量' }, { activityTitle: '联动打卡', eventType: 4, articleDto: { content: '<p>到店打卡赢周边</p>' } }] },
    { date: '2026-10-15', events: [{ activityTitle: '免费脆薯饼', eventType: 2, activitySubTitle: '每日限量' }] }] };
  const rows = classifyActivities(activitiesFromCalendar(calendar, nowMs), { offers: [{ name: '免费脆薯饼', canClaim: true }], now: nowMs });
  assert.deepEqual(rows.map((r) => [r.name, r.participation.mode, r.status]), [['免费脆薯饼', 'mcp', 'ongoing'], ['联动打卡', 'info', 'ongoing']]);
  assert.deepEqual(rows[0].dates, ['2026-10-13', '2026-10-15']);
  assert.match(rows[0].participation.how, /免费脆薯饼.*\/claim.*yes/);
  assert(rows[1].participation.how.includes(OFFICIAL_PATH)); assert.deepEqual(rows[1].rules, ['到店打卡赢周边']);
  const text = renderActivities({ rows, sample: false, offersComplete: true }, createPalette(false)).join('\n');
  assert(text.includes(NO_REGISTER_NOTE));
  assert.match(text, /\[可通过 MCP 参与（领券）\] 免费脆薯饼 · 优惠券 · 2026-10-13 至 2026-10-15/);
  assert.match(text, /\[仅展示\] 联动打卡/);
  assert(!/已报名|报名成功|已为你报名|已自动领取/.test(text));
});

test('/coupons lists claimable coupons before held ones; /activity and “有什么活动” stay read-only', async () => {
  const mcp = fakeMcp({ coupons: true }), session = new TuiSession({ dataset, env, mcpFactory: mcp.factory });
  await session.connect(); session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const text = await pipe('/coupons\n/activity\n/quit\n', { session, autoConnect: false });
  const claimable = text.indexOf('写着 9.9 元的券'), held = text.indexOf('快过期立减券');
  assert(claimable > 0 && held > claimable, text);
  assert.match(text, /可领券 1 张/); assert.match(text, /有效期：接口未返回/);
  assert.match(text, /麦当劳 MCP 没有“报名/);
  const names = mcp.calls.map((c) => c.name);
  assert(names.includes('campaign-calendar') && !names.includes('auto-bind-coupons') && !names.includes('create-order'));
});

test('/help lists every command the shell handles', async () => {
  const text = await pipe('/help\n/quit\n', { demo: true });
  for (const [, cmd] of COMMAND_HELP) assert(text.includes(cmd), cmd);
  for (const c of ['/receipt', '/allergy', '/allergy-clear', '/activity', '/coupons', '/claim', '/radar', '/use', '/status', '/quit']) assert(text.includes(c), c);
});

test('piped demo smoke: a pick, /receipt, /radar, /coupons, /activity, /quit', async () => {
  const text = await pipe('人均30\n/why\n/receipt\n/radar\n/coupons\n/activity\n/quit\n', { dataset: { ...dataset, menu }, demo: true, random: () => 0.99, llm: createFakeLlm() });
  for (const s of ['编号推荐', '券后 ¥', '麦麦饱饱盘 · 选餐小票', '麦当劳雷达', '可领券', '仅展示', '麦当劳 MCP 没有“报名', '再见']) assert(text.includes(s), s);
  assert(!text.includes('这一餐就吃') && !text.includes('/buddy'));
});

test('/cart is an optional local list: add, rm by index, clear; it is never an order', async () => {
  assert.equal(defaultOrdersPath('/home/someone'), '/home/someone/.config/mcd-tui/orders.json');
  const text = await pipe([
    '/cart', '人均30', '/cart add', '/cart', '/cart rm 9',
    '/cart clear', 'no', '/cart clear', 'yes', '/cart', '/quit', ''].join('\n'), { demo: true, llm: createFakeLlm() });
  for (const s of [EMPTY_CART, '已放入购物车', CART_NOTE, '共 1 单', '用法：/cart [add|rm 序号|clear]', '已取消，没清空', '已清空购物车（1 单）', '（只在本次会话内存）']) assert(text.includes(s), s);
  for (const banned of ['/commit', '/push', '/graph', 'Everything up-to-date', '购物车没有变化', 'HEAD -> main', '未 push']) assert(!text.includes(banned), banned);
  assert(!/付款码|支付成功|下单成功|已下单/.test(text.replaceAll('不是付款码', '')));
});

test('cart persistence: one local orders.json (600), /cart rm returns an order to unpushed, a corrupt file is never overwritten, --no-profile stays in memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcd-tui-orders-')), file = join(dir, 'mcd-tui', 'orders.json');
  const pick = (s) => { s.recordPick({ ...singles[0], priceFen: 2050 }); return s; };
  const open = () => new TuiSession({ dataset, env: {}, demo: true, ordersPath: file, now: () => new Date(now) });
  const first = pick(open());
  const a = first.commitOrder('一').commit, b = first.commitOrder('二').commit;
  assert(/^[0-9a-f]{7}$/.test(a.hash) && a.hash !== b.hash && b.parent === a.hash);
  assert.deepEqual(first.pushOrders().pushed.map((c) => c.hash), [a.hash, b.hash]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.schemaVersion, 1); assert.deepEqual(saved.commits.map((c) => [c.hash, Boolean(c.pushedAt)]), [[a.hash, true], [b.hash, true]]);
  assert(!/花生|过敏|allerg/i.test(readFileSync(file, 'utf8')), 'no allergy data in the orders file');

  const second = open();
  assert.equal(second.cartRemove(b.hash.slice(0, 5)).removed.hash, b.hash);
  assert.throws(() => second.cartRemove(b.hash), /不在购物车/);
  assert.deepEqual(loadOrders(file).state.commits.map((c) => Boolean(c.pushedAt)), [true, false], 'rm keeps history, back to unpushed');
  assert.throws(() => second.cartClear(), /明确确认/);
  assert.equal(second.cartClear({ confirmed: true }).removed.length, 1);

  const corrupt = '{"schemaVersion":1,"commits":[{"hash":"nothex!"}]}';
  writeFileSync(file, corrupt);
  const broken = pick(open());
  assert.match(broken.ordersError, /格式无效/); assert.equal(broken.orders.commits.length, 0);
  assert.equal(broken.commitOrder('x').saved, false); assert.equal(broken.pushOrders().saved, false);
  assert.equal(readFileSync(file, 'utf8'), corrupt, 'never overwritten');
  const shown = await pipe('/cart\n/quit\n', { demo: true, ordersPath: file });
  assert.match(shown, /本地订单记录文件格式无效，不会覆盖该文件/);

  const memory = pick(new TuiSession({ dataset, env: {}, demo: true }));
  assert.equal(memory.commitOrder('').saved, false); assert.equal(memory.ordersPath, null);
});

test('/radar is the history heatmap only; a meal spider chart is gone', async () => {
  const piped = await pipe('/radar\n人均30\n/radar\n/quit\n', { demo: true, random: () => 0.99 });
  assert(piped.includes('麦当劳雷达'));
  assert(piped.includes('虚构示例'));
  assert(piped.includes('最近吃了啥'));
  for (const s of ['本餐雷达图', '价格友好度', '口味新鲜度', '偏好匹配']) assert(!piped.includes(s), s);
});

// The interactive palette is tested in tui-ink.test.mjs (Ink renderer + a real PTY); piped input gets the list.
test('/ and /partial in piped input print the matching commands with descriptions and keywords, without hanging', async () => {
  const text = await pipe('/\n/ca\n/zzz\n/quit\n', { demo: true });
  for (const s of ['全部命令：', '以 /ca 开头的命令：', '/cart [add|rm 序号|clear]', '可选的本地暂存', '购物车 清单', '未知命令 /zzz', '再见']) assert(text.includes(s), s);
  assert(!text.includes('/commit') && !text.includes('/buddy') && !text.includes('/weather'));
  assert.equal(text.split('/connect').length - 1, 1, "only '/' alone lists /connect");
});
