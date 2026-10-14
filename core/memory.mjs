// Session memory and the local taste profile. Allergy values stay on disk and in
// the session object. They are stripped before anything is stored as a turn or summarised.

const ALLERGY_CLAUSE = /过敏|忌口|不耐受/;

export function stripAllergyText(text, allergies = []) {
  let out = String(text || '').normalize('NFKC').split(/[，,。；;！!？?\n]+/).map((c) => c.trim()).filter((c) => c && !ALLERGY_CLAUSE.test(c)).join('，');
  for (const a of allergies) if (a) out = out.split(a).join('');
  return out;
}

export function emptyTaste() {
  return { meats: [], likes: [], less: [], budgetYuan: null };
}

const clip = (s, n) => [...String(s || '')].slice(0, n).join('');

export function pushTurn(turns, { text, summary }) {
  const next = [...(turns || []), { text: clip(text, 200), summary: clip(summary || text, 80), ts: Date.now() }];
  return next.slice(-4);
}

// Concrete allergen names never enter this string. The placeholder is the only allergy signal.
export function profileSummary({ taste = emptyTaste(), hasAllergy = false } = {}) {
  const bits = [];
  if (taste.meats?.length) bits.push(`偏好${taste.meats.join('、')}`);
  if (taste.budgetYuan) bits.push(`预算${taste.budgetYuan}内`);
  const likes = (taste.likes || []).slice(-3).map((x) => x.name || x).filter(Boolean);
  if (likes.length) bits.push(`常点${likes.join('、')}`);
  if (hasAllergy) bits.push('有忌口（详情本地）');
  return bits.join('、') || '还没有口味记录';
}

// Preference points, then coupon price. Allergy conflicts are removed by the caller before this runs.
export function reRank(candidates, { taste = emptyTaste(), meatOf = () => [] } = {}) {
  const liked = new Set((taste.likes || []).map((x) => x.code || x.name || x));
  const less = new Set((taste.less || []).map((x) => x.code || x.name || x));
  const meats = new Set(taste.meats || []);
  const scored = candidates.map((c) => {
    const names = [c.title, ...(c.parts || []).map((p) => p.name)].filter(Boolean);
    const kinds = new Set(names.flatMap((n) => meatOf(n)));
    let score = 0;
    if ([...meats].some((m) => kinds.has(m))) score += 2;
    const codes = [c.id, ...(c.mainCodes || []), c.title];
    if (codes.some((id) => liked.has(id))) score += 2;
    if (codes.some((id) => less.has(id))) score -= 2;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.c.priceFen ?? 0) - (b.c.priceFen ?? 0) || String(a.c.id).localeCompare(String(b.c.id)));
  return scored.map((s) => s.c);
}

export function rememberFeedback(taste, plan, vote) {
  const next = { ...emptyTaste(), ...taste, likes: [...(taste.likes || [])], less: [...(taste.less || [])] };
  const entry = { code: plan.mainCodes?.[0] || plan.id, name: plan.title };
  const drop = (list) => list.filter((x) => x.code !== entry.code && x.name !== entry.name);
  if (vote === 'like') next.likes = [...drop(next.likes), entry].slice(-40);
  else if (vote === 'less') next.less = [...drop(next.less), entry].slice(-40);
  else throw new Error('Invalid feedback');
  return next;
}
