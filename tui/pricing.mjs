// À la carte mains next to set meals, ranked by effective price after coupons.
// Live prices come from the official calculate-price quote (same coupon comparison
// as set meals); demo prices from the menu snapshot. Nothing here invents a discount.
import { quoteBest, menuItemCart } from '../core/pricing.mjs';
import { money } from './ansi.mjs';

// Wanting a specific main: a set meal with it wins if it costs at most this much more per person.
export const UPGRADE_MAX_FEN_PER_PERSON = 500;

const fen = (yuan) => /^\d+(?:\.\d{1,2})?$/.test(String(yuan)) ? Math.round(Number(yuan) * 100) : null;
const isAlaCarte = (p) => p.kind === 'alacarte';

// Mains worth pricing alone: the mains in the template sets (for the à la carte vs set
// upgrade math) plus any main the user asked for. Pricing every main would be a
// calculate-price call each, so the rest stay out of the pool.
export function alaCarteMains(mainNames, request, templateCodes = new Set()) {
  const avoid = new Set(request.avoidMainCodes || []), want = new Set(request.wantMainCodes || []);
  return [...mainNames].filter(([code]) => !avoid.has(code) && (templateCodes.has(code) || want.has(code))).map(([code, name]) => ({ code, name }));
}

export function alaCartePlan({ code, name }, request, quote, priceLabel) {
  // One meal for one person: quantity is always 1, and the budget is the total.
  return { id: `alacarte-${code}`, kind: 'alacarte', people: 1,
    title: `单点 · ${name}`, wheelTitle: name, wheelKind: '单点主食',
    packages: [], parts: [{ code, name, quantity: 1 }], mainCodes: [code], priceLabel,
    basePriceFen: quote.basePriceFen, priceFen: quote.priceFen, savingFen: quote.savingFen, couponNames: quote.couponNames || [],
    ...(quote.quotedAt ? { quotedAt: quote.quotedAt } : {}), ...(quote.orderItems ? { orderItems: quote.orderItems, takeWays: quote.takeWays || [] } : {}), withinBudget: quote.priceFen <= request.budgetPerPersonFen };
}

// Demo: menu snapshot prices, no coupons.
export function demoAlaCarte(menu, mains, request) {
  const prices = new Map((menu?.items || []).map((i) => [i.productCode, fen(i.menuPriceYuan)]));
  return mains.filter((m) => prices.get(m.code) != null).map((m) =>
    alaCartePlan(m, request, { basePriceFen: prices.get(m.code), priceFen: prices.get(m.code), savingFen: 0, couponNames: [] }, '菜单样本价'));
}

// Live: one official whole-cart quote per main, with the same held-coupon comparison as set meals.
export async function liveAlaCarte(client, context, mains, request, coupons, onProgress = () => {}, { signal } = {}) {
  const common = { storeCode: context.storeCode, orderType: context.orderType, beType: context.beType }, plans = [], failed = [];
  for (const [i, m] of mains.entries()) {
    onProgress({ step: 4, text: `正在核价单点主食（${i + 1} / ${mains.length}）…` });
    try {
      const cart = await menuItemCart(client, common, m.code, 1, m.name, { signal });
      plans.push(alaCartePlan(m, request, await quoteBest(client, common, cart.items, coupons, 64, { signal }), '官方单点核价'));
    } catch (e) {
      if (signal?.aborted) throw e;
      failed.push({ id: `alacarte-${m.code}`, title: `单点 · ${m.name}`, cause: 'cart', reason: '这家店现在做不出来', cartError: true });
    }
  }
  return { plans, failed };
}

// Cheapest first; at the same price a set meal ranks above the à la carte main.
const byPrice = (a, b) => a.priceFen - b.priceFen || Number(isAlaCarte(a)) - Number(isAlaCarte(b)) || a.id.localeCompare(b.id);

export function mergeAlaCarte(report, { plans = [], failed = [] }) {
  report.quotedPlans = [...report.quotedPlans, ...plans].sort(byPrice);
  report.candidates = report.quotedPlans.filter((p) => p.withinBudget);
  report.failedPlans = [...report.failedPlans, ...failed];
  return report;
}

const extrasOf = (plan, mainCode) => [...new Set((plan.parts || []).filter((p) => p.code !== mainCode).map((p) => p.name))];

// Upgrade math between each à la carte main and the cheapest in-budget set meal with the same main.
// Sets that cost the same or less always beat à la carte; for a main the user asked for, a set within
// UPGRADE_MAX_FEN_PER_PERSON more also wins. Otherwise à la carte stays and cheapest wins.
export function applyUpgrades(report, mainNames = new Map()) {
  const request = report.request, want = new Set(request.wantMainCodes || []), notes = [], dropped = [];
  const limit = UPGRADE_MAX_FEN_PER_PERSON;
  const singles = report.quotedPlans.filter(isAlaCarte);
  const sets = report.candidates.filter((p) => !isAlaCarte(p));
  for (const single of singles) {
    const code = single.mainCodes[0], name = mainNames.get(code) || single.wheelTitle;
    const set = sets.filter((p) => p.mainCodes?.includes(code)).sort(byPrice)[0];
    if (!set) continue;
    const upgrade = { mainName: name, alaCarteFen: single.priceFen, setFen: set.priceFen, setTitle: set.title, deltaFen: set.priceFen - single.priceFen,
      extras: extrasOf(set, code), wanted: want.has(code) };
    const setWins = upgrade.deltaFen <= 0 || (want.has(code) && upgrade.deltaFen <= limit);
    set.upgrade = { ...upgrade, chosen: setWins ? 'set' : 'alacarte' };
    single.upgrade = { ...set.upgrade };
    if (setWins && report.candidates.includes(single)) dropped.push({ single, set });
  }
  if (dropped.length) {
    const ids = new Set(dropped.map((d) => d.single.id));
    report.candidates = report.candidates.filter((p) => !ids.has(p.id));
    report.excludedPlans = [...report.excludedPlans, ...dropped.map(({ single, set }) => ({ id: single.id, title: single.title,
      reason: set.priceFen <= single.priceFen ? `同主食套餐「${set.title}」不比单点贵，推荐套餐` : `你点名的主食：套餐只多 ${money(set.priceFen - single.priceFen)}，推荐套餐` }))];
  }
  // A named main narrows the pool to options containing it, when any are left.
  // When none are left, do NOT silently substitute (e.g. chicken for a beef request):
  // clear the pool and record the miss, so the flow returns an empty card that names
  // the wanted main (emptyCause finds the cheapest wanted plan, even over budget).
  if (want.size) {
    const named = report.candidates.filter((p) => p.mainCodes?.some((c) => want.has(c)));
    const names = [...want].map((c) => mainNames.get(c) || c).join('、');
    if (named.length) { report.candidates = named; notes.push(`按你点名的「${names}」只在含它的选项里挑（单点与套餐都比）。`); }
    else { report.candidates = []; report.wantMissed = { names, codes: [...want] }; notes.push(`没有含「${names}」的候选，不做替代推荐。`); }
  }
  report.pricingNotes = notes;
  return report;
}

// '单点主食 ¥A，+¥X 可得套餐（含薯条+饮料）' and friends.
export function upgradeText(u) {
  const extras = u.extras.length ? `（含${u.extras.join('+')}）` : '';
  if (u.deltaFen < 0) return `单点${u.mainName} ${money(u.alaCarteFen)}，套餐只要 ${money(u.setFen)}${extras}，比单点还省 ${money(-u.deltaFen)}`;
  if (u.deltaFen === 0) return `单点${u.mainName} ${money(u.alaCarteFen)}，同价可得套餐${extras}`;
  const head = `单点${u.mainName} ${money(u.alaCarteFen)}，+${money(u.deltaFen)} 可得套餐${extras}`;
  if (u.chosen === 'set') return head;
  return u.wanted ? `${head}；超过升级线（+${money(UPGRADE_MAX_FEN_PER_PERSON)}），单点更省` : `${head}；单点更省`;
}
