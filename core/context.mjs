// Mainland China calendar, verified against 国办发明电〔2025〕7号. Dates and holidays only.
// Weather was removed: it existed to fill atmosphere sentences.
export const HOLIDAY_SOURCE = 'https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html';
const HOLIDAYS_2026 = [
  ['元旦', '2026-01-01', '2026-01-03'], ['春节', '2026-02-15', '2026-02-23'],
  ['清明节', '2026-04-04', '2026-04-06'], ['劳动节', '2026-05-01', '2026-05-05'],
  ['端午节', '2026-06-19', '2026-06-21'], ['中秋节', '2026-09-25', '2026-09-27'], ['国庆节', '2026-10-01', '2026-10-07'],
];
const WORKDAYS_2026 = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']);
export function calendarContext(now = new Date()) {
  const shifted = new Date(Number(now) + 8 * 3600000), date = shifted.toISOString().slice(0, 10), month = shifted.getUTCMonth() + 1;
  const weekday = shifted.getUTCDay(), supported = shifted.getUTCFullYear() === 2026;
  const holiday = supported ? HOLIDAYS_2026.find(([, start, end]) => start <= date && date <= end)?.[0] || null : null;
  const makeupWorkday = supported && WORKDAYS_2026.has(date);
  const next = supported ? HOLIDAYS_2026.find(([, start]) => start > date) : null;
  const daysAway = next ? Math.round((Date.parse(next[1]) - Date.parse(date)) / 86400000) : null;
  return { date, month, weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday], timezone: 'Asia/Shanghai', region: '中国大陆', holiday, makeupWorkday,
    dayKind: holiday ? 'holiday' : makeupWorkday ? 'workday' : [0, 6].includes(weekday) ? 'weekend' : 'workday',
    holidayVerified: supported, holidaySource: supported ? HOLIDAY_SOURCE : null,
    upcoming: next && daysAway <= 14 ? { name: next[0], date: next[1], daysAway } : null };
}

const clip = (s, n) => [...String(s || '')].slice(0, n).join('');

// Six blocks. Allergy values never appear: the caller passes already-stripped text,
// and the profile line is only the local placeholder.
export function buildTurnContext(session, text) {
  const turns = (session.recentTurns || []).slice(-4).map((t) => clip(t.summary || t.text || '', 80));
  const pick = session.lastPick;
  const ago = pick && session.now ? Math.max(0, Math.round((Number(session.now()) - Date.parse(session.lastReceipt?.at || 0)) / 60000)) : null;
  const pickLine = pick ? `${clip(pick.title, 40)}｜${(pick.parts || []).map((p) => p.name).slice(0, 6).join('+')}｜${((pick.priceFen || 0) / 100).toFixed(2)}元${ago == null ? '' : `｜${ago}分钟前`}` : '无';
  const menu = session.menuSnapshot || [];
  const menuLine = menu.slice(0, 40).map((m) => `${clip(m.name, 24)}/${m.code}/${m.priceFen == null ? '?' : (m.priceFen / 100).toFixed(2)}`).join('；') || '无';
  const details = session.detailCache || {};
  const detailLine = Object.values(details).slice(0, 8).map((d) => {
    const parts = (d.parts || []).map((p) => p.name).join('+') || '组成未知';
    const rem = (d.removable || []).slice(0, 6).join('、') || '无可去掉的料';
    return `${clip(d.name || d.code, 24)}：${parts}；可去掉：${rem}${d.complete ? '' : '；不是完整配料表'}`;
  }).join('｜') || '无';
  const coupons = session.couponTable || [];
  const couponLine = coupons.map((c) => `${c.name}｜${c.applicable ? '适用' : '不适用'}｜${c.note || (c.saveYuan == null ? '价值未知' : `省${c.saveYuan}`)}｜${c.afterYuan == null ? '' : `折后${c.afterYuan}`}`).join('；') || '无';
  const incomplete = Boolean(session.dataIncomplete);
  const prompt = [
    `本轮：${clip(text, 200)}`,
    `最近对话：${turns.join(' / ') || '无'}`,
    `上一餐：${pickLine}`,
    `菜单：${menuLine}`,
    `配料：${detailLine}`,
    `券折算：${couponLine}`,
    `用户：${session.profileLine || '还没有口味记录'}`,
    incomplete ? '数据不全：有的接口这轮没返回，不知道就说不知道。' : '数据状态：本轮已拿到的上下文如上。',
    `日期：${calendarContext(session.now?.() || new Date()).date}`,
    session.lastOrderAttempt ? `上次下单：${session.lastOrderAttempt.status} ${clip(session.lastOrderAttempt.reason, 80)}` : '上次下单：无',
  ].join('\n');
  return { prompt, incomplete };
}
