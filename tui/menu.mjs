// The store's actual menu (query-meals): a fallback when no template prices at this store, direct
// price questions ('牛肉堡多少钱'), and the real reason an answer came back empty. Prices shown as
// quotes come from calculate-price; menu prices are labelled 菜单价 and never treated as a quote.
import { quoteBest, menuItemCart } from '../web/meal-engine.mjs';
import { money } from './ansi.mjs';
import { isDrink } from './render.mjs';

export const MENU_FALLBACK_LIMIT = 6;
export const PRICE_QUOTE_LIMIT = 3;
const MEALISH = /套餐|件套|堡|巨无霸|卷|麦乐鸡|鸡块|鸡排|鸡翅|饭|桶/;
const SET = /套餐|件套|餐$/;
const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s™®·()（）]/g, '');
const byMenuPrice = (a, b) => (a.priceFen ?? Infinity) - (b.priceFen ?? Infinity) || a.code.localeCompare(b.code);
const stripCoupons = ({ couponId, couponCode, ...rest }) => ({ ...rest });

// Demo: the menu snapshot (data/menu.json) in the shape of menuIndex() entries.
export const snapshotMenu = (menu) => (menu?.items || []).map((i) => ({ code: i.productCode, name: i.name, category: '',
  priceFen: /^\d+(?:\.\d{1,2})?$/.test(String(i.menuPriceYuan)) ? Math.round(Number(i.menuPriceYuan) * 100) : null }));

// Menu items to price when no template works: food only, sets first, cheapest first.
// Nothing within the budget → the cheapest ones anyway, so the answer can say what the budget would need.
export function fallbackPicks(items, request, limit = MENU_FALLBACK_LIMIT) {
  const food = items.filter((m) => m.name && m.priceFen != null && MEALISH.test(m.name) && !isDrink(m.name));
  const within = food.filter((m) => m.priceFen <= request.budgetPerPersonFen);
  return (within.length ? within : food).sort((a, b) => (Number(!SET.test(a.name)) - Number(!SET.test(b.name))) || byMenuPrice(a, b)).slice(0, limit);
}

export function menuPlan(item, cart, request, quote, mainCodes = new Set()) {
  const name = cart.name || item.name;
  return { id: `menu-${item.code}`, kind: 'menu', people: 1, title: name,
    wheelTitle: name, wheelKind: '门店菜单', packages: cart.items[0]?.roundList ? [{ productCode: item.code, name, quantity: 1 }] : [],
    parts: cart.parts, mainCodes: [...new Set(cart.parts.filter((p) => mainCodes.has(p.code)).map((p) => p.code))], priceLabel: '官方核价（门店实际菜单）',
    basePriceFen: quote.basePriceFen, priceFen: quote.priceFen, savingFen: quote.savingFen, couponNames: quote.couponNames || [], quotedAt: quote.quotedAt,
    orderItems: (quote.orderItems || []).map(stripCoupons), takeWays: quote.takeWays || [], withinBudget: quote.priceFen <= request.budgetPerPersonFen };
}

// Live: one official whole-cart quote per picked menu item (same coupon comparison as set meals).
export async function liveMenuPlans(client, context, picks, request, coupons, mainCodes, onProgress = () => {}) {
  const common = { storeCode: context.storeCode, orderType: context.orderType, beType: context.beType }, avoid = new Set(request.avoidMainCodes || []);
  const plans = [], failed = [], excluded = [];
  for (const [i, m] of picks.entries()) {
    onProgress({ step: 4, text: `模板套餐这家店不可用，按门店实际菜单核价（${i + 1} / ${picks.length}）…` });
    try {
      const cart = await menuItemCart(client, common, m.code, 1, m.name);
      if (cart.parts.some((p) => avoid.has(p.code))) { excluded.push({ id: `menu-${m.code}`, title: m.name, reason: '避开最近吃过的主食' }); continue; }
      plans.push(menuPlan(m, cart, request, await quoteBest(client, common, cart.items, coupons), mainCodes));
    } catch (e) { failed.push({ id: `menu-${m.code}`, title: m.name, cause: 'api', reason: `门店菜单核价失败：${e?.message || '未返回'}` }); }
  }
  return { plans, failed, excluded };
}

// '牛肉堡' → menu items that are beef burgers. Literal name match first, then the meat + kind of food asked for.
const MEATS = [[/牛/, /牛(?!奶)|巨无霸|吉士|安格斯|1955|大堡口福|肉霸/], [/鸡/, /鸡/], [/鱼/, /鱼/], [/猪/, /猪/], [/虾/, /虾/]];
export function matchMenu(items, item) {
  const named = items.filter((m) => m.name);
  if (!item) return named.filter((m) => m.priceFen != null && MEALISH.test(m.name) && !isDrink(m.name)).sort(byMenuPrice);
  const key = norm(item), literal = named.filter((m) => norm(m.name).includes(key));
  if (literal.length) return literal.sort(byMenuPrice);
  const core = key.replace(/(?:汉堡|堡|套餐|三件套)$/, ''), kind = key.slice(core.length);
  const meat = MEATS.find(([k]) => k.test(core))?.[1];
  const kindRe = /堡/.test(kind) ? /堡|巨无霸/ : /套餐|件套/.test(kind) ? /套餐|件套/ : null;
  if (!meat && !core) return kindRe ? named.filter((m) => kindRe.test(m.name)).sort(byMenuPrice) : [];
  return named.filter((m) => (meat ? meat.test(m.name) : m.name.includes(core)) && (!kindRe || kindRe.test(m.name))).sort(byMenuPrice);
}

// Live price lookup: calculate-price on the cheapest few matches (quantity 1), cheapest official price first.
export async function quoteMenuItems(client, context, matches, coupons, limit = PRICE_QUOTE_LIMIT) {
  const common = { storeCode: context.storeCode, orderType: context.orderType, beType: context.beType }, quoted = [], failed = [];
  for (const m of matches.slice(0, limit)) {
    try {
      const cart = await menuItemCart(client, common, m.code, 1, m.name), q = await quoteBest(client, common, cart.items, coupons);
      quoted.push({ code: m.code, name: cart.name || m.name, menuPriceFen: m.priceFen, priceFen: q.priceFen, basePriceFen: q.basePriceFen, couponNames: q.couponNames || [] });
    } catch (e) { failed.push({ code: m.code, name: m.name, reason: e?.message || '未返回' }); }
  }
  return { quoted: quoted.sort((a, b) => a.priceFen - b.priceFen), failed };
}

// Why a pick came back with no candidate. Only 'budget' and 'want' (over budget for the
// named main) may ever suggest raising the budget.
export function emptyCause(report) {
  const quoted = report.quotedPlans || [], failed = report.failedPlans || [];
  // The user named a main (applyUpgrades set wantMissed) and none is in the pool: say so,
  // with the cheapest wanted plan even when it is over budget. Skip when allergy filtering
  // removed things — then the filtered/menu logic below explains it better.
  if (report.wantMissed && !(report.allergy?.excluded?.length)) {
    const want = new Set(report.wantMissed.codes || []);
    const wantedQuoted = quoted.filter((p) => p.mainCodes?.some((c) => want.has(c)));
    if (wantedQuoted.length) {
      const cheapest = [...wantedQuoted].sort((a, b) => a.priceFen - b.priceFen)[0];
      return { cause: 'want', cheapest, names: report.wantMissed.names || '', overBudget: !cheapest.withinBudget };
    }
    return { cause: 'want', cheapest: null, names: report.wantMissed.names || '' };
  }
  if (quoted.length && !quoted.some((p) => p.withinBudget)) {
    const cheapest = [...quoted].sort((a, b) => a.priceFen - b.priceFen)[0];
    return { cause: 'budget', cheapest, perPersonFen: cheapest.priceFen };
  }
  if (quoted.some((p) => p.withinBudget) || report.allergy?.excluded?.length || (report.excludedPlans || []).length) return { cause: 'filtered' };
  const api = failed.filter((p) => p.cause === 'api');
  if (report.menu && !report.menu.ok) return { cause: 'api', detail: `菜单接口 query-meals：${report.menu.error || '未返回'}` };
  if (failed.length && api.length === failed.length) return { cause: 'api', detail: api[0].reason };
  if (failed.length) return { cause: 'menu', failed: failed.filter((p) => p.cause !== 'api') };
  return { cause: 'none' };
}

const menuLine = (items, limit = 6) => items.slice(0, limit).map((m) => `${m.name} ${m.priceFen != null ? money(m.priceFen) : '价格未返回'}`).join('、');

// The answer card for 0 candidates: { title, lines }, naming the real cause.
export function renderEmpty(report, P) {
  const why = emptyCause(report), r = report.request, menu = report.menu?.items || [];
  const available = matchMenu(menu, null), allergyOut = report.allergy?.excluded?.length || 0;
  const showMenu = available.length ? [`这家店现在能点的（菜单价，未核价）：${menuLine(available)}`, P.gray('想知道某样多少钱，直接问“巨无霸多少钱”。')] : [];
  if (why.cause === 'budget') {
    const c = why.cheapest, perPerson = why.perPersonFen;
    return { title: '预算不够', lines: [P.yellow(`预算内没有候选：最便宜的「${c.title}」要 ${money(c.priceFen)}，你的预算是 ${money(r.budgetPerPersonFen)}。`),
      `把预算提到 ${money(perPerson)} 就能选到它，例如说“预算 ${Math.ceil(perPerson / 100)}”。`, P.gray('/why 查看核价明细')] };
  }
  if (why.cause === 'want') {
    const names = why.names || '你点的';
    if (why.cheapest) {
      const c = why.cheapest, perPerson = c.priceFen;
      return { title: '预算内没有你点的', lines: [P.yellow(`预算内没有含「${names}」的选项。最便宜的含你点的是「${c.title}」${money(c.priceFen)}。`),
        `把预算提到 ${money(perPerson)} 就能选它，例如说“预算 ${Math.ceil(perPerson / 100)}”。`, ...showMenu, P.gray('/why 查看核价明细')] };
    }
    return { title: '这家店没有你点的', lines: [P.yellow(`这家店没有含「${names}」的选项（菜单里没有，或都被排除了）。`), ...showMenu, P.gray('/why 查看核价明细')] };
  }
  if (why.cause === 'filtered') {
    return { title: '都被筛掉了', lines: [P.yellow('有报价，但都被你的条件排除了，不是预算问题。'),
      [allergyOut ? `过敏筛选排除了 ${allergyOut} 份（不会为了凑数放宽）` : '', (report.excludedPlans || []).some((p) => /避开/.test(p.reason)) ? '避开项排除了一部分' : ''].filter(Boolean).join('；') + '。',
      P.gray('/why 查看每一份被排除的原因')] };
  }
  if (why.cause === 'api') {
    return { title: '接口异常', lines: [P.yellow(`不是预算问题：麦当劳接口这次没有正常返回（${why.detail || '未返回'}）。`), '稍后再问一次，或 /store 换一家店。', ...showMenu, P.gray('/why 查看每一步')] };
  }
  if (why.cause === 'menu') {
    const tried = report.menuFallback?.tried || 0;
    return { title: '这家店查不到这些套餐', lines: [P.yellow(`不是预算问题，提高预算也没用：${why.failed.length} 份模板套餐在这家店用不了（菜单接口 query-meals / query-meal-detail 查不到，或搭配对不上）。`),
      ...why.failed.slice(0, 2).map((p) => P.gray(`· ${p.title}：${p.reason}`)),
      ...(tried ? [`也按门店实际菜单试了 ${tried} 样，没有核价成功。`] : []), ...showMenu, P.gray('/why 查看菜单接口返回了什么')] };
  }
  return { title: '没有找到合适的', lines: ['这次没有拿到任何套餐或单点报价。', ...showMenu, P.gray('/why 查看每一步')] };
}

// '牛肉堡多少钱' → one answer: cheapest official price, what that means as a budget, and a few alternatives.
export function renderPriceAnswer(result, P, { storeName = '' } = {}) {
  const ask = result.item || '最便宜的餐', lines = [];
  if (!result.matches.length) {
    lines.push(P.yellow(`这家店的菜单里没有找到「${ask}」。`));
    const cheapest = matchMenu(result.items, null);
    if (cheapest.length) lines.push(`这家店能点的最便宜的（菜单价）：${menuLine(cheapest, 5)}`);
  } else if (result.sample) {
    const m = result.matches[0];
    lines.push(`${P.brand(P.bold(m.name))}  ${P.bold(money(m.priceFen))} ${P.gray('菜单样本价')}`, `最低预算：${money(m.priceFen)} 就够吃到「${ask}」。`);
    if (result.matches.length > 1) lines.push(`同类还有：${menuLine(result.matches.slice(1), 5)}`);
    lines.push(P.yellow('样本价，仅供体验；实时价格请连接后再问。'));
  } else if (result.quoted.length) {
    const best = result.quoted[0], coupon = best.couponNames.length ? P.cyan(` · 已用券 ${best.couponNames.join('、')}，原价 ${money(best.basePriceFen)}`) : '';
    lines.push(`${P.brand(P.bold(best.name))}  ${P.bold(money(best.priceFen))} ${P.gray('官方核价 · 到店自取')}${coupon}`,
      `最低预算：${money(best.priceFen)} 就能吃到「${ask}」（单点一份）。`);
    const others = [...result.quoted.slice(1).map((q) => `${q.name} ${money(q.priceFen)}`), ...result.matches.filter((m) => !result.quoted.some((q) => q.code === m.code)).slice(0, 4).map((m) => `${m.name} ${m.priceFen != null ? `${money(m.priceFen)}（菜单价）` : ''}`)];
    if (others.length) lines.push(`同类还有：${others.join('、')}`);
  } else {
    lines.push(P.yellow(`找到了「${ask}」，但这次官方核价没有成功（${result.failed[0]?.reason || '未返回'}）。`), `菜单价：${menuLine(result.matches, 5)}`);
  }
  lines.push(`门店：${storeName || '未选门店'}`, P.gray('想直接挑一餐就说“预算 30 来一份”。'));
  return lines;
}
