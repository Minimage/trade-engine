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
  `[HL] Initialized — testnet: ${HL_TESTNET}, account: ${HL_ACCOUNT_ADDR || "NOT SET"}`,
);

export function normalizeHLSymbol(ticker) {
  const clean = String(ticker || "")
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

function parseNum(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function getUsdcFromSpotState(spotState) {
  const balances = spotState?.balances || [];

  const usdc = balances.find(
    (b) => b.coin === "USDC" || b.token === "USDC" || b.name === "USDC",
  );

  return parseNum(
    usdc?.total ??
      usdc?.available ??
      usdc?.free ??
      usdc?.hold ??
      usdc?.balance ??
      0,
  );
}

export async function hlGetAsset(ticker) {
  const symbol = normalizeHLSymbol(ticker);

  if (!symbol || symbol === "-PERP") {
    return { symbol, found: false };
  }

  if (hlCache[symbol] !== undefined) return hlCache[symbol];

  try {
    const assets = await sdk.info.getAllAssets();
    const found = assets?.perp?.includes(symbol) === true;

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
    if (!HL_ACCOUNT_ADDR)
      throw new Error("HYPERLIQUID_ACCOUNT_ADDR is not set");

    const [perpState, spotState] = await Promise.allSettled([
      getPerpState(),
      getSpotState(),
    ]);

    const perp = perpState.status === "fulfilled" ? perpState.value : null;
    const spot = spotState.status === "fulfilled" ? spotState.value : null;

    if (perpState.status === "rejected") {
      console.error(
        "[HL] Perp state error:",
        perpState.reason?.message || perpState.reason,
      );
    }

    if (spotState.status === "rejected") {
      console.error(
        "[HL] Spot state error:",
        spotState.reason?.message || spotState.reason,
      );
    }

    console.log("[HL] RAW PERP STATE:", JSON.stringify(perp, null, 2));
    console.log("[HL] RAW SPOT STATE:", JSON.stringify(spot, null, 2));

    const perpBalance = parseNum(
      perp?.marginSummary?.accountValue ??
        perp?.crossMarginSummary?.accountValue ??
        0,
    );

    const withdrawable = parseNum(perp?.withdrawable ?? 0);
    const spotUsdc = getUsdcFromSpotState(spot);

    const positions = (perp?.assetPositions || [])
      .filter((p) => parseNum(p.position?.szi) !== 0)
      .map((p) => {
        const size = parseNum(p.position.szi);
        const entryPrice = parseNum(p.position.entryPx);
        const value = parseNum(
          p.position.positionValue,
          Math.abs(size) * entryPrice,
        );

        return {
          coin: p.position.coin,
          size,
          entryPrice,
          pnl: parseNum(p.position.unrealizedPnl),
          side: size > 0 ? "long" : "short",
          value,
        };
      });

    const deployed = positions.reduce(
      (sum, p) => sum + Math.abs(p.value || 0),
      0,
    );

    const available = Math.max(withdrawable, perpBalance - deployed, spotUsdc);
    const balance = Math.max(perpBalance, spotUsdc);

    console.log(
      `[HL] Balance check — total=$${balance.toFixed(2)}, available=$${available.toFixed(2)}, perp=$${perpBalance.toFixed(2)}, withdrawable=$${withdrawable.toFixed(2)}, spot USDC=$${spotUsdc.toFixed(2)}, deployed=$${deployed.toFixed(2)}`,
    );

    return {
      balance,
      available,
      deployed,
      positions,
      perpBalance,
      spotUsdc,
      withdrawable,
      rawPerp: perp,
      rawSpot: spot,
    };
  } catch (e) {
    console.error("[HL] Account state error FULL:", e);
    throw e;
  }
}

export async function hlPlaceOrder({ ticker, side, usdAmount }) {
  const asset = await hlGetAsset(ticker);
  if (!asset.found) throw new Error(`${ticker} not found on Hyperliquid`);

  const price = await hlGetPrice(ticker);
  if (!price) throw new Error(`Could not get price for ${ticker}`);

  const isBuy = side.toLowerCase() === "buy";

  const size = Number((usdAmount / price).toPrecision(6));

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      `Invalid Hyperliquid order size. USD: ${usdAmount}, price: ${price}, size: ${size}`,
    );
  }

  console.log(`[HL] Placing ${side} ${asset.symbol} size=${size} @ ~${price}`);

  const result = await sdk.custom.marketOpen(asset.symbol, isBuy, size);

  console.log("[HL] Order result:", JSON.stringify(result, null, 2));

  return {
    success: true,
    exchange: "hyperliquid",
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
    if (!asset.found) return { error: `${ticker} not found on Hyperliquid` };

    console.log(`[HL] Closing position ${asset.symbol}`);

    const result = await sdk.custom.marketClose(asset.symbol);

    console.log("[HL] Close result:", JSON.stringify(result, null, 2));

    return {
      success: true,
      exchange: "hyperliquid",
      symbol: asset.symbol,
      result,
    };
  } catch (e) {
    console.error("[HL] Close error:", e.message);
    throw e;
  }
}

export const isHLConfigured = () => Boolean(HL_PRIVATE_KEY && HL_ACCOUNT_ADDR);
