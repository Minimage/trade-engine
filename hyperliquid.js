import { Hyperliquid } from 'hyperliquid';

const HL_PRIVATE_KEY  = process.env.HYPERLIQUID_PRIVATE_KEY  || '0xa70d921f5921ad6c88ce9964b10e47f92020723039942dfe77731a6f008e5fd7';
const HL_ACCOUNT_ADDR = process.env.HYPERLIQUID_ACCOUNT_ADDR || '0x0B403265cA3663b4999886707f021e9951BB1b3B';
const HL_TESTNET      = process.env.HL_TESTNET !== 'false';

const sdk = new Hyperliquid({
  privateKey:    HL_PRIVATE_KEY,
  walletAddress: HL_ACCOUNT_ADDR,
  vaultAddress: HL_ACCOUNT_ADDR,
  testnet:       HL_TESTNET,
  enableWs:      false,
  disableAssetMapRefresh: false,
});

console.log(`[HL] Initialized — testnet: ${HL_TESTNET}, account: ${HL_ACCOUNT_ADDR}`);

export function normalizeHLSymbol(ticker) {
  const clean = ticker
    .toUpperCase()
    .replace(/-USDC$/, '')
    .replace(/\/USDC$/, '')
    .replace(/-USD$/, '')
    .replace(/\/USD$/, '')
    .replace(/-USDT$/, '')
    .replace(/\/USDT$/, '')
    .replace(/-PERP$/, '')
    .replace(/USDC$/, '')
    .replace(/USDT$/, '')
    .trim();
  return `${clean}-PERP`;
}

const hlCache = {};

export async function hlGetAsset(ticker) {
  const symbol = normalizeHLSymbol(ticker);
  if (hlCache[symbol] !== undefined) return hlCache[symbol];
  try {
    const assets = await sdk.info.getAllAssets();
    const found = assets.perp.includes(symbol);
    if (found) {
      const result = { symbol, found: true };
      hlCache[symbol] = result;
      console.log(`[HL] Found ${symbol}`);
      return result;
    }
  } catch(e) {
    console.error(`[HL] Asset lookup error:`, e.message);
  }
  hlCache[symbol] = { symbol, found: false };
  console.log(`[HL] ${symbol} not found on Hyperliquid`);
  return { symbol, found: false };
}

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

export async function hlPlaceOrder({ ticker, side, usdAmount }) {
  const asset = await hlGetAsset(ticker);
  if (!asset.found) throw new Error(`${ticker} not found on Hyperliquid`);
  const price = await hlGetPrice(ticker);
  if (!price) throw new Error(`Could not get price for ${ticker}`);
  const isBuy = side.toLowerCase() === 'buy';
  const size  = parseFloat((usdAmount / price).toFixed(6));
  console.log(`[HL] Placing ${side} ${asset.symbol} size=${size} @ ~${price}`);
  const result = await sdk.custom.marketOpen(asset.symbol, isBuy, size);
  console.log(`[HL] Order result:`, JSON.stringify(result));
  return { success: true, result };
}

export async function hlClosePosition(ticker) {
  try {
    const asset = await hlGetAsset(ticker);
    if (!asset.found) return { error: `${ticker} not found on Hyperliquid` };
    console.log(`[HL] Closing position ${asset.symbol}`);
    const result = await sdk.custom.marketClose(asset.symbol);
    console.log(`[HL] Close result:`, JSON.stringify(result));
    return { success: true, result };
  } catch(e) {
    console.error(`[HL] Close error:`, e.message);
    throw e;
  }
}

export const isHLConfigured = () => !!HL_PRIVATE_KEY && !!HL_ACCOUNT_ADDR;
