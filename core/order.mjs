// Local order-attempt state. Writes require confirmed === true. Ambiguous results are never retried automatically.
const MAX_RETRIES = 3;

export function emptyAttempt() { return null; }

export function recordAttempt(prev, { status, reason, cartSnapshot = null, storeCode = null, ambiguous = false } = {}) {
  const failed = ambiguous ? 'unknown' : status;
  return {
    status: failed === 'success' ? 'success' : failed,
    reason: String(reason || '').slice(0, 200),
    cartSnapshot, storeCode,
    ts: Date.now(),
    retries: prev && prev.status !== 'success' ? prev.retries || 0 : 0,
    ambiguous: Boolean(ambiguous),
  };
}

export function classifyFailure(error) {
  const reason = error?.message || '未知原因';
  if (error?.ambiguous) return { status: 'unknown', reason, ambiguous: true };
  if (/已存在|重复/.test(reason)) return { status: 'failed', reason, ambiguous: false, duplicate: true };
  return { status: 'failed', reason, ambiguous: false, duplicate: false };
}

export function canRetry(attempt) {
  if (!attempt) return { ok: false, message: '没有可重试的失败订单' };
  if (attempt.ambiguous || attempt.status === 'unknown') return { ok: false, message: '结果不明确，请先在麦当劳 App 的订单列表核对，本次不自动重试' };
  if (attempt.status !== 'failed') return { ok: false, message: '没有可重试的失败订单' };
  if ((attempt.retries || 0) >= MAX_RETRIES) return { ok: false, message: `这单一直创不出来（${attempt.reason}），建议换个餐或稍后再试` };
  if (/已存在|重复/.test(attempt.reason || '')) return { ok: false, duplicate: true, message: '这单可能已经创建，请先查订单，不要重新下单' };
  return { ok: true, message: '' };
}

// confirmed must be the local store gate. This function does not call MCP itself.
export async function retryOrder({ attempt, confirmed, place }) {
  if (confirmed !== true) {
    const err = new Error('下单需要先确认门店（回复 是）。');
    err.code = 'confirm';
    throw err;
  }
  const gate = canRetry(attempt);
  if (!gate.ok) return { ok: false, message: gate.message, duplicate: Boolean(gate.duplicate) };
  const next = { ...attempt, retries: (attempt.retries || 0) + 1 };
  return place(next);
}

export const RETRY_PHRASE = /^(?:重试|再试一次|创建)$/;
export { MAX_RETRIES };
