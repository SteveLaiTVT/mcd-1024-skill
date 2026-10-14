// A candidate must be orderable before it can win "cheapest". ¥0 is not a price.
export function admit(candidate) {
  if (!candidate || candidate.cartError) return { ok: false, reason: 'cart' };
  if (candidate.priceError || !Number.isSafeInteger(candidate.priceFen)) return { ok: false, reason: 'quote' };
  if (!(candidate.priceFen > 0)) return { ok: false, reason: 'zero' };
  return { ok: true, reason: null };
}

export function skipLine(name, reason) {
  if (reason === 'cart') return `「${name}」这家店现在做不出来，已跳过`;
  if (reason === 'quote') return `「${name}」问不到价，已跳过`;
  if (reason === 'zero') return `「${name}」价格异常（¥0），已跳过`;
  return `「${name}」已跳过`;
}

export function allOut(n) {
  return `这家店现在没有能点的餐（${n} 个候选都没通过检查），换家店或调预算试试`;
}

export function applyGate(candidates) {
  const kept = [], skipped = [];
  for (const c of candidates || []) {
    const g = admit(c);
    if (g.ok) kept.push(c);
    else skipped.push({ name: c.title || c.name || '这道', reason: g.reason, line: skipLine(c.title || c.name || '这道', g.reason) });
  }
  return { kept, skipped };
}
