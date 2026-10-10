import { chinaDay, historyCalendar, demoHistory } from './order-history.mjs';

export function createRadar({ doc, load, onConnect, onApply, onLoading = () => {} }) {
  const $ = (id) => doc.getElementById(id);
  const el = (tag, text, className) => {
    const node = doc.createElement(tag); if (text != null) node.textContent = text;
    if (className) node.className = className; return node;
  };
  const empty = () => ({ anchorDay: chinaDay(Date.now()), orders: [], coverageComplete: false });
  const state = { connected: false, loading: false, locked: false, epoch: 0, report: null,
    year: Number(empty().anchorDay.slice(0, 4)), mode: 'year', selectedDay: '', message: '' };
  let cells = [], calendar;

  function controls() {
    const locked = state.loading || state.locked;
    $('radar-load').disabled = locked;
    $('radar-load').textContent = state.loading ? '正在读取历史…' : state.connected ? state.report?.sourceKind === 'official-history' ? '刷新我的记录' : '读取我的历史' : '连接账号，读取历史';
    $('radar-demo').disabled = locked; $('radar-year').disabled = locked;
    $('radar-annual').disabled = locked; $('radar-recent').disabled = locked;
    $('radar-apply').disabled = locked || state.report?.sourceKind !== 'official-history' || !state.report.recentMainCodes.length;
  }
  function renderDay(day) {
    state.selectedDay = day;
    cells.forEach(({ button, cell }) => { button.setAttribute('aria-pressed', String(cell.day === day)); button.tabIndex = cell.day === day ? 0 : -1; });
    const cell = cells.find((c) => c.cell.day === day)?.cell;
    $('radar-day-title').textContent = day ? `${day.replace(/-/g, ' / ')} 的餐单` : '选择一个日期';
    $('radar-day-count').textContent = cell?.count ? `${cell.count} 笔完成订单`
      : !state.report ? '尚未读取' : state.report.sourceKind === 'demo-history' ? '示例中无订单' : '没有返回记录';
    const orders = cell?.orders || [];
    $('radar-orders').replaceChildren(...orders.map((order) => {
      const node = el('article', null, 'radar-order');
      const heading = el('div', null, 'radar-order-heading');
      heading.append(el('strong', `${order.time} · ${order.status}`), el('span', order.storeName || '门店未提供'));
      node.append(heading);
      const products = el('ul', null, 'radar-order-products');
      order.items.forEach((item) => {
        const line = el('li'); line.append(el('strong', `${item.name}${item.quantity ? ` ×${item.quantity}` : ''}`));
        if (item.parts.length) line.append(el('p', `包含：${item.parts.map((p) => p.name).join('、')}`));
        products.append(line);
      });
      if (!order.items.length) products.append(el('li', '该笔订单未提供餐品明细。'));
      node.append(products); return node;
    }));
    $('radar-empty-day').hidden = Boolean(orders.length);
    $('radar-empty-day').textContent = !state.report ? '读取历史后，点击有颜色的格子回看那天的套餐。'
      : state.report.sourceKind === 'demo-history' ? '虚构示例中，这天没有订单。'
      : '这天没有出现在本次返回的订单里，无法判断当天是否用餐。';
  }
  function drawCalendar() {
    calendar = historyCalendar(state.report || empty(), { year: state.year, mode: state.mode });
    const monthNodes = calendar.months.map((month) => {
      const node = el('span', month.name); node.style.gridColumn = String(month.column + 1); return node;
    });
    $('radar-months').style.gridTemplateColumns = `repeat(${calendar.weeks.length}, var(--radar-cell))`;
    $('radar-months').replaceChildren(...monthNodes); cells = [];
    $('radar-grid').replaceChildren(...calendar.weeks.map((week) => {
      const column = el('div', null, 'radar-week');
      week.forEach((cell) => {
        if (!cell) { column.append(el('span', null, 'radar-cell radar-padding')); return; }
        const button = el('button', null, 'radar-cell'); button.type = 'button';
        const label = `${cell.day}，${cell.future ? '尚未到来' : cell.count ? `${cell.count} 笔已完成订单` : cell.unknown ? '未返回记录' : '示例中无订单'}`;
        button.setAttribute('aria-label', label); button.title = label; button.dataset.level = String(cell.level);
        button.dataset.state = cell.future ? 'future' : cell.unknown ? 'unknown' : 'known'; button.disabled = cell.future;
        button.addEventListener('click', () => renderDay(cell.day));
        button.addEventListener('keydown', (event) => {
          const index = cells.findIndex((c) => c.button === button);
          const moves = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
          if (!(event.key in moves)) return;
          event.preventDefault(); let next = index + moves[event.key];
          while (cells[next]?.button.disabled) next += Math.sign(moves[event.key]);
          if (cells[next]) { renderDay(cells[next].cell.day); cells[next].button.focus(); }
        });
        column.append(button); cells.push({ button, cell });
      }); return column;
    }));
    $('radar-grid').setAttribute('aria-label', `${state.year} 年${state.mode === 'year' ? '全年' : '近 12 周'}完成订单热力图`);
    const possible = cells.filter(({ cell }) => !cell.future);
    const selected = possible.find(({ cell }) => cell.day === state.selectedDay)
      || [...possible].reverse().find(({ cell }) => cell.count) || possible.at(-1);
    renderDay(selected?.cell.day || '');
    const ready = Boolean(state.report);
    $('radar-order-count').textContent = ready ? calendar.orderCount : '—';
    $('radar-date-count').textContent = ready ? calendar.recordedDays : '—';
    $('radar-food-count').textContent = ready ? calendar.foodCount : '—';
    $('radar-favorite').textContent = ready ? calendar.ranking[0]?.name || '暂无记录' : '等你点亮';
    $('radar-range-label').textContent = `${calendar.start} 至 ${calendar.end}`;
    $('radar-top-foods').replaceChildren(...calendar.ranking.map((food) => {
      const row = el('li'), bar = el('span', null, 'radar-food-bar');
      bar.style.width = `${Math.round(food.count / calendar.orderCount * 100)}%`;
      const heading = el('div'); heading.append(el('span', food.name), el('strong', `${food.count} 笔`));
      const track = el('div', null, 'radar-food-track'); track.append(bar); row.append(heading, track); return row;
    }));
    $('radar-no-foods').hidden = Boolean(calendar.ranking.length);
    $('radar-map').classList.toggle('recent', state.mode === 'recent');
    $('radar-annual').setAttribute('aria-pressed', String(state.mode === 'year'));
    $('radar-recent').setAttribute('aria-pressed', String(state.mode === 'recent'));
  }
  function render() {
    const report = state.report, anchorYear = Number((report || empty()).anchorDay.slice(0, 4));
    const years = [...new Set([anchorYear, anchorYear - 1, ...(report?.orders.map((o) => Number(o.day.slice(0, 4))) || [])])].sort((a, b) => b - a);
    $('radar-year').replaceChildren(...years.map((year) => { const option = el('option', `${year} 年`); option.value = String(year); return option; }));
    $('radar-year').value = String(state.year);
    const demo = report?.sourceKind === 'demo-history';
    $('radar-source').textContent = demo ? '虚构示例' : report ? '我的历史记录' : '等待读取';
    $('radar-source').classList.toggle('live', Boolean(report && !demo));
    $('radar-message').textContent = state.message || (demo
      ? '这是虚构的热力图示例，不来自任何真实账号。连接后读取你自己的记录。'
      : report ? `本次返回 ${report.returnedCount} 条订单，识别到 ${report.orders.length} 条已完成记录。未返回的日期不代表没吃过，全年记录可能不完整。`
      : state.connected ? '已连接。点击“读取我的历史”点亮日历，无需先选择门店。' : '用历史订单点亮你的用餐日历。连接自己的账号后读取，也可以先看虚构示例。');
    $('radar-note').textContent = demo ? '示例颜色按每天的虚构完成订单数划分。' : '只统计已完成 / 已评价订单；取消、待支付、无法确认状态或时间的记录不计入。';
    $('radar-recent-note').textContent = report?.sourceKind === 'official-history'
      ? report.recentMainCodes.length ? `已从前两天返回记录识别 ${report.recentMainCodes.length} 种主食。只补充可识别部分，你仍可手动调整。` : '前两天没有返回可识别的主食，可在套餐页手动勾选。'
      : '读取真实记录后，可把前两天的主食加入本次避开项。多人用餐时由你确认是否全桌共同避开。';
    drawCalendar(); controls();
  }
  async function refresh() {
    if (state.loading || state.locked) return;
    if (!state.connected) { onConnect(); return; }
    const epoch = ++state.epoch; state.loading = true; state.message = '正在读取本次可返回的历史订单…';
    onLoading(true); render();
    try {
      const report = await load(); if (epoch !== state.epoch) return;
      const firstLoad = state.report?.sourceKind !== 'official-history'; state.report = report; state.message = '';
      if (firstLoad) state.year = Number(report.orders[0]?.day.slice(0, 4) || report.anchorDay.slice(0, 4));
      state.selectedDay = ''; render();
    } catch {
      if (epoch !== state.epoch) return;
      state.report = null; state.selectedDay = ''; state.message = '历史读取未完成，尚不能生成你的热力图。请重试读取。'; render();
    } finally { if (epoch === state.epoch) { state.loading = false; onLoading(false); controls(); } }
  }
  $('radar-load').addEventListener('click', refresh);
  $('radar-demo').addEventListener('click', () => {
    if (state.loading || state.locked) return;
    ++state.epoch; state.report = demoHistory(); state.year = 2026; state.selectedDay = ''; state.message = ''; render();
  });
  $('radar-year').addEventListener('change', () => { state.year = Number($('radar-year').value); state.selectedDay = ''; drawCalendar(); });
  $('radar-annual').addEventListener('click', () => { state.mode = 'year'; state.selectedDay = ''; drawCalendar(); });
  $('radar-recent').addEventListener('click', () => { state.mode = 'recent'; state.selectedDay = ''; drawCalendar(); });
  $('radar-apply').addEventListener('click', () => { if (!$('radar-apply').disabled) onApply([...state.report.recentMainCodes]); });
  render();
  return {
    refresh,
    setConnected(connected) { state.connected = connected; render(); },
    setLocked(locked) { state.locked = locked; controls(); },
    clear() {
      ++state.epoch; state.report = null; state.connected = false; state.loading = false; state.selectedDay = '';
      state.year = Number(empty().anchorDay.slice(0, 4)); state.message = ''; onLoading(false); render();
    },
  };
}
