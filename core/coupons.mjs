// Coupon time rules (from the meal engine) plus a per-coupon value table.
import {
  timeCondition, couponTimeStatus, publicOffers, dateValue, inspectBenefits, eligibleCoupons,
  constrainCoupons, publicCalendar, wallet,
} from './pricing.mjs';

export {
  timeCondition, couponTimeStatus, publicOffers, dateValue, inspectBenefits, eligibleCoupons,
  constrainCoupons, publicCalendar, wallet,
};

const HOUR = 3600000;
const chinaIso = (ms) => new Date(ms + 8 * HOUR).toISOString();
export const expiryLabel = (ms) => chinaIso(ms).slice(5, 16).replace('T', ' ');
const SOON_HOURS = 72;

export function couponPicture(benefits, report) {
  if (!benefits) return { live: false, usable: [], used: [], soon: [], heldCount: 0, unavailableCount: 0, claimableCount: 0 };
  const savings = new Map();
  for (const plan of report?.candidates || []) for (const name of plan.couponNames || []) {
    const s = savings.get(name) || { name, savingFen: 0, plans: 0 };
    s.savingFen = Math.max(s.savingFen, plan.savingFen || 0); s.plans++; savings.set(name, s);
  }
  const usable = [...new Map((benefits.usable || []).map((c) => [c.name, c])).values()].sort((a, b) => a.expiresAt - b.expiresAt).map((c) => {
    const hoursLeft = Math.max(0, Math.floor((c.expiresAt - benefits.now) / HOUR));
    return { name: c.name, expiresAt: c.expiresAt, expires: expiryLabel(c.expiresAt), hoursLeft, soon: hoursLeft < SOON_HOURS, used: savings.has(c.name), bestSavingFen: savings.get(c.name)?.savingFen ?? null };
  });
  return { live: true, usable, used: [...savings.values()], soon: usable.filter((c) => c.soon), heldCount: benefits.ownedCount,
    unavailableCount: (benefits.rows || []).filter((r) => r.kind === 'owned-coupon' && r.status !== 'eligible').reduce((s, r) => s + (r.assetCount || 1), 0),
    claimableCount: (benefits.offers || []).filter((o) => o.canClaim).length };
}

const sameName = (a, b) => Boolean(a && b && a.length >= 2 && b.length >= 2 && (a === b || a.includes(b) || b.includes(a)));
export function claimableList(offers = [], entries = []) {
  return offers.filter((o) => o.canClaim).map((o) => {
    const e = entries.find((x) => sameName(x.name, o.name) && (x.timeWindow?.tradeEndDate || x.priceDisplay));
    const w = e?.timeWindow || {};
    return { name: o.name, label: o.label, expires: w.tradeEndDate ? `${w.tradeStartDate ? `${w.tradeStartDate} 至 ` : '至 '}${w.tradeEndDate}` : null, price: e?.priceDisplay || null };
  });
}

// "9.9元中杯" → 9.9. Used only when calculate-price does not return a delta. Marked 估算.
export function faceValueYuan(name) {
  const m = /(\d+(?:\.\d{1,2})?)\s*元/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

const stripCoupon = (items) => (items || []).map(({ couponId, couponCode, ...rest }) => structuredClone(rest));

function applyCoupon(items, coupon) {
  const cart = stripCoupon(items);
  const index = cart.findIndex((item) => !item.couponId && coupon.productCodes?.has?.(item.productCode));
  if (index < 0) return null;
  const target = cart[index];
  if (target.quantity > 1) { const leftover = structuredClone(target); leftover.quantity--; cart.splice(index + 1, 0, leftover); }
  Object.assign(target, { quantity: 1, couponId: coupon.couponId, couponCode: coupon.couponCode });
  return cart;
}

// coupons × candidates(≤3) × 2 calculate-price calls, in parallel. A failed coupon is "价值未知".
export async function valueCoupons(client, common, coupons, candidates) {
  const list = (coupons || []).slice(0, 8);
  const picks = (candidates || []).filter((c) => Array.isArray(c.items) || Array.isArray(c.orderItems)).slice(0, 3);
  const rows = await Promise.all(list.map(async (coupon) => {
    const name = coupon.name || coupon.title || '优惠券';
    let best = null, failed = false;
    if (!picks.length) {
      const face = faceValueYuan(name);
      return { name, applicable: false, saveYuan: face, ratio: null, afterYuan: null, note: face == null ? '价值未知' : '估算' };
    }
    await Promise.all(picks.map(async (cand) => {
      const bareItems = stripCoupon(cand.orderItems || cand.items);
      const withItems = applyCoupon(cand.orderItems || cand.items, coupon);
      if (!withItems) return;
      try {
        const [bare, priced] = await Promise.all([
          client.call('calculate-price', { ...common, items: bareItems }),
          client.call('calculate-price', { ...common, items: withItems }),
        ]);
        const base = bare.data?.price, after = priced.data?.price;
        if (!Number.isSafeInteger(base) || !Number.isSafeInteger(after)) { failed = true; return; }
        const save = base - after;
        if (!best || save > best.save) best = { save, after };
      } catch { failed = true; }
    }));
    if (!best) {
      const face = faceValueYuan(name);
      return { name, applicable: false, saveYuan: face, ratio: null, afterYuan: null, note: face == null || failed ? '价值未知' : '估算' };
    }
    return { name, applicable: best.save > 0, saveYuan: Math.round(best.save) / 100, ratio: null, afterYuan: Math.round(best.after) / 100, note: '' };
  }));
  return rows;
}

export function renderCouponTable(rows) {
  if (!rows?.length) return ['这轮没有可折算的券。'];
  return rows.map((c) => {
    const save = c.saveYuan == null ? '价值未知' : `省 ¥${Number(c.saveYuan).toFixed(2)}${c.note === '估算' ? '（估算）' : ''}`;
    const after = c.afterYuan == null ? '' : `｜折后 ¥${Number(c.afterYuan).toFixed(2)}`;
    return `${c.name}｜${c.applicable ? '适用' : '不适用'}｜${save}${after}${c.note === '价值未知' ? '｜价值未知' : ''}`;
  });
}

export function couponKey(storeCode, coupons) {
  const ids = (coupons || []).map((c) => c.couponId || c.name).sort().join(',');
  return `${storeCode}|${ids}`;
}
