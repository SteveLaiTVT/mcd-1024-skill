// Receipt-style (小票) summary of the latest pick. The QR encodes the receipt text
// only (meal + price + store + time). It is not a payment code and nothing here
// creates an order or a payment.
import { encodeQR, renderQR, utf8, QR_MAX_BYTES } from './qr.mjs';
import { money, padEnd, textWidth } from './ansi.mjs';

export const RECEIPT_ODDS = 1 / 3;
export const QR_LABEL = '扫码查看小票内容（不是付款码）';
export const shouldPrintReceipt = (random = Math.random) => random() < RECEIPT_ODDS;
const WIDTH = 40;
const chinaTime = (iso) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const shortStore = (name) => String(name || '').replace(/^麦当劳/, '').replace(/(?:餐厅|店)$/, '') || '门店';

// Snapshot taken at pick time so /receipt still works after the quote expires.
export function receiptFrom(plan, { storeName, at, report }) {
  return { title: plan.title, parts: (plan.parts || []).map((p) => ({ name: p.name, quantity: p.quantity })), priceFen: plan.priceFen,
    savingFen: plan.savingFen > 0 ? plan.savingFen : 0, couponNames: [...(plan.couponNames || [])], storeName: storeName || '未选门店',
    at: new Date(at).toISOString(), people: report?.request?.people || plan.people || 1, sample: report?.sourceKind === 'demo-snapshot' };
}

// Short UTF-8 text that fits a version ≤ 4 QR at level M; store, then title, are trimmed to fit.
export function receiptPayload(r) {
  const price = `${money(r.priceFen)}${r.sample ? '(样本价)' : ''}`, time = chinaTime(r.at).slice(5);
  const title = [...r.title], store = [...shortStore(r.storeName)];
  const build = () => [title.join(''), price, store.join(''), time].filter(Boolean).join('\n');
  while (utf8(build()).length > QR_MAX_BYTES) {
    if (store.length > 6) store.pop(); else if (title.length > 8) title.pop(); else if (store.length > 3) store.pop();
    else if (title.length > 4) title.pop(); else if (store.length) store.pop(); else if (title.length) title.pop(); else break;
  }
  return build();
}

export function renderReceipt(r, P, { color = P.enabled } = {}) {
  const rule = '-'.repeat(WIDTH), dotted = '- '.repeat(WIDTH / 2).trimEnd();
  const center = (s) => `${' '.repeat(Math.max(0, Math.floor((WIDTH - textWidth(s)) / 2)))}${s}`;
  const row = (left, right) => `${padEnd(left, WIDTH - textWidth(right))}${right}`;
  const payload = receiptPayload(r), qr = encodeQR(payload);
  const lines = [dotted, center(P.bold('麦麦饱饱盘 · 选餐小票')), center(P.gray('非官方产品 · 只记录这次的选择')),
    `门店：${r.storeName}`, `时间：${chinaTime(r.at)}`, rule, P.bold(r.title),
    ...r.parts.map((p) => row(`  ${p.name}`, `×${p.quantity}`)), rule,
    row(`整单（${r.sample ? '历史样本价' : '官方核价'}）`, P.bold(money(r.priceFen))),
    ...(r.people > 1 ? [row(`人均约（${r.people} 人）`, money(Math.ceil(r.priceFen / r.people)))] : []),
    ...(r.savingFen > 0 ? [row('券已省', money(r.savingFen)), P.gray(`  用券：${r.couponNames.join('、')}`)] : [row('券已省', '—')]),
    rule, ...renderQR(qr, { color }).map(center), center(P.bold(QR_LABEL)),
    P.gray(`二维码内容：${payload.replaceAll('\n', ' / ')}`), rule,
    '参赛者独立开发 · 非官方产品 · 本工具不下单、不付款',
    P.bold('请在麦当劳官方渠道下单'), dotted];
  return lines;
}

export function printReceipt(ui, receipt, { auto = false } = {}) {
  ui.write('');
  if (auto) ui.write(ui.palette.gray('（随手掉落一张小票，大约三次一张；/receipt 随时查看最近一份）'));
  renderReceipt(receipt, ui.palette).forEach((line) => ui.write(line));
}

// About one in three picks; `session.random` is injectable so tests stay deterministic.
export function maybeReceipt(ui, session) {
  if (session.lastReceipt && shouldPrintReceipt(session.random)) printReceipt(ui, session.lastReceipt, { auto: true });
}
