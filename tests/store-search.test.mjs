import test from 'node:test';
import assert from 'node:assert/strict';
import { storeResults, storeStatus, addressLocations, addressCity } from '../core/store.mjs';

test('store status follows only official booleans, preserves all reservation slots and never guesses hours', () => {
  const stores = storeResults([
    { storeCode: 'open', storeName: '营业门店', businessStatus: true, businessStartTime: '00:00', businessEndTime: '23:59',
      reservation: true, reservationTimeOptions: [{ date: '2026-10-10', reservationOptionText: '10:00–22:00', today: true }, { date: '2026-10-11', reservationOptionText: '09:00–21:00' }] },
    { storeCode: 'closed', storeName: '暂停门店', businessStatus: false },
    { storeCode: 'unknown', storeName: '未知门店', businessStatus: 'true' },
    { storeName: '无编码' }, null,
  ]);
  assert.equal(stores.length, 3); assert.match(storeStatus(stores[0]), /营业中.*00:00–23:59/);
  assert.equal(stores[0].reservationTimeOptions.length, 2);
  assert.match(storeStatus(stores[1]), /暂停营业.*营业时段未提供/);
  assert.equal(stores[2].businessStatus, null); assert.match(storeStatus(stores[2]), /待确认/);
});

test('address locations omit contacts, phones and IDs, and city is left blank if not explicit', () => {
  assert.deepEqual(addressLocations({ addresses: [{ fullAddress: ' 广东省深圳市南山区科技园 ', contactName: 'private-name', phone: 'private-phone', addressId: 'private-id' }, { fullAddress: '广东省深圳市南山区科技园' }, null] }), ['广东省深圳市南山区科技园']);
  assert.equal(addressCity('广东省深圳市南山区城市花园'), '深圳市');
  assert.equal(addressCity('北京市海淀区中关村'), '北京市');
  assert.equal(addressCity('广西壮族自治区南宁市青秀区'), '南宁市');
  assert.equal(addressCity('科技园一号楼'), '');
  assert.throws(() => addressLocations({})); assert.throws(() => storeResults({}));
});
