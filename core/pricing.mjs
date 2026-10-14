// Meal and coupon pricing. Amounts are integer fen throughout. One person, one meal:
// there is no 1–4 people or 5/7/9 fullness form. Recipes may still carry those fields
// from the sample dataset; they are filters, not a form.
import { budgetFen, requireValue } from './money.mjs';
export { budgetFen };
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const amount = (v) => Number.isSafeInteger(v) && v >= 0;
const clone = (v) => structuredClone(v);
const pick = (v, keys) => Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, v[k]]));
// Cancellation is not a business failure. Callers that swallow errors must let it out
// so an external abort does not keep pricing the rest of the list.
const stopIfAborted = (signal, error) => { if (signal?.aborted) throw error; };

export function dateValue(value, end = false) {
  requireValue(typeof value === 'string' && value.trim(), '有效期未确认');
  let text = value.trim().replaceAll('/', '-').replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += end ? 'T23:59:59' : 'T00:00:00';
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += '+08:00';
  const ms = Date.parse(text); requireValue(Number.isFinite(ms), '有效期未确认'); return ms;
}
const chinaDate = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const chinaSeconds = (ms) => ((ms + 8 * 3600000) % 86400000 + 86400000) % 86400000 / 1000;
function clockSeconds(text) {
  requireValue(typeof text === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(text), '活动时段未确认');
  const [h, m, s = 0] = text.split(':').map(Number);
  requireValue(h < 24 && m < 60 && s < 60, '活动时段未确认'); return h * 3600 + m * 60 + s;
}
export function timeCondition(info) {
  const pieces = [];
  if (info.tradeStartDate && info.tradeEndDate) pieces.push(`${info.tradeStartDate} 至 ${info.tradeEndDate}`);
  const days = ['', '周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (info.weekdays?.length) pieces.push(info.weekdays.map((d) => days[d] || '星期待确认').join(' / '));
  if (info.isAllTradeTime === 1) pieces.push('全天');
  else if (info.tradeTimePeriods?.length) pieces.push(info.tradeTimePeriods.map((p) => `${p.startTime || '?'}–${p.endTime || '?'}`).join(' / '));
  return pieces.join('；') || '有效期与可用时段待确认';
}
export function couponTimeStatus(info, now) {
  try {
    if (now < dateValue(info.tradeStartDate) || now > dateValue(info.tradeEndDate, true)) return 'outside';
    if (info.weekdays != null) {
      if (!Array.isArray(info.weekdays) || info.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'unknown';
      if (info.weekdays.length && !info.weekdays.includes(new Date(now + 8 * 3600000).getUTCDay() + 1)) return 'outside';
    }
    if (info.isAllTradeTime === 1) return 'valid';
    if (info.isAllTradeTime !== 0 || !info.tradeTimePeriods?.length) return 'unknown';
    const clock = chinaSeconds(now);
    return info.tradeTimePeriods.some((p) => {
      const lo = clockSeconds(p.startTime), hi = clockSeconds(p.endTime);
      return lo <= hi ? lo <= clock && clock <= hi : clock >= lo || clock <= hi;
    }) ? 'valid' : 'outside';
  } catch { return 'unknown'; }
}

export function modifications(choice) {
  const result = [];
  for (const group of choice.modification?.items || []) {
    const values = group.values || [], selected = values.filter((v) => v.selectedQuantity > 0);
    requireValue(selected.length >= (group.minValues ?? 0) && ((group.maxValues ?? -1) < 0 || selected.length <= group.maxValues), '特调选项数量不符');
    for (const v of values) {
      const quantity = v.selectedQuantity || 0;
      if (quantity > 0 || 'unselectedKey' in v) {
        requireValue(quantity <= 0 || positive(quantity), '特调数量不符');
        result.push({ code: v.code, key: quantity > 0 ? v.selectedKey : v.unselectedKey, quantity: quantity > 0 ? quantity : 1 });
      }
    }
  }
  return result.length ? { values: result } : null;
}
export function buildPackage(detail, ingredient) {
  requireValue(detail && positive(ingredient.quantity) && detail.code === ingredient.productCode, '套餐编码或份数不符');
  const changes = ingredient.choices || {}, rounds = detail.rounds || [];
  requireValue(rounds.length && Object.keys(changes).every((id) => rounds.some((r) => String(r.id) === id)), '套餐选项不符');
  const parts = [], roundList = rounds.map((round) => {
    const required = round.quantity, choices = round.choices;
    requireValue(positive(required) && Array.isArray(choices), '套餐轮次数量不符');
    let selected;
    if (String(round.id) in changes) {
      const matches = choices.filter((c) => c.code === changes[String(round.id)]);
      requireValue(matches.length === 1, '套餐换项当前不可用'); selected = [[matches[0], required]];
    } else {
      selected = choices.filter((c) => c.quantity > 0).map((c) => [c, c.quantity]);
      if (!selected.length && required === 1) {
        const defaults = choices.filter((c) => c.isDefault);
        requireValue(defaults.length === 1, '无法确认默认搭配'); selected = [[defaults[0], 1]];
      }
    }
    const total = selected.reduce((sum, [, q]) => sum + q, 0);
    requireValue(total === required && total >= (round.minQuantity ?? required) && ((round.maxQuantity ?? required) < 0 || total <= (round.maxQuantity ?? required)), '套餐子项数量不符');
    const comboItemList = selected.map(([c, q]) => {
      requireValue(positive(q) && ((c.maxQuantity ?? -1) < 0 || q <= c.maxQuantity), '套餐选项数量超限');
      const child = { code: c.code, quantity: q }, mod = modifications(c);
      if (mod) child.modification = mod;
      parts.push({ code: c.code, name: c.name, quantity: q * ingredient.quantity }); return child;
    });
    return { round: String(round.id), comboItemList };
  });
  return [{ productCode: detail.code, quantity: ingredient.quantity, roundList }, parts];
}
export function buildCart(recipe, details, mainCodes) {
  const items = [], packages = [], merged = new Map();
  for (const ingredient of recipe.ingredients) {
    const detail = details[ingredient.productCode], [item, parts] = buildPackage(detail, ingredient);
    items.push(item); packages.push({ productCode: detail.code, name: detail.name, quantity: ingredient.quantity });
    for (const part of parts) {
      if (!merged.has(part.code)) merged.set(part.code, { ...part, quantity: 0 });
      const existing = merged.get(part.code); requireValue(existing.name === part.name, '同一餐品名称不一致'); existing.quantity += part.quantity;
    }
  }
  const parts = [...merged.values()];
  requireValue(parts.filter((p) => mainCodes.has(p.code)).reduce((s, p) => s + p.quantity, 0) >= recipe.people, '主餐数量不够每人一份');
  return { items, packages, parts, mainCodes: parts.filter((p) => mainCodes.has(p.code)).map((p) => p.code) };
}

export function publicOffers(raw) {
  const seen = new Set(); return raw.filter((o) => {
    const key = JSON.stringify([o.couponName, o.couponStatus, o.label]);
    if (seen.has(key)) return false; seen.add(key); return true;
  }).map((o) => ({ name: o.couponName, status: o.couponStatus, label: o.label, canClaim: o.couponStatus === 'CAN_GET', priceUse: 'requires-claim-store-validation-and-live-quote' }));
}
export async function wallet(client, { signal } = {}) {
  const assets = new Map(); let complete = false;
  for (let page = 1; page <= 5; page++) {
    const data = (await client.call('query-my-coupons', { page: String(page), pageSize: '200' }, { signal })).data;
    requireValue(data.currentPage === page && Array.isArray(data.coupons) && amount(data.totalCount) && amount(data.totalPages), '券包分页未确认');
    for (const c of data.coupons) { requireValue(c.id, '持有券缺少资产编号'); assets.set(c.id, c); }
    if (page >= data.totalPages) { complete = assets.size >= data.totalCount; break; }
  }
  return { owned: [...assets.values()], complete };
}
export function eligibleCoupons(owned, store, now) {
  const assets = new Map(owned.map((c) => [c.id, c])), seen = new Set(), eligible = [], skipped = [];
  for (const c of store) {
    if (seen.has(c.couponId)) continue; seen.add(c.couponId);
    const asset = assets.get(c.couponId), name = c.title || '优惠券'; let reason, expiresAt, products;
    if (!asset) reason = '未核实持有';
    else if (asset.enable !== 1) reason = '券未启用';
    else if (!c.couponCode || (asset.code && asset.code !== c.couponCode)) reason = '券码未匹配';
    else {
      try {
        const period = (c.tradeDateTime || '').split(' - ');
        const start = dateValue(period.length === 2 ? period[0] : asset.tradeStartDate);
        expiresAt = dateValue(period.length === 2 ? period[1] : asset.tradeEndDate, true);
        if (now < start || now > expiresAt) reason = '不在有效期';
        products = new Set((c.products || []).map((p) => p.productCode).filter(Boolean));
        if (!products.size) reason = '缺少适用商品';
      } catch { reason = '有效期未确认'; }
    }
    if (reason) skipped.push({ name, reason });
    else eligible.push({ couponId: c.couponId, couponCode: c.couponCode, name, productCodes: products, expiresAt });
  }
  return { eligible, skipped };
}
const rulesOf = (calendar) => (calendar.dailyList || []).flatMap((d) => (d.events || []).map((e) => e.couponInfo).filter(Boolean));
const matchesRule = (c, r) => Boolean((r.couponId && r.couponId === c.couponId) || (r.couponCode && r.couponCode === c.couponCode));
export function constrainCoupons(coupons, calendar, now) {
  const rules = rulesOf(calendar), eligible = [], skipped = [], cutoffs = [];
  for (const c of coupons) {
    const matching = rules.filter((r) => matchesRule(c, r)), valid = matching.filter((r) => couponTimeStatus(r, now) === 'valid');
    if (matching.length && !valid.length) { skipped.push({ name: c.name, reason: '活动用券时段未通过验证' }); continue; }
    eligible.push({ ...c, conditionTexts: [...new Set(matching.map(timeCondition))] });
    const ends = valid.map((r) => {
      let end = dateValue(r.tradeEndDate, true);
      if (r.isAllTradeTime === 0) {
        const midnight = dateValue(chinaDate(now)), clock = chinaSeconds(now), activeEnds = [];
        for (const p of r.tradeTimePeriods) {
          const lo = clockSeconds(p.startTime), hi = clockSeconds(p.endTime);
          if ((lo <= hi && lo <= clock && clock <= hi) || (lo > hi && (clock >= lo || clock <= hi))) {
            activeEnds.push(midnight + hi * 1000 + (lo > hi && clock >= lo ? 86400000 : 0));
          }
        }
        end = Math.min(end, Math.max(...activeEnds));
      }
      return end;
    });
    if (ends.length) cutoffs.push(Math.max(...ends));
  }
  return { eligible, skipped, cutoffs };
}
export function publicCalendar(calendar, now) {
  const rows = [], seen = new Set(), today = chinaDate(now), types = ['活动', '神秘活动', '活动券', '品鉴会', '活动文章', '麦麦省', '派对'];
  for (const day of calendar.dailyList || []) for (const event of day.events || []) {
    const kind = event.eventType, name = event.activityTitle || event.articleDto?.title || '活动详情待公布', subtitle = event.activitySubTitle || '';
    const key = JSON.stringify([day.date, name, subtitle, kind]); if (seen.has(key)) continue; seen.add(key);
    const info = event.couponInfo || {};
    rows.push({ kind: 'campaign', name: name.trim(), subtitle, eventType: kind, eventTypeName: types[kind] || '活动', date: day.date,
      status: day.date === today ? 'today' : day.date > today ? 'upcoming' : 'past',
      timeWindow: pick(info, ['tradeStartDate', 'tradeEndDate', 'isAllTradeTime', 'weekdays', 'tradeTimePeriods']),
      timeStatus: Object.keys(info).length ? couponTimeStatus(info, now) : 'unknown',
      condition: Object.keys(info).length ? timeCondition(info) : '活动信息入口；未提供门店或商品折扣规则',
      scope: '门店、渠道和适用商品待确认', priceDisplay: [2, 5].includes(kind) && event.price != null ? String(event.price) : null,
      priceUse: [2, 5].includes(kind) ? 'display-only-requires-wallet-store-validation-and-quote' : 'information-only-no-price-rule' });
  }
  return rows;
}
function benefitRows(offers, owned, store, usable, skipped, entries, calendarComplete) {
  const rows = offers.map((o) => ({ kind: 'claimable-coupon', name: o.name, status: o.canClaim ? 'claimable' : 'unknown', scope: '领取后校验门店和商品', condition: o.label || '尚未验证持有', priceUse: 'not-in-price' }));
  const eligible = new Map(usable.map((c) => [c.couponId, c])), storeById = new Map(store.map((c) => [c.couponId, c])), groups = new Map();
  for (const asset of owned) {
    const s = storeById.get(asset.id) || {}, c = eligible.get(asset.id), name = s.title || asset.title || '持有券';
    const products = (s.products || []).filter((p) => p.productCode).map((p) => ({ productCode: p.productCode, name: p.productName || p.productCode }));
    const condition = c ? [s.tradeDateTime || asset.datetimeText || '有效期已验证', ...(c.conditionTexts || [])].join('；') : skipped.find((p) => p.name === name)?.reason || '当前门店未返回可用券';
    const row = { kind: 'owned-coupon', name, status: c ? 'eligible' : 'unavailable', products, scope: products.map((p) => p.name).join('、') || '适用范围未确认', condition, assetCount: 1, priceUse: c ? 'official-quote-required' : 'not-in-price' };
    const key = JSON.stringify([name, row.status, products, condition]);
    if (groups.has(key)) groups.get(key).assetCount++; else { groups.set(key, row); rows.push(row); }
  }
  rows.push(...entries);
  if (!calendarComplete) rows.push({ kind: 'source-error', name: '活动日历', status: 'unknown', scope: '未查全', condition: '本次展示最低已核验价', priceUse: 'not-in-price' });
  return rows;
}
export async function inspectBenefits(client, context, onProgress = () => {}, { signal } = {}) {
  onProgress({ step: 0, text: '正在查可领券、券包和门店范围…' });
  // The four reads are independent: run them together instead of sequentially.
  // (wallet() pages internally, but that is inherent to pagination.)
  const [nowRes, offersRes, walletRes, storeRes] = await Promise.all([
    client.call('now-time-info', {}, { signal }),
    client.call('available-coupons', {}, { signal }),
    wallet(client, { signal }),
    client.call('query-store-coupons', pick(context, ['storeCode', 'orderType', 'beType']), { signal }),
  ]);
  const now = dateValue(nowRes.data.datetime);
  const offers = publicOffers(offersRes.data);
  const { owned, complete } = walletRes;
  const store = storeRes.data;
  requireValue(Array.isArray(store), '门店优惠范围未确认');
  const initial = eligibleCoupons(owned, store, now);
  onProgress({ step: 1, text: '正在核实活动、有效期和用券时段…' });
  let calendar = {}, calendarComplete = true;
  try { calendar = (await client.call('campaign-calendar', { specifiedDate: chinaDate(now) }, { signal })).data; }
  catch (e) { stopIfAborted(signal, e); calendarComplete = false; }
  const constrained = constrainCoupons(initial.eligible, calendar, now), entries = publicCalendar(calendar, now);
  return { now, offers, ownedCount: owned.length, storeCount: store.length, walletComplete: complete, calendarComplete,
    usable: constrained.eligible, cutoffs: constrained.cutoffs, entries,
    rows: benefitRows(offers, owned, store, constrained.eligible, [...initial.skipped, ...constrained.skipped], entries, calendarComplete) };
}

export function couponVariants(items, coupons, limit = 64) {
  requireValue(positive(limit) && items.every((i) => positive(i.quantity) && !('couponId' in i) && !('couponCode' in i)), '基础餐单无效');
  const variants = [clone(items)], signatures = new Set([JSON.stringify(items)]); let truncated = false;
  const unique = [...new Map(coupons.map((c) => [c.couponId, c])).values()].sort((a, b) => a.expiresAt - b.expiresAt);
  for (const c of unique) {
    const additions = [];
    for (const cart of variants) for (let index = 0; index < cart.length; index++) {
      const item = cart[index]; if (item.couponId || !c.productCodes.has(item.productCode)) continue;
      const candidate = clone(cart), target = candidate[index];
      if (target.quantity > 1) { const leftover = clone(target); leftover.quantity--; candidate.splice(index + 1, 0, leftover); }
      Object.assign(target, { quantity: 1, couponId: c.couponId, couponCode: c.couponCode });
      const signature = JSON.stringify(candidate); if (signatures.has(signature)) continue;
      if (variants.length + additions.length >= limit) { truncated = true; continue; }
      signatures.add(signature); additions.push(candidate);
    }
    variants.push(...additions);
  }
  return { variants, truncated };
}
// calculate-price data.takeWayList → [{ code, title }]; entries without a string code are dropped.
export const takeWaysOf = (data) => (Array.isArray(data?.takeWayList) ? data.takeWayList : [])
  .filter((t) => t && typeof t.code === 'string' && t.code).map((t) => ({ code: t.code, title: typeof t.title === 'string' ? t.title : '' }));
export async function quoteBest(client, common, items, coupons, limit = 64, { signal } = {}) {
  const { variants, truncated } = couponVariants(items, coupons, limit);
  const baseline = await client.call('calculate-price', { ...common, items: variants[0] }, { signal });
  requireValue(amount(baseline.data?.price), '官方基础报价无效');
  // Coupon variants quote in parallel (concurrency 3): a serial loop costs ~1s per variant
  // against the live API and blows the 10s recommendation budget. 429/502/503/504 retries
  // stay inside the MCP client; an external abort still throws via stopIfAborted.
  const results = await mapLimited(variants.slice(1), async (cart) => {
    try {
      const quoted = await client.call('calculate-price', { ...common, items: cart }, { signal });
      requireValue(amount(quoted.data?.price), '官方用券报价无效');
      return { ok: true, quoted, cart };
    } catch (e) { stopIfAborted(signal, e); return { ok: false }; }
  }, 3);
  // Collect every result first, then take the minimum; the winning cart comes along.
  let best = baseline, bestCart = variants[0], successes = 0, failures = 0;
  for (const r of results) {
    if (!r.ok) { failures++; continue; }
    successes++;
    if (r.quoted.data.price < best.data.price) { best = r.quoted; bestCart = r.cart; }
  }
  const names = new Map(coupons.map((c) => [c.couponId, c.name]));
  requireValue(Number.isFinite(dateValue(best.datetime)), '官方报价缺少时间');
  return { basePriceFen: baseline.data.price, priceFen: best.data.price, savingFen: baseline.data.price - best.data.price,
    originalPriceFen: amount(best.data.originalPrice) && best.data.originalPrice >= best.data.price ? best.data.originalPrice : null,
    officialDiscountFen: amount(best.data.discount) ? best.data.discount : null,
    couponNames: bestCart.filter((i) => i.couponId).map((i) => names.get(i.couponId)), quotedAt: best.datetime,
    // The exact priced items (roundList, modification, couponId/couponCode) and pickup options, kept for create-order.
    orderItems: clone(bestCart), takeWays: takeWaysOf(best.data),
    successfulCouponQuotes: successes, failedCouponQuotes: failures, variantLimitReached: truncated, comparisonComplete: !truncated && !failures };
}
async function mapLimited(values, fn, limit = 2) {
  let next = 0; const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await fn(values[index], index); }
  })); return result;
}
export function validateRequest(request) {
  const people = request.people ?? 1;
  requireValue(amount(request.budgetPerPersonFen) && Number.isSafeInteger(people * request.budgetPerPersonFen), '预算金额无效。');
  requireValue(Array.isArray(request.avoidMainCodes) && request.avoidMainCodes.every((c) => typeof c === 'string'), '最近吃过的主食无效。');
}
// query-meals data → Map code → { code, name, priceFen, category }. The documented shape is `meals` keyed by
// code plus `categories[].meals[]` ({ code, tags }); arrays, numeric codes and bare code strings are read too,
// so a store whose response differs in shape still yields its real menu.
const yuanToFen = (v) => { const t = String(v ?? '').trim(); return /^\d+(?:\.\d{1,2})?$/.test(t) ? budgetFen(t) : null; };
const codeOf = (v) => typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' && v.trim() ? v.trim() : null;
export function menuIndex(menu) {
  const index = new Map();
  const add = (rawCode, meal, category = '') => {
    const code = codeOf(rawCode); if (!code) return;
    const m = meal && typeof meal === 'object' ? meal : {}, prev = index.get(code) || { code, name: '', priceFen: null, category: '' };
    index.set(code, { code, name: prev.name || (typeof m.name === 'string' ? m.name.trim() : ''),
      priceFen: prev.priceFen ?? yuanToFen(m.currentPrice ?? m.price), category: prev.category || category });
  };
  const meals = menu?.meals;
  if (Array.isArray(meals)) for (const m of meals) add(m && typeof m === 'object' ? m.code ?? m.productCode : m, m);
  else if (meals && typeof meals === 'object') for (const [code, m] of Object.entries(meals)) add(code, m);
  for (const c of Array.isArray(menu?.categories) ? menu.categories : []) {
    for (const m of Array.isArray(c?.meals) ? c.meals : []) add(m && typeof m === 'object' ? m.code ?? m.productCode : m, m, typeof c.name === 'string' ? c.name : '');
  }
  return index;
}
// One line for /why: what query-meals actually returned.
export function menuShape(menu) {
  const meals = menu?.meals, cats = Array.isArray(menu?.categories) ? menu.categories : null;
  const m = Array.isArray(meals) ? `数组 ${meals.length} 项` : meals && typeof meals === 'object' ? `按编码的对象 ${Object.keys(meals).length} 项` : '缺失';
  return `meals：${m}；categories：${cats ? `${cats.length} 类` : '缺失'}`;
}
const normName = (s) => String(s || '').normalize('NFKC').replace(/[\s™®·()（）]/g, '');
// A template code missing from this store's menu maps to the store's own code when exactly one menu item has the same name.
export function resolveCode(code, index, names = new Map()) {
  if (index.has(code)) return { code, how: 'menu' };
  const name = normName(names.get(code));
  const hits = name ? [...index.values()].filter((m) => normName(m.name) === name) : [];
  return hits.length === 1 ? { code: hits[0].code, how: 'name' } : { code, how: 'absent' };
}
// query-meal-detail data → the package detail, with its code as a string (some responses wrap it or send numbers).
export function detailOf(data, code) {
  const d = data && typeof data === 'object' && !Array.isArray(data.rounds) && data.meal && typeof data.meal === 'object' ? data.meal : data;
  if (!d || typeof d !== 'object') return null;
  return { ...d, code: codeOf(d.code) ?? code };
}
// A whole-cart item for any menu product: a package with rounds takes its default choices; anything else is a plain item.
export async function menuItemCart(client, common, code, quantity, name = '', { signal } = {}) {
  let detail = null;
  try { detail = detailOf((await client.call('query-meal-detail', { ...common, code }, { signal })).data, code); }
  catch (e) { stopIfAborted(signal, e); /* priced as a plain item */ }
  if (detail?.rounds?.length) {
    const [item, parts] = buildPackage(detail, { productCode: code, quantity, choices: {} });
    return { items: [item], parts, name: detail.name || name };
  }
  return { items: [{ productCode: code, quantity }], parts: [{ code, name: detail?.name || name || code, quantity }], name: detail?.name || name };
}
// Why a template could not be built at this store. cause: 'menu' (the store does not list it), 'api' (a call failed), 'structure'.
function templateFailure(recipe, codeStatus, names, error) {
  const bad = recipe.ingredients.map((i) => ({ code: i.productCode, ...codeStatus.get(i.productCode) })).find((s) => s.detail !== 'ok');
  const label = (s) => `「${names.get(s.code) || s.code}」`;
  if (bad?.how === 'absent' && bad.menuOk) return { cause: 'menu', reason: `这家店的菜单（query-meals）里没有${label(bad)}${bad.detail === 'error' ? '，套餐详情也查不到' : ''}` };
  if (bad?.detail === 'error') return { cause: 'api', reason: `${label(bad)}的套餐详情接口（query-meal-detail）出错：${bad.error}` };
  if (bad) return { cause: 'menu', reason: `${label(bad)}的套餐详情为空` };
  return { cause: 'structure', reason: `套餐搭配和模板不一致：${error?.message || '结构不符'}` };
}

export async function prepareWheel(client, templates, context, request, onProgress = () => {}, { names = new Map(), signal } = {}) {
  validateRequest(request); requireValue(context.storeCode && context.beType === 1 && context.orderType === 1, '请先选择到店取餐门店。');
  const recipes = templates.recipes.filter((r) => r.people === request.people && (request.portion == null || r.portion === request.portion));
  requireValue(recipes.length, request.portion == null ? '暂时没有此人数的餐单。' : '暂时没有此人数和食量的餐单。');
  const benefits = await inspectBenefits(client, context, onProgress, { signal }), common = pick(context, ['storeCode', 'orderType', 'beType']);
  onProgress({ step: 2, text: '正在读取当前门店的套餐和搭配…', benefits });
  // A failed or odd menu read no longer aborts: every template still tries query-meal-detail, and each failure says why.
  let rawMenu = null, menuError = '';
  try { rawMenu = (await client.call('query-meals', common, { signal })).data; }
  catch (e) { stopIfAborted(signal, e); menuError = e?.message || '门店菜单未返回'; }
  const index = menuIndex(rawMenu), menuOk = !menuError && index.size > 0;
  if (!menuError && !index.size) menuError = `门店菜单为空或无法识别（${menuShape(rawMenu)}）`;
  const codes = [...new Set(recipes.flatMap((r) => r.ingredients.map((i) => i.productCode)))], details = {}, codeStatus = new Map();
  await mapLimited(codes, async (code) => {
    const { code: storeCode, how } = resolveCode(code, index, names), status = { storeCode, how, menuOk, detail: 'empty' };
    codeStatus.set(code, status);
    try {
      const detail = detailOf((await client.call('query-meal-detail', { ...common, code: storeCode }, { signal })).data, storeCode);
      if (detail?.rounds?.length) { details[code] = detail; status.detail = 'ok'; }
    } catch (e) { stopIfAborted(signal, e); status.detail = 'error'; status.error = e?.message || '未返回'; }
  });
  const mainCodes = new Set(templates.mainProductCodes), avoid = new Set(request.avoidMainCodes), failed = [], excluded = [], ready = [];
  for (const recipe of recipes) {
    try {
      // Name-matched codes: the cart uses this store's own package code.
      const local = { ...recipe, ingredients: recipe.ingredients.map((i) => ({ ...i, productCode: codeStatus.get(i.productCode)?.storeCode || i.productCode })) };
      const localDetails = Object.fromEntries(Object.entries(details).map(([code, d]) => [codeStatus.get(code).storeCode, d]));
      const cart = buildCart(local, localDetails, mainCodes);
      if (cart.mainCodes.some((c) => avoid.has(c))) { excluded.push({ id: recipe.id, title: recipe.title, reason: '避开最近吃过的主食' }); continue; }
      ready.push({ recipe, cart });
    } catch (e) { failed.push({ id: recipe.id, title: recipe.title, ...templateFailure(recipe, codeStatus, names, e) }); }
  }
  // An external abort (the 10s recommendation budget) must not discard the quotes that
  // already finished: collect them as we go and return a partial report instead of throwing.
  const finished = [];
  let done = 0, partial = false;
  onProgress({ step: 3, text: `正在比较整单价格（0 / ${ready.length}）…`, benefits });
  try {
    await mapLimited(ready, async ({ recipe, cart }) => {
      try {
        const quote = await quoteBest(client, common, cart.items, benefits.usable, 64, { signal });
        // The report must not carry account-private coupon identifiers (couponId/couponCode):
        // orderItems are for create-order, and the buy flow re-prices (quoteBest directly)
        // to get fresh ones with coupons before ordering. Strip them here; the plan keeps
        // productCode / quantity / modification / roundList, which is all buyContext needs.
        const orderItems = (quote.orderItems || []).map(({ couponId, couponCode, ...rest }) => ({ ...rest }));
        finished.push({ ...pick(recipe, ['id', 'people', 'portion', 'title', 'wheelTitle', 'wheelKind']), ...quote, orderItems,
          packages: cart.packages, parts: cart.parts, mainCodes: cart.mainCodes, withinBudget: quote.priceFen <= request.people * request.budgetPerPersonFen });
      } catch (e) { stopIfAborted(signal, e); finished.push({ id: recipe.id, title: recipe.title, cause: 'api', reason: `整单核价（calculate-price）失败：${e?.message || '未返回'}` }); }
      finally { done++; onProgress({ step: 3, text: `正在比较整单价格（${done} / ${ready.length}）…`, benefits }); }
    }, 2);
  } catch (e) {
    if (!signal?.aborted) throw e;
    partial = true;
  }
  const quoted = finished.filter((r) => 'priceFen' in r).sort((a, b) => a.priceFen - b.priceFen || a.id.localeCompare(b.id));
  failed.push(...finished.filter((r) => !('priceFen' in r)));
  const complete = !partial && benefits.walletComplete && benefits.calendarComplete && !failed.length && quoted.every((p) => p.comparisonComplete);
  quoted.forEach((p) => { p.priceLabel = complete ? '候选范围内最低核价' : '最低已核验价'; });
  const expiry = Math.min(benefits.now + 300000, ...quoted.map((p) => dateValue(p.quotedAt) + 300000), ...benefits.usable.map((c) => c.expiresAt), ...benefits.cutoffs);
  // Partial (or the signal died after the loop): the signal is dead, so another now-time-info
  // would throw '已取消' — reuse the benefits timestamp and mark partial.
  if (signal?.aborted) partial = true;
  const completedAt = partial ? benefits.now : dateValue((await client.call('now-time-info', {}, { signal })).data.datetime);
  const validForSeconds = Math.max(0, Math.floor((expiry - completedAt) / 1000));
  const candidates = quoted.filter((p) => p.withinBudget);
  return { schemaVersion: 1, sourceKind: 'official-live-pre-wheel-pricing', context: { ...context }, request: { ...request, totalBudgetFen: request.people * request.budgetPerPersonFen },
    status: !validForSeconds ? 'expired' : candidates.length ? 'ready' : quoted.length || excluded.length ? 'empty' : 'unavailable',
    checkedAt: new Date(benefits.now).toISOString(), expiresAt: new Date(expiry).toISOString(), validForSeconds,
    priceComparisonComplete: complete, minimumVerifiedPriceFen: quoted[0]?.priceFen ?? null,
    partial, partialNote: partial ? `${ready.length - finished.length} 个候选未核完` : '',
    benefits: benefits.rows, claimableOffers: benefits.offers, campaignEntries: benefits.entries,
    counts: { ownedAssets: benefits.ownedCount, validatedCoupons: benefits.usable.length, claimableDisplayOffers: benefits.offers.length, campaignEntries: benefits.entries.length, quotedPlans: quoted.length, wheelCandidates: candidates.length },
    quotedPlans: quoted, candidates, failedPlans: failed, excludedPlans: excluded,
    // The store's real menu (kept local: never sent to DeepSeek) and what each template code did, for fallbacks and /why.
    menu: { ok: menuOk, error: menuError, shape: menuShape(rawMenu), items: [...index.values()] },
    templateCodes: [...codeStatus].map(([code, s]) => ({ code, name: names.get(code) || '', ...s })) };
}

export function prepareDemo(dataset, context, request) {
  validateRequest(request);
  const plans = dataset.plans.plans.filter((p) => p.people === request.people && (request.portion == null || p.portion === request.portion) && !p.mainCodes.some((c) => request.avoidMainCodes.includes(c)))
    .map((p) => ({ ...clone(p), basePriceFen: p.priceFen, savingFen: 0, couponNames: [], priceLabel: '历史样本价', withinBudget: p.priceFen <= request.people * request.budgetPerPersonFen }))
    .sort((a, b) => a.priceFen - b.priceFen || a.id.localeCompare(b.id));
  const candidates = plans.filter((p) => p.withinBudget);
  return { sourceKind: 'demo-snapshot', context, request: { ...request, totalBudgetFen: request.people * request.budgetPerPersonFen },
    status: candidates.length ? 'ready' : 'empty', validForSeconds: 0, checkedAt: dataset.plans.capturedAt,
    priceComparisonComplete: false, minimumVerifiedPriceFen: plans[0]?.priceFen ?? null,
    benefits: [], claimableOffers: dataset.offers.offers, campaignEntries: dataset.campaigns.events,
    counts: { ownedAssets: 0, validatedCoupons: 0, claimableDisplayOffers: dataset.offers.offers.length, quotedPlans: plans.length, wheelCandidates: candidates.length },
    quotedPlans: plans, candidates, failedPlans: [], excludedPlans: [] };
}

// Quote window. choose() stays beside it so the fair draw and the expiry share one clock.
// The terminal calls it for /wheel; the core order path does not.
export class QuoteWindow {
  constructor(now = () => performance.now()) { this.now = now; this.invalidate(); }
  invalidate() { this.report = null; this.seen = new Set(); this.validUntil = 0; }
  accept(report) { this.report = report; this.seen.clear(); this.validUntil = this.now() + Math.max(0, report.validForSeconds || 0) * 1000; }
  fresh() { return Boolean(this.report && (this.report.sourceKind === 'demo-snapshot' || this.now() < this.validUntil)); }
  remaining() { return this.fresh() ? this.report.candidates.filter((p) => !this.seen.has(p.id)) : []; }
  choose(cryptoSource = globalThis.crypto) {
    const pool = this.remaining(); requireValue(pool.length, this.fresh() ? '这一轮已经转完，请重新计算。' : '先重新核价，再转盘。');
    const max = Math.floor(4294967296 / pool.length) * pool.length; let draw;
    do { const buffer = new Uint32Array(1); cryptoSource.getRandomValues(buffer); draw = buffer[0]; } while (draw >= max);
    const plan = pool[draw % pool.length]; this.seen.add(plan.id); return { plan, pool, index: pool.indexOf(plan) };
  }
}
export class WheelSession extends QuoteWindow {}
export const buildCandidates = prepareWheel;
