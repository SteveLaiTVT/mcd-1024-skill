// Local order commits and a shopping cart over picks: /cart add records the current
// pick, /cart views or edits it. The cart is a list on this machine, never an order by
// itself: real orders come from the buy flow on the CURRENT pick ('就吃这个了', buy.mjs). Nothing
// here talks to a server or takes a payment. A cart commit of a pick that was then bought gets
// the real `orderId` (it leaves the cart); `placed` lists the real orders with their payment link
// and status. Everything lives in ~/.config/mcd-tui/orders.json (local, git-ignored).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateJson } from './allergy.mjs';
import { money } from './ansi.mjs';
import { chinaTime } from './card.mjs';

export const CART_NOTE = '购物车只是本地暂存，不是订单；要下单请选好一餐后说 就吃这个了。';
export const EMPTY_GRAPH = '还没有暂存记录。';
export const EMPTY_CART = '购物车是空的。选好一餐后 /cart add 放进来（可选，不下单）。';
export const NO_PICK = '先选一餐，再 /cart add';
export const CART_USAGE = '用法：/cart [add|rm 序号|clear]';
export const defaultOrdersPath = (home = homedir()) => join(home, '.config', 'mcd-tui', 'orders.json');

const HASH = /^[0-9a-f]{7}$/;
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
export const emptyOrders = () => ({ commits: [], placed: [] });

// Git-style short hash (sha256 of the pick, note, parent and commit time); re-salted on the rare collision.
export function createCommit(snapshot, { note = '', at, parent = null, taken = new Set() }) {
  const record = { title: snapshot.title, parts: snapshot.parts.map((p) => ({ name: p.name, quantity: p.quantity })), priceFen: snapshot.priceFen,
    savingFen: snapshot.savingFen || 0, couponNames: [...(snapshot.couponNames || [])], storeName: snapshot.storeName, pickedAt: snapshot.at,
    people: snapshot.people || 1, sample: Boolean(snapshot.sample), note: clean(note) };
  const committedAt = new Date(at).toISOString();
  let hash;
  for (let salt = 0; !hash || taken.has(hash); salt++) {
    hash = createHash('sha256').update(JSON.stringify({ ...record, parent, committedAt, salt })).digest('hex').slice(0, 7);
  }
  return { hash, parent, ...record, committedAt };
}

export const headOf = (state) => state.commits.at(-1) || null;
// The cart holds the pushed commits not bought yet; origin/main is the newest pushed commit.
export const cartOf = (state) => state.commits.filter((c) => c.pushedAt && !c.orderId);
export const unpushed = (state) => state.commits.filter((c) => !c.pushedAt && !c.orderId);
export const originOf = (state) => state.commits.filter((c) => c.pushedAt).at(-1) || null;
export const cartTotal = (cart) => cart.reduce((sum, c) => sum + c.priceFen, 0);
// Full hash or a unique prefix (≥ 4 characters), like git.
export function findCommit(state, ref) {
  const r = String(ref || '').toLowerCase();
  if (!/^[0-9a-f]{4,7}$/.test(r)) return null;
  const hits = state.commits.filter((c) => c.hash.startsWith(r));
  return hits.length === 1 ? hits[0] : null;
}

const validTime = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));
const validCommit = (c) => c && HASH.test(c.hash) && typeof c.title === 'string' && Number.isSafeInteger(c.priceFen) && typeof c.note === 'string'
  && Array.isArray(c.parts) && validTime(c.pickedAt) && validTime(c.committedAt) && (c.pushedAt === undefined || validTime(c.pushedAt))
  && (c.orderId === undefined || (typeof c.orderId === 'string' && c.orderId.length > 0));
// Older files have no `placed`.
const validPlaced = (o) => o && typeof o.orderId === 'string' && o.orderId && typeof o.title === 'string' && typeof o.status === 'string' && validTime(o.createdAt)
  && typeof o.payUrl === 'string' && Array.isArray(o.hashes) && (o.priceFen === null || Number.isSafeInteger(o.priceFen));
const normalizePlaced = (o) => ({ orderId: clean(o.orderId), payUrl: o.payUrl, payId: clean(o.payId), title: clean(o.title), storeName: clean(o.storeName), storeCode: clean(o.storeCode),
  takeWay: clean(o.takeWay), priceFen: o.priceFen, hashes: o.hashes.filter((h) => HASH.test(h)), status: clean(o.status), statusCode: clean(o.statusCode), createdAt: o.createdAt,
  ...(validTime(o.checkedAt) ? { checkedAt: o.checkedAt } : {}) });
const normalizeCommit = (c) => ({ hash: c.hash, parent: HASH.test(c.parent) ? c.parent : null, title: clean(c.title),
  parts: c.parts.filter((p) => p && typeof p.name === 'string').map((p) => ({ name: clean(p.name), quantity: Number.isSafeInteger(p.quantity) ? p.quantity : 1 })),
  priceFen: c.priceFen, savingFen: Number.isSafeInteger(c.savingFen) && c.savingFen > 0 ? c.savingFen : 0,
  couponNames: (Array.isArray(c.couponNames) ? c.couponNames : []).filter((n) => typeof n === 'string').map(clean), storeName: clean(c.storeName) || '未选门店',
  pickedAt: c.pickedAt, people: Number.isSafeInteger(c.people) && c.people > 0 ? c.people : 1, sample: c.sample === true, note: clean(c.note), committedAt: c.committedAt,
  ...(c.pushedAt ? { pushedAt: c.pushedAt } : {}), ...(c.orderId ? { orderId: clean(c.orderId) } : {}) });

// { state, error }. A file that cannot be read or parsed yields an empty state plus an error;
// the caller must then never write the file (the user fixes or removes it first).
export function loadOrders(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) { return { state: emptyOrders(), error: e.code === 'ENOENT' ? null : '本地订单记录文件无法读取' }; }
  try {
    const data = JSON.parse(raw);
    if (data?.schemaVersion !== 1 || !Array.isArray(data.commits) || !data.commits.every(validCommit)) throw new Error('shape');
    if (new Set(data.commits.map((c) => c.hash)).size !== data.commits.length) throw new Error('duplicate hash');
    if (data.placed !== undefined && (!Array.isArray(data.placed) || !data.placed.every(validPlaced))) throw new Error('placed');
    return { state: { commits: data.commits.map(normalizeCommit), placed: (data.placed || []).map(normalizePlaced) }, error: null };
  } catch { return { state: emptyOrders(), error: '本地订单记录文件格式无效' }; }
}

export function saveOrders(file, state) {
  writePrivateJson(file, { schemaVersion: 1, commits: state.commits, placed: state.placed || [] });
}

// /cart and /push summary: every order with hash / title / price / note / time, total and count.
export function renderCart(state, P) {
  const cart = cartOf(state);
  if (!cart.length) return [P.gray(EMPTY_CART), '', P.yellow(CART_NOTE)];
  const lines = [];
  cart.forEach((c, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${P.bold(c.title)}  ${money(c.priceFen)}${c.sample ? P.gray('(样本价)') : ''}${c.note ? `  ${P.cyan(`备注：${c.note}`)}` : ''}`);
    lines.push(P.gray(`    ${c.parts.map((p) => `${p.name}×${p.quantity}`).join('、')} · ${c.storeName} · 选餐 ${chinaTime(c.pickedAt).slice(5)}`));
  });
  const sample = cart.some((c) => c.sample);
  lines.push('', `${P.bold(`共 ${cart.length} 单`)} · 合计 ${P.bold(money(cartTotal(cart)))}${sample ? P.gray('（含历史样本价，实际以官方为准）') : ''}`,
    P.gray('/cart rm 序号 移出一单 · /cart clear 清空（需输入 yes）'), '', P.bold(P.yellow(CART_NOTE)));
  return lines;
}
