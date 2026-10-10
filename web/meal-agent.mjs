import { agentSystemPrompt } from './agent-prompts.mjs';
import { memorySummary } from './agent-memory.mjs';
const require = (condition) => { if (!condition) throw new Error('推荐结果未通过餐单校验，可改用本地推荐。'); };
const clean = (v, max = 120) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

export function prepareAgentInput(report, settings, context, mood = 'normal') {
  const avoided = new Set(report.request.avoidMainCodes || []), ids = new Set();
  const candidates = report.candidates.filter((p) => {
    require(p && clean(p.id, 100) === p.id && p.id && !ids.has(p.id)); ids.add(p.id);
    require(Number.isSafeInteger(p.priceFen) && p.priceFen >= 0 && p.priceFen <= report.request.totalBudgetFen && p.people === report.request.people && (p.portion == null || p.portion === report.request.portion) && !p.mainCodes?.some((code) => avoided.has(code)));
    return true;
  });
  require(candidates.length > 0);
  const memory = memorySummary(settings.feedback, context.calendar.date), known = new Map(memory.map((f) => [f.code, f]));
  const minimum = Math.min(...candidates.map((p) => p.priceFen));
  const scored = candidates.map((p) => {
    const parts = (p.parts || []).slice(0, 20), mains = p.mainCodes || [], memories = mains.map((c) => known.get(c)).filter(Boolean);
    const affinity = memories.reduce((sum, f) => sum + f.score, 0) / Math.max(1, mains.length);
    const fresh = !memories.length;
    const names = parts.map((f) => f.name).join(' '), weather = context.weather;
    const weatherMatch = weather?.status === 'available' && ((weather.feelsLikeC >= 27 && /冰|麦旋风|圣代/.test(names)) || (weather.feelsLikeC <= 18 && /热(?:美式|拿铁|咖啡|茶|牛奶|豆浆)|(?:美式|拿铁|咖啡|茶|牛奶|豆浆)[（(·\s]*热/.test(names)));
    const occasion = Boolean(context.calendar.holiday || context.calendar.upcoming || ['comfort', 'gathering'].includes(mood));
    const allowedSignals = ['balanced', ...(p.priceFen === minimum ? ['value'] : []), ...(affinity > 0 ? ['memory'] : []), ...(weatherMatch ? ['weather'] : []), ...(fresh ? ['variety'] : []), ...(occasion ? ['occasion'] : []), ...(settings.personalPrompt ? ['preference'] : [])];
    const score = affinity * (settings.goal === 'variety' ? 3 : 8) + (fresh ? settings.goal === 'variety' ? 14 : 2 : 0) + (weatherMatch ? 4 : 0) + 10 * minimum / Math.max(1, p.priceFen);
    return { plan: p, score, data: { id: p.id, title: clean(p.title), priceFen: p.priceFen, people: p.people, parts: parts.map((f) => ({ name: clean(f.name), quantity: f.quantity })), allowedSignals } };
  }).sort((a, b) => settings.goal === 'cheapest' ? a.plan.priceFen - b.plan.priceFen || b.score - a.score : b.score - a.score || a.plan.priceFen - b.plan.priceFen);
  const shortlist = scored.slice(0, 12);
  const eligibleIds = shortlist.filter((p) => settings.goal !== 'cheapest' || p.plan.priceFen === minimum).map((p) => p.plan.id);
  return { scored: shortlist, input: { schemaVersion: 1, goal: settings.goal, mood, persona: settings.persona, personalPreferences: settings.personalPrompt,
    constraints: { people: report.request.people, portion: report.request.portion, totalBudgetFen: report.request.totalBudgetFen },
    source: { kind: report.sourceKind, checkedAt: report.checkedAt, comparisonComplete: report.priceComparisonComplete, scope: '当前已核价候选范围' },
    context: { calendar: context.calendar, weather: context.weather },
    memory: memory.map(({ code, ...rest }) => rest), eligibleIds, candidates: shortlist.map((p) => p.data) } };
}
export function validateAgentChoice(value, input) {
  require(exactKeys(value, ['choices', 'vibe']) && ['cozy', 'playful', 'frugal'].includes(value.vibe) && Array.isArray(value.choices) && value.choices.length >= 1 && value.choices.length <= Math.min(3, input.eligibleIds.length));
  const seen = new Set(), byId = new Map(input.candidates.map((p) => [p.id, p]));
  for (const choice of value.choices) {
    require(exactKeys(choice, ['id', 'signals']) && input.eligibleIds.includes(choice.id) && !seen.has(choice.id)); seen.add(choice.id);
    require(Array.isArray(choice.signals) && choice.signals.length >= 1 && choice.signals.length <= 3 && new Set(choice.signals).size === choice.signals.length && choice.signals.every((s) => byId.get(choice.id).allowedSignals.includes(s)));
  }
  return { choices: value.choices.map((c) => ({ id: c.id, signals: [...c.signals] })), vibe: value.vibe };
}
export function localRecommendation(prepared, persona) {
  const eligible = prepared.scored.filter((p) => prepared.input.eligibleIds.includes(p.plan.id));
  const value = { choices: eligible.slice(0, 3).map((p) => ({ id: p.plan.id, signals: p.data.allowedSignals.filter((s) => s !== 'preference').sort((a, b) => ['memory', 'weather', 'value', 'variety', 'occasion', 'balanced'].indexOf(a) - ['memory', 'weather', 'value', 'variety', 'occasion', 'balanced'].indexOf(b)).slice(0, 3) })), vibe: persona };
  return validateAgentChoice(value, prepared.input);
}
export async function runMealAgents({ report, settings, context, mood, client = null, signal, onStage = () => {}, fresh = () => true }) {
  const prepared = prepareAgentInput(report, settings, context, mood);
  const check = () => { if (signal?.aborted || !fresh()) throw new Error('条件或报价已更新，请重新推荐。'); };
  check();
  if (!client) return { ...localRecommendation(prepared, settings.persona), source: 'local', rounds: 0, stages: [] };
  const stages = [], roles = settings.mode === 'team' ? ['recommend', 'optimize'] : [settings.mode];
  let previous = null;
  for (const role of roles) {
    check(); onStage(role);
    const input = { ...prepared.input, customPrompt: role === 'recommend' ? settings.recommendPrompt : settings.optimizePrompt, previousRecommendation: previous };
    const started = performance.now();
    const raw = await client.complete(agentSystemPrompt(role, settings), input, { signal }); check();
    previous = validateAgentChoice(raw, prepared.input);
    stages.push({ role, primaryId: previous.choices[0].id, durationMs: Math.round(performance.now() - started) });
  }
  return { ...previous, source: 'deepseek', rounds: roles.length, stages };
}
