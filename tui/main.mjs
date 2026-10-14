#!/usr/bin/env node
// npm run tui [-- --demo] [-- --no-color] [-- --no-profile]
// Reads MCD_TOKEN / DEEPSEEK_API_KEY from the process environment only.
import { readFile } from 'node:fs/promises';
import { runTui } from './app.mjs';
import { defaultProfilePath } from './allergy.mjs';
import { defaultOrdersPath } from './orders.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(`麦麦饱饱盘 · 终端版（参赛者独立开发，非麦当劳官方产品）

用法：npm run tui [-- --demo] [-- --no-color]
  环境变量 MCD_TOKEN          麦当劳 MCP Token（实时选店、查券、核价、历史）
  环境变量 DEEPSEEK_API_KEY   DeepSeek API key（意图理解，可选；没有则走本地模式）
  --demo                      使用仓库内 2026-10-10 历史样本与虚构雷达，不联网
  --no-color                  关闭颜色（也支持 NO_COLOR 环境变量）
  --no-profile                过敏记录和购物车只留在本次会话内存，不读写本地文件
  --fake-llm                  测试用：不调用 DeepSeek，改走 tests/fake-llm.mjs
凭证只从进程环境读取，不会询问、显示或写入任何文件。
过敏记录（/allergy）只保存在本机 ${defaultProfilePath()}，只用于本地筛选，从不发送。
购物车与真实订单记录（/cart /order）只保存在本机 ${defaultOrdersPath()}。
选好一餐后说“就吃这个了”才会下单：先列出要领的券，回答“是这家店吗”后才领券并通过麦当劳 MCP 下真实的到店自取订单；
付款在官方支付链接或麦当劳 App 完成，本工具不经手付款。`);
  process.exit(0);
}

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns, menu, packages] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns', 'menu', 'packages'].map(json));
let llm = null;
if (args.has('--fake-llm')) {
  const { createFakeLlm } = await import('../tests/fake-llm.mjs');
  llm = createFakeLlm();
}
await runTui({ dataset: { templates, plans, offers, campaigns, menu, packages }, demo: args.has('--demo'), color: args.has('--no-color') ? false : undefined,
  llm, profilePath: args.has('--no-profile') ? null : defaultProfilePath(), ordersPath: args.has('--no-profile') ? null : defaultOrdersPath() });
// Keep-alive sockets from fetch can hold the event loop briefly; nothing else is pending.
process.exit(0);
