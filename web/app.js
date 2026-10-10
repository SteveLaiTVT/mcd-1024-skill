import { MCPClient, MCPError } from './mcp-client.mjs';
import { budgetFen, inspectBenefits, prepareWheel, prepareDemo, WheelSession } from './meal-engine.mjs';
import { readHistory } from './order-history.mjs';
import { createRadar } from './radar-view.mjs';
import { createAccountStorage } from './account-storage.mjs';
import { storeResults, storeStatus, addressLocations, addressCity } from './store-search.mjs';
import { createMealAssistant } from './agent-view.mjs';

const NS = 'http://www.w3.org/2000/svg';
const money = (fen) => `¥${(fen / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}`;
const chinaTime = (value) => new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });

export async function startApp({
  doc = globalThis.document, win = globalThis.window,
  extension = ['chrome-extension:', 'moz-extension:'].includes(globalThis.location?.protocol),
  clientFactory = (token) => new MCPClient(token),
  prepareLive = prepareWheel, inspect = inspectBenefits, loadHistory = readHistory,
  accountStorage = null,
  agentStorage, agentClientFactory, weatherClient, agentNow,
  dataset = null, loadJSON = async (name) => {
    const response = await fetch(new URL(`data/${name}.json`, import.meta.url));
    if (!response.ok) throw new Error('体验数据暂时不可用'); return response.json();
  },
  clock = () => performance.now(),
} = {}) {
  const $ = (id) => doc.getElementById(id);
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const svg = (tag, attrs = {}, text) => { const node = doc.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v)); if (text != null) node.textContent = text; return node; };
  const accountStore = accountStorage || createAccountStorage({ extension });
  const state = { client: null, pendingClient: null, context: null, savedStore: null, busy: false, spinning: false, radarBusy: false, restoring: accountStore.available, remembered: false, unloaded: false, view: 'wheel', epoch: 0, offers: [], selected: null, history: new Set(), claimNeedsRefresh: false, loaded: false };
  let activeToken = '', rememberedAccount = null, storageRevision = 0;
  const session = new WheelSession(clock);
  const conditionControls = [...doc.querySelectorAll('#conditions input, #conditions button')];
  let toastTimer;
  const toast = (text) => { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); };
  const readRequest = () => ({ people: Number(doc.querySelector('input[name="people"]:checked').value), portion: Number(doc.querySelector('input[name="portion"]:checked').value), budgetPerPersonFen: budgetFen($('budget').value), avoidMainCodes: [...state.history] });
  const assistant = createMealAssistant({ doc, extension, storage: agentStorage, clientFactory: agentClientFactory, weatherClient, now: agentNow,
    getReport: () => session.report, isFresh: () => session.fresh(), getMainCodes: () => dataset?.templates.mainProductCodes || [],
    onSelect(plan) { if (!session.fresh() || !session.report.candidates.includes(plan)) return; session.seen.add(plan.id); reveal(plan); updateControls(); },
  });
  const radar = createRadar({ doc, load: () => loadHistory(state.client, dataset?.templates.mainProductCodes || []),
    onConnect: openAccount,
    onLoading(loading) { state.radarBusy = loading; updateControls(); },
    onApply(codes) {
      if (state.busy || state.spinning || state.radarBusy) return;
      codes.filter((code) => dataset?.templates.mainProductCodes.includes(code)).forEach((code) => state.history.add(code));
      doc.querySelectorAll('#history-options button').forEach((button) => button.setAttribute('aria-pressed', String(state.history.has(button.dataset.code))));
      $('history-count').textContent = state.history.size ? `避开 ${state.history.size} 种` : '可选';
      $('history-note').textContent = '已补充前两天返回记录中可识别的主食。你可以增删；多人按全桌共同避开。仅本页记住。';
      $('history-details').open = true; setView('wheel'); resetWheel('前两天的主食已加入避开项，按新的条件重新核价。');
    },
  });
  function setView(view) {
    state.view = view;
    $('wheel-view').hidden = view !== 'wheel'; $('radar-view').hidden = view !== 'radar';
    $('view-wheel').setAttribute('aria-pressed', String(view === 'wheel'));
    $('view-radar').setAttribute('aria-pressed', String(view === 'radar'));
    $('hero-title').textContent = view === 'radar' ? '你的麦当劳，' : '今天吃什么？';
    $('hero-title').append(el('br'), el('span', view === 'radar' ? '每一餐都看得见。' : '转一下，就开饭。'));
    $('hero-description').textContent = view === 'radar' ? '从历史订单点亮用餐日历，回看熟悉的味道，也给下一餐留一点新鲜感。' : '人数、食量、预算你来定。先算好套餐优惠，再把纠结交给转盘。';
  }
  function updateBudget() {
    try { const request = readRequest(); $('budget-total').textContent = `整顿最多 ${money(request.people * request.budgetPerPersonFen)}`; }
    catch { $('budget-total').textContent = '请填写有效预算'; }
    doc.querySelectorAll('[data-budget]').forEach((b) => b.classList.toggle('active', b.dataset.budget === $('budget').value));
  }
  function updateControls() {
    const locked = state.busy || state.spinning || state.radarBusy || state.restoring;
    radar.setLocked(locked);
    assistant.setLocked(locked);
    conditionControls.forEach((c) => { c.disabled = locked; });
    doc.querySelectorAll('#history-options button').forEach((c) => { c.disabled = locked; });
    $('prepare').disabled = locked || !state.loaded;
    $('prepare-label').textContent = state.busy ? '正在计算这顿的价格…' : '算好价格，生成转盘';
    $('claim').disabled = locked || !state.client || !state.context || !state.offers.some((o) => o.canClaim) || state.claimNeedsRefresh;
    $('refresh-wallet').disabled = locked || !state.client || !state.context;
    $('connect').disabled = locked || !extension;
    $('remember-account').disabled = locked || !accountStore.available;
    $('retry-saved').disabled = locked;
    $('retry-saved').hidden = !rememberedAccount || Boolean(state.client);
    $('forget-account').hidden = !rememberedAccount || Boolean(state.client);
    $('search-stores').disabled = locked || !state.client;
    $('load-addresses').disabled = locked || !state.client;
    $('store-city').disabled = locked || !state.client;
    $('store-keyword').disabled = locked || !state.client;
    doc.querySelectorAll('#store-results button, #address-results button').forEach((button) => { button.disabled = locked || button.dataset.unavailable === 'true'; });
    $('use-demo').disabled = locked;
    const remaining = session.remaining();
    $('spin').disabled = locked || !remaining.length;
    $('spin-again').disabled = locked || !remaining.length;
    $('spin-label').textContent = state.spinning ? '转动中' : state.busy ? '算优惠' : remaining.length ? '开饭！' : session.report ? session.fresh() ? '转完啦' : '重核价' : '待核价';
    $('spin-subtitle').textContent = remaining.length ? '把纠结交给我' : state.busy ? '马上就好' : '先算好再转';
    $('pool-count').textContent = session.report ? `${remaining.length} 份待揭晓` : '等待入盘';
    $('wheel-dot').classList.toggle('ready', Boolean(remaining.length) && !locked);
  }
  function progress({ step = -1, text, benefits } = {}) {
    $('progress').textContent = text || '先选好这顿的条件，就能生成转盘。';
    doc.querySelectorAll('[data-step]').forEach((node) => { node.classList.toggle('active', Number(node.dataset.step) === step); node.classList.toggle('done', Number(node.dataset.step) < step); });
    if (benefits) renderWallet(benefits.offers, benefits.ownedCount, benefits.usable.length);
  }
  function drawWheel(plans = []) {
    const placeholder = ['套餐优先', '算好优惠', '刚刚好吃', '预算内选', '一起开饭', '来点惊喜'];
    const entries = plans.length ? plans : placeholder.map((title) => ({ wheelTitle: title }));
    const colors = ['#f7ca69', '#f2dec0', '#e9a179', '#f8e7bb', '#f0be77', '#ecd4ad'];
    const rotor = $('rotor'); rotor.style.transition = 'none'; rotor.style.transform = 'rotate(0deg)'; rotor.replaceChildren();
    const n = entries.length, step = 360 / n;
    entries.forEach((p, index) => {
      const start = (-90 + index * step) * Math.PI / 180, end = start + step * Math.PI / 180;
      if (n === 1) rotor.append(svg('circle', { cx: 180, cy: 180, r: 169, fill: colors[0], stroke: '#fff8ed', 'stroke-width': 2 }));
      else rotor.append(svg('path', { d: `M180 180L${180 + 169 * Math.cos(start)} ${180 + 169 * Math.sin(start)}A169 169 0 ${step > 180 ? 1 : 0} 1 ${180 + 169 * Math.cos(end)} ${180 + 169 * Math.sin(end)}Z`, fill: colors[index % colors.length], stroke: '#fff8ed', 'stroke-width': 2 }));
      const middle = -90 + (index + .5) * step, angle = n === 1 ? -90 : middle;
      const x = 180 + 109 * Math.cos(angle * Math.PI / 180), y = 180 + 109 * Math.sin(angle * Math.PI / 180);
      const group = svg('g', { transform: `translate(${x} ${y}) rotate(${n === 1 ? 0 : middle + 90})` });
      group.append(svg('text', { x: 0, y: -3, fill: '#5d4228', 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 650 }, p.wheelTitle || p.title));
      group.append(svg('text', { x: 0, y: 17, fill: '#96744b', 'text-anchor': 'middle', 'font-size': 11 }, plans.length ? money(p.priceFen) : 'MEAL O’CLOCK'));
      rotor.append(group);
    });
    $('wheel').setAttribute('aria-label', plans.length ? `${plans.length} 份预算内完整套餐转盘` : '等待核价的套餐转盘');
  }
  function resetWheel(text = '条件更新了，重新算好价格再转。') {
    assistant.invalidate();
    session.invalidate(); state.selected = null; $('result').hidden = true; $('pricing').hidden = true;
    $('plan-list').replaceChildren(); $('benefit-rows').replaceChildren(); $('calendar-rows').replaceChildren();
    drawWheel(); $('pool-status').textContent = '预算内的完整套餐，才会出现在这里。';
    $('wheel-message').textContent = '每份餐单等概率，同一轮不会重复。'; progress({ text }); updateControls();
  }
  function renderWallet(offers, owned = null, eligible = null) {
    state.offers = offers;
    $('owned-count').textContent = owned == null ? '—' : owned;
    $('eligible-count').textContent = eligible == null ? '—' : eligible;
    $('offer-count').textContent = offers.filter((o) => o.canClaim).length;
    $('offer-list').replaceChildren(...offers.map((o) => {
      const node = el('div', null, 'offer'), body = el('div', null, 'offer-body');
      body.append(el('strong', o.name), el('small', state.client ? o.label || '适用范围待核实' : '公开展示样本 · 当前状态需重查'));
      node.append(el('span', '券', 'offer-mark'), body, el('span', state.client ? o.canClaim ? '可领取' : '待确认' : '样本', 'offer-tag')); return node;
    }));
    $('wallet-note').textContent = state.client ? `${state.context?.storeName || '选门店后'} · 已领取且适用的券才参与核价。` : '这里是历史展示样本；连接后查询你自己的可领券。';
    updateControls();
  }
  function renderInformation(report) {
    const owned = report.benefits.filter((r) => r.kind === 'owned-coupon' || r.kind === 'source-error');
    $('benefit-count').textContent = `${owned.length} 项`;
    const status = { eligible: '可参与核价', unavailable: '本次不可用', unknown: '待确认' };
    $('benefit-rows').replaceChildren(...owned.map((r) => {
      const row = el('tr'), scope = el('td', r.scope); scope.append(el('small', r.condition));
      row.append(el('td', r.name + (r.assetCount > 1 ? ` ×${r.assetCount}` : '')), scope, el('td', status[r.status] || '待确认')); return row;
    }));
    if (!owned.length) { const row = el('tr'), cell = el('td', report.sourceKind === 'demo-snapshot' ? '体验模式未读取个人券包。' : '当前没有可展示的持有券。'); cell.setAttribute('colspan', 3); row.append(cell); $('benefit-rows').append(row); }
    $('calendar-summary').textContent = `${report.campaignEntries.length} 条`;
    $('calendar-rows').replaceChildren(...report.campaignEntries.map((r) => {
      const row = el('tr'), name = el('td', r.name), scope = el('td', r.scope);
      name.append(el('small', `${r.date} · ${r.eventTypeName}`)); scope.append(el('small', r.condition));
      row.append(name, scope, el('td', r.priceUse === 'information-only-no-price-rule' ? '信息入口，不扣价' : '待持券与核价验证')); return row;
    }));
  }
  function mealIcon() {
    const node = svg('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
    node.append(svg('path', { d: 'M4 13C4 2 28 2 28 13Z', fill: '#d39342' }), svg('path', { d: 'M3 16H29L27 20H5Z', fill: '#72875a' }), svg('rect', { x: 4, y: 20, width: 24, height: 4, rx: 2, fill: '#8a5031' }), svg('path', { d: 'M4 25H28Q28 29 24 29H8Q4 29 4 25', fill: '#d39342' })); return node;
  }
  function renderReport(report) {
    session.accept(report); $('pricing').hidden = false;
    const demo = report.sourceKind === 'demo-snapshot';
    renderWallet(report.claimableOffers, demo ? null : report.counts.ownedAssets, demo ? null : report.counts.validatedCoupons);
    $('quote-time').textContent = demo ? '历史样本价' : `核价 ${chinaTime(report.checkedAt)}`;
    $('price-summary').textContent = `${report.request.people} 人 · 整顿最多 ${money(report.request.totalBudgetFen)} · ${report.quotedPlans.length} 份套餐已${demo ? '比较' : '核价'}，${report.candidates.length} 份在预算内。`;
    $('plan-list').replaceChildren(...report.quotedPlans.map((p, i) => {
      const node = el('article', null, `plan${p.withinBudget ? '' : ' outside'}`), icon = el('span', null, 'plan-icon'); icon.append(mealIcon());
      const info = el('div', null, 'plan-text'); info.append(el('h3', p.title), el('p', `${p.wheelKind} · ${p.people} 人${i === 0 ? ' · 此候选池最低' : ''}${p.savingFen ? ` · 用券额外省 ${money(p.savingFen)}` : ''}`));
      const price = el('div', null, 'plan-money'); price.append(el('strong', money(p.priceFen)), el('small', p.withinBudget ? '✓ 预算内，已入盘' : `超预算 ${money(p.priceFen - report.request.totalBudgetFen)}`));
      node.append(icon, info, price); return node;
    }));
    $('comparison-note').textContent = demo ? '演示使用 2026-10-10 深圳样本报价，当前价格和账号优惠需连接后重算。' : `${report.priceComparisonComplete ? '已完成本次模板与已验证持有券的报价比较。' : '部分条件或报价未查全，展示最低已核验价。'} 不含未领券、购卡和积分兑换；仅匹配已核实的商品编码。${report.failedPlans.length ? ` ${report.failedPlans.length} 份核价失败未入盘。` : ''}${report.excludedPlans.length ? ` ${report.excludedPlans.length} 份含最近主食已避开。` : ''}`;
    renderInformation(report); drawWheel(report.candidates);
    doc.querySelectorAll('[data-step]').forEach((node) => { node.classList.remove('active'); node.classList.add('done'); });
    if (report.candidates.length) {
      $('pool-status').textContent = demo ? `${report.candidates.length} 份历史样本餐单已入盘 · 体验模式` : `${report.candidates.length} 份完整套餐已入盘 · 报价最多保留 5 分钟`;
      progress({ step: 4, text: demo ? '体验转盘已准备好。连接自己的账号可核算实时优惠。' : '优惠算好了。现在转一下，揭晓这一餐。' });
    } else {
      $('pool-status').textContent = '这一档暂时没有预算内套餐。';
      $('wheel-message').textContent = report.minimumVerifiedPriceFen == null ? '换个食量档位，或确认门店是否供应这些套餐。' : `这一档最低 ${money(report.minimumVerifiedPriceFen)}，可增加预算或选轻一点。`;
      progress({ text: '没有合适的餐单入盘，调整条件后再算一次。' });
    }
    updateControls();
  }
  const isCurrent = (epoch) => state.epoch === epoch;
  async function calculate(event) {
    event?.preventDefault(); if (state.busy || state.spinning || state.radarBusy || !state.loaded) return;
    let request; try { request = readRequest(); } catch (e) { progress({ text: e.message }); $('budget').focus(); return; }
    if (state.client && !state.context) { openAccount(); $('store-search-message').textContent = '先选自己的门店，再按该店价格核算。'; return; }
    const epoch = ++state.epoch; resetWheel('正在准备这一餐…'); state.busy = true; updateControls();
    try {
      const report = state.client
        ? await prepareLive(state.client, dataset.templates, state.context, request, (p) => { if (isCurrent(epoch)) progress(p); })
        : prepareDemo(dataset, { ...dataset.plans.context }, request);
      if (isCurrent(epoch)) renderReport(report);
    } catch (e) { if (isCurrent(epoch)) progress({ text: e instanceof MCPError ? e.message : '这次套餐准备未完成，请重新查询。' }); }
    finally { if (isCurrent(epoch)) { state.busy = false; updateControls(); } }
  }
  function reveal(plan) {
    state.selected = plan; $('result').hidden = false;
    $('result-title').textContent = plan.title; $('result-kind').textContent = plan.wheelKind;
    $('result-price').textContent = money(plan.priceFen); $('result-per-person').textContent = `${plan.people} 人 · 人均 ${money(Math.round(plan.priceFen / plan.people))}`;
    $('result-packages').textContent = plan.packages.map((p) => `${p.name} ×${p.quantity}`).join(' + ');
    $('result-parts').replaceChildren(...plan.parts.map((p) => el('span', `${p.name} ×${p.quantity}`)));
    const extra = plan.savingFen ? `${plan.couponNames.join('、')} · 比无券基准额外省 ${money(plan.savingFen)}。` : '';
    $('result-benefit').textContent = `${extra}整顿预算还剩 ${money(session.report.request.totalBudgetFen - plan.priceFen)}。`;
    $('result-disclaimer').textContent = session.report.sourceKind === 'demo-snapshot' ? '这是历史样本价；连接后再按你的门店和优惠重算。' : '当前整单核验价；活动已包含在官方报价中，未自动下单。';
    $('wheel-message').textContent = session.remaining().length ? '这份已揭晓，再转会换一份。' : '本轮已转完，重新计算即可开始新一轮。';
    $('pool-status').textContent = session.remaining().length ? `还有 ${session.remaining().length} 份预算内餐单待揭晓` : '这一轮的套餐都揭晓啦。';
    assistant.selectForFeedback(plan);
  }
  async function spin() {
    if (state.busy || state.spinning || state.radarBusy || !session.remaining().length) return;
    const epoch = state.epoch, { plan, pool, index } = session.choose();
    drawWheel(pool); state.spinning = true; $('result').hidden = true; updateControls();
    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced && pool.length > 1) {
      await new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      $('rotor').style.transition = 'transform 2.5s cubic-bezier(.12,.75,.15,1)';
      $('rotor').style.transform = `rotate(${1800 + 360 - (index + .5) * 360 / pool.length}deg)`;
      await new Promise((resolve) => setTimeout(resolve, 2550));
    }
    if (isCurrent(epoch) && session.fresh()) reveal(plan);
    else if (isCurrent(epoch)) expire();
    if (isCurrent(epoch)) { state.spinning = false; updateControls(); }
  }
  function expire() {
    if (!session.report || session.fresh()) return;
    assistant.expire();
    state.selected = null; $('result').hidden = true;
    $('pool-status').textContent = '报价已过期，重新核价后再转。'; $('quote-time').textContent = '报价已过期';
    $('wheel-message').textContent = '重新计算会查询最新券包、门店范围和活动。'; updateControls();
  }
  function openAccount() { if (!$('account-dialog').open) $('account-dialog').showModal(); }
  async function forgetSavedAccount() {
    const previous = rememberedAccount;
    state.remembered = false; rememberedAccount = null; $('remember-account').checked = false; updateControls();
    try {
      await accountStore.clear();
      $('remember-status').textContent = '已清除本机保存的凭证。';
    } catch {
      rememberedAccount = previous; state.remembered = Boolean(previous); $('remember-account').checked = Boolean(previous);
      $('remember-status').textContent = '未能清除已保存凭证，请重新加载扩展后再试。'; updateControls();
    }
  }
  async function rememberConnection(epoch = state.epoch) {
    if (!$('remember-account').checked || !accountStore.available || !state.client || !activeToken) return;
    try {
      const account = await accountStore.save({ version: 1, token: activeToken, store: state.savedStore }, { expectedToken: rememberedAccount?.token || null });
      if (!isCurrent(epoch)) return;
      rememberedAccount = account; state.remembered = true;
      $('remember-status').textContent = '已在本机记住凭证，刷新或重开会自动连接。'; updateControls();
    } catch {
      if (isCurrent(epoch)) $('remember-status').textContent = '当前连接可用，但凭证未能保存；请重新加载扩展后重试。';
    }
  }
  function disconnect({ forget = true } = {}) {
    ++state.epoch; state.client?.close(); state.pendingClient?.close(); state.client = null; state.pendingClient = null;
    activeToken = ''; state.context = null; state.savedStore = null; state.history.clear(); state.offers = []; state.busy = false; state.spinning = false; state.claimNeedsRefresh = false;
    radar.clear();
    $('token').value = ''; $('token').type = 'password'; $('reveal-token').textContent = '显示';
    $('connect-form').hidden = false; $('connected-actions').hidden = true; $('store-settings').hidden = true; $('store-results').replaceChildren(); $('address-results').replaceChildren(); $('selected-store').hidden = true;
    $('store-city').value = ''; $('store-keyword').value = ''; $('selected-store-name').textContent = ''; $('selected-store-status').textContent = '';
    $('address-message').textContent = '主动读取后，选一条地址作为搜索位置；地址簿仅在本页显示。';
    $('connect-message').textContent = ''; $('claim-message').textContent = '体验模式不领取真实优惠券。'; $('mode-badge').classList.remove('live'); $('mode-badge').textContent = '体验模式';
    $('account-button').textContent = '连接我的账号 ↗'; $('mode-notice').classList.remove('live'); $('connect-inline').hidden = false;
    $('mode-note').textContent = '体验模式 · 2026-10-10 深圳套餐报价样本。连接后按你的门店和优惠重新核价。';
    doc.querySelectorAll('#history-options button').forEach((b) => b.setAttribute('aria-pressed', 'false')); $('history-count').textContent = '可选';
    $('history-note').textContent = '手动选主食，或从麦当劳雷达导入。这次全桌一起避开，仅本页记住。';
    renderWallet(dataset?.offers.offers || []); resetWheel('本页账号和券包已清除，可继续体验转盘。');
    if (forget) return forgetSavedAccount();
  }
  async function refreshWallet() {
    if (state.busy || state.spinning || state.radarBusy || !state.client || !state.context) return;
    const epoch = ++state.epoch; resetWheel('券包刷新后，重新核价再转。'); state.busy = true; updateControls();
    try {
      const info = await inspect(state.client, state.context, (p) => { if (isCurrent(epoch)) progress(p); });
      if (isCurrent(epoch)) {
        renderWallet(info.offers, info.ownedCount, info.usable.length); state.claimNeedsRefresh = false;
        $('claim-message').textContent = info.walletComplete ? '券包已刷新。领取后还会重新核价，不按券名称直接减钱。' : '券包未查全；目前只展示已核实部分。';
        progress({ text: '券包与适用范围已更新，点击计算生成这顿的转盘。' });
      }
    } catch (e) { if (isCurrent(epoch)) $('claim-message').textContent = e instanceof MCPError ? e.message : '券包读取未完成，请重试刷新。'; }
    finally { if (isCurrent(epoch)) { state.busy = false; updateControls(); } }
  }
  async function claimAll() {
    if (state.busy || state.spinning || state.radarBusy || !state.client || !state.context || state.claimNeedsRefresh) return;
    let request; try { request = readRequest(); } catch (e) { $('claim-dialog').close(); progress({ text: e.message }); return; }
    $('claim-dialog').close(); const epoch = ++state.epoch; const activeClient = state.client;
    resetWheel('正在领取全部可领券…'); state.busy = true; updateControls();
    let message;
    try {
      const data = (await activeClient.claimAll()).data;
      const successes = Number.isSafeInteger(data?.successCount) && data.successCount >= 0 ? data.successCount : null;
      const failures = Number.isSafeInteger(data?.failedCount) && data.failedCount >= 0 ? data.failedCount : null;
      message = successes == null ? '领券请求已返回，领取数量待券包验证。' : `已领取 ${successes} 张${failures ? `，${failures} 张未领取成功` : ''}。`;
    } catch {
      message = '领券结果未确认，本次不自动重试。已尝试重新读取券包；再次领券前请先点刷新。';
      if (isCurrent(epoch)) state.claimNeedsRefresh = true;
    }
    if (!isCurrent(epoch)) return;
    $('claim-message').textContent = `${message} 正在按更新后的券包核价…`;
    try {
      const report = await prepareLive(activeClient, dataset.templates, state.context, request, (p) => { if (isCurrent(epoch)) progress(p); });
      if (isCurrent(epoch)) { renderReport(report); $('claim-message').textContent = `${message} 券包、门店范围和套餐价格已重新查询。`; }
    } catch {
      if (isCurrent(epoch)) { $('claim-message').textContent = `${message} 后续读取或核价未完成，请刷新后重新计算。`; progress({ text: '领券后的重新核价未完成，转盘暂不可用。' }); }
    } finally { if (isCurrent(epoch)) { state.busy = false; updateControls(); } }
  }
  async function connect(event, saved = null) {
    event?.preventDefault(); if (!extension || state.busy || state.spinning || state.radarBusy || state.restoring || state.unloaded) return;
    const epoch = ++state.epoch; let candidate;
    const token = saved?.token || $('token').value.trim().replace(/^Bearer\s+/i, '');
    try { candidate = clientFactory(token); } catch (e) { $('connect-message').textContent = e.message; return; }
    $('token').value = ''; $('token').type = 'password'; $('reveal-token').textContent = '显示'; state.pendingClient = candidate;
    resetWheel('正在连接麦当劳…'); state.busy = true; updateControls(); $('connect-message').textContent = '正在验证连接，Token 已从输入框清除…';
    try {
      await candidate.initialize(); await candidate.call('now-time-info');
      if (!isCurrent(epoch)) { candidate.close(); return; }
      state.client = candidate; state.pendingClient = null; state.context = null; state.savedStore = null; activeToken = token;
      if (saved) $('remember-status').textContent = '已恢复本机保存的凭证；取消勾选可删除。';
      radar.setConnected(true);
      $('connect-form').hidden = true; $('connected-actions').hidden = false; $('store-settings').hidden = false;
      $('connect-message').textContent = state.view === 'radar' ? '连接成功。关闭面板即可读取历史；套餐核价需要另选门店。' : '连接成功。选择自己的门店后，查券并核算这一餐。';
      $('mode-badge').textContent = '已连接 · 待选门店'; $('mode-badge').classList.add('live'); $('account-button').textContent = '我的账号与门店 ↗';
      $('mode-notice').classList.add('live'); $('connect-inline').hidden = true; $('mode-note').textContent = '已直连麦当劳 · 请先选自己的到店取餐门店。';
      renderWallet([]); $('claim-message').textContent = '选好门店后，可查看并领取当前账号的可领券。';
      if (!saved) await rememberConnection(epoch);
      if (saved?.store && isCurrent(epoch)) {
        $('store-city').value = saved.store.city; $('store-keyword').value = saved.store.storeName;
        try {
          const stores = storeResults((await candidate.call('query-nearby-stores', { beType: 1, searchType: 2, city: saved.store.city, keyword: saved.store.storeName })).data);
          if (!isCurrent(epoch)) return;
          const store = stores.find((item) => item.storeCode === saved.store.storeCode);
          if (store?.businessStatus === true) {
            setStore(store, saved.store.city);
            $('connect-message').textContent = '已恢复连接和上次门店。可随时换店；套餐价格需重新核算。';
            progress({ text: '已恢复上次门店，按当前条件重新核价即可开转。' });
          } else {
            $('store-search-message').textContent = store ? `上次门店${storeStatus(store)}，请重新选择营业中的门店。` : '上次门店未返回，请重新搜索并选择门店。';
          }
          renderStores(stores, saved.store.city);
        } catch {
          if (isCurrent(epoch)) $('store-search-message').textContent = '上次门店未能重新确认，请搜索门店后再核价。';
        }
      }
    } catch (e) {
      candidate.close(); if (isCurrent(epoch)) {
        state.pendingClient = null; activeToken = '';
        $('connect-message').textContent = e instanceof MCPError ? e.message : '连接失败，请检查 Token 后重试。';
        if (saved && [401, 403].includes(e.status)) {
          await forgetSavedAccount();
          if (isCurrent(epoch)) $('connect-message').textContent = '已保存的凭证无法通过验证，请重新填写 Token。';
        } else if (saved) { $('connect-message').textContent = '暂时未能恢复连接，已保留本机凭证，可点击重新连接。'; $('remember-status').textContent = '本机保存的凭证已保留。'; }
        if (isCurrent(epoch)) progress({ text: '连接未完成，可继续体验套餐转盘。' });
      }
    } finally { if (isCurrent(epoch)) { state.busy = false; updateControls(); } }
  }
  function setStore(store, city) {
    state.context = { storeCode: store.storeCode, storeName: store.storeName, beType: 1, orderType: 1 };
    state.savedStore = { storeCode: store.storeCode, storeName: store.storeName, city };
    assistant.setCity(city);
    $('selected-store').hidden = false; $('selected-store-name').textContent = store.storeName;
    $('selected-store-status').textContent = `${storeStatus(store)} · ${store.address || '地址未提供'}`;
    $('mode-badge').textContent = '我的账号 · 已直连'; $('mode-note').textContent = `${store.storeName} · 到店取餐 · 可在账号面板更换门店。`;
    resetWheel('门店已更新，按该店当前优惠重新核价。'); renderWallet([]);
  }
  function renderStores(stores, city) {
    $('store-results').replaceChildren(...stores.map((store) => {
      const button = el('button', null, 'store-choice'); button.type = 'button'; button.dataset.unavailable = String(store.businessStatus !== true);
      button.setAttribute('aria-pressed', String(state.context?.storeCode === store.storeCode));
      button.append(el('strong', store.storeName), el('small', store.address || '地址未提供'), el('small', storeStatus(store)));
      store.reservationTimeOptions.forEach((option) => button.append(el('small', `可预约：${option.date}${option.today ? '（今天）' : ''} ${option.text}`)));
      button.addEventListener('click', () => {
        if (state.busy || state.spinning || state.radarBusy || store.businessStatus !== true) return;
        setStore(store, city); $('account-dialog').close();
        doc.querySelectorAll('#store-results button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        const refreshing = refreshWallet();
        return Promise.all([refreshing, rememberConnection()]);
      }); return button;
    }));
    updateControls();
  }
  async function loadAddresses() {
    if (!state.client || state.busy || state.spinning || state.radarBusy) return;
    const epoch = ++state.epoch; state.busy = true; updateControls(); $('address-results').replaceChildren();
    $('address-message').textContent = '正在读取麦当劳已保存的地址…';
    try {
      const addresses = addressLocations((await state.client.call('delivery-query-addresses')).data);
      if (!isCurrent(epoch)) return;
      $('address-message').textContent = addresses.length ? '选一条地址作为搜索位置；不会保存地址簿。' : '麦当劳没有返回已保存的地址，可直接输入城市和位置。';
      $('address-results').replaceChildren(...addresses.map((address) => {
        const button = el('button', address, 'store-choice'); button.type = 'button';
        button.addEventListener('click', () => {
          if (state.busy || state.spinning || state.radarBusy) return;
          $('store-keyword').value = address; $('store-city').value = addressCity(address);
          $('address-message').textContent = $('store-city').value ? '已填入搜索位置，检查后点击“查找附近门店”。' : '已填入地址，请填写它所在的城市后查找附近门店。';
          $('address-results').replaceChildren(); $('store-city').focus();
        }); return button;
      }));
    } catch { if (isCurrent(epoch)) $('address-message').textContent = '地址读取未完成，可重试或直接输入城市和位置。'; }
    finally { if (isCurrent(epoch)) { state.busy = false; updateControls(); } }
  }
  async function searchStores(event) {
    event.preventDefault(); if (!state.client || state.busy || state.spinning || state.radarBusy) return;
    const city = $('store-city').value.trim(), keyword = $('store-keyword').value.trim(); if (!city || !keyword) return;
    const epoch = ++state.epoch; state.busy = true; updateControls(); $('store-results').replaceChildren(); $('store-search-message').textContent = '正在查询到店取餐门店…';
    try {
      const stores = storeResults((await state.client.call('query-nearby-stores', { beType: 1, searchType: 2, city, keyword })).data);
      if (!isCurrent(epoch)) return;
      $('store-search-message').textContent = stores.length ? '选择一个营业中的门店，以该店当前价格核算。' : '没有找到门店，换个城市或关键词试试。';
      renderStores(stores, city);
    } catch (e) { if (isCurrent(epoch)) $('store-search-message').textContent = e instanceof MCPError ? e.message : '门店查询未完成，请换个关键词重试。'; }
    finally { if (isCurrent(epoch)) { state.busy = false; updateControls(); } }
  }

  $('conditions').addEventListener('submit', calculate);
  $('view-wheel').addEventListener('click', () => setView('wheel'));
  $('view-radar').addEventListener('click', () => setView('radar'));
  doc.querySelectorAll('input[name="people"], input[name="portion"]').forEach((c) => c.addEventListener('change', () => { updateBudget(); resetWheel(); }));
  $('budget').addEventListener('input', () => { updateBudget(); resetWheel(); });
  doc.querySelectorAll('[data-budget]').forEach((button) => button.addEventListener('click', () => { $('budget').value = button.dataset.budget; updateBudget(); resetWheel(); }));
  $('spin').addEventListener('click', spin); $('spin-again').addEventListener('click', spin);
  $('account-button').addEventListener('click', openAccount); $('connect-inline').addEventListener('click', openAccount);
  $('close-account').addEventListener('click', () => { $('token').value = ''; $('account-dialog').close(); });
  $('account-dialog').addEventListener('close', () => { $('token').value = ''; });
  $('use-demo').addEventListener('click', () => { disconnect(); $('account-dialog').close(); });
  $('disconnect').addEventListener('click', disconnect); $('connect-form').addEventListener('submit', connect);
  $('remember-account').addEventListener('change', () => {
    if (!extension || !accountStore.available) return;
    if (!$('remember-account').checked) return forgetSavedAccount();
    if (state.client) return rememberConnection();
    $('remember-status').textContent = '连接成功后，将在这个浏览器保存凭证。';
  });
  $('retry-saved').addEventListener('click', () => connect(null, rememberedAccount));
  $('forget-account').addEventListener('click', () => disconnect());
  $('load-addresses').addEventListener('click', loadAddresses);
  $('reveal-token').addEventListener('click', () => { const show = $('token').type === 'password'; $('token').type = show ? 'text' : 'password'; $('reveal-token').textContent = show ? '隐藏' : '显示'; $('reveal-token').setAttribute('aria-label', show ? '隐藏 Token' : '显示 Token'); });
  $('store-search').addEventListener('submit', searchStores); $('refresh-wallet').addEventListener('click', refreshWallet);
  $('claim').addEventListener('click', () => { if (!$('claim').disabled) $('claim-dialog').showModal(); });
  $('confirm-claim').addEventListener('click', claimAll);
  $('close-claim').addEventListener('click', () => $('claim-dialog').close()); $('cancel-claim').addEventListener('click', () => $('claim-dialog').close());
  $('copy-result').addEventListener('click', async () => {
    if (!state.selected || !session.fresh()) return;
    const p = state.selected;
    try { await win.navigator.clipboard.writeText(`${p.title}\n${p.parts.map((item) => `${item.name} ×${item.quantity}`).join('、')}\n${p.people} 人 · ${money(p.priceFen)}（${session.report.sourceKind === 'demo-snapshot' ? '历史样本价' : '当前核验价'}）`); toast('这一餐已复制'); }
    catch { toast('未能写入剪贴板，可直接选中餐单文字复制。'); }
  });
  win.addEventListener('pagehide', () => { state.unloaded = true; assistant.dispose(); disconnect({ forget: false }); });
  const unsubscribe = accountStore.subscribe((account) => {
    ++storageRevision;
    const wasRemembered = state.remembered;
    const changedAccount = activeToken && account?.token !== activeToken;
    rememberedAccount = account; state.remembered = Boolean(account);
    if (wasRemembered && (!account || changedAccount)) {
      disconnect({ forget: false });
      $('connect-message').textContent = account ? '另一个应用页更新了凭证，请重新连接。' : '已在另一个应用页清除凭证，本页连接和个人数据已清除。';
    }
    $('remember-account').checked = Boolean(account); updateControls();
  });
  const expiryTimer = setInterval(expire, 1000);
  $('token').disabled = !extension;
  if (!accountStore.available) $('remember-note').textContent = extension ? '请重新加载新版扩展以启用本机保存；当前凭证仅在本页保留。' : '静态体验页不接受或保存凭证。';
  $('transport-note').textContent = extension ? '浏览器扩展直接连接麦当劳；仅请求 mcp.mcd.cn，不经过开发者服务器。' : '这是静态体验页。官方目前未开放网页跨域，请安装浏览器扩展后再填 Token。';
  $('transport-note').classList.toggle('connected', extension);
  drawWheel(); updateControls(); updateBudget();
  const startupEpoch = state.epoch;
  try {
    if (!dataset) {
      const [templates, plans, offers, campaigns] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns'].map(loadJSON));
      dataset = { templates, plans, offers, campaigns };
    }
    state.loaded = true;
    const mains = new Map(dataset.plans.plans.flatMap((p) => p.parts.filter((part) => dataset.templates.mainProductCodes.includes(part.code)).map((p) => [p.code, p.name])));
    $('history-options').replaceChildren(...[...mains].map(([code, name]) => {
      const button = el('button', name); button.type = 'button'; button.dataset.code = code; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => { if (state.busy || state.spinning || state.radarBusy) return; state.history.has(code) ? state.history.delete(code) : state.history.add(code); button.setAttribute('aria-pressed', String(state.history.has(code))); $('history-count').textContent = state.history.size ? `避开 ${state.history.size} 种` : '可选'; resetWheel(); }); return button;
    }));
    $('mode-note').textContent = '体验模式 · 2026-10-10 深圳套餐报价样本。连接后按你的门店和优惠重新核价。';
    renderWallet(dataset.offers.offers); updateControls();
  } catch { progress({ text: '体验数据加载失败，请刷新页面。' }); }
  if (accountStore.available) {
    try {
      const readRevision = storageRevision;
      const account = await accountStore.read();
      if (isCurrent(startupEpoch) && !state.unloaded && readRevision === storageRevision) {
        rememberedAccount = account; state.remembered = Boolean(account); $('remember-account').checked = Boolean(account);
        if (account) $('remember-status').textContent = '正在用本机保存的凭证恢复连接…';
      }
    } catch { if (isCurrent(startupEpoch)) $('remember-status').textContent = '读取本机凭证未完成，请重新加载扩展或手动连接。'; }
  }
  state.restoring = false; updateControls();
  await assistant.ready;
  if (isCurrent(startupEpoch) && rememberedAccount && !state.unloaded) await connect(null, rememberedAccount);
  return { dispose() { state.unloaded = true; clearInterval(expiryTimer); clearTimeout(toastTimer); unsubscribe(); assistant.dispose(); disconnect({ forget: false }); }, session };
}
if (typeof document !== 'undefined') startApp();
