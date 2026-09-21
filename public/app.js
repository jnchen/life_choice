/* 人生选择器 · 前端逻辑
   流程：输入场景 → POST /api/options 生成选项 → POST /api/decide 由 Jev 执签
   所有动态文本一律用 textContent 写入，不拼接 innerHTML（防注入）。 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const els = {
  banner: $('#modeBanner'),
  scenario: $('#scenario'),
  chips: $('#exampleChips'),
  btnGenerate: $('#btnGenerate'),
  btnRegen: $('#btnRegen'),
  btnDecide: $('#btnDecide'),
  btnRedecide: $('#btnRedecide'),
  btnReset: $('#btnReset'),
  stepOptions: $('#stepOptions'),
  stepResult: $('#stepResult'),
  optionsGrid: $('#optionsGrid'),
  verdictTitle: $('#verdictTitle'),
  verdictDesc: $('#verdictDesc'),
  badges: $('#badges'),
  probBars: $('#probBars'),
  probTable: $('#probTable'),
  meta: $('#meta'),
  errorLine: $('#errorLine'),
  tooltip: $('#tooltip'),
  // 账号
  userBadge: $('#userBadge'),
  btnAuth: $('#btnAuth'),
  btnLogout: $('#btnLogout'),
  btnHistory: $('#btnHistory'),
  authModal: $('#authModal'),
  authForm: $('#authForm'),
  authEmail: $('#authEmail'),
  authUsername: $('#authUsername'),
  authPassword: $('#authPassword'),
  usernameField: $('#usernameField'),
  authError: $('#authError'),
  btnAuthSubmit: $('#btnAuthSubmit'),
  btnAuthClose: $('#btnAuthClose'),
  tabLogin: $('#tabLogin'),
  tabRegister: $('#tabRegister'),
  gateHint: $('#gateHint'),
  backdrop: $('#backdrop'),
  // 历史
  historyDrawer: $('#historyDrawer'),
  historyList: $('#historyList'),
  btnHistoryClose: $('#btnHistoryClose'),
  btnHistoryClear: $('#btnHistoryClear'),
  btnHistoryMore: $('#btnHistoryMore'),
};

const state = {
  scenario: '',
  options: [], // [{id,title,description,risk}]
  user: null,
  authMode: 'login',
  demoScenarios: [],
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 基础工具 ---------------- */

async function api(path, body) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({ error: '响应解析失败' }));
  if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`);
  return data;
}

function showError(msg) {
  els.errorLine.textContent = `⚠️ ${msg}`;
  els.errorLine.classList.remove('hidden');
  clearTimeout(showError._t);
  showError._t = setTimeout(() => els.errorLine.classList.add('hidden'), 6000);
}

function setLoading(btn, loading, text) {
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || btn.textContent;
  }
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function scrollToEl(el) {
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

/* ---------------- 账号 & 游客门禁 ---------------- */

function isDemoScenario(s) {
  const t = String(s).trim();
  return state.demoScenarios.some((d) => d === t);
}

function setAuthUI() {
  const loggedIn = Boolean(state.user);
  els.userBadge.classList.toggle('hidden', !loggedIn);
  els.btnHistory.classList.toggle('hidden', !loggedIn);
  els.btnLogout.classList.toggle('hidden', !loggedIn);
  els.btnAuth.classList.toggle('hidden', loggedIn);
  els.gateHint.classList.toggle('hidden', loggedIn);

  if (loggedIn) {
    els.userBadge.textContent = `👋 ${state.user.username}`;
    els.scenario.disabled = false;
    els.scenario.placeholder = '例如：毕业三年了，手里有点积蓄，是继续在大厂卷，还是回老家开一家咖啡店？';
    els.gateHint.textContent = '';
  } else {
    const demo = isDemoScenario(els.scenario.value);
    els.scenario.disabled = !demo;
    els.scenario.placeholder = '🔒 游客体验：请点下方任意示例开始；注册登录后可输入自己的场景';
    els.gateHint.textContent = '登录后解锁自定义场景';
    if (!demo) els.scenario.value = '';
    els.chips.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('selected', demo && els.scenario.value.trim() === c.textContent.trim());
    });
  }
}

function openAuth(mode = 'login') {
  switchAuthTab(mode);
  els.authModal.classList.remove('hidden');
  els.backdrop.classList.remove('hidden');
  els.authEmail.focus();
}

function closeAuth() {
  els.authModal.classList.add('hidden');
  els.backdrop.classList.add('hidden');
  els.authError.classList.add('hidden');
}

function switchAuthTab(mode) {
  state.authMode = mode;
  const isLogin = mode === 'login';
  els.tabLogin.classList.toggle('active', isLogin);
  els.tabRegister.classList.toggle('active', !isLogin);
  els.usernameField.classList.toggle('hidden', isLogin);
  els.btnAuthSubmit.textContent = isLogin ? '登录' : '注册并登录';
  els.authError.classList.add('hidden');
}

async function submitAuth(e) {
  e.preventDefault();
  const body = {
    email: els.authEmail.value.trim(),
    password: els.authPassword.value,
  };
  if (state.authMode === 'register') body.username = els.authUsername.value.trim();
  setLoading(els.btnAuthSubmit, true, state.authMode === 'login' ? '登录中…' : '注册中…');
  try {
    const data = await api(`/api/auth/${state.authMode}`, body);
    state.user = data.user;
    closeAuth();
    setAuthUI();
    els.scenario.focus();
  } catch (err) {
    els.authError.textContent = err.message;
    els.authError.classList.remove('hidden');
  } finally {
    setLoading(els.btnAuthSubmit, false);
  }
}

async function logout() {
  try { await api('/api/auth/logout', {}); } catch { /* 忽略 */ }
  state.user = null;
  closeHistory();
  setAuthUI();
}

/* ---------------- 悬浮提示（概率条/卡片详情） ---------------- */

function bindTooltip(el, getText) {
  el.addEventListener('mousemove', (e) => {
    els.tooltip.textContent = getText();
    els.tooltip.classList.remove('hidden');
    const x = Math.min(e.clientX + 14, window.innerWidth - els.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY + 18, window.innerHeight - els.tooltip.offsetHeight - 8);
    els.tooltip.style.left = `${Math.max(8, x)}px`;
    els.tooltip.style.top = `${Math.max(8, y)}px`;
  });
  el.addEventListener('mouseleave', () => els.tooltip.classList.add('hidden'));
}

/* ---------------- 生成选项（含游客门禁） ---------------- */

async function generateOptions() {
  const scenario = els.scenario.value.trim();
  if (!scenario) {
    showError(state.user ? '先写一下你的场景 👆' : '先点一个示例场景，或者登录后输入自己的场景');
    return;
  }
  if (!state.user && !isDemoScenario(scenario)) {
    openAuth('login');
    return;
  }
  state.scenario = scenario;
  hide(els.errorLine);
  hide(els.stepResult);

  setLoading(els.btnGenerate, true, '✨ AI 正在出题…');
  try {
    const data = await api('/api/options', { scenario });
    state.options = data.options;
    renderOptions();
    show(els.stepOptions);
    scrollToEl(els.stepOptions);
  } catch (err) {
    if (/登录|注册/.test(err.message)) openAuth('login');
    showError(err.message);
  } finally {
    setLoading(els.btnGenerate, false);
  }
}

function renderOptions() {
  els.optionsGrid.textContent = '';
  for (const opt of state.options) {
    const card = document.createElement('div');
    card.className = 'opt-card';
    card.dataset.id = opt.id;

    const id = document.createElement('div');
    id.className = 'opt-id';
    id.textContent = opt.id;

    const title = document.createElement('div');
    title.className = 'opt-title';
    title.textContent = opt.title;

    const desc = document.createElement('div');
    desc.className = 'opt-desc';
    desc.textContent = opt.description;

    card.append(id, title, desc);
    if (opt.risk) {
      const risk = document.createElement('div');
      risk.className = 'opt-risk';
      risk.textContent = `⚠ ${opt.risk}`;
      card.append(risk);
    }
    els.optionsGrid.append(card);
  }
}

/* ---------------- ② Jev 执签（轮盘动画 + 请求并行） ---------------- */

async function decide() {
  if (state.options.length < 2 || state.deciding) return;
  state.deciding = true;
  hide(els.errorLine);
  setLoading(els.btnDecide, true, '🔮 Jev 正在执签…');

  const cards = [...els.optionsGrid.children];
  cards.forEach((c) => c.classList.remove('winner', 'hot'));

  let idx = 0;
  let delay = reducedMotion ? 0 : 75;
  let settled = false;
  let apiResult = null;
  let apiError = null;

  const spinOnce = async () => {
    cards.forEach((c) => c.classList.remove('hot'));
    idx = (idx + 1) % cards.length;
    cards[idx].classList.add('hot');
    await sleep(delay);
    if (!reducedMotion) delay = Math.min(300, delay * 1.09);
  };

  try {
    api('/api/decide', { scenario: state.scenario, options: state.options }).then(
      (r) => { apiResult = r; settled = true; },
      (e) => { apiError = e; settled = true; }
    );

    // 结果回来之前一直转；回来后至少转到 1.6s
    const minUntil = performance.now() + (reducedMotion ? 0 : 1600);
    while (true) {
      await spinOnce();
      if (settled && performance.now() >= minUntil) break;
    }
    if (apiError) throw apiError;

    // 快速对齐到中签卡片
    const winnerIdx = cards.findIndex((c) => c.dataset.id === apiResult.result.choice);
    if (winnerIdx >= 0) {
      while (idx !== winnerIdx) await spinOnce();
    }
    cards.forEach((c) => c.classList.remove('hot'));
    if (winnerIdx >= 0) cards[winnerIdx].classList.add('winner');
    await sleep(reducedMotion ? 0 : 450);

    renderResult(apiResult);
    show(els.stepResult);
    scrollToEl(els.stepResult);
  } catch (err) {
    cards.forEach((c) => c.classList.remove('hot'));
    if (/登录|注册/.test(err.message)) openAuth('login');
    showError(err.message);
  } finally {
    setLoading(els.btnDecide, false);
    state.deciding = false;
  }
}

/* ---------------- ③ 渲染裁定结果 ---------------- */

function fmtPct(p) {
  const v = p * 100;
  if (v >= 99.95) return '100%';
  return `${v.toFixed(1)}%`;
}

function gutBadgeText(p) {
  const pct = `${Math.round(p * 100)}%`;
  if (p >= 0.6) return `💭 Jev 觉得你心里早有答案（${pct}）`;
  if (p <= 0.4) return `💭 Jev 觉得你还没想清楚（${pct}）`;
  return `💭 Jev 拿不准你心里的答案（${pct}）`;
}

function renderResult(data) {
  const r = data.result;
  const opt = state.options.find((o) => o.id === r.choice) || state.options[0];

  els.verdictTitle.textContent = opt.title;
  els.verdictDesc.textContent = opt.risk
    ? `${opt.description}（代价：${opt.risk}）`
    : opt.description;

  // 徽章
  els.badges.textContent = '';
  const addBadge = (text, cls) => {
    const b = document.createElement('span');
    b.className = `badge${cls ? ` ${cls}` : ''}`;
    b.textContent = text;
    els.badges.append(b);
  };
  if (r.confidence != null) addBadge(`🎯 裁定置信度 ${Math.round(r.confidence * 100)}%`, 'violet');
  if (r.gutFeeling != null) addBadge(gutBadgeText(r.gutFeeling));
  if (r.importance) addBadge(`⚖ ${r.importance.label}`, 'gold');

  // 概率条（按概率降序；全部同一系列色，胜出行用金环+徽章强调）
  const sorted = [...state.options].sort(
    (a, b) => (r.probabilities[b.id] || 0) - (r.probabilities[a.id] || 0)
  );
  els.probBars.textContent = '';
  for (const o of sorted) {
    const p = r.probabilities[o.id] || 0;
    const isWinner = o.id === r.choice;

    const row = document.createElement('div');
    row.className = `prob-row${isWinner ? ' winner' : ''}`;
    row.dataset.id = o.id;

    const label = document.createElement('div');
    label.className = 'prob-label';

    const name = document.createElement('span');
    name.className = 'prob-name';
    const pid = document.createElement('span');
    pid.className = 'pid';
    pid.textContent = o.id;
    const ptitle = document.createElement('span');
    ptitle.className = 'ptitle';
    ptitle.textContent = o.title;
    name.append(pid, ptitle);
    if (isWinner) {
      const badge = document.createElement('span');
      badge.className = 'pick-badge';
      badge.textContent = '✓ Jev 之选';
      name.append(badge);
    }

    const val = document.createElement('span');
    val.className = 'prob-val';
    val.textContent = fmtPct(p);

    label.append(name, val);

    const track = document.createElement('div');
    track.className = 'prob-track';
    const fill = document.createElement('div');
    fill.className = 'prob-fill';
    track.append(fill);

    row.append(label, track);
    row.setAttribute('aria-label', `选项 ${o.id} ${o.title}：概率 ${fmtPct(p)}${isWinner ? '，Jev 选中' : ''}`);
    bindTooltip(row, () => `${o.title}：${o.description}${o.risk ? `（代价：${o.risk}）` : ''}`);
    els.probBars.append(row);

    // 下一帧再设置宽度，触发从 0 到目标的过渡动画
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.width = `${Math.min(100, p * 100)}%`;
    }));
  }

  // 无障碍：隐藏数据表
  const cap = els.probTable.querySelector('caption');
  els.probTable.textContent = '';
  els.probTable.append(cap);
  const thead = document.createElement('tr');
  for (const h of ['选项', '概率', '是否中签']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    thead.append(th);
  }
  const hb = document.createElement('thead');
  hb.append(thead);
  els.probTable.append(hb);
  const tb = document.createElement('tbody');
  for (const o of sorted) {
    const tr = document.createElement('tr');
    for (const cell of [`${o.id} ${o.title}`, fmtPct(r.probabilities[o.id] || 0), o.id === r.choice ? '是' : '否']) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    tb.append(tr);
  }
  els.probTable.append(tb);

  // 元信息
  const parts = [];
  if (data.demo) parts.push('演示模式');
  parts.push(`裁定模型 ${r.model}`);
  if (r.usage && r.usage.input_tokens != null) {
    parts.push(`输入 ${r.usage.input_tokens} tok / 输出 ${r.usage.output_tokens ?? 0} tok`);
  }
  els.meta.textContent = parts.join(' · ');
}

/* ---------------- 历史记录 ---------------- */

const PAGE_SIZE = 10;
let histOffset = 0;
let histTotal = 0;

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openHistory() {
  if (!state.user) { openAuth('login'); return; }
  els.historyDrawer.classList.remove('hidden');
  els.backdrop.classList.remove('hidden');
  histOffset = 0;
  els.historyList.textContent = '';
  await loadHistory(false);
}

function closeHistory() {
  els.historyDrawer.classList.add('hidden');
  els.backdrop.classList.add('hidden');
}

async function loadHistory(append) {
  try {
    const data = await fetch(`/api/history?limit=${PAGE_SIZE}&offset=${histOffset}`).then((r) => r.json());
    if (!append) els.historyList.textContent = '';
    histTotal = data.total;
    if (!data.items.length && !append) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = '还没有记录 —— 完成一次裁定后会自动保存在这里';
      els.historyList.append(empty);
    }
    for (const item of data.items) renderHistoryItem(item);
    histOffset += data.items.length;
    els.btnHistoryMore.classList.toggle('hidden', histOffset >= histTotal);
  } catch (err) {
    showError(err.message);
  }
}

function renderHistoryItem(item) {
  const r = item.result || {};
  const opt = (item.options || []).find((o) => o.id === r.choice) || {};

  const card = document.createElement('div');
  card.className = 'hist-item';
  card.dataset.id = item.id;

  const sc = document.createElement('div');
  sc.className = 'hist-scenario';
  sc.textContent = item.scenario;

  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  const time = document.createElement('span');
  time.textContent = fmtTime(item.createdAt);
  const choice = document.createElement('span');
  choice.className = 'hist-choice';
  choice.textContent = `→ ${opt.title || '—'}`;
  meta.append(time, choice);
  if (r.demo) {
    const flag = document.createElement('span');
    flag.className = 'demo-flag';
    flag.textContent = '演示';
    meta.append(flag);
  }

  const ops = document.createElement('span');
  ops.className = 'hist-ops';
  const btnView = document.createElement('button');
  btnView.type = 'button';
  btnView.textContent = '展开';
  btnView.addEventListener('click', () => toggleHistoryDetail(card, item, btnView));
  const btnDel = document.createElement('button');
  btnDel.type = 'button';
  btnDel.className = 'danger';
  btnDel.textContent = '删除';
  btnDel.addEventListener('click', () => deleteHistory(item.id, card));
  ops.append(btnView, btnDel);
  meta.append(ops);

  card.append(sc, meta);
  els.historyList.append(card);
}

function toggleHistoryDetail(card, item, btn) {
  const existing = card.querySelector('.hist-detail');
  if (existing) {
    existing.remove();
    btn.textContent = '展开';
    return;
  }
  btn.textContent = '收起';
  const detail = document.createElement('div');
  detail.className = 'hist-detail';
  const r = item.result || {};
  const sorted = [...(item.options || [])].sort((a, b) => (r.probabilities?.[b.id] || 0) - (r.probabilities?.[a.id] || 0));
  for (const o of sorted) {
    const p = r.probabilities?.[o.id] || 0;
    const isWinner = o.id === r.choice;
    const row = document.createElement('div');
    row.className = `prob-row${isWinner ? ' winner' : ''}`;
    const label = document.createElement('div');
    label.className = 'prob-label';
    const name = document.createElement('span');
    name.className = 'prob-name';
    name.textContent = `${o.id} ${o.title}${isWinner ? ' ✓' : ''}`;
    const val = document.createElement('span');
    val.className = 'prob-val';
    val.textContent = fmtPct(p);
    label.append(name, val);
    const track = document.createElement('div');
    track.className = 'prob-track';
    const fill = document.createElement('div');
    fill.className = 'prob-fill';
    fill.style.width = `${Math.min(100, p * 100)}%`;
    track.append(fill);
    row.append(label, track);
    detail.append(row);
  }
  card.append(detail);
}

async function deleteHistory(id, card) {
  try {
    const resp = await fetch(`/api/history/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error((await resp.json()).error || '删除失败');
    card.remove();
    histTotal -= 1;
    histOffset -= 1;
  } catch (err) {
    showError(err.message);
  }
}

async function clearHistoryAll() {
  if (!confirm('确定清空全部历史记录吗？')) return;
  try {
    const data = await api('/api/history/clear', {});
    els.historyList.textContent = '';
    histOffset = 0;
    histTotal = 0;
    els.btnHistoryMore.classList.add('hidden');
    showError(`已清空 ${data.deleted} 条记录`);
  } catch (err) {
    showError(err.message);
  }
}

/* ---------------- 启动 ---------------- */

async function init() {
  try {
    const resp = await fetch('/api/status');
    const s = await resp.json();
    state.user = s.user || null;
    state.demoScenarios = s.demoScenarios || [];
    // 示例 chips 由后端 demoScenarios 渲染（单一事实源，保证与后端白名单一致）
    els.chips.textContent = '';
    for (const d of state.demoScenarios) {
      const c = document.createElement('button');
      c.className = 'chip';
      c.type = 'button';
      c.textContent = d;
      els.chips.append(c);
    }
    const missing = [];
    if (!s.llmReady) missing.push('LLM');
    if (!s.jevReady) missing.push('Jev');
    if (missing.length && !s.user) {
      els.banner.textContent = `⚡ 演示模式：${missing.join(' 和 ')} 未配置 API Key，将使用内置示例。配置方法见 README.md`;
      els.banner.classList.remove('hidden');
    }
  } catch {
    /* 状态接口失败不阻塞使用 */
  }
  setAuthUI();
}

els.btnGenerate.addEventListener('click', generateOptions);
els.btnRegen.addEventListener('click', generateOptions);
els.btnDecide.addEventListener('click', decide);
els.btnRedecide.addEventListener('click', decide);
els.btnReset.addEventListener('click', () => {
  hide(els.stepOptions);
  hide(els.stepResult);
  if (state.user) {
    els.scenario.value = '';
    els.scenario.focus();
  } else {
    setAuthUI();
  }
  window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
});

els.chips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  els.scenario.value = chip.textContent;
  setAuthUI();
  els.scenario.focus();
});

els.scenario.addEventListener('input', () => {
  if (!state.user) {
    els.chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
  }
});

els.scenario.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateOptions();
});

/* 账号 */
els.btnAuth.addEventListener('click', () => openAuth('login'));
els.btnLogout.addEventListener('click', logout);
els.btnAuthClose.addEventListener('click', closeAuth);
els.backdrop.addEventListener('click', () => { closeAuth(); closeHistory(); });
els.tabLogin.addEventListener('click', () => switchAuthTab('login'));
els.tabRegister.addEventListener('click', () => switchAuthTab('register'));
els.authForm.addEventListener('submit', submitAuth);

/* 历史 */
els.btnHistory.addEventListener('click', openHistory);
els.btnHistoryClose.addEventListener('click', closeHistory);
els.btnHistoryClear.addEventListener('click', clearHistoryAll);
els.btnHistoryMore.addEventListener('click', () => loadHistory(true));

init();

/* 自动演示模式：访问 /?demo=1 自动填入示例场景并走完全流程 */
if (new URLSearchParams(location.search).get('demo') === '1') {
  (async () => {
    await sleep(400);
    els.scenario.value = state.demoScenarios[0] || '毕业三年，是继续在大厂卷，还是回老家开咖啡店？';
    setAuthUI();
    await generateOptions();
    await sleep(600);
    if (state.options.length >= 2) await decide();
  })();
}
