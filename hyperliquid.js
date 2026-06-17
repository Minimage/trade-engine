import { Hyperliquid } from "hyperliquid";
import fetch from "node-fetch";

const HL_PRIVATE_KEY = process.env.HYPERLIQUID_PRIVATE_KEY;
const HL_ACCOUNT_ADDR = process.env.HYPERLIQUID_ACCOUNT_ADDR;
const HL_TESTNET = process.env.HL_TESTNET !== "false";

const INFO_URL = HL_TESTNET
  ? "https://api.hyperliquid-testnet.xyz/info"
  : "https://api.hyperliquid.xyz/info";

const sdk = new Hyperliquid({
  privateKey: HL_PRIVATE_KEY,
  walletAddress: HL_ACCOUNT_ADDR,
  testnet: HL_TESTNET,
  enableWs: false,
});

console.log(
  `[HL] Initialized — testnet: ${HL_TESTNET}, account: ${HL_ACCOUNT_ADDR}`,
);

export function normalizeHLSymbol(ticker) {
  const clean = ticker
    .toUpperCase()
    .replace(/-USDC$/, "")
    .replace(/\/USDC$/, "")
    .replace(/-USD$/, "")
    .replace(/\/USD$/, "")
    .replace(/-USDT$/, "")
    .replace(/\/USDT$/, "")
    .replace(/-PERP$/, "")
    .replace(/USDC$/, "")
    .replace(/USDT$/, "")
    .trim();

  return `${clean}-PERP`;
}

const hlCache = {};

async function hlInfo(body) {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Hyperliquid info error ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function getPerpState() {
  return await sdk.info.perpetuals.getClearinghouseState(HL_ACCOUNT_ADDR);
}

async function getSpotState() {
  return await hlInfo({
    type: "spotClearinghouseState",
    user: HL_ACCOUNT_ADDR,
  });
}

function getUsdcFromSpotState(spotState) {
  const balances = spotState?.balances || [];

  const usdc = balances.find(
    (b) => b.coin === "USDC" || b.token === "USDC" || b.name === "USDC",
  );

  return parseFloat(
    usdc?.total ?? usdc?.hold ?? usdc?.free ?? usdc?.available ?? 0,
  );
}

export async function hlGetAsset(ticker) {
  const symbol = normalizeHLSymbol(ticker);

  if (hlCache[symbol] !== undefined) return hlCache[symbol];

  try {
    const assets = await sdk.info.getAllAssets();
    const found = assets.perp.includes(symbol);

    const result = { symbol, found };
    hlCache[symbol] = result;

    console.log(
      found
        ? `[HL] Found ${symbol}`
        : `[HL] ${symbol} not found on Hyperliquid`,
    );
    return result;
  } catch (e) {
    console.error("[HL] Asset lookup error:", e.message);
    return { symbol, found: false };
  }
}

export async function hlGetPrice(ticker) {
  try {
    const symbol = normalizeHLSymbol(ticker);
    const mids = await sdk.info.getAllMids();

    return mids?.[symbol] ? parseFloat(mids[symbol]) : null;
  } catch (e) {
    console.error("[HL] Price error:", e.message);
    return null;
  }
}

export async function hlGetAccountState() {
  try {
    const perpState = await getPerpState();
    const spotState = await getSpotState();

    console.log("[HL] RAW PERP STATE:", JSON.stringify(perpState, null, 2));
    console.log("[HL] RAW SPOT STATE:", JSON.stringify(spotState, null, 2));

    const perpBalance = parseFloat(
      perpState?.marginSummary?.accountValue ??
        perpState?.crossMarginSummary?.accountValue ??
        0,
    );

    const withdrawable = parseFloat(perpState?.withdrawable ?? 0);
    const spotUsdc = getUsdcFromSpotState(spotState);

    const positions = (perpState?.assetPositions || [])
      .filter((p) => parseFloat(p.position?.szi || 0) !== 0)
      .map((p) => {
        const size = parseFloat(p.position.szi || 0);
        const entryPrice = parseFloat(p.position.entryPx || 0);

        return {
          coin: p.position.coin,
          size,
          entryPrice,
          pnl: parseFloat(p.position.unrealizedPnl || 0),
          side: size > 0 ? "long" : "short",
          value: Math.abs(size) * entryPrice,
        };
      });

    const deployed = positions.reduce((sum, p) => sum + p.value, 0);

    const available = Math.max(withdrawable, perpBalance - deployed, spotUsdc);

    console.log(
      `[HL] Balance check — perp: $${perpBalance.toFixed(2)}, withdrawable: $${withdrawable.toFixed(2)}, spot USDC: $${spotUsdc.toFixed(2)}, available used: $${available.toFixed(2)}`,
    );

    return {
      balance: Math.max(perpBalance, spotUsdc),
      perpBalance,
      spotUsdc,
      withdrawable,
      positions,
      deployed,
      available,
    };
  } catch (e) {
    console.error("[HL] Account state error FULL:", e);
    throw e;
  }
}

export async function hlPlaceOrder({ ticker, side, usdAmount }) {
  const asset = await hlGetAsset(ticker);

  if (!asset.found) {
    throw new Error(`${ticker} not found on Hyperliquid`);
  }

  const price = await hlGetPrice(ticker);

  if (!price) {
    throw new Error(`Could not get price for ${ticker}`);
  }

  const isBuy = side.toLowerCase() === "buy";

  const rawSize = usdAmount / price;
  const size = Number(rawSize.toPrecision(6));

  if (size <= 0) {
    throw new Error(`Order size too small. USD: ${usdAmount}, price: ${price}`);
  }

  console.log(`[HL] Placing ${side} ${asset.symbol} size=${size} @ ~${price}`);

  const result = await sdk.custom.marketOpen(asset.symbol, isBuy, size);

  console.log("[HL] Order result:", JSON.stringify(result, null, 2));

  return {
    success: true,
    symbol: asset.symbol,
    side,
    size,
    price,
    usdAmount,
    result,
  };
}

export async function hlClosePosition(ticker) {
  try {
    const asset = await hlGetAsset(ticker);

    if (!asset.found) {
      return { error: `${ticker} not found on Hyperliquid` };
    }

    console.log(`[HL] Closing position ${asset.symbol}`);

    const result = await sdk.custom.marketClose(asset.symbol);

    console.log("[HL] Close result:", JSON.stringify(result, null, 2));

    return {
      success: true,
      symbol: asset.symbol,
      result,
    };
  } catch (e) {
    console.error("[HL] Close error:", e);
    throw e;
  }
}

export const isHLConfigured = () => {
  return Boolean(HL_PRIVATE_KEY && HL_ACCOUNT_ADDR);
};
