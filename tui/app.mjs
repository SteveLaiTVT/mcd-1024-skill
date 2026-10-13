// Interactive shell: readline + ANSI. Works on a TTY and with piped input.
import readline from 'node:readline';
import { MCPError } from '../web/mcp-client.mjs';
import { DeepSeekError } from '../web/deepseek-client.mjs';
import { budgetFen } from '../web/meal-engine.mjs';
import { createPalette, box, fit, padEnd } from './ansi.mjs';
import { TuiSession, TuiError } from './session.mjs';
import { runAgentFlow } from './agent-flow.mjs';
import { NOTICE, statusLine, renderStores, renderBenefits, renderReport, renderPick, renderAgentResult, renderHeatmap, helpLines, renderClaimable, renderAllergies, renderActivities, HELP_COMMANDS } from './render.mjs';
import { GOALS, MOODS, DEFAULT_INTENT, DEFAULT_STORE_SEARCH, isActivityQuery } from './intent.mjs';
import { parseAllergyStatement } from './allergy.mjs';
import { printReceipt, maybeReceipt } from './receipt.mjs';

const message = (e) => e instanceof TuiError || e instanceof MCPError || e instanceof DeepSeekError ? e.message : `未完成：${e?.message || e}`;

export function createUI({ output, palette, redact, tty }) {
  const width = () => Math.max(40, Math.min(100, (output.columns || 88) - 1));
  let transient = false;
  const clearTransient = () => { if (transient) { output.write('\r\x1b[2K'); transient = false; } };
  const write = (text = '') => { clearTransient(); output.write(`${redact(text)}\n`); };
  const P = palette;
  const indent = (lines) => lines.forEach((l) => write(`   ${l}`));
  return {
    palette, write, width,
    clear() { if (tty) output.write('\x1b[2J\x1b[H'); },
    panel(title, lines, tone) { write(box(title, lines, { width: width(), palette, tone })); },
    result(title, lines, tone = 'brand') { write(''); write(box(title, lines, { width: width(), palette, tone })); },
    error(text) { write(`${P.red('✗')} ${text}`); },
    info(text) { write(`${P.cyan('›')} ${text}`); },
    begin(title) {
      const started = Date.now(); let last = '';
      const elapsed = () => P.gray(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
      if (!tty) write(`${P.cyan('▶')} ${title}`);
      const progress = (text) => {
        if (tty) { output.write(`\r\x1b[2K${redact(fit(`${P.cyan('…')} ${title} · ${text}`, width()))}`); transient = true; }
        else if (text !== last) write(`   ${P.gray(`… ${text}`)}`);
        last = text;
      };
      if (tty) progress('进行中');
      return {
        progress,
        ok(summary, lines = []) { write(`${P.green('✓')} ${P.bold(title)} ${elapsed()} ${summary}`); indent(lines); },
        skip(summary) { write(`${P.gray('○')} ${P.bold(title)} ${P.gray(summary)}`); },
        warn(summary) { write(`${P.yellow('!')} ${P.bold(title)} ${elapsed()} ${P.yellow(summary)}`); },
        fail(text) { write(`${P.red('✗')} ${P.bold(title)} ${elapsed()} ${P.red(text)}`); },
      };
    },
  };
}

export async function runTui({ dataset, input = process.stdin, output = process.stdout, env = process.env, demo = false, color, session: provided, autoConnect = true, random, profilePath = null }) {
  const tty = Boolean(input.isTTY && output.isTTY);
  const palette = createPalette(color ?? (Boolean(output.isTTY) && !env.NO_COLOR));
  const session = provided || new TuiSession({ dataset, env, demo, profilePath, ...(random ? { random } : {}) });
  const ui = createUI({ output, palette, redact: (t) => session.redact(t), tty });
  const P = palette;
  const rl = readline.createInterface({ input, output: tty ? output : undefined, terminal: tty, historySize: 200 });
  const queue = []; let waiting = null, closed = false, pendingStores = null, controller = null, busy = false;
  rl.on('line', (line) => { if (waiting) { const w = waiting; waiting = null; w(line); } else queue.push(line); });
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
  let interrupted = false;
  rl.on('SIGINT', () => {
    if (controller && !controller.signal.aborted) { controller.abort(); ui.info('已请求取消当前 Agent 流程。'); }
    else if (busy && !interrupted) { interrupted = true; ui.info('正在等待当前请求结束；再按一次 Ctrl+C 退出。'); }
    else rl.close();
  });
  const nextLine = (prompt) => {
    if (queue.length) { const line = queue.shift(); if (!tty) ui.write(`${P.brand(prompt)}${line}`); return Promise.resolve(line); }
    if (closed) return Promise.resolve(null);
    rl.setPrompt(P.brand(prompt)); if (tty) rl.prompt();
    return new Promise((resolve) => { waiting = (line) => { if (!tty && line !== null) ui.write(`${P.brand(prompt)}${line}`); resolve(line); }; });
  };

  const showReport = (report) => ui.panel('核价结果', renderReport(report, P, { remaining: session.remainingSeconds() }));
  const avoidLines = () => {
    const cells = [...session.mainNames].map(([code, name], i) => `${String(i + 1).padStart(2)}. ${session.request.avoidMainCodes.includes(code) ? P.yellow(`[避开]${name}`) : name}`);
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).map((c) => padEnd(c, 24)).join(''));
    return [...rows, P.gray('/avoid 名称或序号 切换；/avoid clear 清空。条件变化后需重新 /price。')];
  };

  async function quote() {
    const step = ui.begin('查券与官方整单核价');
    try { const report = await session.quote((p) => step.progress(p.text)); step.ok(`预算内 ${report.candidates.length} 份`); showReport(report); }
    catch (e) { step.fail(message(e)); }
  }

  const commands = {
    help: () => ui.panel('命令', helpLines(P)),
    status: () => ui.write(statusLine(session, P)),
    clear: () => ui.clear(),
    async connect() {
      const step = ui.begin('连接麦当劳 MCP');
      try { step.progress('initialize → now-time-info …'); await session.connect(); step.ok('已连接（Token 来自环境变量 MCD_TOKEN，仅在内存）'); }
      catch (e) { step.fail(message(e)); }
    },
    async store(args) {
      const fallback = !args.length, city = fallback ? DEFAULT_STORE_SEARCH.city : args[0].replace(/市$/, ''), keyword = fallback ? DEFAULT_STORE_SEARCH.keyword : args.slice(1).join(' ');
      const step = ui.begin(fallback ? `查询到店门店（默认区域 ${DEFAULT_STORE_SEARCH.label}）` : '查询到店门店');
      try { const stores = await session.searchStores(city, keyword); step.ok(`${stores.length} 家`); pendingStores = { stores: stores.slice(0, 12), city }; ui.panel(`门店 · ${city} ${keyword}`, renderStores(stores, P)); }
      catch (e) { step.fail(message(e)); }
    },
    use(args) { return selectStore(Number(args[0])); },
    async coupons() {
      if (session.demo) return ui.panel('优惠口袋 · 样本', [...renderClaimable(session.couponPicture().claimable, P, { sample: true, limit: 12 }), '',
        P.gray('样本模式不读取券包；连接 MCP 后 /coupons 会在可领券之后列出你持有的券。'), P.gray('活动与参与方式：/activity')]);
      const step = ui.begin('查券（可领 · 持有 · 门店适用 · 活动日历）');
      try { const b = await session.coupons((p) => step.progress(p.text)); step.ok(''); ui.panel('优惠口袋', renderBenefits(b, P, { picture: session.couponPicture() })); }
      catch (e) { step.fail(message(e)); }
    },
    async activity() {
      const step = ui.begin('活动日历（campaign-calendar，只读）');
      try { const r = await session.activities((p) => step.progress(p.text)); step.ok(`${r.rows.length} 项`); ui.panel('活动', renderActivities(r, P)); }
      catch (e) { step.fail(message(e)); }
    },
    allergy(args) {
      if (args.length) {
        try { confirmAllergyAdd(session.addAllergies(args), args); }
        catch (e) { return ui.error(message(e)); }
      }
      ui.panel('过敏记录', renderAllergies(session.allergies, P, { file: session.profilePath || '', error: session.profileError }));
    },
    'allergy-clear'(args) {
      if (!args.length) return ui.error('用法：/allergy-clear 花生（删除一项过敏记录）');
      try {
        const r = session.removeAllergies(args);
        if (!r.removed.length) return ui.error(`过敏记录里没有：${args.join('、')}。当前：${session.allergies.join('、') || '无'}`);
        ui.info(`已删除过敏记录：${r.removed.join('、')}${savedNote(r.saved)}。当前：${session.allergies.join('、') || '无'}。请重新 /price。`);
      } catch (e) { ui.error(message(e)); }
    },
    set(args) {
      try {
        const [people, portion, budget] = args;
        const change = {};
        if (people !== undefined) { if (!['1', '2', '3', '4'].includes(people)) throw new TuiError('人数请填 1–4。'); change.people = Number(people); }
        if (portion !== undefined) { if (!['5', '7', '9'].includes(portion)) throw new TuiError('食量请填 5、7 或 9。'); change.portion = Number(portion); }
        if (budget !== undefined) change.budgetPerPersonFen = budgetFen(budget);
        session.setProfile(change); ui.write(statusLine(session, P));
      } catch (e) { ui.error(e.message); }
    },
    avoid(args) {
      if (args[0] === 'clear') session.setRequest({ avoidMainCodes: [] });
      else if (args.length) {
        const names = [...session.mainNames], current = new Set(session.request.avoidMainCodes);
        for (const arg of args) {
          const hit = /^\d+$/.test(arg) ? names[Number(arg) - 1] : names.find(([, name]) => name === arg);
          if (!hit) { ui.error(`没有找到主食“${arg}”。`); continue; }
          current.has(hit[0]) ? current.delete(hit[0]) : current.add(hit[0]);
        }
        session.setRequest({ avoidMainCodes: [...current] });
      }
      ui.panel('避开的主食', avoidLines());
    },
    price: quote,
    wheel() {
      try {
        const { plan, pool } = session.spin();
        if (tty) { const names = pool.map((p) => p.wheelTitle || p.title); ui.write(P.gray(`转盘：${names.join(' · ')}`)); }
        ui.result(`转盘揭晓（本轮剩 ${session.wheel.remaining().length} 份）`, renderPick(plan, P, { report: session.report, remaining: session.remainingSeconds(), coupons: session.couponPicture().usable }));
        maybeReceipt(ui, session);
      } catch (e) { ui.error(message(e)); }
    },
    receipt() {
      if (!session.lastReceipt) return ui.error('还没有挑出的套餐：先说一句话、/wheel 或 /buddy，再 /receipt。');
      printReceipt(ui, session.lastReceipt);
    },
    async buddy(args) {
      const mood = args.find((a) => MOODS.includes(a)) || 'normal', local = args.includes('local') || !session.hasDeepSeek;
      const step = ui.begin(local ? '本地偏好推荐' : '饭搭子双 Agent（DeepSeek）');
      controller = new AbortController();
      try {
        const result = await session.buddy({ mood, local, signal: controller.signal, onStage: (role) => step.progress(role === 'recommend' ? '推荐 Agent 挑选中…' : '优化 Agent 复核中…') });
        step.ok(result.source === 'deepseek' ? `${result.rounds} 轮完成` : '');
        ui.result('饭搭子推荐', renderAgentResult(result, P, { report: session.report, remaining: session.remainingSeconds() }));
        ui.write(P.gray('/like 喜欢这份 · /less 以后少推荐（只在本次会话内存）· /receipt 小票'));
        maybeReceipt(ui, session);
      } catch (e) { step.fail(message(e)); }
      finally { controller = null; }
    },
    prefs(args) {
      const [key, value] = args, options = { goal: GOALS, persona: ['cozy', 'frugal', 'playful'], mode: ['team', 'recommend', 'optimize'] };
      if (key && options[key]?.includes(value)) session.preferences = { ...session.preferences, [key]: value };
      else if (key) ui.error(`可选：${Object.entries(options).map(([k, v]) => `${k}=${v.join('/')}`).join('；')}`);
      const p = session.preferences;
      ui.write(`目标 ${p.goal} · 风格 ${p.persona} · Agent ${p.mode} · 本次会话反馈 ${p.feedback.length} 条`);
    },
    like: () => { try { ui.info(`已记住喜欢：${session.feedback('like').title}（仅本次会话）`); } catch (e) { ui.error(message(e)); } },
    less: () => { try { ui.info(`以后少推荐：${session.feedback('less').title}（仅本次会话）`); } catch (e) { ui.error(message(e)); } },
    async radar(args) {
      if (args[0] === 'apply') {
        if (session.history?.sourceKind !== 'official-history') return ui.error(session.history ? '虚构示例不能导入最近主食。' : '先 /radar 读取历史。');
        const codes = session.recentMains(2);
        if (!codes.length) return ui.info('前两天没有返回可识别的主食，可用 /avoid 手动选择。');
        session.setRequest({ avoidMainCodes: [...new Set([...session.request.avoidMainCodes, ...codes])] });
        return ui.info(`已加入避开：${codes.map((c) => session.mainNames.get(c) || c).join('、')}。请重新 /price。`);
      }
      const mode = args.includes('year') ? 'year' : 'recent', year = Number(args.find((a) => /^\d{4}$/.test(a))) || undefined;
      if (!session.history || args.includes('refresh')) {
        const step = ui.begin('读取历史订单（order-list）');
        try { step.progress('now-time-info → order-list …'); await session.radar(); step.ok(`${session.history.orders.length} 笔已完成订单`); }
        catch (e) { return step.fail(message(e)); }
      }
      try { ui.panel(`麦当劳雷达 · ${mode === 'year' ? '全年' : '近 12 周'}`, renderHeatmap(session.history, P, { mode, year })); }
      catch (e) { ui.error(message(e)); }
      const recent = session.recentMains(2);
      if (recent.length) ui.write(P.gray(`前两天可识别主食：${recent.map((c) => session.mainNames.get(c) || c).join('、')} · /radar apply 加入避开`));
    },
    async weather() {
      const step = ui.begin('城市天气（Open-Meteo，仅城市名）');
      try { const w = await session.readWeather(); step.ok(`${w.city} · ${w.description} ${w.temperatureC}°C（体感 ${w.feelsLikeC}°C）`); }
      catch (e) { step.fail(message(e)); }
    },
    async claim() {
      if (session.demo) return ui.error('样本模式不能领券。');
      if (!session.connected) return ui.error('尚未连接麦当劳 MCP，请先 /connect。');
      // Read-only look first, so the user sees what would be claimed before confirming.
      if (!session.benefits && session.store) {
        const step = ui.begin('查看可领券（只读，不领取）');
        try { await session.coupons((p) => step.progress(p.text)); step.ok(''); } catch (e) { step.warn(`可领券列表未查到：${message(e)}`); }
      }
      const claimable = session.benefits ? session.couponPicture().claimable : null;
      const listed = !claimable ? [P.gray('还没选门店，未能先列出可领券（/store 选店后 /coupons 可查看）。')]
        : claimable.length ? renderClaimable(claimable, P, { limit: 12 }).slice(0, -1) : renderClaimable(claimable, P);
      ui.panel('领取全部可领券', [...listed, '', '官方接口一次领取全部当前可领券，不能指定单张。', '领取后旧报价作废，会重新查券与核价；结果不明确时不会自动重试。', P.bold('确认领取请输入 yes，其他任何输入都会取消。')], 'yellow');
      const answer = await nextLine('确认领取？> ');
      if (answer?.trim().toLowerCase() !== 'yes') return ui.info('已取消，未领取。');
      const step = ui.begin('领取全部可领券（auto-bind-coupons）');
      try {
        const r = await session.claim({ confirmed: true });
        step.ok(r.successCount == null ? '请求已返回，数量待券包验证' : `已领取 ${r.successCount} 张${r.failedCount ? `，${r.failedCount} 张未成功` : ''}`);
      } catch (e) { step.fail(`${message(e)} 本次不自动重试；再次领券前请先 /coupons 核对。`); return; }
      if (session.store) await quote();
    },
    quit: () => rl.close(),
  };
  Object.assign(commands, { exit: commands.quit, q: commands.quit, h: commands.help, '?': commands.help });
  // /help must list every command the shell handles, and nothing it does not.
  const drift = [...Object.keys(commands).filter((k) => !HELP_COMMANDS.has(k)), ...[...HELP_COMMANDS].filter((k) => !commands[k])];
  if (drift.length) throw new Error(`命令表与 /help 不一致：${drift.join(', ')}`);

  const savedNote = (ok) => ok ? `（已保存到本机 ${session.profilePath}）` : session.profileError ? `（${session.profileError}，只在本次会话内生效）` : '（只在本次会话内存）';
  function confirmAllergyAdd(r, tokens) {
    if (r.added.length) ui.info(`已记录过敏：${r.added.join('、')}${savedNote(r.saved)}。之后在本地排除名称含相关关键词或成分不明的餐品；不会发送给 DeepSeek 或 MCP。`);
    if (r.existing.length) ui.info(`已在过敏记录中：${r.existing.join('、')}`);
    if (!r.added.length && !r.existing.length) ui.error(`没有识别出过敏原：${tokens.join(' ')}`);
  }

  function selectStore(n) {
    const item = pendingStores?.stores[n - 1];
    if (!item) return ui.error('没有这个序号，先 /store 搜索门店。');
    session.selectStore(item, pendingStores.city); pendingStores = null;
    ui.info(`已选择 ${item.storeName}（到店自取）。接下来 /coupons、/price，或直接输入一句话。`);
  }

  async function handle(line) {
    const text = line.trim();
    if (!text) return;
    if (/^\d+$/.test(text) && pendingStores) return selectStore(Number(text));
    if (text.startsWith('/')) {
      const [name, ...args] = text.slice(1).split(/\s+/);
      const command = commands[name.toLowerCase()];
      if (!command) return ui.error(`未知命令 /${name}，输入 /help 查看。`);
      return command(args);
    }
    // Allergy statements are recorded locally and never reach the intent agent.
    const allergy = parseAllergyStatement(text);
    let rest = text;
    if (allergy) {
      if (allergy.allergens.length) confirmAllergyAdd(session.addAllergies(allergy.allergens), allergy.allergens);
      else ui.info('这句话里没有识别出要记录的过敏原；可以用 /allergy 花生 这样添加。');
      rest = allergy.rest.trim();
      if (!rest) return;
    }
    if (isActivityQuery(rest)) return commands.activity();
    ui.write(''); ui.write(P.bold(`Agent 指令：${allergy ? '（过敏信息已在本地记录，以下内容才交给 Agent）' : ''}${rest}`));
    controller = new AbortController();
    try { await runAgentFlow(session, rest, ui, { signal: controller.signal }); }
    finally { controller = null; }
  }

  // Header.
  ui.clear();
  ui.panel('麦麦饱饱盘 · 终端版', [
    P.bold('饭点选套餐：说一句话，Agent 帮你走完查店、查券、核价和挑选。'),
    P.yellow(NOTICE),
    `MCD_TOKEN：${session.demo ? '样本模式未使用' : session.hasMcdToken ? P.green('已从环境变量读取（不显示、不保存）') : P.red('未设置')}`,
    `DEEPSEEK_API_KEY：${session.hasDeepSeek ? P.green('已从环境变量读取（不显示、不保存）') : P.yellow(session.deepseekNote || '未设置，饭搭子使用本地偏好推荐')}`,
    `默认选店区域：${P.bold(DEFAULT_STORE_SEARCH.label)}${session.demo ? P.gray('（样本模式不搜索，用样本门店）') : ''}`,
    `默认餐量：${DEFAULT_INTENT.people} 人 · ${DEFAULT_INTENT.portion} 分饱 · 人均 ¥${DEFAULT_INTENT.budgetPerPersonYuan}`,
    `过敏记录：${session.allergies.length ? P.bold(session.allergies.join('、')) : '无'}${session.profileError ? P.red(`（${session.profileError}，不会覆盖该文件）`) : ''}${P.gray('（只存本机，本地筛选，从不发送；/allergy 管理）')}`,
    P.gray('指令里写明的人数 / 食量 / 预算 / 位置（@城市 关键词）优先；/set、/store 也会覆盖默认。'),
    P.gray('输入 /help 查看命令；不下单、不付款，领券需明确确认。'),
  ]);
  if (autoConnect && !session.demo && session.hasMcdToken) await commands.connect();
  else if (!session.demo && !session.hasMcdToken) ui.error('请先 export MCD_TOKEN=… 再启动；也可以用 npm run tui -- --demo 体验历史样本。');

  try {
    for (;;) {
      if (tty) ui.write(statusLine(session, P));
      const line = await nextLine('麦麦> ');
      if (line === null) break;
      busy = true; interrupted = false;
      try { await handle(line); } catch (e) { ui.error(message(e)); } finally { busy = false; }
      if (!tty) ui.write(statusLine(session, P));
    }
  } finally {
    session.close(); rl.close();
    ui.write(P.gray('再见。凭证只在本次进程内存中，已随退出清除。'));
  }
  return session;
}
