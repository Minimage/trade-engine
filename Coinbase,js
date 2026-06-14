/**
 * Coinbase Advanced Trade API Integration
 * Fallback exchange for tickers not available on Alpaca
 * Handles meme coins, altcoins, and stocks Alpaca doesn't carry
 */

import crypto from 'crypto';
import fetch from 'node-fetch';

const COINBASE_BASE = 'https://api.coinbase.com';
const COINBASE_KEY_NAME = process.env.COINBASE_API_KEY_NAME || 'organizations/455d2524-52be-442e-81e6-b00018c95df9/apiKeys/8aded27a-4cdc-4b0f-8e8b-118b3b5f85a6';
const COINBASE_PRIVATE_KEY = (process.env.COINBASE_PRIVATE_KEY || '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIJUpuJbfUkQSwJWcGDEB23pANxanLjk5ZaTwckaILLTZoAoGCCqGSM49\nAwEHoUQDQgAEChstNguspgX7K7S6VGciH5iqmHA4NxcgeuNn8DZ5UKSrdgcCOguK\niVsRsTF9i2/zhYLoPgoi32W2pCk4IJgEmQ==\n-----END EC PRIVATE KEY-----\n').replace(/\\n/g, '\n');

// Generate JWT for Coinbase API auth
function generateJWT(method, path) {
  const host = 'api.coinbase.com';
  const uri  = `${method} ${host}${path}`;

  const payload = {
    iss: 'cdp',
    nbf: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    sub: COINBASE_KEY_NAME,
    uri,
  };

  const header = { alg: 'ES256', kid: COINBASE_KEY_NAME, nonce: crypto.randomBytes(16).toString('hex') };

  const base64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${base64url(header)}.${base64url(payload)}`;

  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const signature = sign.sign({ key: COINBASE_PRIVATE_KEY, dsaEncoding: 'ieee-p1363' }, 'base64url');

  return `${signingInput}.${signature}`;
}

async function cbFetch(method, path, body = null) {
  const jwt = generateJWT(method, path);
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type':  'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${COINBASE_BASE}${path}`, opts);
  return r.json();
}

// Normalize ticker to Coinbase product format
// PEPE -> PEPE-USDC or PEPE-USD
export function normalizeCoinbaseSymbol(ticker) {
  const clean = ticker.toUpperCase()
    .replace('-USD', '').replace('/USD', '')
    .replace('-USDC', '').replace('/USDC', '');
  return `${clean}-USD`;
}

// Check if ticker exists on Coinbase and get product info
const coinbaseCache = {};

export async function coinbaseGetProduct(ticker) {
  const symbol = normalizeCoinbaseSymbol(ticker);
  if (coinbaseCache[symbol]) return coinbaseCache[symbol];

  try {
    const data = await cbFetch('GET', `/api/v3/brokerage/products/${symbol}`);
    if (data.product_id) {
      const result = {
        symbol:   data.product_id,
        found:    true,
        tradable: !data.is_disabled,
        baseAsset: data.base_currency_id,
      };
      coinbaseCache[symbol] = result;
      console.log(`[COINBASE] Found ${symbol} — tradable: ${result.tradable}`);
      return result;
    }
  } catch(e) {}

  // Try USDC pair as fallback
  const usdcSymbol = symbol.replace('-USD', '-USDC');
  try {
    const data = await cbFetch('GET', `/api/v3/brokerage/products/${usdcSymbol}`);
    if (data.product_id) {
      const result = {
        symbol:    data.product_id,
        found:     true,
        tradable:  !data.is_disabled,
        baseAsset: data.base_currency_id,
      };
      coinbaseCache[symbol] = result;
      console.log(`[COINBASE] Found ${usdcSymbol} (USDC pair) — tradable: ${result.tradable}`);
      return result;
    }
  } catch(e) {}

  coinbaseCache[symbol] = { symbol, found: false };
  return { symbol, found: false };
}

// Get latest price
export async function coinbaseGetPrice(ticker) {
  try {
    const product = await coinbaseGetProduct(ticker);
    if (!product.found) return null;
    const data = await cbFetch('GET', `/api/v3/brokerage/products/${product.symbol}`);
    return data.price ? parseFloat(data.price) : null;
  } catch(e) { return null; }
}

// Place a buy or sell order
export async function coinbasePlaceOrder({ ticker, side, usdAmount }) {
  const product = await coinbaseGetProduct(ticker);
  if (!product.found) throw new Error(`${ticker} not found on Coinbase`);

  const orderId = crypto.randomUUID();
  const body = {
    client_order_id: orderId,
    product_id:      product.symbol,
    side:            side.toUpperCase(), // BUY or SELL
    order_configuration: {
      market_market_ioc: {
        quote_size: usdAmount.toFixed(2), // spend $X
      },
    },
  };

  console.log(`[COINBASE] Placing ${side} ${product.symbol} $${usdAmount}`);
  const data = await cbFetch('POST', '/api/v3/brokerage/orders', body);

  if (data.success) {
    console.log(`[COINBASE] Order placed: ${data.success_response?.order_id}`);
    return data.success_response;
  } else {
    throw new Error(data.error_response?.message || 'Order failed');
  }
}

// Close a position (sell all)
export async function coinbaseClosePosition(ticker) {
  try {
    const product = await coinbaseGetProduct(ticker);
    if (!product.found) return { error: `${ticker} not found on Coinbase` };

    // Get current balance
    const accounts = await cbFetch('GET', '/api/v3/brokerage/accounts');
    const account  = accounts.accounts?.find(a => a.currency === product.baseAsset);
    const available = parseFloat(account?.available_balance?.value || 0);

    if (available <= 0) return { error: `No ${product.baseAsset} balance to sell` };

    const orderId = crypto.randomUUID();
    const body = {
      client_order_id: orderId,
      product_id:      product.symbol,
      side:            'SELL',
      order_configuration: {
        market_market_ioc: {
          base_size: available.toFixed(8),
        },
      },
    };

    console.log(`[COINBASE] Closing ${product.symbol} — selling ${available} ${product.baseAsset}`);
    const data = await cbFetch('POST', '/api/v3/brokerage/orders', body);

    if (data.success) {
      return data.success_response;
    } else {
      throw new Error(data.error_response?.message || 'Close failed');
    }
  } catch(e) {
    console.error(`[COINBASE] Close error:`, e.message);
    throw e;
  }
}

export const isCoinbaseConfigured = () => !!COINBASE_KEY_NAME && !!COINBASE_PRIVATE_KEY;
