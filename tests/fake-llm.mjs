// Test double for the hub. Not used unless --fake-llm or a test passes it as session.llm.
// Patterns live here on purpose: tui/ must not keep intent regexes.

const base = (slots = {}) => ({
  candidate_index: null, ref: null,
  slots: { budget_yuan: slots.budget_yuan ?? null, want: slots.want ?? null, store_kw: slots.store_kw ?? null, item: slots.item ?? null },
  answer: null,
});

const pickWant = (text) => /鸡/.test(text) && !/牛肉/.test(text) ? '鸡肉' : /猪/.test(text) ? '猪肉' : /虾/.test(text) ? '虾' : /鱼/.test(text) ? '鱼' : /牛肉/.test(text) ? '牛肉' : null;

// A named product ("双层吉士汉堡有什么料呢") goes into slots.item; a deictic
// (这个/那个/它) or nothing at all means the question is about the last pick.
const namedItem = (text, re) => {
  const raw = re.exec(text)?.[1]?.trim().replace(/[？?。！!，,、\s]+$/, '').replace(/的$/, '');
  return raw && !/^(?:这|那)/.test(raw) ? raw : null;
};

export function intentFor(prompt) {
  const line = String(prompt || '').split('\n').find((l) => l.startsWith('本轮：')) || String(prompt || '');
  const text = line.replace(/^本轮：/, '');
  const budget = /(?:预算|人均)\s*(\d+(?:\.\d{1,2})?)/.exec(text);
  const slots = { budget_yuan: budget ? Number(budget[1]) : null };
  if (/盲盒|随便来一餐|惊喜一下/.test(text)) return { ...base(slots), kind: 'blindbox' };
  if (/^(?:重试|再试一次|创建)$/.test(text.trim())) return { ...base(slots), kind: 'retry_order' };
  // "想吃牛肉汉堡"是推荐请求，不是肉类问句：必须排在 info_meat 之前
  if (/想吃|要吃/.test(text)) return { ...base({ ...slots, want: pickWant(text) }), kind: 'recommend' };
  if (/配料|有什么料|什么料/.test(text)) {
    const item = namedItem(text, /(.+?)有什么料/) || namedItem(text, /(.+?)配料/);
    return { ...base({ ...slots, item }), kind: 'info_ingredients', ref: item ? null : 'lastPick' };
  }
  if (/里有什么|随心配有什么/.test(text)) {
    const item = namedItem(text, /(.+?)里有什么/) || namedItem(text, /(.+?)随心配有什么/);
    return { ...base({ ...slots, item }), kind: 'info_parts', ref: item ? null : 'lastPick' };
  }
  if (/牛肉|鸡肉|猪肉|虾|鱼|含不含|有没有肉/.test(text)) {
    const item = namedItem(text, /(.+?)(?:有没有|有|是|含)(?:牛肉|鸡肉|猪肉|虾|鱼)/);
    return { ...base({ ...slots, want: pickWant(text), item }), kind: 'info_meat', ref: item ? null : 'lastPick' };
  }
  if (/多少钱|什么价|价格/.test(text)) return { ...base(slots), kind: 'price_ask', ref: 'lastPick' };
  if (/这个看起来不错|吃这个|就吃这个了|就这个|就要这个|下单|买这个/.test(text) && !/不要|不是/.test(text)) return { ...base(slots), kind: 'confirm_pick', ref: 'lastPick' };
  if (/^[123]$|第[一二三]个/.test(text.trim())) {
    const map = { 1: 0, 2: 1, 3: 2, 一: 0, 二: 1, 三: 2 };
    const digit = text.trim().match(/[123一二三]/)[0];
    return { ...base(slots), kind: 'select_candidate', candidate_index: map[digit] };
  }
  return { ...base(slots), kind: 'recommend' };
}

export function createFakeLlm(scripted = intentFor) {
  const calls = [];
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const json = scripted(user, messages);
      return { json, toolCalls: [], content: JSON.stringify(json), message: { role: 'assistant', content: JSON.stringify(json) } };
    },
    close() {},
  };
}
