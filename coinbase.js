/**
 * Coinbase Exchange API Integration
 * Sandbox: public.sandbox.exchange.coinbase.com
 * Uses API Key + Secret + Passphrase authentication
 */

import crypto from 'crypto';
import fetch from 'node-fetch';

const COINBASE_SANDBOX_BASE = 'https://api-public.sandbox.exchange.coinbase.com';
const COINBASE_LIVE_BASE    = 'https://api.exchange.coinbase.com';
const COINBASE_BASE = process.env.COINBASE_LIVE === 'true' ? COINBASE_LIVE_BASE : COINBASE_SANDBOX_BASE;

const COINBASE_KEY        = process.env.COINBASE_API_KEY        || 'e7f991bf926e6de9faafbffd68f290d1';
const COINBASE_SECRET     = process.env.COINBASE_API_SECRET     || 'LjGXcwkx56OFG7RRr6fi0SLXCSfrHLhfFyDLGAV+B6nUVK8192tExETsRL7tqS3eMVPdPAwrLSEI+oNBa8jR/g==';
const COINBASE_PASSPHRASE = process.env.COINBASE_API_PASSPHRASE || 'sw8iqz0gyos5';

// Generate signature for Coinbase Exchange API
function signRequest(timestamp, method, path, body = '') {
  const message = `${timestamp}${method.toUpperCase()}${path}${body}`;
  return crypto
    .createHmac('sha256', Buffer.from(COINBASE_SECRET, 'base64'))
    .update(message)
    .digest('base64');
}

async function cbFetch(method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr   = body ? JSON.stringify(body) : '';
  const signature = signRequest(timestamp, method, path, bodyStr);

  const headers = {
    'CB-ACCESS-KEY':        COINBASE_KEY,
    'CB-ACCESS-SIGN':       signature,
    'CB-ACCESS-TIMESTAMP':  timestamp,
    'CB-ACCESS-PASSPHRASE': COINBASE_PASSPHRASE,
    'Content-Type':         'application/json',
    'Accept':               'application/json',
  };

  const opts = { method, headers };
  if (body) opts.body = bodyStr;

  const r = await fetch(`${COINBASE_BASE}${path}`, opts);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch(e) {
    return { error: text };
  }
}

// Normalize ticker to Coinbase product format
// ETH -> ETH-USD, PEPE -> PEPE-USD, ETH-USD -> ETH-USD
export function normalizeCoinbaseSymbol(ticker) {
  const clean = ticker
    .toUpperCase()
    .replace('/USD', '')
    .replace('-USD', '')
    .replace('USDT', '');
  return `${clean}-USD`;
}

// Cache to avoid repeated lookups
const coinbaseCache = {};

// Check if ticker exists on Coinbase and return product info
export async function coinbaseGetProduct(ticker) {
  const symbol = normalizeCoinbaseSymbol(ticker);
  if (coinbaseCache[symbol]) return coinbaseCache[symbol];

  try {
    const data = await cbFetch('GET', `/products/${symbol}`);
    if (data.id && !data.message) {
      const result = {
        symbol:    data.id,
        found:     true,
        tradable:  !data.trading_disabled && data.status === 'online',
        baseAsset: data.base_currency,
        quote:     data.quote_currency,
      };
      coinbaseCache[symbol] = result;
      console.log(`[COINBASE] Found ${symbol} — tradable: ${result.tradable}`);
      return result;
    }
  } catch(e) {
    console.error(`[COINBASE] Product lookup error:`, e.message);
  }

  coinbaseCache[symbol] = { symbol, found: false };
  console.log(`[COINBASE] ${symbol} not found`);
  return { symbol, found: false };
}

// Get latest price
export async function coinbaseGetPrice(ticker) {
  try {
    const product = await coinbaseGetProduct(ticker);
    if (!product.found) return null;
    const data = await cbFetch('GET', `/products/${product.symbol}/ticker`);
    return data.price ? parseFloat(data.price) : null;
  } catch(e) { return null; }
}

// Place a market order
export async function coinbasePlaceOrder({ ticker, side, usdAmount }) {
  const product = await coinbaseGetProduct(ticker);
  if (!product.found) throw new Error(`${ticker} not found on Coinbase`);

  const price = await coinbaseGetPrice(ticker);
  if (!price) throw new Error(`Could not get price for ${ticker}`);

  const body = side.toLowerCase() === 'buy'
    ? {
        type:       'market',
        side:       'buy',
        product_id: product.symbol,
        funds:      usdAmount.toFixed(2),
      }
    : {
        type:       'market',
        side:       'sell',
        product_id: product.symbol,
        size:       (usdAmount / price).toFixed(8),
      };

  console.log(`[COINBASE] Placing ${side} ${product.symbol}:`, JSON.stringify(body));
  const data = await cbFetch('POST', '/orders', body);

  if (data.id) {
    console.log(`[COINBASE] Order placed: ${data.id} status=${data.status}`);
    return data;
  } else {
    throw new Error(data.message || JSON.stringify(data));
  }
}

// Close a position by selling all available balance
export async function coinbaseClosePosition(ticker) {
  try {
    const product = await coinbaseGetProduct(ticker);
    if (!product.found) return { error: `${ticker} not found on Coinbase` };

    const accounts = await cbFetch('GET', '/accounts');
    const account  = Array.isArray(accounts)
      ? accounts.find(a => a.currency === product.baseAsset)
      : null;

    const available = parseFloat(account?.available || 0);
    if (available <= 0) {
      return { error: `No ${product.baseAsset} balance to sell` };
    }

    const body = {
      type:       'market',
      side:       'sell',
      product_id: product.symbol,
      size:       available.toFixed(8),
    };

    console.log(`[COINBASE] Closing ${product.symbol} — selling ${available} ${product.baseAsset}`);
    const data = await cbFetch('POST', '/orders', body);

    if (data.id) {
      console.log(`[COINBASE] Close order: ${data.id}`);
      return data;
    } else {
      throw new Error(data.message || JSON.stringify(data));
    }
  } catch(e) {
    console.error(`[COINBASE] Close error:`, e.message);
    throw e;
  }
}

export const isCoinbaseConfigured = () => !!COINBASE_KEY && !!COINBASE_SECRET && !!COINBASE_PASSPHRASE;
