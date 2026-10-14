// Integer fen. Shared by pricing and the terminal budget command.
export function requireValue(condition, message) { if (!condition) throw new Error(message); }
const amount = (v) => Number.isSafeInteger(v) && v >= 0;

export function budgetFen(value) {
  const text = String(value).trim();
  requireValue(/^\d+(?:\.\d{1,2})?$/.test(text), '预算请填写非负金额，最多两位小数。');
  const [whole, decimals = ''] = text.split('.');
  const fen = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  requireValue(amount(fen) && Number.isSafeInteger(fen * 4), '预算金额过大。');
  return fen;
}

export const yuanText = (fen) => (Number(fen) / 100).toFixed(2);
