// Read-only tools exposed to the model. Claiming and ordering are intentionally absent.
export const TOOL_NAMES = Object.freeze([
  'search_stores', 'query_meals', 'query_meal_detail', 'calculate_price', 'available_coupons', 'campaign_calendar',
]);

const schema = (name, description, properties, required) => ({
  type: 'function',
  function: {
    name, description,
    parameters: { type: 'object', additionalProperties: false, properties, required },
  },
});

export const TOOLS = Object.freeze([
  schema('search_stores', '搜索到店门店。只读。', { city: { type: 'string' }, keyword: { type: 'string' } }, ['city', 'keyword']),
  schema('query_meals', '读取这家店的菜单。只读。', { storeCode: { type: 'string' } }, ['storeCode']),
  schema('query_meal_detail', '读取一个餐品的套餐组成和可去掉的料。只读。', { storeCode: { type: 'string' }, code: { type: 'string' } }, ['storeCode', 'code']),
  schema('calculate_price', '对一组商品核价。只读，不会下单。', {
    storeCode: { type: 'string' },
    items: { type: 'array' },
  }, ['storeCode', 'items']),
  schema('available_coupons', '查看可领和持有的券。只读，不会领券。', {}, []),
  schema('campaign_calendar', '查看活动日历。只读。', {}, []),
]);

const FORBIDDEN = new Set(['auto-bind-coupons', 'create-order', 'auto_bind_coupons', 'create_order']);

export function assertReadOnlyTools(tools = TOOLS) {
  const names = tools.map((t) => t.function?.name);
  if (names.some((n) => FORBIDDEN.has(n))) throw new Error('写操作不能出现在工具列表里');
  return names;
}

// Map a model tool call onto an MCP tool name and arguments. Unknown names are refused.
export function toolToMcp(name, args = {}) {
  if (FORBIDDEN.has(name) || !TOOL_NAMES.includes(name)) return null;
  if (name === 'search_stores') return ['query-nearby-stores', { beType: 1, searchType: 2, city: String(args.city || ''), keyword: String(args.keyword || '') }];
  if (name === 'query_meals') return ['query-meals', { storeCode: String(args.storeCode || ''), orderType: 1, beType: 1 }];
  if (name === 'query_meal_detail') return ['query-meal-detail', { storeCode: String(args.storeCode || ''), orderType: 1, beType: 1, code: String(args.code || '') }];
  if (name === 'calculate_price') return ['calculate-price', { storeCode: String(args.storeCode || ''), orderType: 1, beType: 1, items: Array.isArray(args.items) ? args.items : [] }];
  if (name === 'available_coupons') return ['available-coupons', {}];
  if (name === 'campaign_calendar') return ['campaign-calendar', {}];
  return null;
}
