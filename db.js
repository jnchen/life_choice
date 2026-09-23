'use strict';
/**
 * 数据层：用户 / 会话 / 历史记录（node:sqlite，Node 22+ 内置，零依赖）
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS history (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario  TEXT NOT NULL,
  options   TEXT NOT NULL,  -- JSON: [{id,title,description,risk}]
  result    TEXT NOT NULL,  -- JSON: {choice,probabilities,confidence,gutFeeling,importance,model,demo}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, created_at DESC);
`);

/* ---------------- 密码（scrypt） ---------------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- 用户 ---------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createUser({ email, username, password }) {
  email = String(email || '').trim().toLowerCase();
  username = String(username || '').trim().slice(0, 24);
  if (!EMAIL_RE.test(email)) throw new Error('邮箱格式不正确');
  if (!username) throw new Error('请填写昵称');
  if (String(password).length < 6) throw new Error('密码至少 6 位');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new Error('该邮箱已注册，请直接登录');

  const { salt, hash } = hashPassword(password);
  const user = { id: crypto.randomUUID(), email, username, password_hash: hash, salt, created_at: Date.now() };
  db.prepare('INSERT INTO users (id, email, username, password_hash, salt, created_at) VALUES (?,?,?,?,?,?)')
    .run(user.id, user.email, user.username, user.password_hash, user.salt, user.created_at);
  return { id: user.id, email: user.email, username: user.username };
}

function verifyUser(email, password) {
  email = String(email || '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) throw new Error('邮箱或密码不正确');
  if (!verifyPassword(String(password), row.salt, row.password_hash)) throw new Error('邮箱或密码不正确');
  return { id: row.id, email: row.email, username: row.username };
}

/** 修改密码：先验原密码，通过后换新盐重哈希 */
function changePassword(userId, oldPassword, newPassword) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new Error('用户不存在');
  if (!verifyPassword(String(oldPassword), row.salt, row.password_hash)) throw new Error('原密码不正确');
  if (String(newPassword).length < 6) throw new Error('新密码至少 6 位');
  if (String(newPassword) === String(oldPassword)) throw new Error('新密码不能和原密码一样');
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
}

/* ---------------- 会话 ---------------- */

const SESSION_TTL = 1000 * 60 * 60 * 24 * 14; // 14 天

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, now + SESSION_TTL);
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.username, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, email: row.email, username: row.username };
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 改密码后调用：踢掉该用户在其他设备上的所有会话，仅保留当前 */
function deleteOtherSessions(userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken || '');
}

function cleanExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/* ---------------- 历史记录 ---------------- */

function addHistory(userId, { scenario, options, result }) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO history (id, user_id, scenario, options, result, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, scenario, JSON.stringify(options), JSON.stringify(result), Date.now());
  return id;
}

function listHistory(userId, { limit = 20, offset = 0 } = {}) {
  const rows = db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset);
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM history WHERE user_id = ?').get(userId);
  return { total: c, items: rows.map(deserializeHistory) };
}

function getHistory(userId, id) {
  const row = db.prepare('SELECT * FROM history WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? deserializeHistory(row) : null;
}

function deleteHistory(userId, id) {
  return db.prepare('DELETE FROM history WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function clearHistory(userId) {
  return db.prepare('DELETE FROM history WHERE user_id = ?').run(userId).changes;
}

function deserializeHistory(row) {
  return {
    id: row.id,
    scenario: row.scenario,
    options: safeParse(row.options, []),
    result: safeParse(row.result, {}),
    createdAt: row.created_at,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = {
  createUser, verifyUser, changePassword,
  createSession, getUserByToken, deleteSession, deleteOtherSessions, cleanExpiredSessions,
  addHistory, listHistory, getHistory, deleteHistory, clearHistory,
};
