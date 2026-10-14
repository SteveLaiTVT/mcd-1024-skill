import test from 'node:test';
import assert from 'node:assert/strict';
import { historyTime, chinaDay, shiftDay, normalizeHistory, historyCalendar, readHistory, demoHistory } from '../core/history.mjs';

const now = '2026-10-10T18:00:00+08:00';
const order = (overrides = {}) => ({ orderId: 'private-order', orderStatus: '订单已完成', createTime: '2026-10-09 12:30:00', storeName: '测试餐厅',
  storeCode: 'private-store-code', payId: 'private-payment', mobilePhone: 'private-phone', realTotalAmount: 'unknown-unit',
  orderProductList: [{ productName: '完整套餐', productCode: 'package', quantity: 2, comboItemList: [{ name: '主食', productCode: 'main', quantity: 1 }, { name: '饮品', productCode: 'drink', quantity: 1 }] }], ...overrides });
const normalize = (list, options = {}) => normalizeHistory({ list }, { now, mainCodes: ['main', 'other-main'], ...options });

test('history counts documented numeric and actual Chinese completed states, strips private IDs and unverified money', () => {
  const report = normalize([order(), order({ orderId: 'reviewed', orderStatus: '8' }), order({ orderId: 'cancel', orderStatus: '7' }), order({ orderId: 'pending', orderStatus: '待支付' }), order({ orderId: 'unknown', orderStatus: '配送中' })]);
  assert.equal(report.returnedCount, 5); assert.equal(report.orders.length, 2); assert.equal(report.skipped.unfinished, 3);
  assert.equal(report.orders[1].items[0].quantity, 2); assert.deepEqual(report.orders[1].mainCodes, ['main']);
  for (const privateValue of ['private-order', 'private-store-code', 'private-payment', 'private-phone', 'unknown-unit']) assert(!JSON.stringify(report).includes(privateValue));
});
test('history normalizes dates in China time, rejects impossible calendar dates, and excludes future orders', () => {
  assert.equal(chinaDay(historyTime('2026-10-08T17:00:00Z')), '2026-10-09');
  assert.equal(historyTime('2026-10-09 01:00:00'), historyTime('2026-10-08T17:00:00Z'));
  assert.equal(historyTime('2026-02-30 12:00:00'), null); assert.equal(historyTime('2026-10-09 25:00:00'), null);
  assert.equal(shiftDay('2028-03-01', -1), '2028-02-29');
  const report = normalize([order({ createTime: '2026-10-08T17:00:00Z' }), order({ orderId: 'bad-date', createTime: '2026-02-30 12:00:00' }), order({ orderId: 'future', createTime: '2026-10-11 12:00:00' })]);
  assert.equal(report.orders[0].day, '2026-10-09'); assert.equal(report.orders[0].time, '01:00');
  assert.equal(report.skipped.invalidTime, 1); assert.equal(report.skipped.future, 1);
});
test('history deduplicates by order identity and retains distinct purchases with identical meals and timestamps', () => {
  const report = normalize([order(), order(), order({ orderId: 'another-purchase' }), order({ orderId: '' }), order({ orderId: '' })]);
  assert.equal(report.orders.length, 4); assert.equal(report.skipped.duplicate, 1); assert.equal(report.skipped.missingId, 2);
});
test('annual grid aligns weekdays, paints only returned history, and keeps missing and future days distinct', () => {
  const report = normalize([order(), order({ orderId: 'another' })]);
  const calendar = historyCalendar(report, { year: 2026 });
  const cells = calendar.weeks.flat().filter(Boolean);
  assert.equal(calendar.weeks.length, 53); assert.equal(cells.length, 365);
  assert.equal(calendar.weeks[0][4].day, '2026-01-01');
  assert.equal(cells.find((c) => c.day === '2026-10-09').level, 2);
  assert.equal(cells.find((c) => c.day === '2026-10-08').unknown, true);
  assert.equal(cells.find((c) => c.day === '2026-10-11').future, true);
  assert.equal(calendar.recordedDays, 1); assert.equal(calendar.orderCount, 2);
  assert.equal(historyCalendar({ ...report, anchorDay: '2028-12-31' }, { year: 2028 }).weeks.flat().filter(Boolean).length, 366);
});
test('twelve-week grid can span years and food ranking counts presence per completed order', () => {
  const repeated = order({ createTime: '2025-12-31 12:30:00', orderProductList: [{ productName: '套餐', quantity: 2, comboItemList: [{ productCode: 'main', name: '主食', quantity: 2 }, { productCode: 'main', name: '主食', quantity: 1 }] }] });
  const report = normalize([repeated], { now: '2026-01-02T18:00:00+08:00' });
  const calendar = historyCalendar(report, { year: 2026, mode: 'recent' });
  assert.equal(calendar.end, '2026-01-02'); assert.equal(calendar.weeks.flat().filter(Boolean).length, 84);
  assert.equal(calendar.orderCount, 1); assert.deepEqual(calendar.ranking, [{ name: '主食', count: 1 }]);
});
test('recent main foods use only yesterday and the day before, with exact known product codes', () => {
  const report = normalize([order(), order({ orderId: 'two-days', createTime: '2026-10-08 23:55:00', orderProductList: [{ productName: '另一个主食', productCode: 'other-main', quantity: 1 }] }), order({ orderId: 'today', createTime: '2026-10-10 12:00:00', orderProductList: [{ productName: '今天主食', productCode: 'today-main', quantity: 1 }] }), order({ orderId: 'old', createTime: '2026-10-07 12:00:00' })]);
  assert.deepEqual(report.recentMainCodes, ['main', 'other-main']);
});
test('history query uses only server time and order-list; malformed replies are not empty histories', async () => {
  const calls = [];
  const report = await readHistory({ async call(name, args) { calls.push({ name, args }); return name === 'now-time-info' ? { data: { datetime: now } } : { data: { list: [order()] } }; } }, ['main']);
  assert.equal(report.orders.length, 1); assert.deepEqual(calls.map((c) => c.name), ['now-time-info', 'order-list']);
  assert.deepEqual(calls[1].args, {}); assert.equal(report.coverageComplete, false);
  assert.throws(() => normalizeHistory({}, { now }));
  assert.equal(demoHistory().sourceKind, 'demo-history');
  assert.equal(demoHistory().coverageComplete, true); assert.equal(demoHistory().recentMainCodes.length, 0);
});
