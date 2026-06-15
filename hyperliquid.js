/**
 * Hyperliquid Exchange Integration
 * Uses official hyperliquid npm SDK
 * API Agent Wallet signs on behalf of main account
 */

import { Hyperliquid } from 'hyperliquid';

const HL_PRIVATE_KEY  = process.env.HYPERLIQUID_PRIVATE_KEY  || '0xa70d921f5921ad6c88ce9964b10e47f92020723039942dfe77731a6f008e5fd7';
const HL_ACCOUNT_ADDR = process.env.HYPERLIQUID_ACCOUNT_ADDR || '0x0B403265cA3663b4999886707f021e9951BB1b3B';
const HL_TESTNET      = process.env.HL_TESTNET !== 'false';

// Initialize SDK
const sdk = new Hyperliquid({
  privateKey:    HL_PRIVATE_KEY,
  walletAddress: HL_ACCOUNT_ADDR, // required when using API Agent Wallet
  testnet:       HL_TESTNET,
  enableWs:      false,
});

console.log(`[HL] Initialized — testnet: ${HL_TESTNET}, account: ${HL_ACCOUNT_ADDR}`);

// Normalize ticker to Hyperliquid format (just the coin name)
export function normalizeHLSymbol(ticker) {
  return ticker
    .toUpperCase()
    .replace(/-USDC$/, '')
    .replace(/\/USDC$/, '')
    .replace(/-USD$/, '')
    .replace(/\/USD$/, '')
    .replace(/-USDT$/, '')
    .replace(/\/USDT$/, '')
    .replace(/USDC$/, '')
    .replace(/USDT$/, '')
    .trim();
}

// Cache for ticker lookups
const hlCache = {};

// Check if ticker exists on Hyperliquid
export async function hlGetAsset(ticker) {
  const symbol = normalizeHLSymbol(ticker);
  if (hlCache[symbol] !== undefined) return hlCache[symbol];

  try {
    const meta = await sdk.info.perpMeta();
    const universe = meta?.universe || [];
    const idx = universe.findIndex(m => m.name.toUpperCase() === symbol);

    if (idx >= 0) {
      const result = { symbol, found: true, assetIndex: idx };
      hlCache[symbol] = result;
      console.log(`[HL] Found ${symbol} at index ${idx}`);
      return result;
    }
  } catch(e) {
    console.error(`[HL] Asset lookup error:`, e.message);
  }

  hlCache[symbol] = { symbol, found: false };
  console.log(`[HL] ${symbol} not found on Hyperliquid`);
  return { symbol, found: false };
}

// Get latest price
export async function hlGetPrice(ticker) {
  try {
    const symbol = normalizeHLSymbol(ticker);
    const mids   = await sdk.info.getAllMids();
    return mids?.[symbol] ? parseFloat(mids[symbol]) : null;
  } catch(e) {
    console.error(`[HL] Price error:`, e.message);
    return null;
  }
}

// Place a market order
export async function hlPlaceOrder({ ticker, side, usdAmount }) {
  const asset = await hlGetAsset(ticker);
  if (!asset.found) throw new Error(`${ticker} not found on Hyperliquid`);

  const price = await hlGetPrice(ticker);
  if (!price) throw new Error(`Could not get price for ${ticker}`);

  const isBuy = side.toLowerCase() === 'buy';
  const size  = parseFloat((usdAmount / price).toFixed(1)); // round to 1 decimal for most perps

  // Use slippage price for IOC (market-like) order
  const slippagePrice = isBuy
    ? parseFloat((price * 1.02).toFixed(6))
    : parseFloat((price * 0.98).toFixed(6));

  console.log(`[HL] Placing ${side} ${asset.symbol} size=${size} @ ~${price}`);

  const orderRequest = {
    coin:       asset.symbol,
    is_buy:     isBuy,
    sz:         size,
    limit_px:   slippagePrice,
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
  };

  const result = await sdk.exchange.placeOrder(orderRequest);
  console.log(`[HL] Order result:`, JSON.stringify(result));

  if (result?.response?.type === 'order' || result?.status === 'ok') {
    return { success: true, result };
  } else {
    throw new Error(JSON.stringify(result));
  }
}

// Close a position
export async function hlClosePosition(ticker) {
  try {
    const asset = await hlGetAsset(ticker);
    if (!asset.found) return { error: `${ticker} not found on Hyperliquid` };

    const price = await hlGetPrice(ticker);
    if (!price) return { error: `Could not get price for ${ticker}` };

    // Get current positions
    const state     = await sdk.info.perpetuals.getClearinghouseState(HL_ACCOUNT_ADDR);
    const positions = state?.assetPositions || [];
    const pos       = positions.find(p => p.position?.coin === asset.symbol);

    if (!pos || parseFloat(pos.position?.szi || 0) === 0) {
      return { error: `No position in ${asset.symbol} on Hyperliquid` };
    }

    const size   = Math.abs(parseFloat(pos.position.szi));
    const isLong = parseFloat(pos.position.szi) > 0;

    const slippagePrice = isLong
      ? parseFloat((price * 0.98).toFixed(6))
      : parseFloat((price * 1.02).toFixed(6));

    const orderRequest = {
      coin:        asset.symbol,
      is_buy:      !isLong,
      sz:          size,
      limit_px:    slippagePrice,
      order_type:  { limit: { tif: 'Ioc' } },
      reduce_only: true,
    };

    console.log(`[HL] Closing ${asset.symbol} position size=${size}`);
    const result = await sdk.exchange.placeOrder(orderRequest);
    console.log(`[HL] Close result:`, JSON.stringify(result));

    return { success: true, result };
  } catch(e) {
    console.error(`[HL] Close error:`, e.message);
    throw e;
  }
}

export const isHLConfigured = () => !!HL_PRIVATE_KEY && !!HL_ACCOUNT_ADDR;
