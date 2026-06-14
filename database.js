/**
 * Database Layer using PostgreSQL (Replit DB)
 * Persists across deployments
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@helium/heliumdb?sslmode=disable',
});

export async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invo_users (
        username  TEXT PRIMARY KEY,
        added_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS invo_seen (
        id        TEXT PRIMARY KEY,
        seen_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS invo_tokens (
        id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        access_token  TEXT,
        refresh_token TEXT,
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed default if empty
    const { rows } = await pool.query('SELECT COUNT(*) as n FROM invo_users');
    if (parseInt(rows[0].n) === 0) {
      // Empty by default = all users mode
    }

    console.log('[DB] PostgreSQL database ready');
  } catch(e) {
    console.error('[DB] Init error:', e.message);
  }
}

// -- Config --
export async function getConfig(key, defaultValue = null) {
  try {
    const { rows } = await pool.query('SELECT value FROM config WHERE key = $1', [key]);
    if (!rows.length) return defaultValue;
    try { return JSON.parse(rows[0].value); } catch(e) { return rows[0].value; }
  } catch(e) { return defaultValue; }
}

export async function setConfig(key, value) {
  try {
    await pool.query(
      'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    );
  } catch(e) { console.error('[DB] setConfig error:', e.message); }
}

export async function getAllConfig() {
  try {
    const { rows } = await pool.query('SELECT key, value FROM config');
    const result = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); }
      catch(e) { result[row.key] = row.value; }
    }
    return result;
  } catch(e) { return {}; }
}

// -- Invo users --
export async function getInvoUsers() {
  try {
    const { rows } = await pool.query('SELECT username FROM invo_users ORDER BY added_at ASC');
    return rows.map(r => r.username);
  } catch(e) { return []; }
}

export async function addInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  try {
    await pool.query('INSERT INTO invo_users (username) VALUES ($1) ON CONFLICT DO NOTHING', [clean]);
    console.log(`[DB] Added Invo user: ${clean}`);
  } catch(e) { console.error('[DB] addInvoUser error:', e.message); }
  return getInvoUsers();
}

export async function removeInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  try {
    await pool.query('DELETE FROM invo_users WHERE username = $1', [clean]);
    console.log(`[DB] Removed Invo user: ${clean}`);
  } catch(e) { console.error('[DB] removeInvoUser error:', e.message); }
  return getInvoUsers();
}

// -- Seen notifications --
export async function isNotificationSeen(id) {
  try {
    const { rows } = await pool.query('SELECT id FROM invo_seen WHERE id = $1', [String(id)]);
    return rows.length > 0;
  } catch(e) { return false; }
}

export async function markNotificationSeen(id) {
  try {
    await pool.query('INSERT INTO invo_seen (id) VALUES ($1) ON CONFLICT DO NOTHING', [String(id)]);
  } catch(e) {}
}

export async function pruneSeenNotifications(keepDays = 7) {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM invo_seen WHERE seen_at < NOW() - INTERVAL '$1 days'",
      [keepDays]
    );
    if (rowCount > 0) console.log(`[DB] Pruned ${rowCount} old seen notifications`);
  } catch(e) {}
}

// -- Tokens --
export async function getTokens() {
  if (process.env.INVO_ACCESS_TOKEN) {
    return {
      accessToken:  process.env.INVO_ACCESS_TOKEN,
      refreshToken: process.env.INVO_REFRESH_TOKEN,
    };
  }
  try {
    const { rows } = await pool.query('SELECT * FROM invo_tokens WHERE id = 1');
    if (!rows.length) return null;
    return { accessToken: rows[0].access_token, refreshToken: rows[0].refresh_token };
  } catch(e) { return null; }
}

export async function saveTokens(accessToken, refreshToken) {
  try {
    await pool.query(`
      INSERT INTO invo_tokens (id, access_token, refresh_token, updated_at)
      VALUES (1, $1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET
        access_token = $1, refresh_token = $2, updated_at = NOW()
    `, [accessToken, refreshToken]);
  } catch(e) { console.error('[DB] saveTokens error:', e.message); }
}
