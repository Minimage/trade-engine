/**
 * Invo Copy Trading Poller
 * Polls Invo API directly — no Selenium, no iframes
 * Runs inside the trade engine server
 *
 * Setup:
 *   1. Set INVO_ACCESS_TOKEN and INVO_REFRESH_TOKEN in Replit Secrets
 *   2. import { startInvoPoller } from './invo_poller.js' in server.js
 *   3. Call startInvoPoller() after server starts
 *
 * One-time auth (run auth_invo.js once to get your tokens):
 *   node auth_invo.js
 */

import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────
const API_BASE      = 'https://api.involio.com/v1_0';
const POLL_INTERVAL = 60 * 1000; // 60 seconds
const TOKEN_FILE    = './invo_tokens.json';
const SEEN_FILE     = './invo_seen.json';

// Users to follow — loaded from tokens file, editable at runtime
const DEFAULT_USERS = ['crypto_rocket'];

// Map Invo tickers to Alpaca format
function mapTicker(ticker) {
  const cryptoTickers = new Set([
    'BTC','ETH','SOL','XRP','DOGE','AVAX','LINK','LTC',
    'HMSTR','MANTA','ATOM','UNI','AAVE','DOT','MATIC',
    'ADA','TRX','NEAR','FTM','OP','ARB','APT','SUI'
  ]);
  if (cryptoTickers.has(ticker.toUpperCase())) {
    return `${ticker.toUpperCase()}-USD`;
  }
  return ticker.toUpperCase(); // stocks stay as-is
}

// ── Token management ──────────────────────────────────────────────
function loadTokens() {
  // First check Replit secrets (production)
  if (process.env.INVO_ACCESS_TOKEN) {
    return {
      accessToken:  process.env.INVO_ACCESS_TOKEN,
      refreshToken: process.env.INVO_REFRESH_TOKEN,
      targetUsers:  DEFAULT_USERS,
    };
  }
  // Fall back to local file (development)
  if (existsSync(TOKEN_FILE)) {
    try {
      return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    } catch(e) {
      console.error('[INVO] Failed to load tokens:', e.message);
    }
  }
  return null;
}

function saveTokens(tokens) {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch(e) {
    console.error('[INVO] Failed to save tokens:', e.message);
  }
}

// ── Seen notifications persistence ───────────────────────────────
function loadSeen() {
  if (existsSync(SEEN_FILE)) {
    try {
      return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8')));
    } catch(e) {}
  }
  return new Set();
}

function saveSeen(seen) {
  try {
    // Only keep last 1000 to prevent bloat
    const arr = [...seen].slice(-1000);
    writeFileSync(SEEN_FILE, JSON.stringify(arr));
  } catch(e) {}
}

// ── API helpers ───────────────────────────────────────────────────
async function invoPost(endpoint, body, accessToken) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function refreshAccessToken(refreshToken) {
  try {
    console.log('[INVO] Refreshing access token...');
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (data.accessToken) {
      console.log('[INVO] Token refreshed successfully');
      return data.accessToken;
    }
  } catch(e) {
    console.error('[INVO] Token refresh failed:', e.message);
  }
  return null;
}

// ── Notification fetching ─────────────────────────────────────────
async function getNotifications(accessToken, page = 1) {
  const { status, data } = await invoPost(
    '/notifications/get_notifications',
    { page, size: 50 },
    accessToken
  );
  if (status === 401) return { expired: true };
  return { items: data.items || [], expired: false };
}

async function getPostDetails(postId, accessToken) {
  const { status, data } = await invoPost(
    '/posts/get_post_by_id',
    { postId },
    accessToken
  );
  if (status === 401) return { expired: true };
  return { trade: data?.post?.update || null, expired: false };
}

// ── Mirror trade to bot ───────────────────────────────────────────
async function mirrorTrade(action, ticker) {
  const alpacaTicker = mapTicker(ticker);
  try {
    const res = await fetch('http://localhost:3002/api/mirror-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ticker: alpacaTicker, source: 'invo' }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`[INVO] ✅ ${action.toUpperCase()} ${alpacaTicker} sent to bot`);
    } else {
      console.log(`[INVO] ❌ ${action.toUpperCase()} ${alpacaTicker} failed: ${data.error}`);
    }
  } catch(e) {
    console.error(`[INVO] Mirror error: ${e.message}`);
  }
}

// ── Main poller ───────────────────────────────────────────────────
export async function startInvoPoller() {
  console.log('[INVO] Starting Invo copy trading poller...');

  let tokens = loadTokens();
  if (!tokens?.accessToken) {
    console.log('[INVO] ⚠️  No tokens found — run auth_invo.js first to authenticate');
    console.log('[INVO] Poller will not start until tokens are configured');
    return;
  }

  const seen    = loadSeen();
  let isFirstRun = true;

  console.log(`[INVO] Following: ${tokens.targetUsers?.join(', ') || DEFAULT_USERS.join(', ')}`);
  console.log(`[INVO] Polling every ${POLL_INTERVAL / 1000}s`);

  const poll = async () => {
    try {
      let { items, expired } = await getNotifications(tokens.accessToken);

      // Handle token expiry
      if (expired) {
        const newToken = await refreshAccessToken(tokens.refreshToken);
        if (newToken) {
          tokens.accessToken = newToken;
          saveTokens(tokens);
          const result = await getNotifications(tokens.accessToken);
          items = result.items;
        } else {
          console.error('[INVO] ❌ Could not refresh token — re-run auth_invo.js');
          return;
        }
      }

      if (!items?.length) {
        console.log('[INVO] No notifications returned');
        return;
      }

      // On first run, mark all existing as seen without acting on them
      if (isFirstRun) {
        for (const item of items) {
          if (item.id) seen.add(item.id);
        }
        saveSeen(seen);
        isFirstRun = false;
        console.log(`[INVO] Marked ${items.length} existing notifications as seen`);
        return;
      }

      const targetUsers = tokens.targetUsers || DEFAULT_USERS;

      for (const item of items) {
        // Skip already seen
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);

        const type     = item.type || '';
        const username = item.username || item.user?.username || '';

        // Only process target users
        const isTracked = targetUsers.some(u =>
          username.toLowerCase().includes(u.toLowerCase())
        );
        if (!isTracked) continue;

        console.log(`[INVO] 🔔 New: ${type} from ${username}`);

        // Only act on buy/sell notifications
        if (type !== 'user_added_investment' && type !== 'user_sold_investment') {
          continue;
        }

        // Must fetch post to get ticker — content field is always null
        const postId = item.postId || item.post_id || item.id;
        if (!postId) {
          console.log('[INVO] No postId found — skipping');
          continue;
        }

        const { trade, expired: postExpired } = await getPostDetails(postId, tokens.accessToken);

        if (postExpired) {
          console.log('[INVO] Token expired fetching post — skipping');
          continue;
        }

        if (!trade) {
          console.log(`[INVO] No trade data in post ${postId} — skipping`);
          continue;
        }

        const ticker      = trade.ticker;
        const isLong      = trade.directionLong === true;
        const isOpen      = trade.isOpen === true;

        console.log(`[INVO] Trade: ${ticker} | long=${isLong} | open=${isOpen} | type=${type}`);

        // BUY — new long trade opened
        if (type === 'user_added_investment' && isLong) {
          await mirrorTrade('buy', ticker);
        }

        // SELL — trade closed (regardless of direction since we only bought longs)
        else if (type === 'user_sold_investment') {
          await mirrorTrade('sell', ticker);
        }

        // Skip shorts
        else if (type === 'user_added_investment' && !isLong) {
          console.log(`[INVO] ⏭️  Skipping SHORT on ${ticker}`);
        }
      }

      saveSeen(seen);

    } catch(e) {
      console.error('[INVO] Poll error:', e.message);
    }
  };

  // Run immediately then on interval
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

// ── Target user management (callable from server.js API) ──────────
export function getInvoUsers() {
  const tokens = loadTokens();
  return tokens?.targetUsers || DEFAULT_USERS;
}

export function addInvoUser(username) {
  const tokens = loadTokens();
  if (!tokens) return false;
  const clean = username.replace('@', '').toLowerCase();
  if (!tokens.targetUsers) tokens.targetUsers = [...DEFAULT_USERS];
  if (!tokens.targetUsers.includes(clean)) {
    tokens.targetUsers.push(clean);
    saveTokens(tokens);
  }
  return true;
}

export function removeInvoUser(username) {
  const tokens = loadTokens();
  if (!tokens) return false;
  const clean = username.replace('@', '').toLowerCase();
  tokens.targetUsers = (tokens.targetUsers || DEFAULT_USERS).filter(u => u !== clean);
  saveTokens(tokens);
  return true;
}
