// Receipt-style (小票) summary of the latest pick. The QR encodes a link to the static
// meal-card page (see card.mjs): scanning it shows a card with the meal, price, store and
// time. It is not a payment code and nothing here creates an order or a payment.
import { encodeQR, renderQR, qrWidth } from './qr.mjs';
import { money, padEnd, textWidth } from './ansi.mjs';
import { cardUrl, chinaTime, shortStore } from './card.mjs';

export { chinaTime, shortStore };
export const RECEIPT_ODDS = 1 / 3;
export const QR_LABEL = '扫码查看套餐卡片';
export const CARD_NOTE = '卡片是 GitHub Pages 上的静态页，数据只在链接 # 之后，不上传；不是付款码。';
export const shouldPrintReceipt = (random = Math.random) => random() < RECEIPT_ODDS;
export const RECEIPT_WIDTH = 40;
const WIDTH = RECEIPT_WIDTH;

// Snapshot taken at pick time so /receipt, /commit and /radar still work after the quote expires.
// Besides the receipt fields it keeps the inputs the radar chart needs: requested portion, budget
// and wanted mains, the pick's mains and portion, and its price rank among this round's candidates.
export function receiptFrom(plan, { storeName, at, report }) {
  const request = report?.request || {}, candidates = report?.candidates || [];
  const cheaper = candidates.filter((p) => Number.isSafeInteger(p.priceFen) && p.priceFen < plan.priceFen).length;
  return { title: plan.title, parts: (plan.parts || []).map((p) => ({ name: p.name, quantity: p.quantity })), priceFen: plan.priceFen,
    savingFen: plan.savingFen > 0 ? plan.savingFen : 0, couponNames: [...(plan.couponNames || [])], storeName: storeName || '未选门店',
    at: new Date(at).toISOString(), people: request.people || plan.people || 1, sample: report?.sourceKind === 'demo-snapshot',
    mainCodes: [...(plan.mainCodes || [])], portion: Number.isSafeInteger(plan.portion) ? plan.portion : null,
    request: { portion: request.portion ?? null, budgetPerPersonFen: request.budgetPerPersonFen ?? null, wantMainCodes: [...(request.wantMainCodes || [])] },
    priceRank: candidates.length ? { cheaper, of: candidates.length } : null };
}

// QR lines plus a label, centred over `width` (the card width). A QR wider than the card is
// not clamped: it is drawn at its own width with the label centred over it. Square modules
// (2 columns × 1 line each) when the terminal has room for them, otherwise half blocks.
export function qrBlock(payload, { color, columns = 80, width = WIDTH, label }) {
  const qr = encodeQR(payload), square = qrWidth(qr, { square: true }) <= columns;
  const lines = renderQR(qr, { color, square }), own = qrWidth(qr, { square });
  const center = (s, w) => `${' '.repeat(Math.max(0, Math.floor((w - textWidth(s)) / 2)))}${s}`;
  const pad = ' '.repeat(Math.max(0, Math.floor((width - own) / 2)));
  return [...lines.map((l) => `${pad}${l}`), center(label, Math.max(width, own))];
}

// `note`: the commit note when this pick has been committed, otherwise ''.
export function renderReceipt(r, P, { color = P.enabled, columns, note = '' } = {}) {
  const rule = '-'.repeat(WIDTH), dotted = '- '.repeat(WIDTH / 2).trimEnd();
  const center = (s) => `${' '.repeat(Math.max(0, Math.floor((WIDTH - textWidth(s)) / 2)))}${s}`;
  const row = (left, right) => `${padEnd(left, WIDTH - textWidth(right))}${right}`;
  const card = cardUrl(r, { note });
  return [dotted, center(P.bold('麦麦饱饱盘 · 选餐小票')), center(P.gray('非官方产品 · 只记录这次的选择')),
    `门店：${r.storeName}`, `时间：${chinaTime(r.at)}`, rule, P.bold(r.title),
    ...r.parts.map((p) => row(`  ${p.name}`, `×${p.quantity}`)), rule,
    row(`整单（${r.sample ? '历史样本价' : '官方核价'}）`, P.bold(money(r.priceFen))),
    ...(r.people > 1 ? [row(`人均约（${r.people} 人）`, money(Math.ceil(r.priceFen / r.people)))] : []),
    ...(r.savingFen > 0 ? [row('券已省', money(r.savingFen)), P.gray(`  用券：${r.couponNames.join('、')}`)] : [row('券已省', '—')]),
    ...(note ? [`备注：${note}`] : []),
    rule, ...qrBlock(card.url, { color, columns, label: P.bold(QR_LABEL) }),
    P.gray(`卡片链接：${card.url}`),
    ...(card.dropped.length ? [P.gray(`（二维码容量有限，卡片省略了：${card.dropped.join('、')}）`)] : []),
    P.gray(CARD_NOTE), rule,
    '参赛者独立开发 · 非官方产品 · 这张小票不是订单，也不是付款码',
    P.bold('想买就说 就吃这个了，下单后扫码或在麦当劳 App 付款'), dotted];
}

export function printReceipt(ui, receipt, { auto = false, note = '' } = {}) {
  ui.write('');
  if (auto) ui.write(ui.palette.gray('（随手掉落一张小票，大约三次一张；/receipt 随时查看最近一份）'));
  renderReceipt(receipt, ui.palette, { columns: ui.columns?.(), note }).forEach((line) => ui.write(line));
}

// About one in three picks; `session.random` is injectable so tests stay deterministic.
export function maybeReceipt(ui, session) {
  if (session.lastReceipt && shouldPrintReceipt(session.random)) printReceipt(ui, session.lastReceipt, { auto: true });
}
