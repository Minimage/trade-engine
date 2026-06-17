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

function parseNum(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

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

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Hyperliquid returned non-JSON response: ${text}`);
  }
}

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

function normalizeCoin(ticker) {
  return normalizeHLSymbol(ticker).replace("-PERP", "");
}

const assetCache = {};
const metaCache = {
  value: null,
  fetchedAt: 0,
};

async function getMeta() {
  const now = Date.now();

  // Cache metadata for 5 minutes.
  if (metaCache.value && now - metaCache.fetchedAt < 5 * 60 * 1000) {
    return metaCache.value;
  }

  const meta = await hlInfo({ type: "meta" });
  metaCache.value = meta;
  metaCache.fetchedAt = now;

  return meta;
}

async function getPerpState() {
  return sdk.info.perpetuals.getClearinghouseState(HL_ACCOUNT_ADDR);
}

async function getSpotState() {
  return hlInfo({
    type: "spotClearinghouseState",
    user: HL_ACCOUNT_ADDR,
  });
}

function getUsdcFromSpotState(spotState) {
  const balances = spotState?.balances || [];

  const usdc = balances.find((b) => {
    const coin = String(b.coin || b.token || b.name || "").toUpperCase();
    return coin === "USDC";
  });

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
  const coin = symbol.replace("-PERP", "");

  if (!coin) {
    return { symbol, coin, found: false };
  }

  if (assetCache[symbol] !== undefined) return assetCache[symbol];

  try {
    const meta = await getMeta();
    const found = Array.isArray(meta?.universe)
      ? meta.universe.some((a) => a.name === coin)
      : false;

    const result = { symbol, coin, found };
    assetCache[symbol] = result;

    console.log(
      found
        ? `[HL] Found ${symbol}`
        : `[HL] ${symbol} not found on Hyperliquid`,
    );

    return result;
  } catch (e) {
    console.error("[HL] Asset lookup error:", e.message);
    return { symbol, coin, found: false };
  }
}

export async function hlGetPrice(ticker) {
  try {
    const symbol = normalizeHLSymbol(ticker);
    const coin = symbol.replace("-PERP", "");

    const mids = await sdk.info.getAllMids();

    const value = mids?.[symbol] ?? mids?.[coin] ?? null;

    return value != null ? parseFloat(value) : null;
  } catch (e) {
    console.error("[HL] Price error:", e.message);
    return null;
  }
}

export async function hlGetAccountState() {
  try {
    if (!HL_ACCOUNT_ADDR) {
      throw new Error("HYPERLIQUID_ACCOUNT_ADDR is not set");
    }

    const [perpResult, spotResult] = await Promise.allSettled([
      getPerpState(),
      getSpotState(),
    ]);

    const perp = perpResult.status === "fulfilled" ? perpResult.value : null;
    const spot = spotResult.status === "fulfilled" ? spotResult.value : null;

    if (perpResult.status === "rejected") {
      console.error(
        "[HL] Perp state error:",
        perpResult.reason?.message || perpResult.reason,
      );
    }

    if (spotResult.status === "rejected") {
      console.error(
        "[HL] Spot state error:",
        spotResult.reason?.message || spotResult.reason,
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
        const size = parseNum(p.position?.szi);
        const entryPrice = parseNum(p.position?.entryPx);
        const value = parseNum(
          p.position?.positionValue,
          Math.abs(size) * entryPrice,
        );

        const rawCoin = String(p.position?.coin || "");
        const baseCoin = rawCoin.replace("-PERP", "");

        return {
          coin: rawCoin,
          ticker: `${baseCoin}-USD`,
          size,
          entryPrice,
          pnl: parseNum(p.position?.unrealizedPnl),
          side: size > 0 ? "long" : "short",
          value,
        };
      });

    const deployed = positions.reduce(
      (sum, p) => sum + Math.abs(parseNum(p.value)),
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

async function getSizeDecimals(ticker) {
  const coin = normalizeCoin(ticker);
  const meta = await getMeta();

  const universeAsset = meta?.universe?.find((a) => a.name === coin);

  if (!universeAsset) {
    throw new Error(`Could not find Hyperliquid metadata for ${coin}`);
  }

  return universeAsset.szDecimals;
}

function roundSizeToDecimals(rawSize, szDecimals) {
  const size = Number(rawSize.toFixed(szDecimals));

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      `Invalid Hyperliquid order size. rawSize=${rawSize}, roundedSize=${size}, szDecimals=${szDecimals}`,
    );
  }

  return size;
}

export async function hlPlaceOrder({ ticker, side, usdAmount }) {
  try {
    if (!HL_PRIVATE_KEY || !HL_ACCOUNT_ADDR) {
      throw new Error(
        "Hyperliquid is not configured. Set HYPERLIQUID_PRIVATE_KEY and HYPERLIQUID_ACCOUNT_ADDR.",
      );
    }

    const asset = await hlGetAsset(ticker);

    if (!asset.found) {
      throw new Error(`${ticker} not found on Hyperliquid`);
    }

    const price = await hlGetPrice(ticker);

    if (!price) {
      throw new Error(`Could not get price for ${ticker}`);
    }

    const isBuy = String(side).toLowerCase() === "buy";
    const szDecimals = await getSizeDecimals(ticker);
    const rawSize = parseNum(usdAmount) / price;
    const size = roundSizeToDecimals(rawSize, szDecimals);

    console.log(`[HL] ${asset.symbol} size precision = ${szDecimals}`);
    console.log(`[HL] Raw size=${rawSize}, rounded size=${size}`);
    console.log(
      `[HL] Placing ${side} ${asset.symbol} size=${size} @ ~${price}`,
    );

    const result = await sdk.custom.marketOpen(asset.symbol, isBuy, size);

    console.log("[HL] Order result:", JSON.stringify(result, null, 2));

    const statuses = result?.response?.data?.statuses || [];
    const errorStatus = statuses.find((s) => s.error);

    if (errorStatus) {
      throw new Error(errorStatus.error);
    }

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
  } catch (e) {
    console.error("[HL] Place order error:", e.message);
    throw e;
  }
}

export async function hlClosePosition(ticker) {
  try {
    if (!HL_PRIVATE_KEY || !HL_ACCOUNT_ADDR) {
      throw new Error(
        "Hyperliquid is not configured. Set HYPERLIQUID_PRIVATE_KEY and HYPERLIQUID_ACCOUNT_ADDR.",
      );
    }

    const asset = await hlGetAsset(ticker);

    if (!asset.found) {
      return { error: `${ticker} not found on Hyperliquid` };
    }

    console.log(`[HL] Closing position ${asset.symbol}`);

    const result = await sdk.custom.marketClose(asset.symbol);

    console.log("[HL] Close result:", JSON.stringify(result, null, 2));

    const statuses = result?.response?.data?.statuses || [];
    const errorStatus = statuses.find((s) => s.error);

    if (errorStatus) {
      throw new Error(errorStatus.error);
    }

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

export const isHLConfigured = () => {
  return Boolean(HL_PRIVATE_KEY && HL_ACCOUNT_ADDR);
};
