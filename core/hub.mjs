// Intent hub: rich context in, TypeSafe JSON out. At most 3 tool rounds and 1 final answer.
import { exactKeys, DeepSeekError } from './llm.mjs';
import { TOOLS, toolToMcp } from './tools.mjs';
import { buildTurnContext } from './context.mjs';

export const INTENT_KINDS = Object.freeze([
  'recommend', 'blindbox', 'select_candidate', 'confirm_pick', 'retry_order',
  'info_meat', 'info_parts', 'info_ingredients', 'price_ask', 'register_allergy', 'chitchat', 'help', 'unknown',
]);
const KEYS = ['kind', 'candidate_index', 'ref', 'slots', 'answer'];
const SLOT_KEYS = ['budget_yuan', 'want', 'store_kw', 'item'];

export const SYSTEM_PROMPT = `你是个人麦当劳助手。只根据用户消息里的上下文作答，上下文里没有的就说不知道，禁止编造价格、配料和活动。
你没有领券和下单的工具，也不要建议自己去领券或下单。过敏的具体内容不会出现在上下文里，你也不要追问或复述过敏原。
不确定就在 answer 里写“不知道”或“接口没给”。
只返回一个 JSON 对象，键必须恰好是 kind、candidate_index、ref、slots、answer。
kind 只能是：recommend、blindbox、select_candidate、confirm_pick、retry_order、info_meat、info_parts、info_ingredients、price_ask、register_allergy、chitchat、help、unknown。
candidate_index 是 0、1、2 或 null（0 是编号 1）。ref 是 "lastPick" 或 null。
slots 必须恰好含 budget_yuan（数字或 null）、want（字符串或 null）、store_kw（字符串或 null）、item（字符串或 null）。
answer 是字符串或 null。吃这个、这个不错、就要这个用 confirm_pick。用户说盲盒、随便来一餐、惊喜用 blindbox，不要自己指定品类。
info_meat、info_parts、info_ingredients 里，如果用户指名了具体餐品（比如“双层吉士汉堡有什么料呢”），把名字原样抽进 item；没指名（这个、它）时 item 为 null、ref 用 "lastPick"。
当上下文写明上次下单失败时，重试、再试一次、创建用 retry_order。`;

export function validateHubIntent(value) {
  if (!exactKeys(value, KEYS)) return null;
  if (!INTENT_KINDS.includes(value.kind)) return null;
  const idx = value.candidate_index;
  if (!(idx === null || idx === 0 || idx === 1 || idx === 2)) return null;
  if (!(value.ref === null || value.ref === 'lastPick')) return null;
  if (!exactKeys(value.slots, SLOT_KEYS)) return null;
  const { budget_yuan: budget, want, store_kw: store, item } = value.slots;
  if (!(budget === null || (typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 && budget <= 1000))) return null;
  if (!(want === null || (typeof want === 'string' && want.length <= 40))) return null;
  if (!(store === null || (typeof store === 'string' && store.length <= 40))) return null;
  if (!(item === null || (typeof item === 'string' && item.length <= 40))) return null;
  if (!(value.answer === null || (typeof value.answer === 'string' && value.answer.length <= 500))) return null;
  return {
    kind: value.kind, candidate_index: idx, ref: value.ref,
    slots: { budget_yuan: budget, want, store_kw: store, item }, answer: value.answer,
  };
}

export function unknownIntent(reason = 'invalid') {
  return { kind: 'unknown', candidate_index: null, ref: null, slots: { budget_yuan: null, want: null, store_kw: null, item: null }, answer: null, degraded: reason };
}

const aborted = (signal) => Boolean(signal?.aborted);

export async function decide({ session, text, llm, signal, runTool, maxToolRounds = 3 }) {
  if (!llm) return unknownIntent('no-key');
  const built = buildTurnContext(session, text);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: built.prompt }];
  let toolRounds = 0;
  let calls = 0;
  try {
    while (toolRounds <= maxToolRounds) {
      if (aborted(signal)) return { ...unknownIntent('timeout'), calls };
      const finalRound = toolRounds === maxToolRounds;
      calls += 1;
      const turn = await llm.chat(messages, { signal, tools: finalRound ? null : TOOLS, json: true, toolChoice: finalRound ? 'none' : 'auto' });
      if (aborted(signal)) return { ...unknownIntent('timeout'), calls };
      if (turn.toolCalls?.length && !finalRound) {
        toolRounds += 1;
        messages.push(turn.message || { role: 'assistant', content: turn.content || '', tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } })) });
        for (const call of turn.toolCalls) {
          const mapped = toolToMcp(call.name, call.arguments);
          let payload;
          if (!mapped) payload = { error: '没有这个只读工具' };
          else {
            try { payload = await runTool(mapped[0], mapped[1], { signal, tool: call.name }); }
            catch (error) { payload = { error: '接口没给', detail: String(error?.message || '').slice(0, 80) }; }
          }
          messages.push({ role: 'tool', tool_call_id: call.id || call.name, content: JSON.stringify(payload).slice(0, 4000) });
        }
        continue;
      }
      const intent = validateHubIntent(turn.json);
      if (!intent) return { ...unknownIntent('invalid'), calls };
      return { ...intent, calls };
    }
  } catch (error) {
    if (error instanceof DeepSeekError && error.code === 'cancelled') throw error;
    if (error instanceof DeepSeekError) {
      // Auth/balance/rate/network problems are the model's problem, not the user's phrasing:
      // surface the real message and let the executor fall back to local numbered picks.
      // Only a JSON validation failure means "didn't understand".
      if (['auth', 'balance', 'rate', 'network'].includes(error.code)) {
        return { ...unknownIntent('degraded'), calls, errorMessage: error.message };
      }
      const timeout = error.code === 'timeout';
      return { ...unknownIntent(timeout ? 'timeout' : 'invalid'), calls };
    }
    return { ...unknownIntent('invalid'), calls };
  }
  return { ...unknownIntent('invalid'), calls };
}
