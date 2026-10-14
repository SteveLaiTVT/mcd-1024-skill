const DAY = 86400000;
const CHINA_OFFSET = 8 * 3600000;
const completed = new Set(['6', '8', '已完成', '订单已完成', '已评价', '订单已评价', 'COMPLETED']);
const text = (value, limit = 140) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const quantity = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;

export function historyTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d, h = '00', min = '00', s = '00', ms = '', zone = '+08:00'] = match;
  const calendar = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number(y) < 2000 || Number(y) > 2100 || calendar.getUTCFullYear() !== Number(y) || calendar.getUTCMonth() + 1 !== Number(m) || calendar.getUTCDate() !== Number(d) || Number(h) > 23 || Number(min) > 59 || Number(s) > 59) return null;
  const parsed = Date.parse(`${y}-${m}-${d}T${h}:${min}:${s}${ms ? `.${ms}` : ''}${zone}`);
  return Number.isFinite(parsed) ? parsed : null;
}
export const chinaDay = (time) => new Date(time + CHINA_OFFSET).toISOString().slice(0, 10);
const dayTime = (day) => Date.parse(`${day}T00:00:00Z`);
export const shiftDay = (day, offset) => new Date(dayTime(day) + offset * DAY).toISOString().slice(0, 10);

function products(order, mainCodes) {
  const items = [], foods = new Map(), mains = new Set();
  const addFood = (code, name) => {
    if (name) foods.set(code || name, { code, name });
    if (code && mainCodes.has(code)) mains.add(code);
  };
  for (const item of Array.isArray(order.orderProductList) ? order.orderProductList : []) {
    if (!item || item.quantity === 0) continue;
    const name = text(item.productName), code = text(item.productCode, 80);
    const parts = (Array.isArray(item.comboItemList) ? item.comboItemList : []).filter((p) => p && p.quantity !== 0).map((p) => ({ name: text(p.name), code: text(p.productCode, 80), quantity: quantity(p.quantity) })).filter((p) => p.name);
    if (name) items.push({ name, quantity: quantity(item.quantity), parts });
    if (parts.length) parts.forEach((p) => addFood(p.code, p.name));
    else addFood(code, name);
    if (mainCodes.has(code)) mains.add(code);
  }
  return { items, foods: [...foods.values()], mainCodes: [...mains] };
}

// Raw IDs are only used to deduplicate this response; no identifier enters the report.
export function normalizeHistory(data, { now, mainCodes = [], sourceKind = 'official-history' } = {}) {
  const checkedAt = historyTime(now);
  if (checkedAt == null || !Array.isArray(data?.list)) throw new Error('历史记录的时间或列表未确认。');
  const anchorDay = chinaDay(checkedAt), seen = new Set(), orders = [];
  const skipped = { duplicate: 0, unfinished: 0, invalidTime: 0, future: 0, missingId: 0 };
  const mainSet = new Set(mainCodes);
  for (const raw of data.list) {
    if (!raw || typeof raw !== 'object') { skipped.invalidTime++; continue; }
    const id = typeof raw.orderId === 'string' || Number.isSafeInteger(raw.orderId) ? String(raw.orderId).trim() : '';
    if (id && seen.has(id)) { skipped.duplicate++; continue; }
    if (id) seen.add(id); else skipped.missingId++;
    const status = String(raw.orderStatus ?? '').trim().toUpperCase();
    if (!completed.has(status)) { skipped.unfinished++; continue; }
    const createdAt = historyTime(raw.createTime);
    if (createdAt == null) { skipped.invalidTime++; continue; }
    if (createdAt > checkedAt) { skipped.future++; continue; }
    const timestamp = new Date(createdAt + CHINA_OFFSET).toISOString();
    orders.push({ day: timestamp.slice(0, 10), time: timestamp.slice(11, 16), createdAt,
      status: ['8', '已评价', '订单已评价'].includes(status) ? '已评价' : '已完成',
      storeName: text(raw.storeName, 100), ...products(raw, mainSet) });
  }
  orders.sort((a, b) => b.createdAt - a.createdAt);
  const recentDays = new Set([shiftDay(anchorDay, -1), shiftDay(anchorDay, -2)]);
  return { sourceKind, checkedAt: new Date(checkedAt).toISOString(), anchorDay,
    returnedCount: data.list.length, skipped, coverageComplete: sourceKind === 'demo-history', orders,
    recentMainCodes: [...new Set(orders.filter((o) => recentDays.has(o.day)).flatMap((o) => o.mainCodes))] };
}

export async function readHistory(client, mainCodes = []) {
  const now = (await client.call('now-time-info')).data?.datetime;
  const body = await client.call('order-list', {});
  return normalizeHistory(body.data, { now, mainCodes });
}

export function historyCalendar(report, { year, mode = 'year' } = {}) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !['year', 'recent'].includes(mode)) throw new Error('日历范围无效。');
  const anchorDay = report.anchorDay;
  const lastDay = `${year}-12-31`;
  const end = mode === 'recent' ? (year === Number(anchorDay.slice(0, 4)) ? anchorDay : lastDay) : lastDay;
  const start = mode === 'recent' ? shiftDay(end, -83) : `${year}-01-01`;
  const visible = report.orders.filter((o) => o.day >= start && o.day <= end);
  const byDay = new Map();
  for (const order of visible) { if (!byDay.has(order.day)) byDay.set(order.day, []); byDay.get(order.day).push(order); }
  const first = shiftDay(start, -new Date(dayTime(start)).getUTCDay());
  const final = shiftDay(end, 6 - new Date(dayTime(end)).getUTCDay());
  const weeks = [], months = [], monthSeen = new Set();
  for (let cursor = first; cursor <= final; cursor = shiftDay(cursor, 7)) {
    const week = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const day = shiftDay(cursor, weekday);
      if (day < start || day > end) { week.push(null); continue; }
      const records = byDay.get(day) || [], future = day > anchorDay;
      week.push({ day, count: records.length, level: Math.min(4, records.length), future,
        unknown: !future && !records.length && !report.coverageComplete, orders: records });
      const monthKey = day.slice(0, 7);
      if (!monthSeen.has(monthKey)) { monthSeen.add(monthKey); months.push({ name: `${Number(day.slice(5, 7))}月`, column: weeks.length }); }
    }
    weeks.push(week);
  }
  const foods = new Map();
  for (const order of visible) for (const food of order.foods) {
    const key = food.code || food.name, previous = foods.get(key);
    foods.set(key, { name: food.name, count: (previous?.count || 0) + 1 });
  }
  return { start, end, weeks, months, orderCount: visible.length, recordedDays: byDay.size,
    foodCount: foods.size, ranking: [...foods.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5) };
}

export function demoHistory() {
  const anchorDay = '2026-10-10';
  const menu = [['麦香鸡中套餐', '麦香鸡', '中薯条', '可乐'], ['大堡口福三件套', '鸡排堡', '中薯条', '可乐'], ['麦麦周末双人餐', '麦辣鸡腿堡', '麦香鸡', '无糖可乐'], ['酥脆无双套餐', '脆汁鸡琵琶腿', '迷你薯条', '无糖可乐']];
  const list = [];
  for (let i = 0; i < 58; i++) {
    const day = shiftDay(anchorDay, -((i * 17 + 1) % 270));
    const meal = menu[i % menu.length];
    for (let n = 0; n < (i % 11 === 0 ? 4 : i % 7 === 0 ? 2 : 1); n++) list.push({ orderId: `fiction-${i}-${n}`, orderStatus: '订单已完成', createTime: `${day} ${n ? '18' : '12'}:20:00`, storeName: '示例餐厅', orderProductList: [{ productName: meal[0], quantity: 1, comboItemList: meal.slice(1).map((name) => ({ name, quantity: 1 })) }] });
  }
  return normalizeHistory({ list }, { now: `${anchorDay}T20:00:00+08:00`, sourceKind: 'demo-history' });
}
