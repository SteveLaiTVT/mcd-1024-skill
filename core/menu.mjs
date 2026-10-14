// Menu index, detail parsing, and the short-list ingredient prefetch.
import { detailOf, menuIndex, menuShape, menuItemCart, resolveCode } from './pricing.mjs';

export { detailOf, menuIndex, menuShape, menuItemCart, resolveCode };

// Product-name meat classes. 吉士 counts as beef on purpose (known false positive with 吉士猪柳蛋).
export const MEAT_KINDS = Object.freeze([
  { label: '牛肉', ask: /牛(?!奶)/, name: /牛(?!奶)|巨无霸|吉士|安格斯|1955|大堡口福|肉霸/ },
  { label: '鸡肉', ask: /鸡/, name: /鸡/ },
  { label: '鱼', ask: /鱼/, name: /鱼/ },
  { label: '猪肉', ask: /猪/, name: /猪/ },
  { label: '虾', ask: /虾/, name: /虾/ },
]);

export function meatsInName(name) {
  const text = String(name || '');
  return MEAT_KINDS.filter((k) => k.name.test(text)).map((k) => k.label);
}

const MAIN_NAME = /牛(?!奶)|鸡|猪|鱼|虾|堡|饭/;

export function shortlistMeals(items, limit = 8) {
  const mains = (items || []).filter((m) => m?.code && MAIN_NAME.test(String(m.name || '')));
  return mains.slice(0, limit);
}

function removableOf(detail) {
  const names = [];
  for (const group of detail?.modification?.items || []) {
    for (const v of group.values || []) if (Number(v.selectedQuantity) > 0 && v.unselectedKey && v.name) names.push(String(v.name));
  }
  for (const round of detail?.rounds || []) for (const c of round.choices || []) {
    if (!(c.quantity > 0 || c.isDefault)) continue;
    for (const group of c.modification?.items || []) {
      for (const v of group.values || []) if (Number(v.selectedQuantity) > 0 && v.unselectedKey && v.name) names.push(String(v.name));
    }
  }
  return [...new Set(names)];
}

function partsOf(detail) {
  const parts = [];
  for (const round of detail?.rounds || []) {
    for (const c of round.choices || []) if ((c.quantity > 0 || c.isDefault) && c.name) parts.push({ name: String(c.name), qty: c.quantity > 0 ? c.quantity : 1 });
  }
  return parts;
}

// The public detail payload does not include a full ingredient table. Callers must say so.
export function parseDetail(detail, meal = {}) {
  const full = Array.isArray(detail?.ingredients) && detail.ingredients.length > 0;
  return {
    code: meal.code || detail?.code || '',
    name: detail?.name || meal.name || '',
    parts: partsOf(detail),
    removable: removableOf(detail),
    meatKind: meatsInName(detail?.name || meal.name || ''),
    complete: full,
    unknown: false,
  };
}

export async function prefetchDetails(client, common, items, { limit = 8 } = {}) {
  const pool = shortlistMeals(items, limit);
  const cache = {};
  await Promise.all(pool.map(async (meal) => {
    try {
      const data = detailOf((await client.call('query-meal-detail', { ...common, code: meal.code })).data, meal.code);
      if (!data) cache[meal.code] = { code: meal.code, name: meal.name, parts: [], removable: [], meatKind: meatsInName(meal.name), complete: false, unknown: true };
      else cache[meal.code] = parseDetail(data, meal);
    } catch {
      cache[meal.code] = { code: meal.code, name: meal.name, parts: [], removable: [], meatKind: meatsInName(meal.name), complete: false, unknown: true };
    }
  }));
  return cache;
}

// Ingredient prefetch for the meals the user actually sees: the ranked candidates'
// orderItems product codes, cached by code. Replaces menu-wide prefetching, which
// fetched unrelated items and could answer "有什么料" with the wrong meal.
export async function prefetchCandidateDetails(client, common, candidates, { limit = 4, signal } = {}) {
  const cache = {};
  const seen = new Set();
  const jobs = [];
  for (const cand of (candidates || []).slice(0, limit)) {
    if (!cand) continue;
    const codes = [...new Set([cand.id, ...(cand.orderItems || []).map((i) => i?.productCode)].filter(Boolean))];
    for (const code of codes) {
      if (seen.has(code)) continue;
      seen.add(code);
      jobs.push((async () => {
        try {
          const data = detailOf((await client.call('query-meal-detail', { ...common, code }, { signal })).data, code);
          cache[code] = data
            ? parseDetail(data, { code, name: cand.title })
            : { code, name: cand.title, parts: [], removable: [], meatKind: meatsInName(cand.title), complete: false, unknown: true };
        } catch {
          cache[code] = { code, name: cand.title, parts: [], removable: [], meatKind: meatsInName(cand.title), complete: false, unknown: true };
        }
      })());
    }
  }
  await Promise.all(jobs);
  return cache;
}
