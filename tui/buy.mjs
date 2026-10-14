// Natural-language buy flow: after a pick, '就吃这个了' turns the CURRENT pick into ONE McDonald's
// pickup order (orderType=1) via MCP create-order. Before buying it lists the coupons to claim; the
// only confirmation is '是这家店吗？', which covers claiming those coupons AND creating the order.
// create-order returns a payment link; MCP has no payment tool and never takes payment: the user
// pays by scanning the QR of that exact link or in the McDonald's App. Nothing here invents,
// shortens or rewrites a payment link, and there is no QR without one. Pure helpers; session.mjs
// does the calls.
import { utf8, QR_MAX_BYTES } from './qr.mjs';
import { qrBlock } from './receipt.mjs';
import { money } from './ansi.mjs';
import { chinaTime } from './card.mjs';

export const BUY_NO_PICK = '先选一餐，再说买';
export const BUY_DEMO = '演示模式不下真实订单';
export const BUY_NO_CONTEXT = '这份缺少下单所需信息，请重新选一餐';
export const BUY_CANCELLED = '已取消，没下单';
export const BUY_CONFIRM_NEEDED = '下单需要先确认门店（回复 是）。';
export const PICKUP_ONLY = '现在只支持到店自取（orderType=1）；外送需要配送地址（addressId），暂不支持。';
export const COUPONS_HEAD = '这单能用的券：';
export const PAY_HINT = '扫码或打开麦当劳 App 完成支付';
export const PAY_FOLLOWUP = '支付完成后回复 支付完成，我帮你查订单状态';
export const QR_TOO_LONG = '链接太长，二维码放不下，请直接打开链接或在 App 内支付';
export const PAY_QR_LABEL = '支付二维码（内容就是上面的支付链接）';
export const NO_PENDING = '没有待支付的订单';
export const NO_PLACED = '还没有真实订单；选好一餐后说 就吃这个了 下单';
export const PENDING = '待支付';
export const storeQuestion = (storeName) => `是这家店吗？${storeName}（是/不是）`;
// create-order / query-order orderStatus codes (tool catalog).
export const ORDER_STATUS = Object.freeze({ 1: PENDING, 2: '配餐中（已支付）', 4: '配送中', 6: '已完成', 7: '已取消', 8: '已评价', 10: '配餐中（餐厅已确认）' });

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const ITEM_KEYS = ['productCode', 'quantity', 'couponId', 'couponCode', 'modification', 'roundList'];
const pick = (v, keys) => Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));

// The store question: 是/对/就是这家/yes confirm. Anything else (不是/换一家/no, or no answer) cancels.
export const isStoreConfirm = (text) => /^(?:是|是的|对|对的|没错|就是这家|是这家|就这家|yes|y)[。.!！]*$/i.test(String(text ?? '').trim());
// '支付完成' / '支付失败' as the create-order tool asks the user to reply.
export const isPaymentReply = (text) => /^(?:我)?(?:已经?)?(支付完成|支付失败|付好了|已支付|支付成功)[。.!！~～]*$/.test(String(text ?? '').trim());

// create-order inputs carried by a live pick, from its official quote: the exact priced items
// (roundList + modification from query-meal-detail, couponId/couponCode when a coupon won), the
// store, and the pickup options from calculate-price's data.takeWayList. Sample picks have none.
export function buyContext(plan, report) {
  if (!plan || report?.sourceKind === 'demo-snapshot') return null;
  const storeCode = report?.context?.storeCode, items = plan.orderItems, takeWays = plan.takeWays;
  if (typeof storeCode !== 'string' || !storeCode || !Array.isArray(items) || !items.length || !Array.isArray(takeWays) || !takeWays.length) return null;
  return normalizeBuyContext({ storeCode, takeWayCode: takeWays[0].code, takeWays, items });
}
export function validBuyContext(x) {
  return Boolean(x && typeof x === 'object' && typeof x.storeCode === 'string' && x.storeCode && typeof x.takeWayCode === 'string' && x.takeWayCode
    && Array.isArray(x.items) && x.items.length && x.items.every((i) => i && typeof i.productCode === 'string' && i.productCode && positive(i.quantity)
      && (i.couponId === undefined || typeof i.couponId === 'string') && (i.couponCode === undefined || typeof i.couponCode === 'string')));
}
export function normalizeBuyContext(x) {
  if (!validBuyContext(x)) return null;
  return { storeCode: x.storeCode, takeWayCode: x.takeWayCode,
    takeWays: (Array.isArray(x.takeWays) ? x.takeWays : []).filter((t) => t && typeof t.code === 'string' && t.code).map((t) => ({ code: t.code, title: clean(t.title) })),
    items: structuredClone(x.items.map((i) => pick(i, ITEM_KEYS))) };
}
// The priced items without their coupons: the base cart re-priced (with the refreshed coupons) before ordering.
export const baseItems = (items) => items.map(({ couponId, couponCode, ...rest }) => structuredClone(rest));
// The take-away option the user named ('堂食' / '外带'), else the one the pick was priced with, else the first.
export function chooseTakeWay(takeWays, { title = null, code = null } = {}) {
  return (title && takeWays.find((t) => t.title.includes(title))) || takeWays.find((t) => t.code === code) || takeWays[0] || null;
}

// Pickup only: orderType=1, beType=1 (到店自取), never beCode; remark / needTableware only when the user gave them.
export function createOrderArgs({ storeCode, takeWayCode, items, remark = null, tableware = null }) {
  return { storeCode, orderType: 1, beType: 1, takeWayCode, items: structuredClone(items),
    ...(remark ? { remark } : {}), ...(typeof tableware === 'boolean' ? { needTableware: tableware } : {}) };
}

// auto-bind-coupons data → names of the coupons that failed ([] when all succeeded). A failure count without names still counts.
export function claimFailures(data) {
  const names = (Array.isArray(data?.failedCoupons) ? data.failedCoupons : []).map((c) => clean(c?.couponName || c?.couponId)).filter(Boolean);
  const count = Number.isSafeInteger(data?.failedCount) && data.failedCount > 0 ? data.failedCount : 0;
  return names.length ? names : count ? [`${count} 张券`] : [];
}

// '23.50' (yuan, as create-order / query-order return amounts) → 2350; anything else → null.
export const yuanFen = (v) => /^\d+(?:\.\d{1,2})?$/.test(String(v ?? '').trim()) ? Math.round(Number(String(v).trim()) * 100) : null;
const idOf = (v) => (typeof v === 'string' && v.trim()) || (Number.isSafeInteger(v) && v > 0) ? String(v).trim() : '';

// create-order data → the fields we keep. The payment link is kept exactly as returned.
export function orderResult(data) {
  return { orderId: clean(idOf(data?.orderId) || idOf(data?.orderDetail?.orderId)), payUrl: typeof data?.payH5Url === 'string' ? data.payH5Url : '',
    payId: clean(idOf(data?.payId)), paidFen: yuanFen(data?.orderDetail?.realTotalAmount) };
}

// query-order data → { code, label, pickupCode, expirePayTime, paidFen }.
export function orderStatus(data) {
  const code = clean(data?.orderStatus), text = clean(data?.status);
  return { code, reported: Boolean(code || text), label: ORDER_STATUS[code] || text || (code ? `状态码 ${code}` : '接口未返回订单状态'),
    pickupCode: clean(data?.pickupCode), expirePayTime: clean(data?.expirePayTime), paidFen: yuanFen(data?.realTotalAmount) };
}

// A link we can show and encode as-is: http(s), no whitespace or control characters.
export const safeLink = (url) => typeof url === 'string' && /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/.test(url);
export const qrFits = (url) => utf8(url).length <= QR_MAX_BYTES;

// '这单能用的券：…，领完再下单' — the coupon the pricing already used, then exactly what will be claimed.
export function couponLine(used = [], claimable = []) {
  const list = [...used.map((n) => `${n}（已用在报价里）`), ...claimable.map((c) => `${c.name}（待领取）`)];
  if (!list.length) return `${COUPONS_HEAD}没有，直接下单`;
  return `${COUPONS_HEAD}${list.join('、')}${claimable.length ? '，领完再下单' : '；没有要领的券，直接下单'}`;
}

// What the store question confirms: the pick, the coupons, the store.
export function renderBuySummary(preview, P) {
  const r = preview.receipt;
  const lines = [`${P.bold(r.title)}  ${money(r.priceFen)}${r.sample ? P.gray('(样本价)') : ''}`,
    P.gray(`  ${r.parts.map((p) => `${p.name}×${p.quantity}`).join('、')}`),
    `方式：${P.bold('到店自取')}${preview.takeWay ? ` · 取餐方式：${preview.takeWay.title || preview.takeWay.code}` : ''}`,
    '', couponLine(preview.used, preview.claimable)];
  if (preview.claimable.length) lines.push(P.gray('  官方接口一次领取全部可领券（上面列的就是会领的），不能单选。'));
  if (!preview.demo) lines.push(P.gray('  确认后：领券 → 重新核价（只会持平或更便宜，变贵就不下单）→ 在麦当劳创建订单并给支付链接；本工具不经手付款。'));
  lines.push('', P.bold(storeQuestion(preview.storeName)));
  return lines;
}

// Payment block after create-order succeeded: order ID, the link as text, a QR of exactly that link.
export function renderPayment(order, P, { color = P.enabled, columns } = {}) {
  const lines = [`${P.green('✓')} ${P.bold('已创建麦当劳订单（待支付）')}`, `订单号：${order.orderId}`, `门店：${order.storeName} · 到店自取${order.takeWay ? ` · ${order.takeWay}` : ''}`];
  if (order.priceFen != null) lines.push(`应付：${P.bold(money(order.priceFen))}`);
  if (!order.payUrl) lines.push(P.yellow('官方这次没有返回支付链接：请打开麦当劳 App 的订单列表完成支付。'));
  else if (!safeLink(order.payUrl)) lines.push(P.yellow('官方返回的支付链接格式异常，不显示也不生成二维码：请打开麦当劳 App 的订单列表完成支付。'));
  else {
    lines.push(`支付链接：${order.payUrl}`);
    if (qrFits(order.payUrl)) lines.push('', ...qrBlock(order.payUrl, { color, columns, label: P.gray(PAY_QR_LABEL) }));
    else lines.push(P.yellow(QR_TOO_LONG));
  }
  lines.push('', P.bold(PAY_HINT), P.gray('麦当劳 MCP 只创建订单、返回支付链接，不经手付款。'), P.cyan(PAY_FOLLOWUP));
  return lines;
}

// /order: recent real orders, newest first.
export function renderPlaced(placed, P, { limit = 10 } = {}) {
  if (!placed.length) return [P.gray(NO_PLACED)];
  const lines = [...placed].reverse().slice(0, limit).map((o) => `${P.yellow(o.orderId)}  ${P.bold(o.title)}  ${o.priceFen != null ? money(o.priceFen) : '金额待确认'}  ${o.status === PENDING ? P.yellow(o.status) : P.green(o.status)}  ${P.gray(chinaTime(o.createdAt).slice(5))}`);
  if (placed.length > limit) lines.push(P.gray(`……更早的 ${placed.length - limit} 单省略`));
  lines.push('', P.gray('/order <订单号> 向麦当劳查询实时状态（query-order，只读）'));
  return lines;
}

export function renderOrderStatus(orderId, s, P) {
  return [`订单号：${orderId}`, `状态：${P.bold(s.label)}`, ...(s.paidFen != null ? [`实付：${money(s.paidFen)}`] : []),
    ...(s.pickupCode ? [`取餐码：${P.bold(s.pickupCode)}`] : []), ...(s.code === '1' && s.expirePayTime ? [P.yellow(`支付截止：${s.expirePayTime}`)] : [])];
}
