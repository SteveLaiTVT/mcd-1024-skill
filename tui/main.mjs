#!/usr/bin/env node
// npm run tui [-- --demo] [-- --no-color] [-- --no-profile]
// Reads MCD_TOKEN / DEEPSEEK_API_KEY from the process environment only.
import { readFile } from 'node:fs/promises';
import { runTui } from './app.mjs';
import { defaultProfilePath } from './allergy.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(`麦麦饱饱盘 · 终端版（参赛者独立开发，非麦当劳官方产品）

用法：npm run tui [-- --demo] [-- --no-color]
  环境变量 MCD_TOKEN          麦当劳 MCP Token（实时选店、查券、核价、历史）
  环境变量 DEEPSEEK_API_KEY   DeepSeek API key（需求理解 + 推荐 / 优化双 Agent，可选）
  --demo                      使用仓库内 2026-10-10 历史样本与虚构雷达，不联网
  --no-color                  关闭颜色（也支持 NO_COLOR 环境变量）
  --no-profile                过敏记录只留在本次会话内存，不读写本地文件
凭证只从进程环境读取，不会询问、显示或写入任何文件。
过敏记录（/allergy）只保存在本机 ${defaultProfilePath()}，只用于本地筛选，从不发送。`);
  process.exit(0);
}

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns, menu] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns', 'menu'].map(json));
await runTui({ dataset: { templates, plans, offers, campaigns, menu }, demo: args.has('--demo'), color: args.has('--no-color') ? false : undefined,
  profilePath: args.has('--no-profile') ? null : defaultProfilePath() });
// Keep-alive sockets from fetch can hold the event loop briefly; nothing else is pending.
process.exit(0);
