import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = ['index.html', 'app.css', 'app.js', 'icon.svg', 'mcp-client.mjs', 'meal-engine.mjs', 'order-history.mjs', 'radar-view.mjs', 'radar.css', 'account-storage.mjs', 'store-search.mjs', 'local-record.mjs', 'agent-prompts.mjs', 'agent-memory.mjs', 'deepseek-client.mjs', 'agent-context.mjs', 'meal-agent.mjs', 'agent-view.mjs', 'agent.css'];
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const dataFiles = ['plan-recipes.json', 'meal-plans.json', 'coupon-offers.json', 'campaigns.json'];

for (const kind of ['extension', 'static']) {
  const output = path.join(root, 'output', `mcd-wheel-${kind}`);
  await mkdir(path.join(output, 'data'), { recursive: true });
  for (const name of assets) {
    const from = path.join(root, 'web', name);
    try { await copyFile(from, path.join(output, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const name of dataFiles) await copyFile(path.join(root, 'data', name), path.join(output, 'data', name));
  if (kind === 'static') {
    // Meal-card page for the terminal receipt QR; GitHub Pages serves it at …/mcd-1024-skill/receipt/ (tui/card.mjs CARD_BASE_URL).
    await mkdir(path.join(output, 'receipt'), { recursive: true });
    await copyFile(path.join(root, 'static', 'receipt-card.html'), path.join(output, 'receipt', 'index.html'));
  }
  if (kind === 'extension') {
    for (const name of ['manifest.json', 'launcher.js']) {
      try { await copyFile(path.join(root, 'web', name), path.join(output, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await copyFile(path.join(root, 'docs', 'frontend-architecture.md'), path.join(output, '接入说明.md'));
    await copyFile(path.join(root, 'docs', 'meal-agents.md'), path.join(output, 'AI搭子说明.md'));
    await writeFile(path.join(output, '安装说明.txt'), `麦麦饱饱盘 · 纯前端浏览器扩展 ${version}

1. 打开 Chrome chrome://extensions 或 Edge edge://extensions。
2. 打开开发者模式，选择“加载已解压的扩展程序”，选中本文件夹。
3. 点击扩展的“麦麦饱饱盘”图标，打开应用标签页。
4. 点击“连接我的账号”，填写你从 https://open.mcd.cn/mcp 申请的 Token；可自行勾选“在这个浏览器长期记住凭证”。
5. 选餐：输入城市和位置，或主动读取麦当劳已保存地址作为搜索位置；选择营业中的门店，再按预算核价、转盘。
6. 雷达：点击“麦当劳雷达 → 读取我的历史”，无需先选择门店。
7. AI 饭搭子：顶部“AI 搭子与记忆”中填写自己的 DeepSeek API key，选择风格 / 目标 / Agent，保存个人口味和 prompt。先核价，再点击推荐或本地偏好挑选；可主动读城市天气。

更新：在扩展详情页点击“重新加载”，关闭旧应用页，再从扩展图标打开。
勾选后，Token 和上次门店保存在本机扩展 storage.local，不跨设备同步；刷新或重开自动连接，并向官方重新确认门店营业情况。
取消勾选或点击“断开并清除已保存凭证”会删除保存记录；未勾选时 Token 仅在本页内存。
个人历史、券包和地址簿仅在当前应用页内存中，刷新或断开清除，需主动重新读取。
DeepSeek 模型为 V4.1 Flash（deepseek-flash）。key 独立保存，默认仅本页，可选择长期保管；刷新不调用 AI，推荐每次最多两轮。点击推荐会把候选餐单、口味 / prompt、反馈摘要和城市情境直接发送给 DeepSeek，不发送麦当劳 Token、地址簿或订单。
主动反馈“喜欢这份 / 以后少推荐”才学习口味；长期反馈默认关闭，勾选并保存偏好后生效，可查看、忘掉和清空，不当作已吃过。真实订单仍只留在本页。
扩展只申请 storage 和麦当劳 MCP、DeepSeek、Open-Meteo 天气 / 城市四个明确域名，没有网页注入或开发者账号上传服务。
热力图只包含接口返回的完成订单；未返回日期不等于没吃过，全年可能不完整。
前两天可识别主食需主动点击导入，不会自动覆盖手动选择；虚构示例不能导入。
领券需要点击按钮并确认，官方一次领取全部可领券；不支持指定单张。
应用不下单或付款。历史体验价来自 2026-10-10 深圳样本门店。
`);
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
  await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ version, kind, datasetVersion: manifest.datasetVersion, sampleCapturedAt: manifest.capturedAt }, null, 2) + '\n');
  console.log(`已生成 ${path.relative(root, output)}（${kind === 'extension' ? '无后端扩展' : '静态体验页'}）`);
}
