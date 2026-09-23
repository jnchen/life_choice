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
  btnStress: $('#btnStress'),
  btnCapsule: $('#btnCapsule'),
  supplementInput: $('#supplementInput'),
  btnSupplement: $('#btnSupplement'),
  suppRegen: $('#suppRegen'),
  roundsTimeline: $('#roundsTimeline'),
  infoHint: $('#infoHint'),
  stepOptions: $('#stepOptions'),
  stepResult: $('#stepResult'),
  stepStress: $('#stepStress'),
  stepPath: $('#stepPath'),
  pathIntro: $('#pathIntro'),
  pathBrainstorm: $('#pathBrainstorm'),
  futureList: $('#futureList'),
  pathDemo: $('#pathDemo'),
  humanPick: $('#humanPick'),
  humanPickBtns: $('#humanPickBtns'),
  stressIntro: $('#stressIntro'),
  stressList: $('#stressList'),
  stressVerdict: $('#stressVerdict'),
  stressDemo: $('#stressDemo'),
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
  // 命运胶囊
  capsuleModal: $('#capsuleModal'),
  capsuleCanvas: $('#capsuleCanvas'),
  btnCapsuleClose: $('#btnCapsuleClose'),
  btnCapsuleDownload: $('#btnCapsuleDownload'),
  btnCapsuleCopy: $('#btnCapsuleCopy'),
};

const state = {
  scenario: '',       // 基础场景（不含补充）
  supplements: [],    // 多轮补充的信息 [{text, pick, pickTitle}]
  options: [], // [{id,title,description,risk}]
  result: null, // 最近一次裁定结果
  humanChoice: null, // 人亲自选定的选项 id
  user: null,
  authMode: 'login',
  demoScenarios: [],
};

/** 补充信息拼接标记（与后端 baseScenario 保持一致） */
const SUPPLEMENT_MARKER = '当事人后续补充的信息：';

/** 有效场景 = 基础场景 + 历轮补充（喂给 Jev 的完整上下文） */
function effectiveScenario() {
  if (!state.supplements.length) return state.scenario;
  return [
    state.scenario,
    '',
    SUPPLEMENT_MARKER,
    ...state.supplements.map((s, i) => `${i + 1}. ${s.text}`),
  ].join('\n');
}

/** 把历史记录里存的场景文本拆成 { base, supplements[] }，用于完整展示 */
function splitScenario(text) {
  const t = String(text || '');
  const idx = t.indexOf(SUPPLEMENT_MARKER);
  if (idx === -1) return { base: t, supplements: [] };
  const base = t.slice(0, idx).trim();
  const supplements = t
    .slice(idx + SUPPLEMENT_MARKER.length)
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\s*[.、．]\s*/, '').trim())
    .filter(Boolean);
  return { base, supplements };
}

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
  state.supplements = []; // 新场景/换一批选项 → 轮次清零
  state.humanChoice = null;
  hide(els.errorLine);
  hide(els.stepResult);
  hide(els.stepStress);
  hide(els.stepPath);

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
  hide(els.stepPath); // 新一轮概率评估，旧的未来推演作废
  setLoading(els.btnDecide, true, '🔮 Jev 评估中…');

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
    api('/api/decide', { scenario: effectiveScenario(), options: state.options }).then(
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
  state.result = r;
  hide(els.stepStress); // 新裁定后旧的压力测试作废
  const opt = state.options.find((o) => o.id === r.choice) || state.options[0];

  // 本轮裁定是由补充信息触发的 → 把时间线上最新一轮补上裁定结果
  const lastRound = state.supplements[state.supplements.length - 1];
  if (lastRound && lastRound.pick === undefined) {
    lastRound.pick = r.choice;
    lastRound.pickTitle = opt.title;
  }

  els.verdictTitle.textContent = `Jev 最看好：${opt.title}`;
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

  // Jev 觉得信息不足时给出提示（阈值 0.5）
  if (r.infoSufficient != null && r.infoSufficient < 0.5) {
    els.infoHint.textContent = `🤔 Jev 觉得信息不太够（充足度 ${Math.round(r.infoSufficient * 100)}%）—— 补充点细节再评估一次，概率可能更靠谱`;
    els.infoHint.classList.remove('hidden');
  } else {
    els.infoHint.classList.add('hidden');
  }

  // 多轮时间线
  els.roundsTimeline.textContent = '';
  els.roundsTimeline.classList.toggle('hidden', !state.supplements.length);
  state.supplements.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'round-item';
    const no = document.createElement('span');
    no.className = 'round-no';
    no.textContent = `补充 ${i + 1}`;
    const text = document.createElement('span');
    text.textContent = s.text;
    item.append(no, text);
    if (s.pickTitle) {
      const pick = document.createElement('span');
      const prevTitle = i > 0 ? state.supplements[i - 1].pickTitle : null;
      pick.className = `round-pick${prevTitle && prevTitle !== s.pickTitle ? ' changed' : ''}`;
      pick.textContent = `→ Jev 看好 ${s.pickTitle}`;
      item.append(pick);
    }
    els.roundsTimeline.append(item);
  });

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

  // 人来选：每个选项一个按钮，点了就顺着推演未来
  renderHumanPick();
}

/* ---------------- 我的路：人选完 → 头脑风暴 + 未来推演 ---------------- */

function renderHumanPick() {
  els.humanPickBtns.textContent = '';
  for (const o of state.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn pick-btn${state.humanChoice === o.id ? ' chosen' : ''}`;
    btn.textContent = `${o.id} ${o.title}`;
    btn.disabled = state.pathing;
    btn.addEventListener('click', () => runPath(o.id));
    els.humanPickBtns.append(btn);
  }
}

async function runPath(choiceId) {
  if (!state.result || state.pathing) return;
  state.pathing = true;
  state.humanChoice = choiceId;
  renderHumanPick();
  hide(els.errorLine);

  const opt = state.options.find((o) => o.id === choiceId) || {};
  els.pathIntro.textContent = `你选了「${opt.title}」—— LLM 正在顺着这个选择头脑风暴，并推演一年后的走向，Jev 会为每种走向给出概率……`;
  els.pathBrainstorm.textContent = '';
  els.pathBrainstorm.classList.add('hidden');
  els.futureList.textContent = '';
  els.pathDemo.classList.add('hidden');
  show(els.stepPath);
  scrollToEl(els.stepPath);

  try {
    const data = await api('/api/path', {
      scenario: effectiveScenario(),
      options: state.options,
      choice: choiceId,
    });
    renderPath(data, opt);
  } catch (err) {
    hide(els.stepPath);
    if (/登录|注册/.test(err.message)) openAuth('login');
    showError(err.message);
  } finally {
    state.pathing = false;
    renderHumanPick();
  }
}

function renderPath(data, opt) {
  els.pathIntro.textContent = `你选了「${opt.title}」。顺着这条路，先做头脑风暴，再看一年后的可能走向：`;
  els.pathDemo.classList.toggle('hidden', !data.demo);

  // 头脑风暴：第一步 + 行动建议 + 风险预案
  const p = data.path || {};
  const bs = els.pathBrainstorm;
  bs.textContent = '';
  if (p.firstStep) {
    const first = document.createElement('div');
    first.className = 'path-first';
    const fl = document.createElement('span');
    fl.className = 'path-first-label';
    fl.textContent = '🚀 第一步';
    const ft = document.createElement('span');
    ft.textContent = p.firstStep;
    first.append(fl, ft);
    bs.append(first);
  }
  const mkList = (label, icon, items, cls) => {
    if (!items || !items.length) return;
    const block = document.createElement('div');
    block.className = `path-block ${cls}`;
    const lb = document.createElement('div');
    lb.className = 'path-block-label';
    lb.textContent = `${icon} ${label}`;
    block.append(lb);
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'path-item';
      row.textContent = it;
      block.append(row);
    }
    bs.append(block);
  };
  mkList('行动建议', '🗺', p.actions, 'actions');
  mkList('风险预案', '🛡', p.watchouts, 'watchouts');
  bs.classList.remove('hidden');

  // 未来走向概率条（后端已按概率降序）
  els.futureList.textContent = '';
  (data.futures || []).forEach((f, i) => {
    const top = i === 0;
    const row = document.createElement('div');
    row.className = `prob-row future-row${top ? ' winner' : ''}`;

    const label = document.createElement('div');
    label.className = 'prob-label';
    const name = document.createElement('span');
    name.className = 'prob-name';
    const ptitle = document.createElement('span');
    ptitle.className = 'ptitle';
    ptitle.textContent = f.title;
    name.append(ptitle);
    if (top) {
      const badge = document.createElement('span');
      badge.className = 'pick-badge';
      badge.textContent = '✓ 最可能的未来';
      name.append(badge);
    }
    const val = document.createElement('span');
    val.className = 'prob-val';
    val.textContent = fmtPct(f.prob || 0);
    label.append(name, val);

    const track = document.createElement('div');
    track.className = 'prob-track';
    const fill = document.createElement('div');
    fill.className = 'prob-fill';
    track.append(fill);

    const desc = document.createElement('div');
    desc.className = 'future-desc';
    desc.textContent = f.description;

    row.append(label, track, desc);
    row.setAttribute('aria-label', `走向 ${f.title}：概率 ${fmtPct(f.prob || 0)}${top ? '，最可能的未来' : ''}。${f.description}`);
    els.futureList.append(row);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.width = `${Math.min(100, (f.prob || 0) * 100)}%`;
    }));
  });
}

/* ---------------- 多轮补充 ---------------- */

async function supplementAndRedecide() {
  const text = els.supplementInput.value.trim();
  if (!text) {
    showError('先写点补充信息，再让 Jev 重新裁定');
    els.supplementInput.focus();
    return;
  }
  if (!state.result || state.deciding) return;
  state.supplements.push({ text });
  els.supplementInput.value = '';
  // 勾选了「重新生成选项」→ 带着补充重新出题，再执签；否则沿用原选项直接再裁
  if (els.suppRegen && els.suppRegen.checked) {
    await regenerateOptionsAndDecide();
  } else {
    await decide(); // decide 内部会把本轮裁定结果补到时间线上
  }
}

/** 带着补充信息重新生成选项，然后直接执签 */
async function regenerateOptionsAndDecide() {
  setLoading(els.btnSupplement, true, '✨ 带着补充重新出题…');
  hide(els.errorLine);
  try {
    const data = await api('/api/options', { scenario: effectiveScenario() });
    state.options = data.options;
    renderOptions();
    show(els.stepOptions);
  } catch (err) {
    if (/登录|注册/.test(err.message)) openAuth('login');
    showError(err.message);
    return;
  } finally {
    setLoading(els.btnSupplement, false);
  }
  await decide();
}

/* ---------------- 决策压力测试 ---------------- */

async function runStress() {
  if (!state.result || state.stressing) return;
  state.stressing = true;
  setLoading(els.btnStress, true, '🔬 测试中…');
  hide(els.errorLine);

  els.stressList.textContent = '';
  els.stressVerdict.textContent = '';
  els.stressDemo.classList.add('hidden');
  els.stressIntro.textContent = 'Jev 正在把场景改写成 3 个压力变体，逐一复裁……';
  show(els.stepStress);
  scrollToEl(els.stepStress);

  try {
    const data = await api('/api/stress', {
      scenario: effectiveScenario(),
      options: state.options,
      choice: state.result.choice,
    });
    renderStress(data);
  } catch (err) {
    hide(els.stepStress);
    if (/登录|注册/.test(err.message)) openAuth('login');
    showError(err.message);
  } finally {
    setLoading(els.btnStress, false);
    state.stressing = false;
  }
}

function renderStress(data) {
  const original = state.options.find((o) => o.id === state.result.choice);
  const origLabel = `${original.id} ${original.title}`;
  els.stressIntro.textContent = `原裁定是「${origLabel}」。Jev 把场景改写成 ${data.variants.length} 个压力变体，逐一复裁，看这个选择扛不扛得住条件变化：`;
  els.stressDemo.classList.toggle('hidden', !data.demo);

  els.stressList.textContent = '';
  let flips = 0;
  for (const v of data.variants) {
    if (v.flipped) flips += 1;
    const newOpt = state.options.find((o) => o.id === v.choice);

    const card = document.createElement('div');
    card.className = `variant-card ${v.flipped ? 'flipped' : 'held'}`;

    const head = document.createElement('div');
    head.className = 'variant-head';
    const label = document.createElement('span');
    label.className = 'variant-label';
    label.textContent = v.label;
    const tag = document.createElement('span');
    tag.className = `variant-tag ${v.flipped ? 'flip' : 'hold'}`;
    tag.textContent = v.flipped ? '⚡ 翻转了' : '🛡 守住了';
    head.append(label, tag);

    const sc = document.createElement('div');
    sc.className = 'variant-scenario';
    sc.textContent = v.scenario;

    const resLine = document.createElement('div');
    resLine.className = 'variant-result';
    if (v.flipped) {
      resLine.textContent = 'Jev 改选 ';
      const b = document.createElement('b');
      b.textContent = newOpt ? `${newOpt.id} ${newOpt.title}` : v.choice;
      resLine.append(b);
    } else {
      resLine.textContent = 'Jev 仍选 ';
      const b = document.createElement('b');
      b.textContent = origLabel;
      resLine.append(b);
    }

    const track = document.createElement('div');
    track.className = 'variant-track';
    const fill = document.createElement('div');
    fill.className = 'variant-fill';
    track.append(fill);
    const probLabel = document.createElement('div');
    probLabel.className = 'variant-prob-label';
    probLabel.textContent = `此变体下原选项的存活概率：${fmtPct(v.originalProb)}`;

    card.append(head, sc, resLine, track, probLabel);
    els.stressList.append(card);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.width = `${Math.min(100, v.originalProb * 100)}%`;
    }));
  }

  // 稳健性结论
  const total = data.variants.length;
  const verdict = document.createElement('div');
  if (flips === 0) {
    verdict.className = 'stress-verdict solid';
    verdict.textContent = `结论：${total} 个压力条件全部守住 —— 这个决定相当稳健，可以放心推进。`;
  } else if (flips === total) {
    verdict.className = 'stress-verdict fragile';
    verdict.textContent = `结论：${total} 个压力条件全部翻转 —— 这个选择极其脆弱，几乎任何风吹草动都会改变答案，强烈建议重新评估。`;
  } else {
    verdict.className = 'stress-verdict';
    verdict.textContent = `结论：${total} 个压力条件中有 ${flips} 个翻转 —— 决定部分稳健。翻转发生的地方，就是你决策的真正支点，值得重点想想。`;
  }
  els.stressVerdict.textContent = '';
  els.stressVerdict.append(verdict);
}

/* ---------------- 命运胶囊（Canvas 分享卡片） ---------------- */

function openCapsule() {
  if (!state.result) return;
  drawCapsule();
  els.capsuleModal.classList.remove('hidden');
  els.backdrop.classList.remove('hidden');
}

function closeCapsule() {
  els.capsuleModal.classList.add('hidden');
  els.backdrop.classList.add('hidden');
}

/** 中文按字换行 */
function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCapsule() {
  const canvas = els.capsuleCanvas;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;   // 1000
  const H = canvas.height;  // 1400
  const r = state.result;
  const opt = state.options.find((o) => o.id === r.choice) || state.options[0];

  const INK = '#f5f3ff';
  const INK2 = '#c9c4e4';
  const MUTED = '#8f89ad';
  const GOLD = '#f5c66b';
  const SERIES = '#9085e9';

  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1a1630');
  bg.addColorStop(1, '#0d0b16');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // 顶部光晕
  const glow = ctx.createRadialGradient(W / 2, -100, 50, W / 2, -100, 700);
  glow.addColorStop(0, 'rgba(144,133,233,0.35)');
  glow.addColorStop(1, 'rgba(144,133,233,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 700);

  ctx.textBaseline = 'alphabetic';
  const FONT = 'system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  let y = 92;

  // 标题
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText('人生选择器 · 命运胶囊', W / 2, y);

  // 日期
  y += 44;
  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${FONT}`;
  const d = new Date();
  ctx.fillText(`${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`, W / 2, y);

  // 场景卡（含历轮补充的完整上下文）
  y += 56;
  ctx.textAlign = 'left';
  ctx.font = `400 28px ${FONT}`;
  const scLines = wrapCanvasText(ctx, effectiveScenario(), W - 160).slice(0, 6);
  const scH = 40 + scLines.length * 44 + 30;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  roundRect(ctx, 60, y, W - 120, scH, 20);
  ctx.fill();
  ctx.fillStyle = MUTED;
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText('📝 我的人生场景', 92, y + 48);
  ctx.fillStyle = INK2;
  ctx.font = `400 28px ${FONT}`;
  scLines.forEach((line, i) => ctx.fillText(line, 92, y + 96 + i * 44));

  // 分割线
  y += scH + 54;
  const rule = ctx.createLinearGradient(80, 0, W - 80, 0);
  rule.addColorStop(0, 'rgba(245,198,107,0)');
  rule.addColorStop(0.5, 'rgba(245,198,107,0.55)');
  rule.addColorStop(1, 'rgba(245,198,107,0)');
  ctx.fillStyle = rule;
  ctx.fillRect(80, y, W - 160, 2);

  // 裁定标签
  y += 64;
  ctx.textAlign = 'center';
  ctx.fillStyle = MUTED;
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText('—  J e v  的  裁  定  —', W / 2, y);

  // 中签标题（金色大字）
  y += 88;
  ctx.fillStyle = GOLD;
  ctx.font = `800 76px ${FONT}`;
  ctx.shadowColor = 'rgba(245,198,107,0.35)';
  ctx.shadowBlur = 30;
  ctx.fillText(opt.title, W / 2, y);
  ctx.shadowBlur = 0;

  // 描述
  y += 52;
  ctx.fillStyle = INK2;
  ctx.font = `400 27px ${FONT}`;
  const descLines = wrapCanvasText(ctx, opt.description || '', W - 200).slice(0, 2);
  descLines.forEach((line, i) => ctx.fillText(line, W / 2, y + i * 40));
  y += descLines.length * 40;

  // 徽章行
  y += 30;
  ctx.font = `600 23px ${FONT}`;
  const badgeTexts = [];
  if (r.confidence != null) badgeTexts.push(`置信度 ${Math.round(r.confidence * 100)}%`);
  if (r.importance) badgeTexts.push(r.importance.label);
  if (r.gutFeeling != null) badgeTexts.push(r.gutFeeling >= 0.6 ? '你心里早有答案' : r.gutFeeling <= 0.4 ? '你还没想清楚' : 'Jev 看不透你');
  const badgeStr = badgeTexts.join('   ·   ');
  ctx.fillStyle = '#c4b8ff';
  ctx.fillText(badgeStr, W / 2, y);

  // 概率条标题
  y += 66;
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText('各选项命运倾向度', 60, y);
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.font = `400 21px ${FONT}`;
  ctx.fillText('Jev 给出的概率分布', W - 60, y);

  // 概率条（按概率降序）
  y += 30;
  const sorted = [...state.options].sort((a, b) => (r.probabilities[b.id] || 0) - (r.probabilities[a.id] || 0));
  const BAR_X = 60;
  const BAR_W = W - 120;
  const BAR_H = 20;
  for (const o of sorted) {
    const p = r.probabilities[o.id] || 0;
    const isWinner = o.id === r.choice;

    // 标签行
    ctx.textAlign = 'left';
    ctx.font = `600 25px ${FONT}`;
    ctx.fillStyle = isWinner ? GOLD : INK;
    ctx.fillText(`${o.id} ${o.title}${isWinner ? '  ✓' : ''}`, BAR_X, y + 26);
    ctx.textAlign = 'right';
    ctx.fillStyle = INK2;
    ctx.font = `500 24px ${FONT}`;
    ctx.fillText(fmtPct(p), BAR_X + BAR_W, y + 26);

    // 轨道 + 填充
    const ty = y + 42;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(ctx, BAR_X, ty, BAR_W, BAR_H, 10);
    ctx.fill();
    const fw = Math.max(BAR_H, BAR_W * Math.min(1, p));
    const fg = ctx.createLinearGradient(BAR_X, 0, BAR_X + fw, 0);
    fg.addColorStop(0, '#7a6ee0');
    fg.addColorStop(1, SERIES);
    ctx.fillStyle = fg;
    roundRect(ctx, BAR_X, ty, fw, BAR_H, 10);
    ctx.fill();
    if (isWinner) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 3;
      roundRect(ctx, BAR_X - 2, ty - 2, BAR_W + 4, BAR_H + 4, 12);
      ctx.stroke();
    }
    y += 96;
  }

  // 页脚
  ctx.textAlign = 'center';
  ctx.fillStyle = MUTED;
  ctx.font = `400 21px ${FONT}`;
  ctx.fillText('LLM 出题 · Jev（TypeSafe AI System One）执签', W / 2, H - 76);
  ctx.fillText('仅供参考，人生自负 😉', W / 2, H - 42);
}

function downloadCapsule() {
  els.capsuleCanvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `命运胶囊-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

async function copyCapsuleText() {
  const r = state.result;
  const opt = state.options.find((o) => o.id === r.choice) || state.options[0];
  const lines = [
    '🏺 我的命运胶囊',
    `场景：${effectiveScenario()}`,
    `Jev 的裁定：${opt.title} —— ${opt.description}`,
    '概率分布：' + state.options
      .map((o) => `${o.title} ${fmtPct(r.probabilities[o.id] || 0)}`)
      .join(' / '),
    r.confidence != null ? `置信度 ${Math.round(r.confidence * 100)}%` : '',
    '—— 人生选择器（LLM 出题 · Jev 执签，仅供参考，人生自负）',
  ].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(lines);
    els.btnCapsuleCopy.textContent = '✅ 已复制';
    setTimeout(() => { els.btnCapsuleCopy.textContent = '📋 复制分享文案'; }, 1500);
  } catch {
    showError('复制失败，浏览器未授权剪贴板');
  }
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
  const { base, supplements } = splitScenario(item.scenario);

  const card = document.createElement('div');
  card.className = 'hist-item';
  card.dataset.id = item.id;

  const sc = document.createElement('div');
  sc.className = 'hist-scenario';
  sc.textContent = base;

  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  const time = document.createElement('span');
  time.textContent = fmtTime(item.createdAt);
  const choice = document.createElement('span');
  choice.className = 'hist-choice';
  choice.textContent = r.human ? `→ 你选了 ${opt.title || '—'}` : `→ ${opt.title || '—'}`;
  meta.append(time, choice);
  if (supplements.length) {
    const supp = document.createElement('span');
    supp.className = 'hist-supp-count';
    supp.textContent = `📝 ${supplements.length} 轮补充`;
    meta.append(supp);
  }
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

  // 完整场景 + 历轮补充
  const { base, supplements } = splitScenario(item.scenario);
  const scBlock = document.createElement('div');
  scBlock.className = 'hist-full-scenario';
  const scLabel = document.createElement('div');
  scLabel.className = 'hist-detail-label';
  scLabel.textContent = '场景';
  const scText = document.createElement('div');
  scText.className = 'hist-full-text';
  scText.textContent = base;
  scBlock.append(scLabel, scText);
  detail.append(scBlock);

  if (supplements.length) {
    const suppBlock = document.createElement('div');
    suppBlock.className = 'hist-supps';
    const suppLabel = document.createElement('div');
    suppLabel.className = 'hist-detail-label';
    suppLabel.textContent = `后续补充（${supplements.length} 轮）`;
    suppBlock.append(suppLabel);
    supplements.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'hist-supp-item';
      row.textContent = `${i + 1}. ${s}`;
      suppBlock.append(row);
    });
    detail.append(suppBlock);
  }

  // 概率分布（普通裁定）或 未来走向 + 头脑风暴（人选完后的「我的路」）
  const mkProbRow = (name, pct, isWinner) => {
    const row = document.createElement('div');
    row.className = `prob-row${isWinner ? ' winner' : ''}`;
    const label = document.createElement('div');
    label.className = 'prob-label';
    const nm = document.createElement('span');
    nm.className = 'prob-name';
    nm.textContent = `${name}${isWinner ? ' ✓' : ''}`;
    const val = document.createElement('span');
    val.className = 'prob-val';
    val.textContent = fmtPct(pct);
    label.append(nm, val);
    const track = document.createElement('div');
    track.className = 'prob-track';
    const fill = document.createElement('div');
    fill.className = 'prob-fill';
    fill.style.width = `${Math.min(100, pct * 100)}%`;
    track.append(fill);
    row.append(label, track);
    return row;
  };

  if (Array.isArray(r.futures) && r.futures.length) {
    if (r.path && (r.path.firstStep || (r.path.actions || []).length)) {
      const pLabel = document.createElement('div');
      pLabel.className = 'hist-detail-label';
      pLabel.textContent = '头脑风暴';
      detail.append(pLabel);
      if (r.path.firstStep) {
        const first = document.createElement('div');
        first.className = 'hist-supp-item';
        first.textContent = `🚀 第一步：${r.path.firstStep}`;
        detail.append(first);
      }
      for (const a of (r.path.actions || []).slice(0, 4)) {
        const row = document.createElement('div');
        row.className = 'hist-supp-item';
        row.textContent = `🗺 ${a}`;
        detail.append(row);
      }
      for (const w of (r.path.watchouts || []).slice(0, 3)) {
        const row = document.createElement('div');
        row.className = 'hist-supp-item';
        row.textContent = `🛡 ${w}`;
        detail.append(row);
      }
    }
    const fLabel = document.createElement('div');
    fLabel.className = 'hist-detail-label';
    fLabel.textContent = '一年后的走向（Jev 概率）';
    detail.append(fLabel);
    r.futures.forEach((f, i) => detail.append(mkProbRow(f.title, f.prob || 0, i === 0)));
  } else {
    const probLabel = document.createElement('div');
    probLabel.className = 'hist-detail-label';
    probLabel.textContent = '本轮裁定';
    detail.append(probLabel);
    const sorted = [...(item.options || [])].sort((a, b) => (r.probabilities?.[b.id] || 0) - (r.probabilities?.[a.id] || 0));
    for (const o of sorted) {
      detail.append(mkProbRow(`${o.id} ${o.title}`, r.probabilities?.[o.id] || 0, o.id === r.choice));
    }
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
els.btnStress.addEventListener('click', runStress);
els.btnSupplement.addEventListener('click', supplementAndRedecide);
els.supplementInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) supplementAndRedecide();
});
els.btnCapsule.addEventListener('click', openCapsule);
els.btnCapsuleClose.addEventListener('click', closeCapsule);
els.btnCapsuleDownload.addEventListener('click', downloadCapsule);
els.btnCapsuleCopy.addEventListener('click', copyCapsuleText);
els.btnReset.addEventListener('click', () => {
  hide(els.stepOptions);
  hide(els.stepResult);
  hide(els.stepStress);
  state.result = null;
  state.supplements = [];
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
els.backdrop.addEventListener('click', () => { closeAuth(); closeHistory(); closeCapsule(); });
els.tabLogin.addEventListener('click', () => switchAuthTab('login'));
els.tabRegister.addEventListener('click', () => switchAuthTab('register'));
els.authForm.addEventListener('submit', submitAuth);

/* 历史 */
els.btnHistory.addEventListener('click', openHistory);
els.btnHistoryClose.addEventListener('click', closeHistory);
els.btnHistoryClear.addEventListener('click', clearHistoryAll);
els.btnHistoryMore.addEventListener('click', () => loadHistory(true));

init();

/* 自动演示模式：?demo=1 走全流程；&capsule=1 自动打开命运胶囊；&round=1 自动补一轮信息 */
const qs = new URLSearchParams(location.search);
if (qs.get('demo') === '1') {
  (async () => {
    await sleep(400);
    els.scenario.value = state.demoScenarios[0] || '毕业三年，是继续在大厂卷，还是回老家开咖啡店？';
    setAuthUI();
    await generateOptions();
    await sleep(600);
    if (state.options.length >= 2) await decide();
    if (qs.get('round') === '1' && state.result) {
      await sleep(500);
      els.supplementInput.value = '补充一下：我手里存款大概只够撑半年，而且家人更希望我回老家';
      await supplementAndRedecide();
    }
    await sleep(400);
    if (state.result) await runStress();
    if (qs.get('capsule') === '1' && state.result) openCapsule();
  })();
}
