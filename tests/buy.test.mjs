// Natural-language buy flow ('就吃这个了') and payment status against a MOCKED MCP client only.
// Nothing here reaches mcp.mcd.cn and no real order is ever created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { TuiSession } from '../tui/session.mjs';
import { runTui } from '../tui/app.mjs';
import { stripAnsi, createPalette } from '../tui/ansi.mjs';
import { MCPError } from '../web/mcp-client.mjs';
import { encodeQR, renderQR, qrWidth, QR_MAX_BYTES } from '../tui/qr.mjs';
import { cartOf, loadOrders } from '../tui/orders.mjs';
import { COMMAND_HELP, HELP_COMMANDS, helpLines } from '../tui/render.mjs';
import { parseBuyIntent } from '../tui/intent.mjs';
import { createOrderArgs, renderPayment, isPaymentReply, isStoreConfirm, orderStatus, couponLine, claimFailures, baseItems, chooseTakeWay,
  BUY_NO_PICK, BUY_DEMO, BUY_NO_CONTEXT, BUY_CANCELLED, PICKUP_ONLY, PAY_HINT, PAY_FOLLOWUP, PAY_QR_LABEL, QR_TOO_LONG, NO_PENDING, NO_PLACED } from '../tui/buy.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns, packages] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns', 'packages'].map(json));
const dataset = { templates, plans, offers, campaigns };
const details = Object.fromEntries(packages.packages.map((p) => [p.productCode, { code: p.productCode, name: p.name, rounds: p.rounds }]));
const env = { MCD_TOKEN: 'test-only-mcd-token-0001' };
const now = '2026-10-13T12:00:00+08:00';
const couponPkg = templates.recipes.find((r) => r.people === 1 && r.portion === 7).ingredients[0].productCode;
// HELD is in the wallet from the start (the pick is priced with it: ¥22); NEW appears only after
// auto-bind-coupons and makes the same meal ¥20.
const HELD = { id: 'COUPON-ID-1', enable: 1, code: 'COUPON-CODE-1', tradeStartDate: '2026-10-01', tradeEndDate: '2026-10-14', title: '立减券' };
const NEW = { id: 'COUPON-ID-NEW', enable: 1, code: 'COUPON-CODE-NEW', tradeStartDate: '2026-10-01', tradeEndDate: '2026-10-20', title: '新领立减券' };
const storeCoupon = (c) => ({ couponId: c.id, couponCode: c.code, title: c.title, products: [{ productCode: couponPkg, productName: '套餐' }] });
const TAKE_WAYS = [{ code: 'TW-EAT', title: '堂食', subtitle: '' }, { code: 'TW-OUT', title: '外带', subtitle: '' }];
const LINK = 'https://m.mcd.cn/pay/cashier?payId=PAY-123&orderId=ORDER-123&sign=0a1b2c3d';
const WRITES = ['auto-bind-coupons', 'create-order', 'mall-create-order', 'party-order-create', 'cancel-order'];

// The fixed mock. `state.claimable`: one coupon to claim; `state.claimed` flips on auto-bind-coupons;
// `state.noCoupons`: calculate-price ignores coupons (re-pricing comes back higher); `state.status`: query-order.
function fakeMcp({ claim = async () => ({ data: { successCount: 1, failedCount: 0, successCoupons: [{ couponId: NEW.id, couponName: NEW.title }] } }),
  createOrder = async () => ({ data: { orderId: 'ORDER-123', payH5Url: LINK, payId: 'PAY-123', orderDetail: { realTotalAmount: '20.00' } } }), state = {} } = {}) {
  const calls = [];
  Object.assign(state, { claimable: false, claimed: false, noCoupons: false, status: '1', ...state });
  const factory = () => ({ initialize: async () => {}, close() {},
    async claimAll() { calls.push({ name: 'auto-bind-coupons' }); const r = await claim(); state.claimed = true; return r; },
    async createOrder(args) { calls.push({ name: 'create-order', args: structuredClone(args) }); return createOrder(args); },
    async call(name, args = {}) {
      calls.push({ name, args });
      const held = state.claimed ? [HELD, NEW] : [HELD];
      if (name === 'now-time-info') return { data: { datetime: now } };
      if (name === 'available-coupons') return { data: state.claimable ? [{ couponName: NEW.title, couponStatus: state.claimed ? 'GOT' : 'CAN_GET', label: '可领取' }] : [] };
      if (name === 'query-my-coupons') return { data: { currentPage: Number(args.page), totalPages: 1, totalCount: held.length, coupons: held } };
      if (name === 'query-store-coupons') return { data: held.map(storeCoupon) };
      if (name === 'campaign-calendar') return { data: { dailyList: [] } };
      if (name === 'query-meals') return { data: { meals: Object.fromEntries(Object.keys(details).map((c) => [c, {}])) } };
      if (name === 'query-meal-detail') return { data: details[args.code] };
      if (name === 'calculate-price') {
        const ids = state.noCoupons ? [] : args.items.map((i) => i.couponId).filter(Boolean);
        return { data: { price: ids.includes(NEW.id) ? 2000 : ids.includes(HELD.id) ? 2200 : 2500, takeWayList: TAKE_WAYS }, datetime: now };
      }
      if (name === 'query-order') return { data: { orderId: args.orderId, orderStatus: state.status, pickupCode: state.status === '2' ? 'A123' : '', realTotalAmount: '20.00', expirePayTime: '2026-10-13 12:15:00' } };
      throw new Error(`Unexpected tool ${name}`);
    } });
  return { calls, factory, state };
}
function sink() { const chunks = []; return { columns: 100, isTTY: false, write(s) { chunks.push(s); return true; }, text: () => stripAnsi(chunks.join('')) }; }
const drive = async (session, lines) => {
  const input = new PassThrough(), out = sink();
  input.end(`${lines.join('\n')}\n`);
  await runTui({ input, output: out, color: false, env: {}, dataset, session, autoConnect: false });
  return out.text();
};
const pipe = async (lines, options) => {
  const input = new PassThrough(), out = sink();
  input.end(`${lines.join('\n')}\n`);
  await runTui({ input, output: out, color: false, env: {}, dataset, ...options });
  return out.text();
};
const tmpOrders = () => join(mkdtempSync(join(tmpdir(), 'mcd-tui-buy-')), 'orders.json');
const writes = (mcp) => mcp.calls.filter((c) => WRITES.includes(c.name));
const names = (mcp) => mcp.calls.map((c) => c.name);

// A live (mocked) pick priced with the held coupon (¥22). `inCart`: it was also /commit + /push'ed.
async function livePick({ ordersPath = null, mcp = fakeMcp(), inCart = false } = {}) {
  const session = new TuiSession({ dataset, env, mcpFactory: mcp.factory, now: () => new Date(now), ordersPath });
  await session.connect();
  session.selectStore({ storeCode: 'S1', storeName: '测试餐厅' }, '深圳');
  const report = await session.quote();
  // The coupon-priced candidate: ¥22.00 with the held coupon applied (the report carries
  // coupon NAMES, never the private couponId/couponCode — those come from the re-price).
  const plan = report.candidates.find((p) => p.priceFen === 2200);
  assert(plan, 'a coupon-priced candidate');
  assert.equal(plan.priceFen, 2200);
  session.recordPick(plan);
  let commit = null;
  if (inCart) { commit = session.commitOrder('午饭').commit; session.pushOrders(); }
  return { session, mcp, plan, commit };
}

test('the pick carries the create-order inputs from its official quote: store, items with combo rounds, takeWayCode — the coupon itself comes from the re-price', async () => {
  const { session, plan } = await livePick();
  const ctx = session.lastReceipt.buy;
  assert.equal(ctx.storeCode, 'S1');
  assert.equal(ctx.takeWayCode, 'TW-EAT', 'from calculate-price data.takeWayList[].code');
  assert.deepEqual(ctx.takeWays.map((t) => t.code), ['TW-EAT', 'TW-OUT']);
  assert.deepEqual(ctx.items, plan.orderItems);
  // The report never carries the private couponId/couponCode (privacy); the buy flow
  // re-prices (quoteBest directly) and the fresh quote supplies the coupon for create-order.
  assert(ctx.items.every((i) => i.couponId === undefined && i.couponCode === undefined), 'no private coupon identifiers in the report');
  assert(ctx.items.some((i) => i.productCode === couponPkg && i.quantity === 1), 'the priced item');
  assert.equal(plan.couponNames[0], '立减券', 'the applied coupon is shown by name');
});

test('就吃这个了 → coupons listed → 是这家店吗 → 是: claims first, re-prices down, creates ONE pickup order, shows the link and a QR of exactly it; 支付完成 → query-order', async () => {
  const file = tmpOrders(), mcp = fakeMcp({ state: { claimable: true } });
  const { session, commit } = await livePick({ ordersPath: file, mcp, inCart: true });
  const before = mcp.calls.length;
  mcp.state.status = '2';
  const text = await drive(session, ['就吃这个了', '是', '支付完成', '/order', '/quit']);

  for (const s of ['这单能用的券：立减券（已用在报价里）、新领立减券（待领取），领完再下单', '是这家店吗？测试餐厅（是/不是）', '取餐方式：堂食',
    '最终合计 ¥20.00（比刚才 ¥22.00 少 ¥2.00）', '用券：新领立减券', '订单号：ORDER-123', `支付链接：${LINK}`, PAY_HINT, PAY_FOLLOWUP,
    '状态：配餐中（已支付）', '取餐码：A123', `已移出购物车：${commit.hash}`]) assert(text.includes(s), s);

  // Coupons are claimed before the order, and exactly one order is created.
  const flow = names(mcp).slice(before);
  assert.deepEqual(writes(mcp).map((c) => c.name), ['auto-bind-coupons', 'create-order']);
  assert(flow.indexOf('auto-bind-coupons') < flow.indexOf('calculate-price'), 're-priced after claiming');
  assert(flow.lastIndexOf('calculate-price') < flow.indexOf('create-order'), 'create-order last');
  const [, created] = writes(mcp);
  assert.deepEqual(Object.keys(created.args).sort(), ['beType', 'items', 'orderType', 'storeCode', 'takeWayCode']);
  assert.equal(created.args.orderType, 1); assert.equal(created.args.beType, 1); assert.equal(created.args.storeCode, 'S1'); assert.equal(created.args.takeWayCode, 'TW-EAT');
  assert(created.args.items.some((i) => i.productCode === couponPkg && i.couponId === NEW.id && i.couponCode === NEW.code), 'the better, just-claimed coupon');
  assert(created.args.items.every((i) => i.productCode && i.quantity > 0));

  // The QR printed is exactly the encoding of the returned link.
  const qr = encodeQR(LINK), square = qrWidth(qr, { square: true }) <= 100;
  for (const line of renderQR(qr, { square })) assert(text.includes(line), 'QR row of the payment link');
  assert(text.includes(PAY_QR_LABEL));

  // Recorded as a real order; the cart copy of this pick leaves the cart.
  assert.equal(cartOf(session.orders).length, 0);
  assert.equal(session.orders.commits.find((c) => c.hash === commit.hash).orderId, 'ORDER-123');
  const [placed] = session.orders.placed;
  assert.equal(placed.payUrl, LINK); assert.equal(placed.priceFen, 2000); assert.deepEqual(placed.hashes, [commit.hash]);
  assert.equal(placed.status, '配餐中（已支付）', 'updated from query-order');
  assert.deepEqual(mcp.calls.filter((c) => c.name === 'query-order').map((c) => c.args), [{ orderId: 'ORDER-123' }]);
  assert.match(text, /ORDER-123 .*配餐中（已支付）/, '/order lists it');
  const saved = loadOrders(file).state;
  assert.equal(saved.placed[0].payUrl, LINK); assert.equal(saved.placed[0].orderId, 'ORDER-123');
  assert(!JSON.stringify(saved).includes(env.MCD_TOKEN) && !text.includes(env.MCD_TOKEN));
});

test('right after buying the order is 待支付 (cart untouched when the pick was not in it); 支付失败 and /order <id> query it', async () => {
  const { session, mcp } = await livePick();
  const text = await drive(session, ['就这个', '对', '/order', '支付失败', '/order ORDER-123', '/quit']);
  assert(text.includes('已创建麦当劳订单（待支付）'));
  assert(text.includes('这单能用的券：立减券（已用在报价里）；没有要领的券，直接下单'));
  assert.equal(writes(mcp).filter((c) => c.name === 'auto-bind-coupons').length, 0, 'nothing to claim, nothing claimed');
  assert.match(text, /ORDER-123 .*待支付/);
  assert(text.includes('状态：待支付') && text.includes('支付截止：2026-10-13 12:15:00'));
  assert.equal(mcp.calls.filter((c) => c.name === 'query-order').length, 2);
  assert.equal(session.pendingOrder().orderId, 'ORDER-123');
  assert.deepEqual(session.orders.placed[0].hashes, []);
});

test('the store question is the only gate: 不是 (or anything but 是) cancels with nothing claimed or ordered', async () => {
  for (const answer of ['不是', '换一家', 'no', '好吃吗']) {
    const mcp = fakeMcp({ state: { claimable: true } });
    const { session, commit } = await livePick({ mcp, inCart: true });
    const text = await drive(session, ['就吃这个了', answer, '/quit']);
    assert(text.includes('是这家店吗？测试餐厅（是/不是）'), answer);
    assert(text.includes(BUY_CANCELLED), answer);
    assert.equal(writes(mcp).length, 0, `${answer}: no claim, no order`);
    assert.deepEqual(cartOf(session.orders).map((c) => c.hash), [commit.hash]);
    assert.equal(session.orders.placed.length, 0);
  }
  // Session level: every write step refuses without the confirmation.
  const { session, mcp } = await livePick({ mcp: fakeMcp({ state: { claimable: true } }) });
  const preview = await session.buyPreview();
  for (const step of [() => session.buyClaim(preview), () => session.buyReprice(preview), () => session.buyPlace(preview, { takeWay: { code: 'TW-EAT' }, items: [] }),
    () => session.buyClaim(preview, { confirmed: 'yes' })]) await assert.rejects(step, /确认门店/);
  assert.equal(writes(mcp).length, 0);
});

test('a coupon that fails to claim aborts before create-order and names the coupon; the cart is unchanged', async () => {
  const mcp = fakeMcp({ state: { claimable: true }, claim: async () => ({ data: { successCount: 0, failedCount: 1, failedCoupons: [{ couponId: NEW.id, couponName: NEW.title, reason: '已领完' }] } }) });
  const { session, commit } = await livePick({ mcp, inCart: true });
  const text = await drive(session, ['就吃这个了', '是', '/quit']);
  assert(text.includes('这些券没领到：新领立减券。没下单。') && text.includes('购物车没有变化'));
  assert.deepEqual(writes(mcp).map((c) => c.name), ['auto-bind-coupons']);
  assert.deepEqual(cartOf(session.orders).map((c) => c.hash), [commit.hash]);
  assert.equal(session.orders.placed.length, 0);

  const ambiguous = fakeMcp({ state: { claimable: true }, claim: async () => { throw new MCPError('领券结果未确认。请先刷新券包，避免重复领取。', { ambiguous: true }); } });
  const second = await livePick({ mcp: ambiguous });
  const out = await drive(second.session, ['就吃这个了', '是', '/quit']);
  assert(out.includes('领券结果未确认'));
  assert.equal(writes(ambiguous).filter((c) => c.name === 'create-order').length, 0);

  const silent = fakeMcp({ state: { claimable: true }, claim: async () => ({ data: {} }) });
  const third = await livePick({ mcp: silent });
  assert((await drive(third.session, ['就吃这个了', '是', '/quit'])).includes('官方没有返回领取数量'));
  assert.equal(writes(silent).filter((c) => c.name === 'create-order').length, 0);
});

test('re-pricing that comes back higher (or fails) aborts: the total never goes up, no order', async () => {
  const mcp = fakeMcp();
  const { session } = await livePick({ mcp });
  mcp.state.noCoupons = true;
  const text = await drive(session, ['就吃这个了', '是', '/quit']);
  assert(text.includes('重新核价是 ¥25.00，比刚才的 ¥22.00 贵，没下单'));
  assert.equal(writes(mcp).length, 0);
  assert.equal(session.orders.placed.length, 0);
});

test('create-order failure: the error is shown plainly and the cart is unchanged; no order ID → no QR', async () => {
  const mcp = fakeMcp({ createOrder: async () => { throw new MCPError('麦当劳未创建订单：门店已打烊'); } });
  const { session, commit } = await livePick({ mcp, inCart: true });
  const text = await drive(session, ['就吃这个了', '是', '/cart', '/quit']);
  assert(text.includes('麦当劳未创建订单：门店已打烊') && text.includes('购物车没有变化'));
  assert.equal(writes(mcp).length, 1);
  assert.deepEqual(cartOf(session.orders).map((c) => c.hash), [commit.hash]);
  assert.equal(session.orders.placed.length, 0); assert(!session.orders.commits[0].orderId);
  assert(!text.includes('支付链接：') && !text.includes(PAY_QR_LABEL));

  const noId = fakeMcp({ createOrder: async () => ({ data: { payH5Url: LINK } }) });
  const second = await livePick({ mcp: noId, inCart: true });
  const out = await drive(second.session, ['就吃这个了', '是', '/quit']);
  assert(out.includes('没有订单号') && !out.includes(PAY_QR_LABEL) && !out.includes(`支付链接：${LINK}`));
  assert.equal(cartOf(second.session.orders).length, 1);
});

test('a pick without create-order inputs is refused instead of guessed; no pick → 先选一餐; delivery is out of scope', async () => {
  const { session, mcp, plan } = await livePick();
  session.recordPick({ ...plan, orderItems: undefined });
  const before = mcp.calls.length;
  const text = await drive(session, ['就吃这个了', '就吃这个了，外送', '/quit']);
  assert(text.includes(BUY_NO_CONTEXT) && text.includes(PICKUP_ONLY));
  assert.equal(mcp.calls.length, before, 'no coupon check, no pricing, no order');

  const fresh = new TuiSession({ dataset, env, mcpFactory: fakeMcp().factory, now: () => new Date(now) });
  assert((await drive(fresh, ['就吃这个了', '/quit'])).includes(BUY_NO_PICK));
});

test('piped demo: a pick, 就吃这个了 shows coupons + store question then refuses; /order, 支付完成, /help; /checkout no longer exists', async () => {
  const text = await pipe(['就吃这个了', '1人 7分饱 人均30', '就吃这个了', '/order', '支付完成', '/checkout', '/help', '/quit'], { demo: true, random: () => 0.99 });
  for (const s of [BUY_NO_PICK, '就吃这个 · 到店自取（演示）', '这单能用的券：', '是这家店吗？', BUY_DEMO, '没有调用 create-order', NO_PLACED, NO_PENDING,
    '/order [订单号]', '说 就吃这个了 直接下单', '未知命令 /checkout', '再见']) assert(text.includes(s), s);
  for (const s of ['支付链接：', PAY_QR_LABEL, '订单号：', '已创建麦当劳订单']) assert(!text.includes(s), s);
  assert(!HELP_COMMANDS.has('checkout') && HELP_COMMANDS.has('order'));
  assert(!helpLines(createPalette(false)).join('\n').includes('checkout'));
  assert(COMMAND_HELP.some(([n]) => n.includes('order')));

  const demo = new TuiSession({ dataset, env: {}, demo: true });
  const preview = { receipt: {}, context: {}, claimable: [] };
  for (const step of [() => demo.buyClaim(preview, { confirmed: true }), () => demo.buyReprice(preview, { confirmed: true }), () => demo.buyPlace(preview, {}, { confirmed: true })]) {
    await assert.rejects(step, new RegExp(BUY_DEMO));
  }
});

test('a payment link too long for a v10-M QR is shown whole as text, with no QR', async () => {
  const long = `https://m.mcd.cn/pay/cashier?token=${'a'.repeat(QR_MAX_BYTES)}`;
  const { session } = await livePick({ mcp: fakeMcp({ createOrder: async () => ({ data: { orderId: 'ORDER-9', payH5Url: long } }) }) });
  const text = await drive(session, ['就吃这个了', '是', '/quit']);
  assert(text.includes(`支付链接：${long}`), 'never truncated');
  assert(text.includes(QR_TOO_LONG) && !text.includes(PAY_QR_LABEL));
  assert.equal(session.orders.placed[0].payUrl, long);
});

test('buy helpers: intent phrases, store answers, coupon line, claim failures, create-order args, payment rendering and replies', () => {
  for (const s of ['就吃这个了', '就这个', '要这个', '就要这个', '买这个', '下单', '就它了', '定这个', '就吃这个', '那就吃这个吧', '就这个了！', '我要这个', '帮我下单', '就吃这个了，下单'])
    assert.deepEqual(parseBuyIntent(s), { delivery: false, takeWay: null }, s);
  for (const s of ['这个好吃', '这个好吃吗', '不要这个', '1人 7分饱', '有什么活动', '吃什么好', '我要外卖', '']) assert.equal(parseBuyIntent(s), null, s);
  assert.deepEqual(parseBuyIntent('就吃这个了，打包'), { delivery: false, takeWay: '外带' });
  assert.deepEqual(parseBuyIntent('就这个 堂食'), { delivery: false, takeWay: '堂食' });
  assert.deepEqual(parseBuyIntent('就吃这个了，外送'), { delivery: true, takeWay: null });

  for (const s of ['是', '对', '就是这家', 'yes', 'YES', '是的']) assert(isStoreConfirm(s), s);
  for (const s of ['不是', '换一家', 'no', '', null, '是吗', '是不是']) assert(!isStoreConfirm(s), String(s));

  assert.equal(couponLine(['A'], [{ name: 'B' }]), '这单能用的券：A（已用在报价里）、B（待领取），领完再下单');
  assert.equal(couponLine([], []), '这单能用的券：没有，直接下单');
  assert.deepEqual(claimFailures({ successCount: 2, failedCount: 0 }), []);
  assert.deepEqual(claimFailures({ failedCount: 2 }), ['2 张券']);

  const items = [{ productCode: 'P1', quantity: 1, couponId: 'C1', couponCode: 'CC1', roundList: [{ round: '1', comboItemList: [{ code: 'X', quantity: 1, modification: { values: [{ code: 'M', key: 'K-sel', quantity: 1 }] } }] }] }];
  assert.deepEqual(baseItems(items), [{ productCode: 'P1', quantity: 1, roundList: items[0].roundList }], 'modification kept, coupon dropped for re-pricing');
  assert.deepEqual(createOrderArgs({ storeCode: 'S1', takeWayCode: 'T', items }), { storeCode: 'S1', orderType: 1, beType: 1, takeWayCode: 'T', items });
  assert.deepEqual(createOrderArgs({ storeCode: 'S1', takeWayCode: 'T', items, remark: '少冰', tableware: false }), { storeCode: 'S1', orderType: 1, beType: 1, takeWayCode: 'T', items, remark: '少冰', needTableware: false });
  const ways = [{ code: 'A', title: '堂食' }, { code: 'B', title: '外带' }];
  assert.equal(chooseTakeWay(ways, { title: '外带' }).code, 'B'); assert.equal(chooseTakeWay(ways, { code: 'B' }).code, 'B'); assert.equal(chooseTakeWay(ways).code, 'A'); assert.equal(chooseTakeWay([]), null);

  const P = createPalette(false), order = { orderId: 'O1', storeName: '店', priceFen: 100, takeWay: '堂食' };
  const none = renderPayment({ ...order, payUrl: '' }, P).join('\n');
  assert.match(none, /没有返回支付链接/); assert(!none.includes(PAY_QR_LABEL));
  const odd = renderPayment({ ...order, payUrl: 'javascript:alert(1)' }, P).join('\n');
  assert.match(odd, /格式异常/); assert(!odd.includes('javascript:') && !odd.includes(PAY_QR_LABEL));

  for (const s of ['支付完成', '支付失败', '支付完成。', '我已支付']) assert(isPaymentReply(s), s);
  for (const s of ['支付完成了吗怎么查', '帮我支付', '1人 7分饱']) assert(!isPaymentReply(s), s);
  assert.equal(orderStatus({ orderStatus: '7' }).label, '已取消'); assert.equal(orderStatus({}).reported, false);
});
