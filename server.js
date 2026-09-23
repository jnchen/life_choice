#!/usr/bin/env node
/**
 * 人生选择器 · Life Chooser
 * 流程：用户描述场景 → LLM（OpenAI 兼容接口）生成 3~5 个选项 → Jev（TypeSafe AI
 * System One）对场景做裁定：选中一项 + 每项概率分布 + 置信度 + 两个趣味判断。
 *
 * 零依赖：Node.js 18+（内置 fetch），`node server.js` 直接运行。
 * 未配置 API Key 时自动进入演示模式（内置选项 + 模拟裁定）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

/* ---------------- 配置读取（.env 热加载，改完无需重启） ---------------- */

function readEnvFile() {
  const out = {};
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/** 每次请求时合并 环境变量 + .env（环境变量优先） */
function getConfig() {
  const fileEnv = readEnvFile();
  const get = (k, d) => process.env[k] || fileEnv[k] || d;
  const clean = (s) => String(s).replace(/\/+$/, '');
  return {
    LLM_BASE: clean(get('OPENAI_BASE_URL', 'https://api.deepseek.com/v1')),
    LLM_KEY: get('OPENAI_API_KEY', ''),
    LLM_MODEL: get('OPENAI_MODEL', 'deepseek-chat'),
    JEV_BASE: clean(get('TYPESAFE_API_BASE', 'https://api.typesafe.ai')),
    JEV_KEY: get('TYPESAFE_API_KEY', ''),
    JEV_MODEL: get('JEV_MODEL', 'jev-latest'),
  };
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 = 监听所有网卡，支持内网访问
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Jev score 问题的有序等级（index 0 = 影响最小） */
const IMPORTANCE_LEVELS = [
  '影响很小，随时可以反悔',
  '有一定影响，但可以调整',
  '影响较大，会改变生活轨迹',
  '重大转折，可能改变人生方向',
];

/** 游客演示：只能点内置示例（chip 文案）。白名单由文案推导——每个 chip 前半句映射到完整问句，
 *  避免「前端文案」与「后端白名单」两处维护脱节。 */
const DEMO_PAIRS = [
  ['毕业三年，是继续在大厂卷，还是回老家开咖啡店？', '毕业三年了，是继续在大厂卷，还是回老家开一家咖啡店？'],
  ['30 岁了，要不要裸辞去追插画的梦想？', '30 岁了，要不要裸辞去追插画的梦想？'],
  ['异地恋三年，我搬过去、TA 搬过来，还是就算了？', '异地恋三年，我搬过去、TA 搬过来，还是就算了？'],
  ['手里 20 万，先付首付买房，还是先读个在职研究生？', '手里 20 万，先付首付买房，还是先读个在职研究生？'],
];
/** 供前端展示用的示例（chip 文案） */
const DEMO_SCENARIOS = DEMO_PAIRS.map(([chip]) => chip);
const DEMO_LOOKUP = new Map(DEMO_PAIRS.map(([chip, full]) => [chip, full]));

function matchDemoScenario(scenario) {
  return DEMO_LOOKUP.get(String(scenario).trim()) || null;
}

/* ---------------- 小工具 ---------------- */

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj, extraHeaders = {}) {
  try {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(buf);
  } catch {
    /* 连接已断开时忽略写入错误 */
  }
}

/* ---------------- 会话 Cookie ---------------- */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  return `lc_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function currentUser(req) {
  const token = parseCookies(req).lc_session;
  return db.getUserByToken(token);
}

async function postJSON(url, body, { timeoutMs = 30000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 保持原样 */
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null; // 保留 text 供错误信息使用
    }
    if (!resp.ok) {
      const detail = data?.error?.message || data?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
      throw new Error(`上游 ${host} 返回 ${resp.status}：${detail}`);
    }
    if (!data) throw new Error('上游返回了无法解析的内容');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求 ${host} 超时（${timeoutMs / 1000}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 LLM 回复中稳健地抠出 JSON（容忍 ```json 围栏与前后废话） */
function extractJSON(text) {
  const t = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('模型没有返回 JSON 格式的内容');
  return JSON.parse(t.slice(start, end + 1));
}

/* ---------------- ① LLM 生成选项 ---------------- */

const OPTION_SYSTEM_PROMPT = [
  '你是「人生选择器」应用里的选项策划师。用户会描述一个人生场景（两难、抉择、迷茫时刻），',
  '你负责给出 3~5 个互斥、具体、有想象力的候选选项，风格要有差异：至少一个稳妥选项、一个大胆选项，',
  '允许一个出其不意的选项。选项要贴合用户场景里的具体处境，不要空泛。',
  '只输出 JSON，不要任何多余文字，格式：',
  '{"options":[{"title":"选项名，不超过10个字","description":"一句话说明这条路大概怎么走，不超过40个字","risk":"这条路的主要代价或风险，不超过30个字"}]}',
].join('\n');

function normalizeOptions(list) {
  return list.slice(0, 6).map((o, i) => ({
    id: 'ABCDE'[i] || String(i + 1),
    title: String(o.title || `选项${i + 1}`).trim().slice(0, 24),
    description: String(o.description || '').trim().slice(0, 80),
    risk: String(o.risk || '').trim().slice(0, 60),
  }));
}

async function llmGenerateOptions(scenario) {
  const { LLM_BASE, LLM_KEY, LLM_MODEL } = getConfig();
  const makeBody = (withFormat) => ({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: OPTION_SYSTEM_PROMPT },
      { role: 'user', content: `我的人生场景：${scenario}` },
    ],
    temperature: 0.95,
    ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
  });

  let data;
  try {
    data = await postJSON(`${LLM_BASE}/chat/completions`, makeBody(true), {
      timeoutMs: 60000,
      headers: { Authorization: `Bearer ${LLM_KEY}` },
    });
  } catch (err) {
    // 部分兼容服务不支持 response_format 字段，去掉后重试一次
    data = await postJSON(`${LLM_BASE}/chat/completions`, makeBody(false), {
      timeoutMs: 60000,
      headers: { Authorization: `Bearer ${LLM_KEY}` },
    }).catch(() => {
      throw err; // 报第一次的错误，信息更真实
    });
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 没有返回内容');
  const parsed = extractJSON(content);
  const list = Array.isArray(parsed) ? parsed : parsed.options;
  if (!Array.isArray(list) || list.length < 2) throw new Error('LLM 返回的选项数量不足');
  return { options: normalizeOptions(list), model: data.model || LLM_MODEL };
}

/* ---------------- ② Jev 执签（TypeSafe AI System One） ---------------- */

/** 原始 Jev 查询：一次 systemone 调用，可并行问多个问题 */
async function jevQuery(state, questions) {
  const { JEV_BASE, JEV_KEY, JEV_MODEL } = getConfig();
  return postJSON(`${JEV_BASE}/v1/systemone`, { state, model: JEV_MODEL, questions }, {
    timeoutMs: 30000,
    headers: { Authorization: `Bearer ${JEV_KEY}` },
  });
}

/** 把 Jev 的 choice 答案归一化成 {choice, probabilities, confidence} */
function normalizePick(pick, options) {
  pick = pick || {};
  const rawProbs = pick.probabilities || {};
  const validIds = new Set(options.map((o) => o.id));

  // 归一化概率（只保留合法选项，缺失补 0，总和归一）
  const probs = {};
  let sum = 0;
  for (const o of options) {
    const p = Math.max(0, Number(rawProbs[o.id]) || 0);
    probs[o.id] = p;
    sum += p;
  }
  if (sum > 0) for (const k of Object.keys(probs)) probs[k] /= sum;

  // 选中的选项若不在候选里（极小概率），回退到概率最高的合法选项
  let choice = pick.choice;
  if (!validIds.has(choice)) {
    const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
    choice = best ? best[0] : options[0].id;
  }

  return {
    choice,
    probabilities: probs,
    confidence: Number.isFinite(Number(pick.confidence)) ? Number(pick.confidence) : null,
  };
}

/** 构造选项场景文本（裁定与压力测试共用） */
function buildState(scenario, options) {
  return [
    '一个真实的人生抉择场景，等待裁定：',
    `场景：${scenario}`,
    '',
    '候选选项：',
    ...options.map((o) => `${o.id}. ${o.title} —— ${o.description}${o.risk ? `（代价/风险：${o.risk}）` : ''}`),
  ].join('\n');
}

/** 构造 choice 问题（裁定与压力测试共用） */
function pickQuestion(options) {
  return {
    type: 'choice',
    instructions: '如果必须替当事人选一个选项，综合考虑长远幸福、个人成长与风险承受能力，你会选哪个？',
    criteria: Object.fromEntries(
      options.map((o) => [o.id, `${o.title}：${o.description}${o.risk ? `（主要代价：${o.risk}）` : ''}`])
    ),
  };
}

async function jevDecide(scenario, options) {
  const questions = {
    pick: pickQuestion(options),
    gut_feeling: {
      type: 'noul',
      instructions: '从场景描述的措辞看，提问的人心里其实已经偏向其中某一个选项。',
    },
    info_sufficient: {
      type: 'noul',
      instructions: '场景描述里包含的信息已经足够做出一个负责任的判断（1 = 信息充足，0 = 关键信息缺失，需要当事人补充更多细节）。',
    },
    importance: {
      type: 'score',
      instructions: '这个决定对当事人人生的影响程度。',
      criteria: IMPORTANCE_LEVELS,
    },
  };

  const resp = await jevQuery(buildState(scenario, options), questions);
  const answers = resp.answers || {};
  const picked = normalizePick(answers.pick, options);

  const impRaw = Number(answers.importance?.score);
  const impLevel = Number.isFinite(impRaw)
    ? Math.min(IMPORTANCE_LEVELS.length - 1, Math.max(0, Math.round(impRaw)))
    : null;

  return {
    ...picked,
    gutFeeling: Number.isFinite(Number(answers.gut_feeling?.noul)) ? Number(answers.gut_feeling.noul) : null,
    infoSufficient: Number.isFinite(Number(answers.info_sufficient?.noul))
      ? Number(answers.info_sufficient.noul)
      : null,
    importance:
      impLevel === null
        ? null
        : { score: impRaw, level: impLevel, label: IMPORTANCE_LEVELS[impLevel] },
    model: resp.model || getConfig().JEV_MODEL,
    usage: resp.usage || null,
  };
}

/* ---------------- ③ 决策压力测试：变体生成 + 复裁 ---------------- */

const STRESS_SYSTEM_PROMPT = [
  '你是「决策压力测试」设计师。给定一个人生抉择场景，生成 3 个压力变体：',
  '每个变体在原场景上增加或改变一个关键条件，用来测试原决策是否稳健。',
  '三个变体要有区分度：一个偏不利条件、一个偏有利条件、一个改变核心约束。',
  '只输出 JSON，不要任何多余文字，格式：',
  '{"variants":[{"label":"变体名，不超过8个字","scenario":"改写后的完整场景，不超过120字"}]}',
].join('\n');

async function llmGenerateVariants(scenario) {
  const { LLM_BASE, LLM_KEY, LLM_MODEL } = getConfig();
  const data = await postJSON(`${LLM_BASE}/chat/completions`, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: STRESS_SYSTEM_PROMPT },
      { role: 'user', content: `人生场景：${scenario}` },
    ],
    temperature: 0.8,
  }, { timeoutMs: 60000, headers: { Authorization: `Bearer ${LLM_KEY}` } });

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 没有返回内容');
  const parsed = extractJSON(content);
  const list = Array.isArray(parsed) ? parsed : parsed.variants;
  if (!Array.isArray(list) || !list.length) throw new Error('LLM 没有返回变体');
  return list.slice(0, 3).map((v, i) => ({
    label: String(v.label || `变体${i + 1}`).trim().slice(0, 12),
    scenario: String(v.scenario || scenario).trim().slice(0, 200),
  }));
}

/** 单个变体：只问 Jev 一道选择题 */
async function jevChoose(scenario, options) {
  const resp = await jevQuery(buildState(scenario, options), { pick: pickQuestion(options) });
  return normalizePick(resp.answers?.pick, options);
}

/* ---------------- 演示模式（未配置 key） ---------------- */

const MOCK_OPTION_SETS = [
  [
    { title: '稳住别动', description: '维持现状，把手里的牌打稳，攒够筹码再说', risk: '可能会在原地待太久' },
    { title: '放手一搏', description: '押上现有的一切，全力冲一把你真正想要的', risk: '输了会很疼' },
    { title: '小步试错', description: '不动大盘，先用最小成本验证那件心动的事', risk: '两头兼顾可能两头都慢' },
    { title: '跳出去看看', description: '换个环境、换个圈子，让新鲜信息冲一冲判断', risk: '新环境未必更好' },
  ],
  [
    { title: '再等等看', description: '先什么都不决定，给自己设个期限收集信息', risk: '拖字诀可能变成逃避' },
    { title: '选心里那个', description: '抛开利弊表，选那个半夜想起来会心动的', risk: '心动不能当饭吃' },
    { title: '选稳妥那个', description: '选错了损失最小的那条路，把风险关进笼子', risk: '安稳久了会不甘心' },
    { title: '问问过来人', description: '找三个走过类似路口的人聊完再决定', risk: '别人的答案未必是你的' },
  ],
  [
    { title: '留在原地', description: '守住现在拥有的一切，让时间给答案', risk: '舒适区会越待越小' },
    { title: '全部推倒', description: '清空重来，把人生当第二次活', risk: '重启的代价比想象大' },
    { title: '并行推进', description: '主线不丢，用业余时间把新可能养起来', risk: '精力被切成两半' },
    { title: '反过来想', description: '假设十年后的自己回头看，选不会后悔的那个', risk: '十年后的你还没投票权' },
  ],
];

function mockOptions(scenario) {
  const set = MOCK_OPTION_SETS[scenario.length % MOCK_OPTION_SETS.length];
  return { options: normalizeOptions(set), model: 'demo（未配置 LLM Key）' };
}

function mockDecide(options) {
  const weights = options.map(() => 0.25 + Math.random());
  const total = weights.reduce((a, b) => a + b, 0);
  const probabilities = {};
  options.forEach((o, i) => {
    probabilities[o.id] = weights[i] / total;
  });
  let acc = Math.random();
  let choice = options[0].id;
  for (const o of options) {
    acc -= probabilities[o.id];
    if (acc <= 0) {
      choice = o.id;
      break;
    }
  }
  const level = Math.floor(Math.random() * IMPORTANCE_LEVELS.length);
  return {
    choice,
    probabilities,
    confidence: 0.55 + Math.random() * 0.4,
    gutFeeling: Math.random(),
    infoSufficient: Math.random(),
    importance: { score: level, level, label: IMPORTANCE_LEVELS[level] },
    model: 'jev-demo（未配置 TYPESAFE_API_KEY）',
    usage: null,
  };
}

/** 演示模式的压力变体（按场景长度轮转模板） */
const MOCK_VARIANTS = [
  { label: '预算减半', suffix: '（压力条件：可用资金只剩一半）' },
  { label: '时间收紧', suffix: '（压力条件：必须在三个月内做出决定并执行）' },
  { label: '有人同行', suffix: '（压力条件：有一位完全信赖的伙伴愿意同行）' },
  { label: '家人反对', suffix: '（压力条件：最亲近的家人明确反对你的首选）' },
  { label: '经济下行', suffix: '（压力条件：未来两年大环境明显变差）' },
];

function mockStress(scenario, options, originalChoice) {
  const offset = scenario.length % MOCK_VARIANTS.length;
  const variants = [0, 1, 2].map((i) => {
    const t = MOCK_VARIANTS[(offset + i) % MOCK_VARIANTS.length];
    return { label: t.label, scenario: scenario + t.suffix };
  });
  return variants.map((v) => {
    const pick = mockDecide(options);
    return {
      ...v,
      choice: pick.choice,
      probabilities: pick.probabilities,
      flipped: pick.choice !== originalChoice,
      originalProb: pick.probabilities[originalChoice] || 0,
    };
  });
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  let p = pathname;
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJSON(res, 400, { error: '非法请求路径' });
  }
  const user = currentUser(req);

  try {
    /* ================= 账号 ================= */

    /* POST /api/auth/register {email, username, password} */
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const u = db.createUser(body);
        const token = db.createSession(u.id);
        return sendJSON(res, 200, { user: u }, { 'Set-Cookie': sessionCookie(token, 14 * 24 * 3600) });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    /* POST /api/auth/login {email, password} */
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const u = db.verifyUser(body.email, body.password);
        const token = db.createSession(u.id);
        return sendJSON(res, 200, { user: u }, { 'Set-Cookie': sessionCookie(token, 14 * 24 * 3600) });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    /* POST /api/auth/logout */
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      db.deleteSession(parseCookies(req).lc_session);
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    /* GET /api/me */
    if (req.method === 'GET' && url.pathname === '/api/me') {
      return sendJSON(res, 200, { user });
    }

    /* ================= 状态 ================= */

    /* GET /api/status */
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const cfg = getConfig();
      return sendJSON(res, 200, {
        llmReady: Boolean(cfg.LLM_KEY),
        llmModel: cfg.LLM_MODEL,
        jevReady: Boolean(cfg.JEV_KEY),
        jevModel: cfg.JEV_MODEL,
        user,
        demoScenarios: DEMO_SCENARIOS,
      });
    }

    /* ================= 核心流程 ================= */

    /* POST /api/options {scenario} → {demo, model, options[]}
       游客：仅允许内置 demo 场景（白名单）；登录用户：自由场景 + 真实模型 */
    if (req.method === 'POST' && url.pathname === '/api/options') {
      const cfg = getConfig();
      const body = JSON.parse((await readBody(req)) || '{}');
      let scenario = String(body.scenario || '').trim();
      if (!scenario) return sendJSON(res, 400, { error: '请先描述你的场景' });
      if (scenario.length > 1000) return sendJSON(res, 400, { error: '场景描述太长了（上限 1000 字）' });

      const guestDemoFull = !user ? matchDemoScenario(scenario) : null;
      if (!user && !guestDemoFull) {
        return sendJSON(res, 401, { error: '注册登录后，才能输入自己的场景调用真实模型' });
      }
      if (guestDemoFull) scenario = guestDemoFull; // chip 文案 → 完整场景，喂给演示选项

      if (!cfg.LLM_KEY || guestDemoFull) {
        const mock = mockOptions(scenario);
        return sendJSON(res, 200, { demo: true, ...mock });
      }
      const out = await llmGenerateOptions(scenario);
      return sendJSON(res, 200, { demo: false, ...out });
    }

    /* POST /api/decide {scenario, options[]} → {demo, result}
       规则同 /api/options；登录用户的裁定结果会写入历史记录 */
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const cfg = getConfig();
      const body = JSON.parse((await readBody(req)) || '{}');
      let scenario = String(body.scenario || '').trim();
      const raw = Array.isArray(body.options) ? body.options : [];
      const options = raw
        .filter((o) => o && typeof o.title === 'string' && o.title.trim())
        .slice(0, 6)
        .map((o, i) => ({
          id: /^[A-F]$/.test(String(o.id)) ? String(o.id) : 'ABCDE'[i] || String(i + 1),
          title: String(o.title).trim().slice(0, 24),
          description: String(o.description || '').trim().slice(0, 120),
          risk: String(o.risk || '').trim().slice(0, 80),
        }));
      if (!scenario) return sendJSON(res, 400, { error: '缺少场景描述' });
      if (scenario.length > 3000) return sendJSON(res, 400, { error: '场景描述太长了（含补充信息上限 3000 字）' });
      if (options.length < 2) return sendJSON(res, 400, { error: '至少需要两个选项才能执签' });

      const guestDemoFull = !user ? matchDemoScenario(scenario) : null;
      if (!user && !guestDemoFull) {
        return sendJSON(res, 401, { error: '注册登录后，才能输入自己的场景调用真实模型' });
      }
      if (guestDemoFull) scenario = guestDemoFull;

      let result;
      let demo;
      if (!cfg.JEV_KEY || guestDemoFull) {
        demo = true;
        result = mockDecide(options);
      } else {
        demo = false;
        result = await jevDecide(scenario, options);
      }

      let historyId = null;
      if (user) {
        historyId = db.addHistory(user.id, { scenario, options, result: { ...result, demo } });
      }
      return sendJSON(res, 200, { demo, result, historyId });
    }

    /* POST /api/stress {scenario, options[], choice} → {demo, variants[]}
       压力测试：LLM 生成 3 个场景变体，每个变体让 Jev 复裁一次，看选择是否翻转 */
    if (req.method === 'POST' && url.pathname === '/api/stress') {
      const cfg = getConfig();
      const body = JSON.parse((await readBody(req)) || '{}');
      let scenario = String(body.scenario || '').trim();
      const originalChoice = String(body.choice || '').trim();
      const raw = Array.isArray(body.options) ? body.options : [];
      const options = raw
        .filter((o) => o && typeof o.title === 'string' && o.title.trim())
        .slice(0, 6)
        .map((o, i) => ({
          id: /^[A-F]$/.test(String(o.id)) ? String(o.id) : 'ABCDE'[i] || String(i + 1),
          title: String(o.title).trim().slice(0, 24),
          description: String(o.description || '').trim().slice(0, 120),
          risk: String(o.risk || '').trim().slice(0, 80),
        }));
      if (!scenario) return sendJSON(res, 400, { error: '缺少场景描述' });
      if (options.length < 2) return sendJSON(res, 400, { error: '至少需要两个选项' });
      if (!options.some((o) => o.id === originalChoice)) {
        return sendJSON(res, 400, { error: '缺少原始裁定结果' });
      }

      const guestDemoFull = !user ? matchDemoScenario(scenario) : null;
      if (!user && !guestDemoFull) {
        return sendJSON(res, 401, { error: '注册登录后，才能输入自己的场景调用真实模型' });
      }
      if (guestDemoFull) scenario = guestDemoFull;

      // 需要同时有 LLM（出变体）和 Jev（复裁），缺一就走演示
      if (!cfg.LLM_KEY || !cfg.JEV_KEY || guestDemoFull) {
        return sendJSON(res, 200, { demo: true, variants: mockStress(scenario, options, originalChoice) });
      }

      const variants = await llmGenerateVariants(scenario);
      // 三个变体并行复裁（Jev 便宜快速，放心并发）
      const results = await Promise.all(
        variants.map(async (v) => {
          const pick = await jevChoose(v.scenario, options);
          return {
            label: v.label,
            scenario: v.scenario,
            choice: pick.choice,
            probabilities: pick.probabilities,
            flipped: pick.choice !== originalChoice,
            originalProb: pick.probabilities[originalChoice] || 0,
          };
        })
      );
      return sendJSON(res, 200, { demo: false, variants: results });
    }

    /* ================= 历史记录（需登录） ================= */
    /* GET /api/history?limit&offset */
    if (req.method === 'GET' && url.pathname === '/api/history') {
      if (!user) return sendJSON(res, 401, { error: '请先登录' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return sendJSON(res, 200, db.listHistory(user.id, { limit, offset }));
    }

    /* DELETE /api/history/:id */
    const delMatch = url.pathname.match(/^\/api\/history\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && delMatch) {
      if (!user) return sendJSON(res, 401, { error: '请先登录' });
      const ok = db.deleteHistory(user.id, delMatch[1]);
      return sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: '记录不存在' });
    }

    /* POST /api/history/clear */
    if (req.method === 'POST' && url.pathname === '/api/history/clear') {
      if (!user) return sendJSON(res, 401, { error: '请先登录' });
      const n = db.clearHistory(user.id);
      return sendJSON(res, 200, { ok: true, deleted: n });
    }

    /* ================= 静态文件 ================= */

    if (req.method === 'GET') return serveStatic(url.pathname, res);
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname} →`, msg);
    return sendJSON(res, /上游|超时|JSON|LLM|返回/.test(msg) ? 502 : 500, { error: msg });
  }
});

server.listen(PORT, HOST, () => {
  db.cleanExpiredSessions();
  const cfg = getConfig();
  const mode = [
    cfg.LLM_KEY ? `LLM=已接入(${cfg.LLM_MODEL})` : 'LLM=演示模式',
    cfg.JEV_KEY ? `Jev=已接入(${cfg.JEV_MODEL})` : 'Jev=演示模式',
  ].join('  ');
  const os = require('os');
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`\n🎲 人生选择器已启动`);
  console.log(`   本机   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`   内网   http://${ip}:${PORT}`);
  console.log(`   模式   ${mode}`);
  console.log(`   提示   编辑 .env 立即生效，无需重启服务\n`);
});
