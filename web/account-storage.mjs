import { createLocalRecord } from './local-record.mjs';
// Opt-in, device-local extension storage. Never use browser sync or web storage.
export const ACCOUNT_KEY = 'mcd-wheel.account.v1';

export function savedAccount(value) {
  if (!value || value.version !== 1 || typeof value.token !== 'string') return null;
  const token = value.token.trim().replace(/^Bearer\s+/i, '');
  if (!token || /[\r\n]/.test(token)) return null;
  const candidate = value.store;
  const store = candidate && ['storeCode', 'storeName', 'city'].every((key) => typeof candidate[key] === 'string' && candidate[key].trim())
    ? { storeCode: candidate.storeCode.trim(), storeName: candidate.storeName.trim(), city: candidate.city.trim() }
    : null;
  return { version: 1, token, store };
}

export function createAccountStorage(options = {}) {
  const record = createLocalRecord({ ...options, key: ACCOUNT_KEY, normalize: savedAccount });
  return {
    available: record.available, read: record.read, clear: record.clear, subscribe: record.subscribe,
    save: (value, { expectedToken } = {}) => record.save(value, {
      matches: expectedToken === undefined ? null : (current) => (current?.token || null) === expectedToken,
    }),
  };
}
