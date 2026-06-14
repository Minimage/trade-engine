/**
 * Database Layer using MongoDB
 * Persists across deployments
 */

import { MongoClient } from 'mongodb';

const uri = process.env.DATABASE_URL;
let db = null;
let client = null;

// In-memory fallback
const mem = {
  config: {},
  invo_users: [],
  invo_seen: new Set(),
};

export async function initDatabase() {
  if (!uri) {
    console.log('[DB] No DATABASE_URL - using in-memory storage (will not persist)');
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('TradeBot');
    // Create indexes
    await db.collection('invo_seen').createIndex({ id: 1 }, { unique: true });
    await db.collection('invo_seen').createIndex({ seen_at: 1 }, { expireAfterSeconds: 604800 }); // 7 days TTL
    await db.collection('invo_users').createIndex({ username: 1 }, { unique: true });
    await db.collection('config').createIndex({ key: 1 }, { unique: true });
    console.log('[DB] MongoDB connected successfully');
  } catch(e) {
    console.error('[DB] MongoDB connection error:', e.message);
    db = null;
  }
}

// -- Config --
export async function getConfig(key, defaultValue = null) {
  if (!db) return mem.config[key] !== undefined ? mem.config[key] : defaultValue;
  try {
    const doc = await db.collection('config').findOne({ key });
    return doc ? doc.value : defaultValue;
  } catch(e) { return defaultValue; }
}

export async function setConfig(key, value) {
  if (!db) { mem.config[key] = value; return; }
  try {
    await db.collection('config').updateOne(
      { key },
      { $set: { key, value } },
      { upsert: true }
    );
  } catch(e) { console.error('[DB] setConfig error:', e.message); }
}

export async function getAllConfig() {
  if (!db) return { ...mem.config };
  try {
    const docs = await db.collection('config').find({}).toArray();
    const result = {};
    for (const doc of docs) result[doc.key] = doc.value;
    return result;
  } catch(e) { return {}; }
}

// -- Invo users --
export async function getInvoUsers() {
  if (!db) return [...mem.invo_users];
  try {
    const docs = await db.collection('invo_users').find({}).sort({ added_at: 1 }).toArray();
    return docs.map(d => d.username);
  } catch(e) { return []; }
}

export async function addInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  if (!db) {
    if (!mem.invo_users.includes(clean)) mem.invo_users.push(clean);
    return [...mem.invo_users];
  }
  try {
    await db.collection('invo_users').updateOne(
      { username: clean },
      { $setOnInsert: { username: clean, added_at: new Date() } },
      { upsert: true }
    );
    console.log(`[DB] Added Invo user: ${clean}`);
  } catch(e) { console.error('[DB] addInvoUser error:', e.message); }
  return getInvoUsers();
}

export async function removeInvoUser(username) {
  const clean = username.replace('@', '').toLowerCase().trim();
  if (!db) {
    mem.invo_users = mem.invo_users.filter(u => u !== clean);
    return [...mem.invo_users];
  }
  try {
    await db.collection('invo_users').deleteOne({ username: clean });
    console.log(`[DB] Removed Invo user: ${clean}`);
  } catch(e) { console.error('[DB] removeInvoUser error:', e.message); }
  return getInvoUsers();
}

// -- Seen notifications --
export async function isNotificationSeen(id) {
  if (!db) return mem.invo_seen.has(String(id));
  try {
    const doc = await db.collection('invo_seen').findOne({ id: String(id) });
    return !!doc;
  } catch(e) { return false; }
}

export async function markNotificationSeen(id) {
  if (!db) { mem.invo_seen.add(String(id)); return; }
  try {
    await db.collection('invo_seen').updateOne(
      { id: String(id) },
      { $setOnInsert: { id: String(id), seen_at: new Date() } },
      { upsert: true }
    );
  } catch(e) {}
}

export async function pruneSeenNotifications() {
  // MongoDB TTL index handles this automatically
}

// -- Tokens --
export async function getTokens() {
  if (process.env.INVO_ACCESS_TOKEN) {
    return {
      accessToken:  process.env.INVO_ACCESS_TOKEN,
      refreshToken: process.env.INVO_REFRESH_TOKEN,
    };
  }
  if (!db) return null;
  try {
    const doc = await db.collection('invo_tokens').findOne({ _id: 'main' });
    if (!doc) return null;
    return { accessToken: doc.access_token, refreshToken: doc.refresh_token };
  } catch(e) { return null; }
}

export async function saveTokens(accessToken, refreshToken) {
  if (!db) return;
  try {
    await db.collection('invo_tokens').updateOne(
      { _id: 'main' },
      { $set: { access_token: accessToken, refresh_token: refreshToken, updated_at: new Date() } },
      { upsert: true }
    );
  } catch(e) { console.error('[DB] saveTokens error:', e.message); }
}
