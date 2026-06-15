/**
 * Hyperliquid Exchange Integration
 * Handles altcoin and meme coin trading
 * Uses API wallet authentication
 */

import { ethers } from 'ethers';
import fetch from 'node-fetch';

const HL_BASE      = 'https://api.hyperliquid.xyz';
const HL_TESTNET   = 'https://api.hyperliquid-testnet.xyz';
const HL_API_URL   = process.env.HL_TESTNET === 'false' ? HL_BASE : HL_TESTNET;

const HL_PRIVATE_KEY  = process.env.HYPERLIQUID_PRIVATE_KEY  || '0xa70d921f5921ad6c88ce9964b10e47f92020723039942dfe77731a6f008e5fd7';
const HL_WALLET_ADDR  = process.env.HYPERLIQUID_WALLET_ADDR  || '0x8761ca99192A20ec5A6c591CF19BA680CE8eC1e5'; // API wallet (signs requests)
const HL_ACCOUNT_ADDR = process.env.HYPERLIQUID_ACCOUNT_ADDR || '0x0B403265cA3663b4999886707f021e9951BB1b3B'; // Main account (trades go here)

// Wallet for signing
let wallet;
try {
  wallet = new ethers.Wallet(HL_PRIVATE_KEY);
} catch(e) {
  console.error('[HL] Failed to initialize wallet:', e.message);
}

// Sign an action for Hyperliquid
async function signAction(action, nonce) {
  const msgHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify({ action, nonce }))
  );
  const sig = await wallet.signMessage(ethers.utils.arrayify(msgHash));
  const { r, s, v } = ethers.utils.splitSignature(sig);
  return { r, s, v };
}

// Generic Hyperliquid API call
async function hlPost(endpoint, payload) {
  const r = await fetch(`${HL_API_URL}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { return { error: text }; }
}

// Get all available markets/coins on Hyperliquid
let marketCache = null;
async function getMarkets() {
  if (marketCache) return marketCache;
  try {
    const data = await hlPost('/info', { type: 'meta' });
    marketCache = data?.universe || [];
    return marketCache;
  } catch(e) {
    return [];
  }
}

// Normalize ticker — Hyperliquid uses just the coin name e.g. "BTC", "PEPE"
export function normalizeHLSymbol(ticker) {
  return ticker
    .toUpperCase()
    .replace('-USDC', '')
    .replace('/USDC', '')
    .replace('-USD', '')
    .replace('/USD', '')
    .replace('-USDT', '')
    .replace('/USDT', '')
    .replace('USDC', '')
    .replace('USDT', '')
    .trim();
}

// Cache for ticker lookups
const hlCache = {};

// Check if ticker exists on Hyperliquid
export async function hlGetAsset(ticker) {
  const symbol = normalizeHLSymbol(ticker);
  if (hlCache[symbol] !== undefined) return hlCache[symbol];

  const markets = await getMarkets();
  const asset = markets.find(m => m.name.toUpperCase() === symbol);

  if (asset) {
    const result = {
      symbol,
      found:      true,
      assetIndex: markets.indexOf(asset),
    };
    hlCache[symbol] = result;
    console.log(`[HL] Found ${symbol} at index ${result.assetIndex}`);
    return result;
  }

  hlCache[symbol] = { symbol, found: false };
  console.log(`[HL] ${symbol} not found on Hyperliquid`);
  return { symbol, found: false };
}

// Get latest price for a coin
export async function hlGetPrice(ticker) {
  try {
    const symbol = normalizeHLSymbol(ticker);
    const data   = await hlPost('/info', { type: 'allMids' });
    return data?.[symbol] ? parseFloat(data[symbol]) : null;
  } catch(e) { return null; }
}

// Place a market order on Hyperliquid
export async function hlPlaceOrder({ ticker, side, usdAmount }) {
  try {
    const asset = await hlGetAsset(ticker);
    if (!asset.found) throw new Error(`${ticker} not found on Hyperliquid`);

    const price = await hlGetPrice(ticker);
    if (!price) throw new Error(`Could not get price for ${ticker}`);

    const isBuy = side.toLowerCase() === 'buy';
    const size  = parseFloat((usdAmount / price).toFixed(6));
    const nonce = Date.now();

    // Limit price with 1% slippage for market-like fill
    const limitPrice = isBuy
      ? parseFloat((price * 1.01).toFixed(6))
      : parseFloat((price * 0.99).toFixed(6));

    const action = {
      type:   'order',
      orders: [{
        a:   asset.assetIndex, // asset index
        b:   isBuy,            // is buy
        p:   limitPrice.toString(),
        s:   size.toString(),
        r:   false,            // reduce only
        t:   { limit: { tif: 'Ioc' } }, // immediate or cancel (market-like)
      }],
      grouping: 'na',
    };

    const signature = await signAction(action, nonce);

    const payload = {
      action,
      nonce,
      signature,
      vaultAddress: HL_ACCOUNT_ADDR,
    };

    const symbol = asset.symbol;
    console.log(`[HL] Placing ${side} ${symbol} size=${size} @ ~${price}`);
    const data = await hlPost('/exchange', payload);
    console.log(`[HL] Order response:`, JSON.stringify(data));

    if (data?.status === 'ok') {
      return { success: true, data };
    } else {
      throw new Error(JSON.stringify(data));
    }
  } catch(e) {
    console.error(`[HL] Order error:`, e.message);
    throw e;
  }
}

// Close a position on Hyperliquid
export async function hlClosePosition(ticker) {
  try {
    const asset = await hlGetAsset(ticker);
    if (!asset.found) return { error: `${ticker} not found on Hyperliquid` };

    const price = await hlGetPrice(ticker);
    if (!price) return { error: `Could not get price for ${ticker}` };

    // Get current position size
    const stateData = await hlPost('/info', {
      type:    'clearinghouseState',
      user:    HL_ACCOUNT_ADDR,
    });

    const positions = stateData?.assetPositions || [];
    const pos = positions.find(p => p.position?.coin === normalizeHLSymbol(ticker));

    if (!pos || parseFloat(pos.position?.szi || 0) === 0) {
      return { error: `No position in ${ticker} on Hyperliquid` };
    }

    const size    = Math.abs(parseFloat(pos.position.szi));
    const isLong  = parseFloat(pos.position.szi) > 0;
    const nonce   = Date.now();

    // Close by selling if long, buying if short
    const limitPrice = isLong
      ? parseFloat((price * 0.99).toFixed(6))
      : parseFloat((price * 1.01).toFixed(6));

    const action = {
      type:   'order',
      orders: [{
        a:   asset.assetIndex,
        b:   !isLong,  // opposite side to close
        p:   limitPrice.toString(),
        s:   size.toString(),
        r:   true,     // reduce only — closes position
        t:   { limit: { tif: 'Ioc' } },
      }],
      grouping: 'na',
    };

    const signature = await signAction(action, nonce);
    const payload   = { action, nonce, signature, vaultAddress: HL_ACCOUNT_ADDR };

    console.log(`[HL] Closing ${ticker} position size=${size}`);
    const data = await hlPost('/exchange', payload);
    console.log(`[HL] Close response:`, JSON.stringify(data));

    return data?.status === 'ok' ? { success: true, data } : { error: JSON.stringify(data) };
  } catch(e) {
    console.error(`[HL] Close error:`, e.message);
    throw e;
  }
}

export const isHLConfigured = () => !!HL_PRIVATE_KEY && !!HL_WALLET_ADDR;
