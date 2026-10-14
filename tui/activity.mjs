// Activities from campaign-calendar, each tagged with how the user can take part.
// The MCP server has no tool that registers a user for an activity, so the only
// MCP route is claiming a matching claimable coupon (auto-bind-coupons, after an
// explicit typed yes). Everything else is information-only with the official path.
import { timeCondition, couponTimeStatus } from '../core/coupons.mjs';

const TYPES = ['活动', '神秘活动', '优惠券', '品鉴会', '活动文章', '麦麦省', '派对'];
export const OFFICIAL_PATH = '在麦当劳官方 App 或微信小程序的活动页查看并按官方规则参与（入口以官方为准）';
export const NO_REGISTER_NOTE = '麦当劳 MCP 没有“报名 / 参与活动”的工具：本工具不能替你报名。唯一能通过 MCP 做的是领券（/claim，需输入 yes 确认）。';
const clean = (v, max = 160) => typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const chinaDate = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const sameName = (a, b) => Boolean(a && b && a.length >= 2 && b.length >= 2 && (a === b || a.includes(b) || b.includes(a)));

// Raw campaign-calendar data → one row per activity (same title + type), dates merged.
export function activitiesFromCalendar(calendar, now) {
  const groups = new Map(), subscribed = (calendar?.subscribedEvents || []).map((e) => clean(e.activityTitle, 60)).filter(Boolean);
  for (const day of calendar?.dailyList || []) for (const event of day.events || []) {
    const name = clean(event.activityTitle || event.articleDto?.title, 60) || '活动详情待公布', type = Number.isInteger(event.eventType) ? event.eventType : 0;
    const key = JSON.stringify([name, type]);
    if (!groups.has(key)) {
      const info = event.couponInfo && Object.keys(event.couponInfo).length ? event.couponInfo : null;
      const rules = [clean(event.activitySubTitle, 80), info ? `用券时段：${timeCondition(info)}` : '', clean(event.articleDto?.content)].filter(Boolean);
      groups.set(key, { name, type, typeName: TYPES[type] || '活动', dates: [], rules, priceDisplay: event.price != null && event.price !== '' ? clean(String(event.price), 20) : null,
        couponWindow: info ? { start: info.tradeStartDate || null, end: info.tradeEndDate || null, status: couponTimeStatus(info, now) } : null,
        subscribed: subscribed.some((s) => sameName(s, name)) });
    }
    if (typeof day.date === 'string' && !groups.get(key).dates.includes(day.date)) groups.get(key).dates.push(day.date);
  }
  return [...groups.values()].map((a) => ({ ...a, dates: a.dates.sort() }));
}

// Demo snapshot rows (already in publicCalendar shape) → the same activity rows.
export function activitiesFromSnapshot(events) {
  const groups = new Map();
  for (const e of events || []) {
    const key = JSON.stringify([e.name, e.eventType]);
    if (!groups.has(key)) groups.set(key, { name: clean(e.name, 60), type: e.eventType, typeName: TYPES[e.eventType] || e.eventTypeName || '活动', dates: [],
      rules: [clean(e.subtitle, 80), clean(e.condition)].filter(Boolean), priceDisplay: e.priceDisplay || null, couponWindow: null, subscribed: false });
    if (e.date && !groups.get(key).dates.includes(e.date)) groups.get(key).dates.push(e.date);
  }
  return [...groups.values()].map((a) => ({ ...a, dates: a.dates.sort() }));
}

// Participation: MCP (a matching claimable or held coupon) vs information only. Never claims anything.
export function classifyActivities(rows, { offers = [], heldNames = [], now }) {
  const today = chinaDate(now);
  return rows.map((a) => {
    const offer = offers.find((o) => o.canClaim && sameName(o.name, a.name)), held = heldNames.find((n) => sameName(n, a.name));
    const status = !a.dates.length ? 'unknown' : a.dates.at(-1) < today ? 'past' : a.dates[0] > today ? 'upcoming' : 'ongoing';
    const participation = held ? { mode: 'held', coupon: held, how: `你已持有券「${held}」，到店下单时按券规则使用即可（价格以官方核价为准）。` }
      : offer ? { mode: 'mcp', coupon: offer.name, how: `可领券「${offer.name}」：输入 /claim，再输入 yes 确认后由官方领取（官方一次领取全部可领券，不能单选）。` }
      : { mode: 'info', how: `仅展示，MCP 不能参与：${OFFICIAL_PATH}。` };
    return { ...a, status, participation };
  }).sort((x, y) => ['ongoing', 'upcoming', 'unknown', 'past'].indexOf(x.status) - ['ongoing', 'upcoming', 'unknown', 'past'].indexOf(y.status) || (x.participation.mode === 'info') - (y.participation.mode === 'info'));
}
