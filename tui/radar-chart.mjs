// /radar spider chart for the current pick. Four axes, each normalised to 0..1 and
// computed only from data the session really has: the pick snapshot (price, budget,
// coupon saving), the order history read by /radar, and the user's own
// /like · /less feedback and "想吃" mains. No nutrition or health data is used or
// invented; an axis without data is shown as "无数据" and drawn at 0.
import { money, textWidth } from './ansi.mjs';

export const NO_PICK_RADAR = '先选一餐，再看雷达图';
export const RADAR_NOTE = '四个维度都由本次核价、历史订单和你的反馈算出；不含营养或健康数据。';
const clamp = (v) => Math.max(0, Math.min(1, v));
const RECENT_ORDERS = 6; // Same window as the 最近吃了啥 list.

// [{ key, label, value (0..1 or null), basis }] in drawing order (clockwise from the top).
export function radarAxes(r, { history = null, feedback = [], mainNames = new Map() } = {}) {
  const name = (code) => mainNames.get(code) || code;
  const budget = r.request?.budgetPerPersonFen > 0 ? r.request.budgetPerPersonFen : null;
  const price = budget == null ? null : clamp((budget - r.priceFen) / budget); // share of the budget left over

  const recent = history?.orders?.slice(0, RECENT_ORDERS) || [], eaten = new Set(recent.flatMap((o) => o.mainCodes || []));
  const mains = r.mainCodes || [], fresh = mains.filter((c) => !eaten.has(c));
  const novelty = history && mains.length ? fresh.length / mains.length : null;

  const full = r.priceFen + (r.savingFen || 0), coupon = full > 0 ? (r.savingFen || 0) / full : null;

  const liked = new Set(feedback.filter((f) => f.vote === 'like').flatMap((f) => f.foods.map((x) => x.code)));
  const less = new Set(feedback.filter((f) => f.vote === 'less').flatMap((f) => f.foods.map((x) => x.code)));
  const wanted = new Set(r.request?.wantMainCodes || []);
  const hasPrefs = liked.size || less.size || wanted.size;
  const score = mains.reduce((s, c) => s + ((liked.has(c) || wanted.has(c)) ? 1 : 0) - (less.has(c) ? 1 : 0), 0);
  const preference = hasPrefs && mains.length ? clamp(0.5 + score / (2 * mains.length)) : null;
  const hits = mains.filter((c) => liked.has(c) || wanted.has(c)).map(name), misses = mains.filter((c) => less.has(c)).map(name);

  return [
    { key: 'price', label: '价格友好度', value: price,
      basis: budget == null ? '没有预算数据' : `整单 ${money(r.priceFen)} / 预算 ${money(budget)}，预算剩 ${Math.round(price * 100)}%` },
    { key: 'novelty', label: '口味新鲜度', value: novelty,
      basis: !history ? '未读到历史订单' : !mains.length ? '这份没有可识别的主食'
        : `主食 ${mains.length} 种里 ${fresh.length} 种不在最近 ${recent.length} 单${history.sourceKind === 'demo-history' ? '（对比的是虚构示例历史）' : ''}` },
    { key: 'coupon', label: '券优惠', value: coupon,
      basis: coupon == null ? '没有价格数据' : r.savingFen > 0 ? `券省 ${money(r.savingFen)} / 无券 ${money(full)}` : '这份没用上券' },
    { key: 'preference', label: '偏好匹配', value: preference,
      basis: !hasPrefs ? '还没有偏好记录（/like · /less · 指令里写“想吃…”）' : !mains.length ? '这份没有可识别的主食'
        : [hits.length ? `合你口味：${hits.join('、')}` : '', misses.length ? `少推荐过：${misses.join('、')}` : '', !hits.length && !misses.length ? '主食和偏好记录无关（中性 0.5）' : ''].filter(Boolean).join('；') },
  ];
}

const fmt = (v) => (v == null ? '无数据' : v.toFixed(2));

// ASCII spider chart: grid polygons at 50% / 100%, spokes, the value polygon, axis labels with values.
export function renderRadarChart(axes, P, { rx = 14, ry = 7 } = {}) {
  const W = 64, cx = 32, cy = ry + 1, H = 2 * ry + 4;
  const cells = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', tone: null })));
  const put = (x, y, ch, tone) => { x = Math.round(x); y = Math.round(y); if (y >= 0 && y < H && x >= 0 && x < W) cells[y][x] = { ch, tone }; };
  const text = (x, y, s, tone) => { for (const ch of s) { const w = textWidth(ch); put(x, y, ch, tone); if (w === 2) put(x + 1, y, '', tone); x += w; } };
  const at = (k, r) => { const a = -Math.PI / 2 + (2 * Math.PI * k) / axes.length; return [cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]; };
  const line = ([x0, y0], [x1, y1], ch, tone) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2));
    for (let i = 0; i <= steps; i++) put(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, ch, tone);
  };
  const ring = (r, ch) => axes.forEach((_, k) => line(at(k, r), at((k + 1) % axes.length, r), ch, 'gray'));
  ring(0.5, '·'); ring(1, '·');
  axes.forEach((_, k) => line([cx, cy], at(k, 1), '·', 'gray'));
  const pts = axes.map((a, k) => at(k, a.value ?? 0));
  pts.forEach((p, k) => line(p, pts[(k + 1) % pts.length], '*', 'brand'));
  pts.forEach((p) => put(p[0], p[1], 'O', 'yellow'));
  put(cx, cy, '+', 'gray');
  axes.forEach((a, k) => {
    const label = `${a.label} ${fmt(a.value)}`, w = textWidth(label), [tx, ty] = at(k, 1), tip = [Math.round(tx), Math.round(ty)];
    const [lx, ly] = k === 0 ? [tip[0] - Math.floor(w / 2), tip[1] - 1]
      : tx > cx + 1 ? (ty > cy ? [tip[0] - 2, tip[1] + 1] : [tip[0] + 2, tip[1]])
        : (ty > cy ? [tip[0] - w + 3, tip[1] + 1] : [tip[0] - w - 1, tip[1]]);
    text(Math.max(0, Math.min(W - w, lx)), ly, label, a.value == null ? 'gray' : 'bold');
  });
  const paint = (c) => (c.tone && P[c.tone] ? P[c.tone](c.ch) : c.ch);
  return cells.map((row) => row.map(paint).join('').trimEnd()).filter((l, i, all) => l || (i > 0 && i < all.length - 1));
}

export function renderRadar(r, P, context = {}) {
  const axes = radarAxes(r, context);
  const bar = (v) => `${'█'.repeat(Math.round((v ?? 0) * 10))}${'░'.repeat(10 - Math.round((v ?? 0) * 10))}`;
  return [P.bold(`${r.title} · ${money(r.priceFen)}${r.sample ? '（样本价）' : ''}`), '',
    ...renderRadarChart(axes, P), '',
    ...axes.map((a) => `${a.label.padEnd(5, '　')} ${P.brand(bar(a.value))} ${fmt(a.value).padStart(4)}  ${P.gray(a.basis)}`),
    '', P.gray(RADAR_NOTE)];
}
