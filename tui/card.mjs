// Meal-card link for the receipt QR: CARD_BASE_URL + '#' + delimited UTF-8 data.
// Format: v1~title~priceFen~store~time~sp~items~note
// items = name*qty,name*qty (empty = no items, '-' = items dropped for size).
// The '~', ',', '*', '\', '%' inside a field value are percent-encoded, so a literal
// '~' / ',' / '*' in the fragment is always a structural separator and a plain
// split is safe. Delimited (not base64url JSON): base64 inflates Chinese ~4/3,
// which pushed a normal pick over the v10 cap and forced the item list to be
// dropped. Raw UTF-8 keeps a normal pick (~185 bytes) inside v10. The browser
// percent-encodes the fragment on open; the card page splits first, then
// decodeURIComponent()s each field. '#' fragment is never sent to a server.
// The card records a pick only: it is not an order, not a payment code, and carries
// no allergy data.
import { utf8, QR_MAX_BYTES } from './qr.mjs';

// GitHub Pages must be enabled for this repository (workflow .github/workflows/github-pages.yml)
// or the QR link will not open. Change this one constant if the site moves.
export const CARD_BASE_URL = 'https://stevelaitvt.github.io/mcd-1024-skill/receipt/';

export const chinaTime = (iso) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
export const shortStore = (name) => String(name || '').replace(/^麦当劳/, '').replace(/(?:餐厅|店)$/, '') || '门店';

// Short keys keep the link small: t title, p price (fen), s store, at 'MM-DD HH:mm',
// items [{ n name, q quantity }], note, sp 1 when the price is the historical sample.
// An empty note is omitted rather than sent as ''.
export function cardData(r, { note = '' } = {}) {
  return { t: r.title, p: r.priceFen, s: shortStore(r.storeName), at: chinaTime(r.at).slice(5),
    items: (r.parts || []).map((p) => ({ n: p.name, q: p.quantity })), ...(note ? { note } : {}), ...(r.sample ? { sp: 1 } : {}) };
}

// Percent-encode the five characters that would collide with the structural
// separators or with percent-decoding itself. '%' goes first so the '%' in
// '%7E' etc. is not re-encoded. Chinese text stays raw UTF-8 (no size blow-up).
const escField = (s) => String(s ?? '').replace(/%/g, '%25').replace(/~/g, '%7E').replace(/,/g, '%2C').replace(/\*/g, '%2A').replace(/\\/g, '%5C');
// A field that fails to decode is used raw (a hand-made link), never dropped.
const decField = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function encodeCard(data) {
  const items = data.items === undefined ? '-' : (data.items || []).map((it) => `${escField(it.n)}*${Number.isSafeInteger(it.q) && it.q > 0 ? it.q : 1}`).join(',');
  return ['v1', escField(data.t), data.p ?? 0, escField(data.s), escField(data.at), data.sp === 1 ? '1' : '0', items, escField(data.note ?? '')].join('~');
}

export function decodeCard(fragment) {
  const parts = String(fragment ?? '').replace(/^#/, '').split('~');
  if (parts.length !== 8 || parts[0] !== 'v1') return null;
  const t = decField(parts[1]), s = decField(parts[3]), at = decField(parts[4]), note = decField(parts[7]);
  const p = Number(parts[2]);
  if (!t || !Number.isSafeInteger(p) || p < 0) return null;
  const itemsStr = parts[6];
  let items;
  if (itemsStr === '-') items = undefined;
  else if (!itemsStr) items = [];
  else {
    items = [];
    for (const item of itemsStr.split(',')) {
      const star = item.lastIndexOf('*');
      const name = decField(star < 0 ? item : item.slice(0, star));
      if (!name) return null;
      const q = star < 0 ? 1 : Number(item.slice(star + 1));
      items.push({ n: name, q: Number.isSafeInteger(q) && q > 0 ? q : 1 });
    }
  }
  return { t, p, s, at, ...(items === undefined ? {} : { items }), ...(note ? { note } : {}), ...(parts[5] === '1' ? { sp: 1 } : {}) };
}

// { url, data, dropped } where url always fits a version ≤ 10 level-M QR. When it would not,
// fields go in this order: the item list (the card then shows title / price / store / time),
// the note, then the store and finally the title are trimmed a character at a time.
export function cardUrl(r, { note = '', base = CARD_BASE_URL, max = QR_MAX_BYTES } = {}) {
  const data = cardData(r, { note }), dropped = [];
  const build = () => `${base}#${encodeCard(data)}`, fits = () => utf8(build()).length <= max;
  if (!fits()) { delete data.items; dropped.push('餐品明细'); }
  if (!fits() && data.note) { delete data.note; dropped.push('备注'); }
  for (const key of ['s', 't']) {
    if (fits()) break;
    const chars = [...data[key]];
    while (!fits() && chars.length) { chars.pop(); data[key] = chars.length ? `${chars.join('')}…` : ''; }
    dropped.push(key === 's' ? '门店名（截短）' : '套餐名（截短）');
  }
  if (!fits()) throw new Error(`卡片链接过长：CARD_BASE_URL 本身已超过二维码容量 ${max} 字节。`);
  return { url: build(), data, dropped };
}
