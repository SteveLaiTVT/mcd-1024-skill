// Mainland China calendar, verified against 国办发明电〔2025〕7号.
export const HOLIDAY_SOURCE = 'https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html';
const HOLIDAYS_2026 = [
  ['元旦', '2026-01-01', '2026-01-03'], ['春节', '2026-02-15', '2026-02-23'],
  ['清明节', '2026-04-04', '2026-04-06'], ['劳动节', '2026-05-01', '2026-05-05'],
  ['端午节', '2026-06-19', '2026-06-21'], ['中秋节', '2026-09-25', '2026-09-27'], ['国庆节', '2026-10-01', '2026-10-07'],
];
const WORKDAYS_2026 = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']);
export function calendarContext(now = new Date()) {
  const shifted = new Date(Number(now) + 8 * 3600000), date = shifted.toISOString().slice(0, 10), month = shifted.getUTCMonth() + 1;
  const weekday = shifted.getUTCDay(), supported = shifted.getUTCFullYear() === 2026;
  const holiday = supported ? HOLIDAYS_2026.find(([, start, end]) => start <= date && date <= end)?.[0] || null : null;
  const makeupWorkday = supported && WORKDAYS_2026.has(date);
  const next = supported ? HOLIDAYS_2026.find(([, start]) => start > date) : null;
  const daysAway = next ? Math.round((Date.parse(next[1]) - Date.parse(date)) / 86400000) : null;
  return { date, month, weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday], timezone: 'Asia/Shanghai', region: '中国大陆', holiday, makeupWorkday,
    dayKind: holiday ? 'holiday' : makeupWorkday ? 'workday' : [0, 6].includes(weekday) ? 'weekend' : 'workday',
    holidayVerified: supported, holidaySource: supported ? HOLIDAY_SOURCE : null,
    upcoming: next && daysAway <= 14 ? { name: next[0], date: next[1], daysAway } : null };
}
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const label = (v, n = 60) => typeof v === 'string' ? v.trim().slice(0, n) : '';
export function cityLocations(data) {
  const seen = new Set();
  return (Array.isArray(data?.results) ? data.results : []).filter((v) => {
    if (!v || v.country_code !== 'CN' || !label(v.name) || !finite(v.latitude, -90, 90) || !finite(v.longitude, -180, 180) || seen.has(v.id)) return false;
    seen.add(v.id); return true;
  }).slice(0, 8).map((v) => ({ name: label(v.name), region: label(v.admin1), latitude: v.latitude, longitude: v.longitude }));
}
export function weatherLabel(code) {
  if (code === 0) return '晴'; if ([1, 2, 3].includes(code)) return '多云';
  if ([45, 48].includes(code)) return '雾'; if ([51, 53, 55, 56, 57].includes(code)) return '毛毛雨';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '有雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '有雪'; if ([95, 96, 99].includes(code)) return '雷雨';
  return '天气类型待确认';
}
export function normalizeWeather(data, location, now = new Date()) {
  const current = data?.current, observed = current?.time * 1000;
  if (data?.current_units?.temperature_2m !== '°C' || data?.current_units?.apparent_temperature !== '°C' || !finite(current?.temperature_2m, -80, 65) || !finite(current?.apparent_temperature, -90, 80) || !Number.isInteger(current?.weather_code) || !Number.isFinite(observed) || Math.abs(Number(now) - observed) > 90 * 60000) throw new Error('天气时效或数据未确认');
  return { status: 'available', city: label(location.name), region: label(location.region), temperatureC: current.temperature_2m, feelsLikeC: current.apparent_temperature, weatherCode: current.weather_code, description: weatherLabel(current.weather_code), observedAt: new Date(observed).toISOString(), fetchedAt: new Date(now).toISOString(), source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/' };
}
export class WeatherClient {
  #fetch; #cache = new Map();
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), now = () => new Date(), timeoutMs = 8000 } = {}) { this.#fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs; }
  async #get(url, signal) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) throw new Error('天气查询已取消');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.#fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('天气暂时不可用');
      const data = await response.json(); if (controller.signal.aborted) throw new Error('天气查询已取消'); return data;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async search(city, { signal } = {}) {
    const name = label(city, 40).replace(/市$/, '');
    if (name.length < 2 || /[\r\n]/.test(name)) throw new Error('请填写城市名称');
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '8', language: 'zh', countryCode: 'CN' });
    return cityLocations(await this.#get(url, signal));
  }
  async current(location, { signal } = {}) {
    if (!finite(location?.latitude, -90, 90) || !finite(location?.longitude, -180, 180)) throw new Error('请先选择天气城市');
    const key = `${location.latitude},${location.longitude}`, cached = this.#cache.get(key), now = this.now();
    if (cached && Number(now) - Date.parse(cached.fetchedAt) < 30 * 60000 && Number(now) - Date.parse(cached.observedAt) < 90 * 60000) return { ...cached };
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), current: 'temperature_2m,apparent_temperature,weather_code', timeformat: 'unixtime', timezone: 'Asia/Shanghai', forecast_days: '1' });
    const weather = normalizeWeather(await this.#get(url, signal), location, this.now());
    this.#cache.set(key, weather); return { ...weather };
  }
}
