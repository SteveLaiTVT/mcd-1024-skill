import { createLocalRecord } from './local-record.mjs';
import { DEFAULT_RECOMMEND_PROMPT, DEFAULT_OPTIMIZE_PROMPT } from './agent-prompts.mjs';
export const AGENT_KEY = 'mcd-wheel.agent-preferences.v1';
export const DEEPSEEK_KEY = 'mcd-wheel.deepseek.v1';
const text = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const pick = (v, options, fallback) => options.includes(v) ? v : fallback;
export function defaultPreferences() {
  return { version: 1, persona: 'cozy', goal: 'balanced', mode: 'team', personalPrompt: '', recommendPrompt: DEFAULT_RECOMMEND_PROMPT, optimizePrompt: DEFAULT_OPTIMIZE_PROMPT, weatherEnabled: true, rememberMemory: false, feedback: [] };
}
export function normalizePreferences(value) {
  if (!value || value.version !== 1) return null;
  const feedback = (Array.isArray(value.feedback) ? value.feedback : []).slice(-80).flatMap((entry) => {
    if (!entry || !['like', 'less'].includes(entry.vote) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !text(entry.planId, 100)) return [];
    const parsed = new Date(`${entry.date}T12:00:00Z`);
    if (!Number.isFinite(Number(parsed)) || parsed.toISOString().slice(0, 10) !== entry.date) return [];
    const foods = (Array.isArray(entry.foods) ? entry.foods : []).slice(0, 8).flatMap((food) => text(food?.code, 80) && text(food?.name, 100) ? [{ code: text(food.code, 80), name: text(food.name, 100) }] : []);
    return [{ planId: text(entry.planId, 100), title: text(entry.title, 120), date: entry.date, vote: entry.vote, foods }];
  });
  return { version: 1, persona: pick(value.persona, ['cozy', 'frugal', 'playful'], 'cozy'), goal: pick(value.goal, ['balanced', 'cheapest', 'variety'], 'balanced'), mode: pick(value.mode, ['recommend', 'optimize', 'team'], 'team'), personalPrompt: text(value.personalPrompt, 600), recommendPrompt: text(value.recommendPrompt, 1200) || DEFAULT_RECOMMEND_PROMPT, optimizePrompt: text(value.optimizePrompt, 1200) || DEFAULT_OPTIMIZE_PROMPT, weatherEnabled: value.weatherEnabled !== false, rememberMemory: value.rememberMemory === true, feedback: value.rememberMemory === true ? feedback : [] };
}
export function normalizeDeepSeek(value) {
  if (!value || value.version !== 1 || typeof value.token !== 'string') return null;
  const token = value.token.trim().replace(/^Bearer\s+/i, '');
  return /^[A-Za-z0-9._-]{8,512}$/.test(token) ? { version: 1, token } : null;
}
export function createAgentStorage(options = {}) {
  return { preferences: createLocalRecord({ ...options, key: AGENT_KEY, normalize: normalizePreferences }), credentials: createLocalRecord({ ...options, key: DEEPSEEK_KEY, normalize: normalizeDeepSeek }) };
}
export function learnFeedback(preferences, plan, vote, mainCodes, date) {
  if (!['like', 'less'].includes(vote)) throw new Error('Invalid feedback');
  const valid = new Set(mainCodes);
  const entry = { planId: plan.id, title: plan.title, vote, date, foods: (plan.parts || []).filter((p) => valid.has(p.code)).map((p) => ({ code: p.code, name: p.name })) };
  const feedback = preferences.feedback.filter((f) => f.planId !== plan.id || f.date !== date);
  return { ...preferences, feedback: [...feedback, entry].slice(-80) };
}
export function memorySummary(feedback, today) {
  const foods = new Map(), now = Date.parse(`${today}T12:00:00+08:00`);
  for (const entry of feedback) {
    const age = (now - Date.parse(`${entry.date}T12:00:00+08:00`)) / 86400000;
    if (!Number.isFinite(age) || age < 0) continue;
    const weight = 2 ** (-age / 90);
    for (const food of entry.foods) {
      const item = foods.get(food.code) || { code: food.code, name: food.name, likes: 0, less: 0, score: 0, lastDate: entry.date };
      item[entry.vote === 'like' ? 'likes' : 'less']++; item.score += (entry.vote === 'like' ? 1 : -1.5) * weight;
      if (entry.date > item.lastDate) item.lastDate = entry.date;
      foods.set(food.code, item);
    }
  }
  return [...foods.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)).slice(0, 32).map((f) => ({ ...f, score: Math.round(Math.max(-3, Math.min(3, f.score)) * 100) / 100 }));
}
