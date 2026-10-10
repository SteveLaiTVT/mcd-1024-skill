import { createAgentStorage, defaultPreferences, normalizePreferences, learnFeedback, memorySummary, normalizeDeepSeek } from './agent-memory.mjs';
import { PERSONAS, DEFAULT_RECOMMEND_PROMPT, DEFAULT_OPTIMIZE_PROMPT, SIGNAL_LABELS } from './agent-prompts.mjs';
import { DeepSeekClient, DeepSeekError } from './deepseek-client.mjs';
import { WeatherClient, calendarContext } from './agent-context.mjs';
import { runMealAgents } from './meal-agent.mjs';

const money = (fen) => `¥${(fen / 100).toFixed(2).replace(/\.00$/, '')}`;
const MODE_NAMES = { team: '双 Agent 协作', recommend: '推荐 Agent', optimize: '优化 Agent' };
export function createMealAssistant({ doc, extension, getReport, isFresh, getMainCodes, onSelect, storage = createAgentStorage({ extension }), clientFactory = (key) => new DeepSeekClient(key), weatherClient = new WeatherClient(), now = () => new Date() }) {
  const $ = (id) => doc.getElementById(id);
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  let preferences = defaultPreferences(), client = null, activeKey = '', savedKey = null, credentialRevision = 0, preferenceRevision = 0;
  let busy = false, locked = false, restoring = true, disposed = false, generation = 0, controller = null, selected = null, feedbackBusy = false;
  let location = null, weather = { status: 'unavailable' }, manualCity = false;
  $('deepseek-remember').checked = false;
  function updateControls() {
    const blocked = locked || busy || restoring || disposed;
    $('agent-run').disabled = blocked || !extension || !isFresh() || !getReport()?.candidates.length;
    $('agent-local').disabled = blocked || !isFresh() || !getReport()?.candidates.length;
    $('agent-weather').disabled = blocked || !extension || !preferences.weatherEnabled;
    $('agent-city').disabled = blocked || !extension || !preferences.weatherEnabled;
    $('agent-mood').disabled = blocked;
    $('agent-cancel').hidden = !busy;
    $('deepseek-use').disabled = restoring || disposed || !extension;
    $('deepseek-token').disabled = !extension || disposed;
    $('deepseek-remember').disabled = restoring || disposed || !storage.credentials.available;
    $('deepseek-forget').hidden = !activeKey && !savedKey;
    $('agent-remember-memory').disabled = !storage.preferences.available || restoring || disposed;
    $('agent-save').disabled = restoring || disposed || feedbackBusy;
    $('agent-clear-memory').disabled = feedbackBusy || restoring || disposed;
    $('agent-like').disabled = blocked || feedbackBusy || !selected || !isFresh();
    $('agent-less').disabled = $('agent-like').disabled;
    for (const button of $('agent-city-choices').children) button.disabled = blocked || !preferences.weatherEnabled;
    for (const card of $('agent-results').children) card.children[card.children.length - 1].disabled = blocked || !isFresh();
    $('agent-run').textContent = client ? `让${MODE_NAMES[preferences.mode]}挑一份 →` : '配置 DeepSeek，开始推荐 →';
  }
  function renderContext() {
    const calendar = calendarContext(now());
    const pieces = [`${calendar.month} 月 · ${calendar.weekday}`, calendar.holiday || (calendar.makeupWorkday ? '调休上班日' : calendar.dayKind === 'weekend' ? calendar.holidayVerified ? '周末饭点' : '日历周末 · 调休待确认' : '日常饭点')];
    if (calendar.upcoming) pieces.push(`${calendar.upcoming.name}还有 ${calendar.upcoming.daysAway} 天`);
    if (!calendar.holidayVerified) pieces.push('本年节假日安排尚未收录');
    if (preferences.weatherEnabled && weather.status === 'available') pieces.push(`${weather.city} · ${weather.description} ${weather.temperatureC}°C`);
    $('agent-day').replaceChildren(...pieces.map((p) => el('span', p)));
  }
  function renderPreferences() {
    $('agent-persona').value = preferences.persona; $('agent-goal').value = preferences.goal; $('agent-mode').value = preferences.mode;
    $('agent-personal-prompt').value = preferences.personalPrompt;
    $('agent-recommend-prompt').value = preferences.recommendPrompt; $('agent-optimize-prompt').value = preferences.optimizePrompt;
    $('agent-use-weather').checked = preferences.weatherEnabled; $('agent-remember-memory').checked = preferences.rememberMemory;
    $('agent-badge').textContent = PERSONAS[preferences.persona].name;
    $('agent-intro').textContent = `${PERSONAS[preferences.persona].greeting} ${MODE_NAMES[preferences.mode]} · ${preferences.goal === 'cheapest' ? '候选池里尽量省钱' : preferences.goal === 'variety' ? '换个新口味' : '口味、心情和价格一起考虑'}。`;
    renderMemory(); renderContext(); updateControls();
  }
  function renderMemory() {
    const summary = memorySummary(preferences.feedback, calendarContext(now()).date);
    $('agent-memory-status').textContent = `${preferences.rememberMemory ? '本机长期记忆' : '仅本页反馈'} · ${preferences.feedback.length} 条明确反馈${summary.length ? '。你可以随时忘掉某种口味。' : '。点“喜欢这份”或“以后少推荐”，搭子才会学习。'}`;
    $('agent-memory-list').replaceChildren(...summary.map((food) => {
      const row = el('div', null, 'agent-memory-item'), body = el('div');
      body.append(el('strong', food.name), el('small', `喜欢 ${food.likes} 次 · 少推荐 ${food.less} 次 · 最近反馈 ${food.lastDate}`));
      const forget = el('button', '忘掉', 'text-button'); forget.type = 'button';
      forget.addEventListener('click', () => changeMemory((current) => ({ ...current, feedback: current.feedback.map((entry) => ({ ...entry, foods: entry.foods.filter((f) => f.code !== food.code) })).filter((entry) => entry.foods.length) })));
      row.append(body, forget); return row;
    }));
    if (selected) {
      const vote = preferences.feedback.find((entry) => entry.planId === selected.id && entry.date === calendarContext(now()).date)?.vote;
      $('agent-like').setAttribute('aria-pressed', String(vote === 'like')); $('agent-less').setAttribute('aria-pressed', String(vote === 'less'));
    }
  }
  function stop({ message = null, clear = true } = {}) {
    ++generation; controller?.abort(); controller = null; busy = false;
    if (clear) { $('agent-results').replaceChildren(); selected = null; $('agent-feedback').hidden = true; }
    if (message) $('agent-status').textContent = message;
    updateControls();
  }
  function openSettings() {
    renderPreferences(); $('deepseek-token').value = ''; $('deepseek-token').type = 'password'; $('deepseek-reveal').textContent = '显示'; $('agent-dialog').showModal();
  }
  function useKey(key) {
    client?.close(); client = key ? clientFactory(key) : null; activeKey = key || '';
    stop({ message: key ? 'DeepSeek 已配置，算好价格后点击推荐。' : 'DeepSeek 已停用，可以继续使用本地偏好推荐。' }); updateControls();
  }
  async function clearSavedKey({ stopUsing = false } = {}) {
    const previous = savedKey;
    savedKey = null;
    if (stopUsing) useKey('');
    try {
      await storage.credentials.clear(); savedKey = null; $('deepseek-remember').checked = false;
      $('deepseek-status').textContent = stopUsing ? '已停用并清除本机 DeepSeek 凭证。' : '已删除长期凭证，当前页仍可使用。';
    } catch { savedKey = previous; $('deepseek-remember').checked = Boolean(savedKey); $('deepseek-status').textContent = '本机凭证删除未完成，请重试。'; }
    updateControls();
  }
  async function saveKey(key) {
    if (!storage.credentials.available) throw new Error('Local storage unavailable');
    const expectedToken = savedKey?.token || null;
    const saved = await storage.credentials.save({ version: 1, token: key }, { matches: (current) => (current?.token || null) === expectedToken });
    if (activeKey !== key || disposed) return;
    savedKey = saved; $('deepseek-remember').checked = true;
    $('deepseek-status').textContent = '已在本机记住 DeepSeek key；点击推荐才发起请求。';
  }
  async function configureKey(event) {
    event.preventDefault(); if (!extension || restoring || disposed) return;
    const credential = normalizeDeepSeek({ version: 1, token: $('deepseek-token').value });
    $('deepseek-token').value = ''; $('deepseek-token').type = 'password'; $('deepseek-reveal').textContent = '显示';
    if (!credential) { $('deepseek-status').textContent = '请重新填写有效的 DeepSeek API key。'; return; }
    try {
      useKey(credential.token);
      $('deepseek-status').textContent = '已配置 V4.1 Flash，仅本页使用；首次推荐时验证 key。';
      if ($('deepseek-remember').checked) await saveKey(credential.token);
      else if (savedKey) await clearSavedKey();
    } catch { $('deepseek-status').textContent = '当前 key 已配置，但长期保存未完成，请重试。'; }
    updateControls();
  }
  async function changeMemory(change) {
    if (feedbackBusy || restoring || disposed) return;
    feedbackBusy = true; updateControls();
    try {
      if (preferences.rememberMemory) {
        const saved = await storage.preferences.update((current) => {
          if (!current?.rememberMemory) throw new Error('Memory revoked');
          return change(current);
        });
        if (saved && !disposed) preferences = saved;
      } else preferences = change(preferences);
      if (!disposed) { renderMemory(); $('agent-feedback-note').textContent = `${preferences.rememberMemory ? '已在本机记住' : '已在本页记住'}这次反馈。没有记录为已吃过，下次挑选会参考。`; }
    } catch { if (!disposed) $('agent-feedback-note').textContent = '反馈记忆未能保存；请检查长期记忆设置后重试。'; }
    finally { feedbackBusy = false; updateControls(); }
  }
  async function savePreferences(event) {
    event.preventDefault(); if (restoring || feedbackBusy || disposed) return;
    stop({ message: '搭子偏好已更新，请重新推荐。' });
    const draft = normalizePreferences({ ...preferences, persona: $('agent-persona').value, goal: $('agent-goal').value, mode: $('agent-mode').value, personalPrompt: $('agent-personal-prompt').value, recommendPrompt: $('agent-recommend-prompt').value, optimizePrompt: $('agent-optimize-prompt').value, weatherEnabled: $('agent-use-weather').checked, rememberMemory: $('agent-remember-memory').checked });
    try {
      if (storage.preferences.available) {
        const wasRemembered = preferences.rememberMemory;
        preferences = await storage.preferences.update((current) => ({ ...draft, feedback: draft.rememberMemory ? wasRemembered ? current?.feedback || [] : draft.feedback : [] }));
      } else preferences = draft;
      $('agent-save-status').textContent = storage.preferences.available ? '搭子风格、口味和提示词已保存在这个浏览器。' : '偏好仅在本页使用，安装扩展可长期保存。';
      renderPreferences();
    } catch { $('agent-save-status').textContent = '偏好保存未完成，请重试；现有设置继续使用。'; renderPreferences(); }
  }
  async function loadWeather(event) {
    event?.preventDefault(); if (busy || locked || !extension || !preferences.weatherEnabled || disposed) return;
    stop(); const current = generation; controller = new AbortController(); busy = true; updateControls();
    $('agent-weather-note').textContent = '正在查询城市，请选择准确地点…';
    try {
      const choices = await weatherClient.search($('agent-city').value, { signal: controller.signal });
      if (current !== generation || disposed) return;
      $('agent-city-choices').replaceChildren(...choices.map((choice) => {
        const button = el('button', `${choice.name} · ${choice.region}`); button.type = 'button'; button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => selectLocation(choice, button)); return button;
      }));
      $('agent-weather-note').textContent = choices.length ? '请选择城市所在地区，同名地点不会自动猜测。' : '没有找到城市，请换个名称；仍可按口味和月份推荐。';
    } catch { if (current === generation) $('agent-weather-note').textContent = '城市查询未完成；天气暂不可用，可以继续按口味推荐。'; }
    finally { if (current === generation) { busy = false; controller = null; updateControls(); } }
  }
  async function selectLocation(choice, button) {
    if (busy || locked || disposed || !extension || !preferences.weatherEnabled) return;
    stop(); location = choice; weather = { status: 'unavailable' }; const current = generation;
    controller = new AbortController(); busy = true; updateControls();
    $('agent-weather-note').textContent = `正在读取 ${choice.name} · ${choice.region} 的天气…`;
    try {
      const result = await weatherClient.current(choice, { signal: controller.signal });
      if (current !== generation || disposed) return;
      weather = result;
      $('agent-weather-note').textContent = `${result.city} · ${result.region} · ${result.description} · ${result.temperatureC}°C，体感 ${result.feelsLikeC}°C · Open-Meteo，${new Date(result.observedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })} 数据。`;
      for (const node of $('agent-city-choices').children) node.setAttribute('aria-pressed', String(node === button));
    } catch { if (current === generation) $('agent-weather-note').textContent = '天气读取未完成，推荐会标记天气未知。'; }
    finally { if (current === generation) { busy = false; controller = null; renderContext(); updateControls(); } }
  }
  function renderResults(result, report) {
    const demo = report.sourceKind === 'demo-snapshot';
    $('agent-results').replaceChildren(...result.choices.map((choice, index) => {
      const plan = report.candidates.find((p) => p.id === choice.id);
      const card = el('article', null, 'agent-pick'), body = el('div');
      body.append(el('span', index === 0 ? '给今天的首选' : '也可以试试', 'agent-pick-top'), el('h3', plan.title), el('p', choice.signals.map((s) => SIGNAL_LABELS[s]).join(' · ')), el('p', `${plan.people} 人 · ${demo ? '历史样本价' : '当前核验价'}${!report.priceComparisonComplete ? ' · 候选比较未查全' : ''}`));
      const choose = el('button', '就选这份', 'button button-outline'); choose.type = 'button';
      choose.addEventListener('click', () => {
        if (busy || locked || getReport() !== report || !isFresh() || disposed) return;
        onSelect(plan); selectForFeedback(plan); choose.textContent = '这一餐已选好';
      });
      card.append(body, el('strong', money(plan.priceFen), 'agent-pick-price'), choose); return card;
    }));
  }
  async function run(local = false) {
    if (busy || locked || restoring || disposed || !isFresh() || !getReport()?.candidates.length) return;
    if (!local && (!extension || !client)) { openSettings(); return; }
    stop(); const current = generation, report = getReport(), requestClient = client;
    controller = new AbortController(); const signal = controller.signal; busy = true; updateControls();
    $('agent-status').textContent = local ? '正在按明确偏好比较…' : '正在准备搭子的推荐…';
    try {
      const calendar = calendarContext(now());
      if (!preferences.weatherEnabled) weather = { status: 'disabled' };
      else if (weather.status === 'disabled') weather = { status: 'unavailable' };
      else if (!local && location && extension) {
        try { weather = await weatherClient.current(location, { signal }); }
        catch { weather = { status: 'unavailable' }; $('agent-weather-note').textContent = '本次天气未确认，推荐只参考口味和节令。'; }
      } else if (weather.status === 'available' && Number(now()) - Date.parse(weather.observedAt) > 90 * 60000) weather = { status: 'unavailable' };
      if (current !== generation || signal.aborted) return;
      renderContext();
      const result = await runMealAgents({ report, settings: structuredClone(preferences), context: { calendar, weather: { ...weather } }, mood: $('agent-mood').value || 'normal', client: local ? null : requestClient, signal,
        fresh: () => current === generation && getReport() === report && isFresh() && !disposed,
        onStage: (role) => { if (current === generation) $('agent-status').textContent = role === 'recommend' ? '推荐 Agent 正在按口味、心情和节令挑选…' : '优化 Agent 正在复核偏好与候选价格…'; },
      });
      if (current !== generation || !isFresh() || getReport() !== report) return;
      renderResults(result, report);
      const changed = result.stages.length === 2 && result.stages[0].primaryId !== result.stages[1].primaryId;
      $('agent-status').textContent = `${local ? '本地偏好推荐' : `DeepSeek V4.1 Flash · ${result.rounds} 轮完成${changed ? '，优化 Agent 调整了首选' : ''}`}。${report.sourceKind === 'demo-snapshot' ? '当前是历史样本餐单。' : '仅在这次已核价候选中比较。'}${weather.status === 'unavailable' && preferences.weatherEnabled ? ' 天气未知，本次未采用天气因素。' : ''}`;
      if (!local) $('deepseek-status').textContent = 'V4.1 Flash 请求成功，key 可用。';
    } catch (error) {
      if (current !== generation || disposed) return;
      $('agent-status').textContent = error instanceof DeepSeekError ? error.message : '推荐未通过候选校验，可重新核价或使用本地偏好推荐。';
      if (error instanceof DeepSeekError && error.code === 'auth' && client === requestClient) {
        await clearSavedKey({ stopUsing: true }); $('deepseek-status').textContent = error.message; $('agent-status').textContent = error.message;
      }
    } finally { if (current === generation) { busy = false; controller = null; updateControls(); } }
  }
  function selectForFeedback(plan) {
    selected = plan; $('agent-feedback').hidden = false; $('agent-feedback-title').textContent = `这份 ${plan.title}，合你口味吗？`;
    $('agent-feedback-note').textContent = '只记录你主动给的反馈，揭晓餐单不会自动记成吃过。'; renderMemory(); updateControls();
  }
  const vote = (kind) => {
    if (!selected || busy || locked || !isFresh() || feedbackBusy || disposed) return;
    const plan = selected, date = calendarContext(now()).date;
    return changeMemory((current) => learnFeedback(current, plan, kind, getMainCodes(), date));
  };
  $('agent-settings-button').addEventListener('click', openSettings);
  $('agent-close').addEventListener('click', () => $('agent-dialog').close());
  $('agent-dialog').addEventListener('close', () => { $('deepseek-token').value = ''; $('deepseek-token').type = 'password'; $('deepseek-reveal').textContent = '显示'; });
  $('deepseek-form').addEventListener('submit', configureKey);
  $('deepseek-reveal').addEventListener('click', () => { const show = $('deepseek-token').type === 'password'; $('deepseek-token').type = show ? 'text' : 'password'; $('deepseek-reveal').textContent = show ? '隐藏' : '显示'; });
  $('deepseek-forget').addEventListener('click', () => clearSavedKey({ stopUsing: true }));
  $('deepseek-remember').addEventListener('change', async () => {
    if (!storage.credentials.available || restoring || disposed) return;
    if (!$('deepseek-remember').checked) return clearSavedKey();
    if (activeKey) { try { await saveKey(activeKey); } catch { $('deepseek-status').textContent = '长期凭证保存未完成，当前页可以继续用。'; } }
    else $('deepseek-status').textContent = '点击“使用这个 key”后，在这个浏览器保存凭证。';
  });
  $('agent-preferences').addEventListener('submit', savePreferences);
  $('agent-reset-prompts').addEventListener('click', () => { $('agent-recommend-prompt').value = DEFAULT_RECOMMEND_PROMPT; $('agent-optimize-prompt').value = DEFAULT_OPTIMIZE_PROMPT; });
  $('agent-clear-memory').addEventListener('click', async () => { await changeMemory((current) => ({ ...current, feedback: [] })); $('agent-memory-status').textContent = preferences.feedback.length ? '反馈清除未完成，请重试。' : '反馈记忆已清空，口味提示词仍可自行编辑。'; });
  $('agent-weather').addEventListener('click', loadWeather);
  $('agent-city').addEventListener('input', () => { manualCity = true; location = null; weather = { status: 'unavailable' }; $('agent-city-choices').replaceChildren(); stop({ message: '城市更新了，重新读取天气后推荐。' }); renderContext(); });
  $('agent-mood').addEventListener('change', () => stop({ message: '按今天的新心情，重新挑选一份。' }));
  $('agent-run').addEventListener('click', () => run(false)); $('agent-local').addEventListener('click', () => run(true));
  $('agent-cancel').addEventListener('click', () => stop({ message: '已取消这次推荐，可以重新挑选。' }));
  $('agent-like').addEventListener('click', () => vote('like')); $('agent-less').addEventListener('click', () => vote('less'));
  const unsubCredentials = storage.credentials.subscribe((record) => {
    ++credentialRevision;
    const revoked = savedKey && (!record || record.token !== activeKey);
    savedKey = record; $('deepseek-remember').checked = Boolean(record);
    if (revoked) { useKey(''); $('deepseek-status').textContent = '另一个应用页更改了凭证，本页 DeepSeek 已停用；重开页面可恢复新配置。'; }
    updateControls();
  });
  const unsubPreferences = storage.preferences.subscribe((record) => {
    ++preferenceRevision;
    const next = record || defaultPreferences();
    const settingsChanged = ['persona', 'goal', 'mode', 'personalPrompt', 'recommendPrompt', 'optimizePrompt', 'weatherEnabled', 'rememberMemory'].some((key) => next[key] !== preferences[key]);
    preferences = next;
    if (settingsChanged) stop({ message: '搭子设置已更新，请重新推荐。' });
    renderPreferences();
  });
  renderPreferences();
  const ready = (async () => {
    const keyRevision = credentialRevision, prefsRevision = preferenceRevision;
    const reads = await Promise.allSettled([storage.credentials.read(), storage.preferences.read()]);
    if (disposed) return;
    const [credentials, settings] = reads;
    if (credentials.status === 'fulfilled' && keyRevision === credentialRevision && credentials.value) {
      savedKey = credentials.value; $('deepseek-remember').checked = true; useKey(savedKey.token); $('deepseek-status').textContent = '已恢复本机 DeepSeek 配置；点击推荐才请求模型。';
    } else if (credentials.status === 'rejected') $('deepseek-status').textContent = '本机 DeepSeek 凭证读取未完成，可手动配置。';
    if (settings.status === 'fulfilled' && prefsRevision === preferenceRevision && settings.value) preferences = settings.value;
    restoring = false; renderPreferences();
    if (!extension) $('deepseek-status').textContent = '静态体验页只支持本地推荐，安装扩展后再填写 DeepSeek key。';
  })();
  return {
    ready, selectForFeedback,
    setLocked(value) {
      locked = value;
      if (!busy && isFresh() && getReport()?.candidates.length && $('agent-status').textContent.startsWith('先算好价格')) $('agent-status').textContent = '价格已就绪，选好心情，让搭子挑选；也可以继续转盘。';
      updateControls();
    },
    invalidate() { stop({ message: '先算好价格，再让搭子在这一池里挑选。' }); },
    expire() { stop({ message: '报价已过期，重新核价后再推荐。' }); },
    setCity(city) {
      if (manualCity || !city || $('agent-city').value === city) return;
      $('agent-city').value = city; location = null; weather = { status: 'unavailable' }; $('agent-city-choices').replaceChildren(); renderContext();
    },
    dispose() { disposed = true; stop(); client?.close(); activeKey = ''; selected = null; location = null; weather = { status: 'unavailable' }; unsubCredentials(); unsubPreferences(); $('deepseek-token').value = ''; },
  };
}
