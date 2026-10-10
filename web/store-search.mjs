// Only documented MCP fields enter the view. Address contacts/IDs stay out.
const clean = (value) => typeof value === 'string' ? value.trim() : '';

export function storeResults(data) {
  if (!Array.isArray(data)) throw new Error('Invalid stores');
  return data.filter((store) => clean(store?.storeCode) && clean(store?.storeName)).map((store) => ({
    storeCode: clean(store.storeCode), storeName: clean(store.storeName), address: clean(store.address),
    businessStatus: typeof store.businessStatus === 'boolean' ? store.businessStatus : null,
    businessStartTime: clean(store.businessStartTime), businessEndTime: clean(store.businessEndTime),
    reservationTimeOptions: store.reservation === true && Array.isArray(store.reservationTimeOptions)
      ? store.reservationTimeOptions.map((option) => ({ date: clean(option?.date), text: clean(option?.reservationOptionText), today: option?.today === true })).filter((option) => option.date || option.text)
      : [],
  }));
}

export function storeStatus(store) {
  const status = store.businessStatus === true ? '营业中' : store.businessStatus === false ? '暂停营业' : '营业状态待确认';
  const hours = store.businessStartTime && store.businessEndTime ? `${store.businessStartTime}–${store.businessEndTime}` : '营业时段未提供';
  return `${status} · ${hours}`;
}

export function addressLocations(data) {
  if (!Array.isArray(data?.addresses)) throw new Error('Invalid addresses');
  return [...new Set(data.addresses.map((address) => clean(address?.fullAddress)).filter(Boolean))];
}

export function addressCity(address) {
  const text = clean(address).replace(/^.*?(?:省|自治区)/, '').replace(/\s/g, '');
  return /^([\u4e00-\u9fff]{2,10}?市)/.exec(text)?.[1] || '';
}
