/**
 * SQLite Database Layer
 * Handles all persistent storage for trade engine + Invo poller
 * Replaces config.json, invo_tokens.json, invo_seen.json
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';

const DB_FILE = './trade_engine.db';
let db;

export function initDatabase() {
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');

  // ── Config table ─────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── Invo users table ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS invo_users (
      username  TEXT PRIMARY KEY,
      added_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Invo seen notifications table ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS invo_seen (
      id        TEXT PRIMARY KEY,
      seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invo_seen_at ON invo_seen(seen_at);
  `);

  // ── Invo tokens table ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS invo_tokens (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT,
      refresh_token TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Seed default user if empty ───────────────────────────────────
  const userCount = db.prepare('SELECT COUNT(*) as n FROM invo_users').get();
  if (userCount.n === 0) {
    db.prepare('INSERT OR IGNORE INTO invo_users (username) VALUES (?)').run('crypto_rocket');
    console.log('[DB] Seeded default Invo user: crypto_rocket');
  }

  // ── Migrate from old JSON files ──────────────────────────────────
  migrateFromJson();

  console.log('[DB] Database ready:', DB_FILE);
  return db;
}

function migrateFromJson() {
  // Migrate config.json
  if (existsSync('./config.json')) {
    try {
      const old = JSON.parse(readFileSync('./config.json', 'utf8'));
      for (const [key, value] of Object.entries(old)) {
        setConfig(key, value);
      }
      console.log('[DB] Migrated config.json');
    } catch(e) { console.log('[DB] config.json migration skipped:', e.message); }
  }

  // Migrate invo_tokens.json
  if (existsSync('./invo_tokens.json')) {
    try {
      const old = JSON.parse(readFileSync('./invo_tokens.json', 'utf8'));
      if (old.accessToken) saveTokens(old.accessToken, old.refreshToken);
      if (old.targetUsers) {
        for (const user of old.targetUsers) addInvoUser(user);
      }
      console.log('[DB] Migrated invo_tokens.json');
    } catch(e) { console.log('[DB] invo_tokens.json migration skipped:', e.message); }
  }

  // Migrate invo_seen.json
  if (existsSync('./invo_seen.json')) {
    try {
      const old = JSON.parse(readFileSync('./invo_seen.json', 'utf8'));
      if (Array.isArray(old)) {
        const insert = db.prepare('INSERT OR IGNORE INTO invo_seen (id) VALUES (?)');
        for (const id of old) insert.run(String(id));
        console.log(`[DB] Migrated ${old.length} seen notifications`);
      }
    } catch(e) { console.log('[DB] invo_seen.json migration skipped:', e.message); }
  }
}

// ── Config operations ─────────────────────────────────────────────
export function getConfig(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (!row) return defaultValue;
  try { return JSON.parse(row.value); }
  catch(e) { return row.value; }
}

export function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(key, JSON.stringify(value));
}

export function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const result = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); }
    catch(e) { result[row.key] = row.value; }
  }
  return result;
}

// ── Invo user operations ──────────────────────────────────────────
export function getInvoUsers() {
  return db.prepare('SELECT username FROM invo_users ORDER BY added_at ASC')
    .all().map(r => r.username);
}

export function addInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  db.prepare('INSERT OR IGNORE INTO invo_users (username) VALUES (?)').run(clean);
  console.log(`[DB] Added Invo user: ${clean}`);
  return getInvoUsers();
}

export function removeInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  db.prepare('DELETE FROM invo_users WHERE username = ?').run(clean);
  console.log(`[DB] Removed Invo user: ${clean}`);
  return getInvoUsers();
}

// ── Invo seen notifications ───────────────────────────────────────
export function isNotificationSeen(id) {
  return !!db.prepare('SELECT id FROM invo_seen WHERE id = ?').get(String(id));
}

export function markNotificationSeen(id) {
  db.prepare('INSERT OR IGNORE INTO invo_seen (id) VALUES (?)').run(String(id));
}

export function pruneSeenNotifications(keepDays = 7) {
  const result = db.prepare(
    "DELETE FROM invo_seen WHERE seen_at < datetime('now', ?)"
  ).run(`-${keepDays} days`);
  if (result.changes > 0) {
    console.log(`[DB] Pruned ${result.changes} old seen notifications`);
  }
}

// ── Invo token operations ─────────────────────────────────────────
export function getTokens() {
  // Prefer env secrets over database
  if (process.env.INVO_ACCESS_TOKEN) {
    return {
      accessToken:  process.env.INVO_ACCESS_TOKEN,
      refreshToken: process.env.INVO_REFRESH_TOKEN,
    };
  }
  const row = db.prepare('SELECT * FROM invo_tokens WHERE id = 1').get();
  if (!row) return null;
  return { accessToken: row.access_token, refreshToken: row.refresh_token };
}

export function saveTokens(accessToken, refreshToken) {
  db.prepare(`
    INSERT INTO invo_tokens (id, access_token, refresh_token, updated_at)
    VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      updated_at    = excluded.updated_at
  `).run(accessToken, refreshToken);
}

export { db };
