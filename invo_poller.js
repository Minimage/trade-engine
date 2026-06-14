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
import {
  getInvoUsers, addInvoUser as dbAddUser, removeInvoUser as dbRemoveUser,
  getTokens, saveTokens as dbSaveTokens,
  isNotificationSeen, markNotificationSeen, pruneSeenNotifications
} from './database.js';

// ── Config ────────────────────────────────────────────────────────
const API_BASE      = 'https://api.involio.com/v1_0';
const POLL_INTERVAL = 60 * 1000; // 60 seconds

// Users to follow — loaded from tokens file, editable at runtime
const DEFAULT_USERS = ['crypto_rocket'];

// Map Invo tickers to Alpaca format
function mapTicker(ticker) {
  // Known stock exchanges — anything else is treated as crypto
  const knownStocks = new Set([
    'AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','JPM',
    'BAC','WFC','AMD','INTC','MU','NFLX','DIS','V','MA',
    'PYPL','UBER','LYFT','SNAP','TWTR','SPY','QQQ','GLD'
  ]);

  // Explicit overrides from TICKER_MAP
  if (TICKER_MAP[ticker.toUpperCase()]) {
    return TICKER_MAP[ticker.toUpperCase()];
  }

  // If it's a known stock, return as-is
  if (knownStocks.has(ticker.toUpperCase())) {
    return ticker.toUpperCase();
  }

  // Everything else from Invo is crypto — add -USD suffix
  // This covers XMR, TAO, CRV, ZEC, CC, and any new tokens
  return `${ticker.toUpperCase()}-USD`;
}

// ── Token/seen management now handled by database.js ─────────────

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
      dbSaveTokens(data.accessToken, data.refreshToken || refreshToken);
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
    { page, size: 20 },
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
  const port = process.env.PORT || 3002;

  try {
    // For sells, check if we actually have a position first
    if (action === 'sell') {
      const posRes = await fetch(`http://localhost:${port}/api/positions`).catch(() => null);
      if (posRes?.ok) {
        const positions = await posRes.json();
        const hasPosition = Object.keys(positions).some(k =>
          k.toLowerCase() === alpacaTicker.toLowerCase() ||
          k.toLowerCase() === ticker.toLowerCase()
        );
        if (!hasPosition) {
          console.log(`[INVO] No position in ${alpacaTicker} — skipping sell`);
          return;
        }
      }
    }

    const res = await fetch(`http://localhost:${port}/api/mirror-trade`, {
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
export async function startInvoPoller(invoState) {
  console.log('[INVO] Starting Invo copy trading poller...');

  let tokens = await getTokens();
  console.log('[INVO] Token check — INVO_ACCESS_TOKEN env:', process.env.INVO_ACCESS_TOKEN ? 'SET' : 'NOT SET');
  console.log('[INVO] Token check — tokens from db:', tokens ? 'FOUND' : 'NOT FOUND');
  if (!tokens?.accessToken) {
    console.log('[INVO] ⚠️  No tokens found — run auth_invo.js first to authenticate');
    console.log('[INVO] Poller will not start until tokens are configured');
    if (invoState) invoState.running = false;
    return;
  }

  let isFirstRun = true;
  const users = await getInvoUsers();
  console.log(`[INVO] Following: ${users.join(', ')}`);
  console.log(`[INVO] Polling every ${POLL_INTERVAL / 1000}s`);

  const poll = async () => {
    // Check if stopped
    if (invoState && !invoState.running) {
      console.log('[INVO] Poller stopped');
      return;
    }
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
        console.log('[INVO] No notifications returned from API');
        return;
      }
      console.log(`[INVO] Got ${items.length} notifications from API`);

      // On startup: mark everything currently visible as seen, trade nothing
      // From next poll onwards: only NEW items get traded
      if (isFirstRun) {
        isFirstRun = false;
        let markedCount = 0;
        for (const item of items) {
          if (item.id) {
            const alreadySeen = await isNotificationSeen(item.id);
            if (!alreadySeen) {
              await markNotificationSeen(item.id);
              markedCount++;
            }
          }
        }
        console.log(`[INVO] Startup complete: marked ${markedCount} existing notifications as seen`);
        console.log(`[INVO] Now watching for NEW trades only...`);
        return;
      }

      const targetUsers = await getInvoUsers();

      let newCount = 0;
      let skippedCount = 0;
      for (const item of items) {
        // Skip already seen
        const alreadySeen = await isNotificationSeen(item.id);
        if (!item.id || alreadySeen) { skippedCount++; continue; }
        await markNotificationSeen(item.id);
        newCount++;

        // notificationType is the action field
        const type = item.notificationType || item.type || '';

        // Username is embedded in the content string e.g. "vortex_legion added a new investment"
        const contentStr = item.content || '';
        const usernameFromContent = contentStr.split(' ')[0] || '';

        console.log(`[INVO] Notification: type="${type}" content="${contentStr}" postId="${item.postId}"`);

        const username = usernameFromContent;

        // Empty list = ALL USERS mode (default)
        // Non-empty list = only trade listed users
        const allUsersMode = targetUsers.length === 0;
        const isTracked = allUsersMode || targetUsers.some(u => {
          const uLower = u.toLowerCase().replace('@', '');
          return username.toLowerCase() === uLower
            || contentStr.toLowerCase().includes(uLower);
        });

        if (!isTracked) {
          console.log(`[INVO] Not in whitelist - skipping (${username})`);
          continue;
        }

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

      pruneSeenNotifications();
      console.log(`[INVO] Poll complete: ${newCount} new, ${skippedCount} already seen`);

    } catch(e) {
      console.error('[INVO] Poll error:', e.message);
    }

    console.log(`[INVO] ⏱ Next poll in ${POLL_INTERVAL/1000}s — watching ${(await getInvoUsers()).join(', ')}`);
  };

  // Run immediately then on interval
  await poll();
  const id = setInterval(async () => {
    if (invoState && !invoState.running) {
      clearInterval(id);
      console.log('[INVO] Poller stopped');
      return;
    }
    await poll();
  }, POLL_INTERVAL);
  if (invoState) invoState.intervalId = id;
}

// ── Target user management (callable from server.js API) ──────────
// Re-export database functions for server.js compatibility
export { getInvoUsers, dbAddUser as addInvoUser, dbRemoveUser as removeInvoUser };
