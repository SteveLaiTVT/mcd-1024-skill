// Local order commits and a shopping cart, as a git metaphor over picks:
// /commit records the current pick, /push adds every unpushed commit to the cart
// (the cart is the "remote": origin/main is the newest commit in it), /cart views or
// edits it, /graph shows the history. LOCAL ONLY: the cart is a list on this machine,
// never a real McDonald's order. Nothing here talks to a server, places an order or
// takes a payment, and there is no payment QR. Commits and cart live in
// ~/.config/mcd-tui/orders.json, which is local-only and git-ignored.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateJson } from './allergy.mjs';
import { money } from './ansi.mjs';
import { chinaTime } from './card.mjs';

export const CART_NOTE = '购物车只是本地清单，不是真实订单。请在麦当劳官方 App / 小程序按此清单下单支付。';
export const EMPTY_GRAPH = '还没有订单提交，用 /commit -m ... 创建';
export const EMPTY_CART = '购物车是空的，用 /commit 再 /push 加入';
export const NO_PICK = '先选一餐，再 /commit';
export const COMMIT_USAGE = '用法：/commit -m "备注"';
export const CART_USAGE = '用法：/cart · /cart rm <hash> · /cart clear';
export const NOTE_MAX = 40;
export const defaultOrdersPath = (home = homedir()) => join(home, '.config', 'mcd-tui', 'orders.json');

const HASH = /^[0-9a-f]{7}$/;
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
export const emptyOrders = () => ({ commits: [] });

// '-m "备注"' / "-m '备注'" / '-m “备注”' / '-m 备注' / '' → { note } or { error }.
export function parseCommitNote(rest = '') {
  const s = String(rest).trim();
  if (!s) return { note: '' };
  const m = /^-m(?:\s+|(?=["'“]))(?:"([^"]*)"|'([^']*)'|“([^”]*)”|(.+))$/s.exec(s);
  if (!m) return { error: COMMIT_USAGE };
  const note = clean(m[1] ?? m[2] ?? m[3] ?? m[4]);
  if ([...note].length > NOTE_MAX) return { error: `备注最多 ${NOTE_MAX} 个字。` };
  return { note };
}

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
// The cart holds exactly the pushed commits; origin/main is the newest of them.
export const cartOf = (state) => state.commits.filter((c) => c.pushedAt);
export const unpushed = (state) => state.commits.filter((c) => !c.pushedAt);
export const originOf = (state) => cartOf(state).at(-1) || null;
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
  && Array.isArray(c.parts) && validTime(c.pickedAt) && validTime(c.committedAt) && (c.pushedAt === undefined || validTime(c.pushedAt));
const normalizeCommit = (c) => ({ hash: c.hash, parent: HASH.test(c.parent) ? c.parent : null, title: clean(c.title),
  parts: c.parts.filter((p) => p && typeof p.name === 'string').map((p) => ({ name: clean(p.name), quantity: Number.isSafeInteger(p.quantity) ? p.quantity : 1 })),
  priceFen: c.priceFen, savingFen: Number.isSafeInteger(c.savingFen) && c.savingFen > 0 ? c.savingFen : 0,
  couponNames: (Array.isArray(c.couponNames) ? c.couponNames : []).filter((n) => typeof n === 'string').map(clean), storeName: clean(c.storeName) || '未选门店',
  pickedAt: c.pickedAt, people: Number.isSafeInteger(c.people) && c.people > 0 ? c.people : 1, sample: c.sample === true, note: clean(c.note), committedAt: c.committedAt,
  ...(c.pushedAt ? { pushedAt: c.pushedAt } : {}) });

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
    return { state: { commits: data.commits.map(normalizeCommit) }, error: null };
  } catch { return { state: emptyOrders(), error: '本地订单记录文件格式无效' }; }
}

export function saveOrders(file, state) {
  writePrivateJson(file, { schemaVersion: 1, commits: state.commits });
}

export const commitSubject = (c) => [`${c.title} ${money(c.priceFen)}${c.sample ? '(样本价)' : ''}`, c.note, chinaTime(c.pickedAt).slice(5)].filter(Boolean).join(' · ');

// `git log --graph --oneline` over the local commits, newest first.
export function renderGraph(state, P) {
  if (!state.commits.length) return [P.gray(EMPTY_GRAPH)];
  const head = headOf(state), origin = originOf(state), pending = unpushed(state), lines = [];
  for (const c of [...state.commits].reverse()) {
    const refs = [c === head ? `${P.cyan('HEAD -> ')}${P.green('main')}` : '', c === origin ? P.red('origin/main') : ''].filter(Boolean);
    const decoration = refs.length ? `${P.yellow('(')}${refs.join(P.yellow(', '))}${P.yellow(')')} ` : '';
    lines.push(`${P.brand('*')} ${P.yellow(c.hash)} ${decoration}${commitSubject(c)}${c.pushedAt ? '' : P.yellow(' (未 push)')}`);
  }
  lines.push('', pending.length ? P.yellow(`${pending.length} 个提交未 push；/push 加入购物车`) : P.green('全部提交都已在购物车（origin/main 与 HEAD 同步）'),
    P.gray(`购物车 ${cartOf(state).length} 单 · /cart 查看 · 只存本机，不下单、不付款`));
  return lines;
}

export const commitLine = (c, P) => `${P.yellow(c.hash)}  ${P.bold(c.title)}  ${money(c.priceFen)}${c.sample ? P.gray('(样本价)') : ''}${c.note ? `  ${P.cyan(`备注：${c.note}`)}` : ''}`;

// /cart and /push summary: every order with hash / title / price / note / time, total and count.
export function renderCart(state, P) {
  const cart = cartOf(state);
  if (!cart.length) return [P.gray(EMPTY_CART), '', P.yellow(CART_NOTE)];
  const lines = [];
  cart.forEach((c, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${commitLine(c, P)}`);
    lines.push(P.gray(`    ${c.parts.map((p) => `${p.name}×${p.quantity}`).join('、')} · ${c.storeName} · 选餐 ${chinaTime(c.pickedAt).slice(5)}`));
  });
  const sample = cart.some((c) => c.sample);
  lines.push('', `${P.bold(`共 ${cart.length} 单`)} · 合计 ${P.bold(money(cartTotal(cart)))}${sample ? P.gray('（含历史样本价，实际以官方为准）') : ''}`,
    P.gray('/cart rm <hash> 移出一单（回到未 push，历史保留）· /cart clear 清空（需输入 yes）'), '', P.bold(P.yellow(CART_NOTE)));
  return lines;
}
