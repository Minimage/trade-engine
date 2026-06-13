/**
 * Database Layer using Replit DB
 * Persists across deployments — no file system needed
 * Falls back to in-memory if Replit DB not available
 */

import fetch from 'node-fetch';

const REPLIT_DB_URL = process.env.REPLIT_DB_URL;

// Simple Replit DB client
async function dbGet(key) {
  if (!REPLIT_DB_URL) return null;
  try {
    const r = await fetch(`${REPLIT_DB_URL}/${encodeURIComponent(key)}`);
    if (r.status === 404) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch(e) { return text; }
  } catch(e) { return null; }
}

async function dbSet(key, value) {
  if (!REPLIT_DB_URL) return;
  try {
    await fetch(REPLIT_DB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(value))}`,
    });
  } catch(e) { console.error('[DB] Set error:', e.message); }
}

async function dbDelete(key) {
  if (!REPLIT_DB_URL) return;
  try {
    await fetch(`${REPLIT_DB_URL}/${encodeURIComponent(key)}`, { method: 'DELETE' });
  } catch(e) {}
}

async function dbList(prefix) {
  if (!REPLIT_DB_URL) return [];
  try {
    const r = await fetch(`${REPLIT_DB_URL}?prefix=${encodeURIComponent(prefix)}`);
    const text = await r.text();
    return text ? text.split('\n').filter(Boolean) : [];
  } catch(e) { return []; }
}

// In-memory fallback
const memStore = {
  config: {},
  invo_users: ['crypto_rocket'],
  invo_seen: new Set(),
};

export function initDatabase() {
  if (REPLIT_DB_URL) {
    console.log('[DB] Using Replit DB for persistent storage');
  } else {
    console.log('[DB] REPLIT_DB_URL not found - using in-memory storage (data will not persist)');
  }
}

// -- Config operations --
export async function getConfig(key, defaultValue = null) {
  if (REPLIT_DB_URL) {
    const val = await dbGet(`config:${key}`);
    return val !== null ? val : defaultValue;
  }
  return memStore.config[key] !== undefined ? memStore.config[key] : defaultValue;
}

export async function setConfig(key, value) {
  if (REPLIT_DB_URL) {
    await dbSet(`config:${key}`, value);
  } else {
    memStore.config[key] = value;
  }
}

export async function getAllConfig() {
  if (REPLIT_DB_URL) {
    const keys = await dbList('config:');
    const result = {};
    for (const key of keys) {
      const shortKey = key.replace('config:', '');
      result[shortKey] = await dbGet(key);
    }
    return result;
  }
  return { ...memStore.config };
}

// -- Invo user operations --
export async function getInvoUsers() {
  if (REPLIT_DB_URL) {
    const users = await dbGet('invo:users');
    return Array.isArray(users) ? users : [];  // empty = all users mode
  }
  return [...memStore.invo_users];
}

export async function addInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  const users = await getInvoUsers();
  if (!users.includes(clean)) {
    users.push(clean);
    if (REPLIT_DB_URL) {
      await dbSet('invo:users', users);
    } else {
      memStore.invo_users = users;
    }
    console.log(`[DB] Added Invo user: ${clean}`);
  }
  return users;
}

export async function removeInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  const users = (await getInvoUsers()).filter(u => u !== clean);
  if (REPLIT_DB_URL) {
    await dbSet('invo:users', users);
  } else {
    memStore.invo_users = users;
  }
  console.log(`[DB] Removed Invo user: ${clean}`);
  return users;
}

// -- Invo seen notifications --
export async function isNotificationSeen(id) {
  if (REPLIT_DB_URL) {
    const val = await dbGet(`invo:seen:${id}`);
    return val !== null;
  }
  return memStore.invo_seen.has(id);
}

export async function markNotificationSeen(id) {
  if (REPLIT_DB_URL) {
    await dbSet(`invo:seen:${id}`, 1);
  } else {
    memStore.invo_seen.add(id);
  }
}

export async function pruneSeenNotifications() {
  // Replit DB handles this naturally - old keys just expire
  // For in-memory, trim to last 500
  if (!REPLIT_DB_URL && memStore.invo_seen.size > 500) {
    const arr = [...memStore.invo_seen].slice(-500);
    memStore.invo_seen = new Set(arr);
  }
}

// -- Invo token operations --
export async function getTokens() {
  // Always prefer env secrets
  if (process.env.INVO_ACCESS_TOKEN) {
    return {
      accessToken:  process.env.INVO_ACCESS_TOKEN,
      refreshToken: process.env.INVO_REFRESH_TOKEN,
    };
  }
  if (REPLIT_DB_URL) {
    return await dbGet('invo:tokens');
  }
  return null;
}

export async function saveTokens(accessToken, refreshToken) {
  if (REPLIT_DB_URL) {
    await dbSet('invo:tokens', { accessToken, refreshToken });
  }
}
