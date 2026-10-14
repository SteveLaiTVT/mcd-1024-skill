// Numbered recommendations and the user-triggered blind box. No persona, no weather, no template reasons.
import { reRank } from './memory.mjs';
import { meatsInName } from './menu.mjs';
import { applyGate, allOut } from './eligibility.mjs';

export function defaultPreferences() {
  return { version: 1, goal: 'cheapest', feedback: [] };
}

export function learnFeedback(preferences, plan, vote, mainCodes, date) {
  if (!['like', 'less'].includes(vote)) throw new Error('Invalid feedback');
  const valid = new Set(mainCodes || []);
  const entry = { planId: plan.id, title: plan.title, vote, date, foods: (plan.parts || []).filter((p) => !valid.size || valid.has(p.code)).map((p) => ({ code: p.code, name: p.name })) };
  const feedback = (preferences.feedback || []).filter((f) => f.planId !== plan.id || f.date !== date);
  return { ...preferences, feedback: [...feedback, entry].slice(-80) };
}

// One verifiable sentence. No season and no time of day.
export function factReason(plan, { rank, taste, cheaper } = {}) {
  const bits = [];
  if (plan.savingFen > 0) bits.push(`券后价第 ${rank}，省 ¥${(plan.savingFen / 100).toFixed(2)}`);
  else if (rank) bits.push(`券后价第 ${rank}`);
  const meats = new Set([plan.title, ...(plan.parts || []).map((p) => p.name)].flatMap((n) => meatsInName(n)));
  const hit = (taste?.meats || []).find((m) => meats.has(m));
  if (hit) bits.push(`你常点${hit}`);
  if (cheaper === 0 && rank === 1) bits.push('这是预算内最便宜的一份');
  return bits.slice(0, 2).join('；');
}

export function rankCandidates(candidates, { taste, budgetFen, wantMeats } = {}) {
  const { kept, skipped } = applyGate(candidates);
  const within = budgetFen == null ? kept : kept.filter((c) => c.priceFen <= budgetFen);
  const over = kept.filter((c) => budgetFen != null && c.priceFen > budgetFen);
  const ranked = reRank(within, { taste, meatOf: meatsInName, wantMeats });
  return { ranked: ranked.slice(0, 3), skipped, overBudget: over.length, emptyLine: ranked.length ? '' : allOut(skipped.length + over.length) };
}

// Blind box: a random main that already passed the gate and the budget. No category argument.
export function blindboxPick(candidates, { taste, budgetFen, random = Math.random } = {}) {
  const { ranked, skipped, emptyLine } = rankCandidates(candidates, { taste, budgetFen: null });
  const pool = (candidates || []).filter((c) => {
    if (!applyGate([c]).kept.length) return false;
    if (budgetFen != null && !(c.priceFen <= budgetFen)) return false;
    const mains = c.mainCodes?.length || meatsInName(c.title).length;
    return mains > 0;
  });
  if (!pool.length) return { plan: null, pool: [], skipped, emptyLine: emptyLine || allOut(skipped.length), ranked };
  const index = Math.floor(random() * pool.length);
  return { plan: pool[index], pool, skipped, emptyLine: '', ranked, index };
}
