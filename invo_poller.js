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

import fetch from "node-fetch";
import {
  getInvoUsers,
  addInvoUser as dbAddUser,
  removeInvoUser as dbRemoveUser,
  getTokens,
  saveTokens as dbSaveTokens,
  isNotificationSeen,
  markNotificationSeen,
  pruneSeenNotifications,
  recordOpenTrade,
  getOpenTrade,
  getOpenTradesByTicker,
  getAllOpenTrades,
  closeTrade,
} from "./database.js";
import { hlGetPrice, hlGetAccountState } from "./hyperliquid.js";

// ── Config ────────────────────────────────────────────────────────
const API_BASE = "https://api.involio.com/v1_0";
const POLL_INTERVAL = 60 * 1000; // 60 seconds

// Users to follow — loaded from tokens file, editable at runtime
const DEFAULT_USERS = ["crypto_rocket"];

// Map Invo tickers to Alpaca format
const TICKER_MAP = {
  HMSTR: "HMSTR-USD",
  MANTA: "MANTA-USD",
};

function mapTicker(ticker) {
  // Known stock exchanges — anything else is treated as crypto
  const knownStocks = new Set([
    "AAPL",
    "MSFT",
    "NVDA",
    "TSLA",
    "AMZN",
    "GOOGL",
    "META",
    "JPM",
    "BAC",
    "WFC",
    "AMD",
    "INTC",
    "MU",
    "NFLX",
    "DIS",
    "V",
    "MA",
    "PYPL",
    "UBER",
    "LYFT",
    "SNAP",
    "TWTR",
    "SPY",
    "QQQ",
    "GLD",
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
  return `${ticker.toUpperCase()}-USD`;
}

// ── Token/seen management now handled by database.js ─────────────

// ── API helpers ───────────────────────────────────────────────────
async function invoPost(endpoint, body, accessToken) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function refreshAccessToken(refreshToken) {
  try {
    console.log("[INVO] Refreshing access token...");
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (data.accessToken) {
      console.log("[INVO] Token refreshed successfully");
      dbSaveTokens(data.accessToken, data.refreshToken || refreshToken);
      return data.accessToken;
    }
  } catch (e) {
    console.error("[INVO] Token refresh failed:", e.message);
  }
  return null;
}

// ── Notification fetching ─────────────────────────────────────────
async function getNotifications(accessToken, page = 1) {
  const { status, data } = await invoPost(
    "/notifications/get_notifications",
    { page, size: 20 },
    accessToken,
  );
  if (status === 401) return { expired: true };
  return { items: data.items || [], expired: false };
}

async function getPostDetails(postId, accessToken) {
  const { status, data } = await invoPost(
    "/posts/get_post_by_id",
    { postId },
    accessToken,
  );
  if (status === 401) return { expired: true };
  return { trade: data?.post?.update || null, expired: false };
}

// ── Mirror trade to bot ───────────────────────────────────────────
// username is passed so we can record who opened the trade
async function mirrorTrade(action, ticker, username) {
  const normalizedTicker = mapTicker(ticker);
  const port = process.env.PORT || 3002;

  try {
    if (action === "sell") {
      // Look up THIS user's open trade on this ticker specifically
      // Multiple users can have stacked positions — only close the one that matches
      const openTrade = await getOpenTrade(normalizedTicker, username);

      if (!openTrade) {
        console.log(
          `[INVO] No open trade record for ${normalizedTicker} by ${username} — skipping close`,
        );
        return;
      }

      console.log(
        `[INVO] Closing ${normalizedTicker} (opened by ${username} @ $${openTrade.entryPrice} on ${openTrade.side.toUpperCase()} account)`,
      );
    }

    const side =
      action === "short" ? "short" : action === "buy" ? "long" : null;

    // No conflict check needed — longs go to LONG account, shorts go to SHORT account.
    // They can never cancel each other out. Multiple users can stack on the same ticker.
    // The only guard is username matching on close (handled above).
    // For sells, openTrade is already looked up above — reuse it for routing.
    const tradeSide = action === "sell" ? openTrade?.side || null : null;

    const res = await fetch(`http://localhost:${port}/api/mirror-trade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        ticker: normalizedTicker,
        source: "invo",
        ...(tradeSide && { side: tradeSide }),
        ...(username && { openedBy: username }),
      }),
    });
    const data = await res.json();

    if (res.ok) {
      console.log(
        `[INVO] ✅ ${action.toUpperCase()} ${normalizedTicker} sent to bot`,
      );

      // On successful open: fetch live price from HL and record in DB
      if (action === "buy" || action === "short") {
        const entryPrice = await hlGetPrice(normalizedTicker).catch(() => null);
        if (!entryPrice) {
          console.warn(
            `[INVO] Could not fetch entry price for ${normalizedTicker} — recording without price`,
          );
        }
        await recordOpenTrade(normalizedTicker, username, side, entryPrice);
      }

      // On successful close: fetch live price, calculate PnL, archive to closed_trades
      if (action === "sell") {
        const exitPrice = await hlGetPrice(normalizedTicker).catch(() => null);
        if (!exitPrice) {
          console.warn(
            `[INVO] Could not fetch exit price for ${normalizedTicker} — closing without PnL`,
          );
        }
        const closed = await closeTrade(
          normalizedTicker,
          exitPrice,
          openTrade.openedBy,
        );
        if (closed) {
          const pnlStr =
            closed.pnlPct !== null
              ? `${closed.pnlPct >= 0 ? "+" : ""}${closed.pnlPct.toFixed(2)}% (${closed.pnlDirection})`
              : "PnL unknown";
          console.log(
            `[INVO] 📊 ${normalizedTicker} closed — entry $${closed.entryPrice} → exit $${exitPrice} | ${pnlStr}`,
          );
        }
      }
    } else {
      console.log(
        `[INVO] ❌ ${action.toUpperCase()} ${normalizedTicker} failed: ${data.error}`,
      );
    }
  } catch (e) {
    console.error(`[INVO] Mirror error: ${e.message}`);
  }
}

// ── Main poller ───────────────────────────────────────────────────
export async function startInvoPoller(invoState) {
  console.log("[INVO] Starting Invo copy trading poller...");

  let tokens = await getTokens();
  console.log(
    "[INVO] Token check — INVO_ACCESS_TOKEN env:",
    process.env.INVO_ACCESS_TOKEN ? "SET" : "NOT SET",
  );
  console.log(
    "[INVO] Token check — tokens from db:",
    tokens ? "FOUND" : "NOT FOUND",
  );
  if (!tokens?.accessToken) {
    console.log(
      "[INVO] ⚠️  No tokens found — run auth_invo.js first to authenticate",
    );
    console.log("[INVO] Poller will not start until tokens are configured");
    if (invoState) invoState.running = false;
    return;
  }

  let isFirstRun = true;
  const users = await getInvoUsers();
  console.log(`[INVO] Following: ${users.join(", ")}`);
  console.log(`[INVO] Polling every ${POLL_INTERVAL / 1000}s`);

  // On startup, log any open trades we're still tracking from the DB
  const existingTrades = await getAllOpenTrades();
  if (existingTrades.length > 0) {
    console.log(
      `[INVO] Resuming with ${existingTrades.length} open trade(s) from DB:`,
    );
    for (const t of existingTrades) {
      console.log(
        `[INVO]   ${t.ticker} — opened by ${t.openedBy} (${t.side}) @ $${t.entryPrice} at ${t.openedAt}`,
      );
    }
  } else {
    console.log("[INVO] No open trades in DB — fresh start");
  }

  const poll = async () => {
    // Check if stopped
    if (invoState && !invoState.running) {
      console.log("[INVO] Poller stopped");
      return;
    }
    try {
      let { items, expired } = await getNotifications(tokens.accessToken);

      // Handle token expiry
      if (expired) {
        const newToken = await refreshAccessToken(tokens.refreshToken);
        if (newToken) {
          tokens.accessToken = newToken;
          dbSaveTokens(newToken, tokens.refreshToken);
          const result = await getNotifications(tokens.accessToken);
          items = result.items;
        } else {
          console.error(
            "[INVO] ❌ Could not refresh token — re-run auth_invo.js",
          );
          return;
        }
      }

      if (!items?.length) {
        console.log("[INVO] No notifications returned from API");
        return;
      }
      console.log(`[INVO] Got ${items.length} notifications from API`);

      // On startup: mark everything currently visible as seen
      // Exception: if we have an open DB record for a ticker and a close notification
      // is in this batch, still process it so we don't miss a close that happened
      // during a restart window
      if (isFirstRun) {
        isFirstRun = false;
        let markedCount = 0;
        let closedCount = 0;

        for (const item of items) {
          if (!item.id) continue;
          const alreadySeen = await isNotificationSeen(item.id);
          if (!alreadySeen) {
            await markNotificationSeen(item.id);
            markedCount++;
          }

          // Check if this is a close for a ticker we have an open record for
          const type = item.notificationType || item.type || "";
          if (
            type === "user_sold_investment" ||
            type === "user_closed_investment"
          ) {
            const postId = item.postId || item.post_id || item.id;
            if (!postId) continue;

            const { trade } = await getPostDetails(postId, tokens.accessToken);
            if (!trade?.ticker) continue;

            const normalizedTicker = mapTicker(trade.ticker);
            const openTrade = await getOpenTrade(normalizedTicker);

            if (openTrade) {
              const contentStr = item.content || "";
              const username = contentStr.split(" ")[0] || "";
              if (openTrade.openedBy === username) {
                console.log(
                  `[INVO] Startup: detected pending close for ${normalizedTicker} (opened by ${username}) — executing`,
                );
                await mirrorTrade("sell", trade.ticker, username);
                closedCount++;
              }
            }
          }
        }

        console.log(
          `[INVO] Startup complete: marked ${markedCount} notifications as seen, closed ${closedCount} pending position(s)`,
        );
        console.log(`[INVO] Now watching for NEW trades only...`);
        return;
      }

      const targetUsers = await getInvoUsers();

      let newCount = 0;
      let skippedCount = 0;
      for (const item of items) {
        // Skip already seen
        const alreadySeen = await isNotificationSeen(item.id);
        if (!item.id || alreadySeen) {
          skippedCount++;
          continue;
        }
        await markNotificationSeen(item.id);
        newCount++;

        // notificationType is the action field
        const type = item.notificationType || item.type || "";

        // Username is embedded in the content string e.g. "vortex_legion added a new investment"
        const contentStr = item.content || "";
        const username = contentStr.split(" ")[0] || "";

        console.log(
          `[INVO] Notification: type="${type}" content="${contentStr}" postId="${item.postId}"`,
        );

        // Empty list = ALL USERS mode (default)
        // Non-empty list = only trade listed users
        const allUsersMode = targetUsers.length === 0;
        const isTracked =
          allUsersMode ||
          targetUsers.some((u) => {
            const uLower = u.toLowerCase().replace("@", "");
            return (
              username.toLowerCase() === uLower ||
              contentStr.toLowerCase().includes(uLower)
            );
          });

        if (!isTracked) {
          console.log(`[INVO] Not in whitelist - skipping (${username})`);
          continue;
        }

        console.log(`[INVO] 🔔 New: ${type} from ${username}`);

        // Only act on buy/sell notifications
        if (
          type !== "user_added_investment" &&
          type !== "user_sold_investment" &&
          type !== "user_closed_investment"
        ) {
          continue;
        }

        // Must fetch post to get ticker — content field is always null
        const postId = item.postId || item.post_id || item.id;
        if (!postId) {
          console.log("[INVO] No postId found — skipping");
          continue;
        }

        const { trade, expired: postExpired } = await getPostDetails(
          postId,
          tokens.accessToken,
        );

        if (postExpired) {
          console.log("[INVO] Token expired fetching post — skipping");
          continue;
        }

        if (!trade) {
          console.log(`[INVO] No trade data in post ${postId} — skipping`);
          continue;
        }

        const ticker = trade.ticker;
        const isLong = trade.directionLong === true;
        const isOpen = trade.isOpen === true;

        console.log(
          `[INVO] Trade: ${ticker} | long=${isLong} | open=${isOpen} | type=${type}`,
        );

        // BUY long or SHORT
        if (type === "user_added_investment") {
          if (isLong) {
            console.log(`[INVO] LONG on ${ticker}`);
            await mirrorTrade("buy", ticker, username);
          } else {
            console.log(`[INVO] SHORT on ${ticker}`);
            await mirrorTrade("short", ticker, username);
          }
        }

        // Close position
        else if (
          type === "user_sold_investment" ||
          type === "user_closed_investment"
        ) {
          await mirrorTrade("sell", ticker, username);
        }

        // Skip updates
        else if (type === "user_updated_investment") {
          console.log(`[INVO] Ignoring update for ${ticker}`);
        }
      }

      pruneSeenNotifications();
      console.log(
        `[INVO] Poll complete: ${newCount} new, ${skippedCount} already seen`,
      );
    } catch (e) {
      console.error("[INVO] Poll error:", e.message);
    }

    console.log(
      `[INVO] ⏱ Next poll in ${POLL_INTERVAL / 1000}s — watching ${(await getInvoUsers()).join(", ")}`,
    );
  };

  // Run immediately then on interval
  await poll();
  const id = setInterval(async () => {
    if (invoState && !invoState.running) {
      clearInterval(id);
      console.log("[INVO] Poller stopped");
      return;
    }
    await poll();
  }, POLL_INTERVAL);
  if (invoState) invoState.intervalId = id;
}

// ── Target user management (callable from server.js API) ──────────
// Re-export database functions for server.js compatibility
export {
  getInvoUsers,
  dbAddUser as addInvoUser,
  dbRemoveUser as removeInvoUser,
};
