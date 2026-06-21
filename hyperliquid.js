import { Hyperliquid } from "hyperliquid";
import fetch from "node-fetch";

// ── Dual account config ───────────────────────────────────────────
// Long account — all buy signals route here
const HL_PRIVATE_KEY_LONG = process.env.HYPERLIQUID_PRIVATE_KEY_LONG;
const HL_ACCOUNT_ADDR_LONG = process.env.HYPERLIQUID_ACCOUNT_ADDR_LONG;

// Short account — all short signals route here
const HL_PRIVATE_KEY_SHORT = process.env.HYPERLIQUID_PRIVATE_KEY_SHORT;
const HL_ACCOUNT_ADDR_SHORT = process.env.HYPERLIQUID_ACCOUNT_ADDR_SHORT;

// Fallback to legacy single-account env vars if dual not configured
const HL_PRIVATE_KEY =
  HL_PRIVATE_KEY_LONG || process.env.HYPERLIQUID_PRIVATE_KEY;
const HL_ACCOUNT_ADDR =
  HL_ACCOUNT_ADDR_LONG || process.env.HYPERLIQUID_ACCOUNT_ADDR;

const HL_TESTNET = process.env.HL_TESTNET !== "false";

const INFO_URL = HL_TESTNET
  ? "https://api.hyperliquid-testnet.xyz/info"
  : "https://api.hyperliquid.xyz/info";

// ── SDK instances — one per account ──────────────────────────────
const sdkLong = new Hyperliquid({
  privateKey: HL_PRIVATE_KEY_LONG || process.env.HYPERLIQUID_PRIVATE_KEY,
  walletAddress: HL_ACCOUNT_ADDR_LONG || process.env.HYPERLIQUID_ACCOUNT_ADDR,
  testnet: HL_TESTNET,
  enableWs: false,
});

const sdkShort = new Hyperliquid({
  privateKey: HL_PRIVATE_KEY_SHORT || process.env.HYPERLIQUID_PRIVATE_KEY,
  walletAddress: HL_ACCOUNT_ADDR_SHORT || process.env.HYPERLIQUID_ACCOUNT_ADDR,
  testnet: HL_TESTNET,
  enableWs: false,
});

// Helper — pick the right SDK and address based on trade side
function getAccountForSide(side) {
  const isShort =
    String(side).toLowerCase() === "short" ||
    String(side).toLowerCase() === "sell";
  if (isShort) {
    return {
      sdk: sdkShort,
      address: HL_ACCOUNT_ADDR_SHORT || process.env.HYPERLIQUID_ACCOUNT_ADDR,
      key: HL_PRIVATE_KEY_SHORT || process.env.HYPERLIQUID_PRIVATE_KEY,
      label: "SHORT",
    };
  }
  return {
    sdk: sdkLong,
    address: HL_ACCOUNT_ADDR_LONG || process.env.HYPERLIQUID_ACCOUNT_ADDR,
    key: HL_PRIVATE_KEY_LONG || process.env.HYPERLIQUID_PRIVATE_KEY,
    label: "LONG",
  };
}

console.log(`[HL] Initialized — testnet: ${HL_TESTNET}`);
console.log(
  `[HL] Long  account: ${HL_ACCOUNT_ADDR_LONG || process.env.HYPERLIQUID_ACCOUNT_ADDR || "NOT SET"}`,
);
console.log(
  `[HL] Short account: ${HL_ACCOUNT_ADDR_SHORT || process.env.HYPERLIQUID_ACCOUNT_ADDR || "NOT SET (using same as long)"}`,
);

// ── Helpers ───────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Hyperliquid info error ${res.status}: ${text}`);

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
const metaCache = { value: null, fetchedAt: 0 };

async function getMeta() {
  const now = Date.now();
  if (metaCache.value && now - metaCache.fetchedAt < 5 * 60 * 1000) {
    return metaCache.value;
  }
  const meta = await hlInfo({ type: "meta" });
  metaCache.value = meta;
  metaCache.fetchedAt = now;
  return meta;
}

// Fetch perp state for a specific account address
async function getPerpState(address) {
  return sdkLong.info.perpetuals.getClearinghouseState(address);
}

// Fetch spot state for a specific account address
async function getSpotState(address) {
  return hlInfo({ type: "spotClearinghouseState", user: address });
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

function buildAccountState(perp, spot) {
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

  return {
    balance,
    available,
    deployed,
    positions,
    perpBalance,
    spotUsdc,
    withdrawable,
  };
}

// ── Public API ────────────────────────────────────────────────────

export async function hlGetAsset(ticker) {
  const symbol = normalizeHLSymbol(ticker);
  const coin = symbol.replace("-PERP", "");

  if (!coin) return { symbol, coin, found: false };
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
    const mids = await sdkLong.info.getAllMids();
    const value = mids?.[symbol] ?? mids?.[coin] ?? null;
    return value != null ? parseFloat(value) : null;
  } catch (e) {
    console.error("[HL] Price error:", e.message);
    return null;
  }
}

// Get state for a specific account by side ('long' or 'short')
export async function hlGetAccountState(side = "long") {
  const account = getAccountForSide(side);

  if (!account.address) {
    throw new Error(`Hyperliquid ${side} account address is not set`);
  }

  try {
    const [perpResult, spotResult] = await Promise.allSettled([
      getPerpState(account.address),
      getSpotState(account.address),
    ]);

    const perp = perpResult.status === "fulfilled" ? perpResult.value : null;
    const spot = spotResult.status === "fulfilled" ? spotResult.value : null;

    if (perpResult.status === "rejected") {
      console.error(
        `[HL] ${account.label} perp state error:`,
        perpResult.reason?.message || perpResult.reason,
      );
    }
    if (spotResult.status === "rejected") {
      console.error(
        `[HL] ${account.label} spot state error:`,
        spotResult.reason?.message || spotResult.reason,
      );
    }

    console.log(
      `[HL] RAW PERP STATE (${account.label}):`,
      JSON.stringify(perp, null, 2),
    );

    const state = buildAccountState(perp, spot);

    console.log(
      `[HL] ${account.label} account — total=$${state.balance.toFixed(2)}, available=$${state.available.toFixed(2)}, deployed=$${state.deployed.toFixed(2)}`,
    );

    return { ...state, rawPerp: perp, rawSpot: spot };
  } catch (e) {
    console.error(`[HL] Account state error (${account.label}):`, e);
    throw e;
  }
}

// Get state for both accounts simultaneously
export async function hlGetAllAccountStates() {
  const [longResult, shortResult] = await Promise.allSettled([
    hlGetAccountState("long"),
    hlGetAccountState("short"),
  ]);

  return {
    long: longResult.status === "fulfilled" ? longResult.value : null,
    short: shortResult.status === "fulfilled" ? shortResult.value : null,
  };
}

async function getSizeDecimals(ticker) {
  const coin = normalizeCoin(ticker);
  const meta = await getMeta();
  const universeAsset = meta?.universe?.find((a) => a.name === coin);
  if (!universeAsset)
    throw new Error(`Could not find Hyperliquid metadata for ${coin}`);
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
    const account = getAccountForSide(side);

    if (!account.key || !account.address) {
      throw new Error(
        `Hyperliquid ${account.label} account is not configured.`,
      );
    }

    const asset = await hlGetAsset(ticker);
    if (!asset.found) throw new Error(`${ticker} not found on Hyperliquid`);

    const price = await hlGetPrice(ticker);
    if (!price) throw new Error(`Could not get price for ${ticker}`);

    const isBuy = String(side).toLowerCase() === "buy";
    const szDecimals = await getSizeDecimals(ticker);
    const rawSize = parseNum(usdAmount) / price;
    const size = roundSizeToDecimals(rawSize, szDecimals);

    console.log(
      `[HL] ${account.label} account — placing ${side} ${asset.symbol} size=${size} @ ~${price}`,
    );

    const result = await account.sdk.custom.marketOpen(
      asset.symbol,
      isBuy,
      size,
    );

    console.log("[HL] Order result:", JSON.stringify(result, null, 2));

    const statuses = result?.response?.data?.statuses || [];
    const errorStatus = statuses.find((s) => s.error);
    if (errorStatus) throw new Error(errorStatus.error);

    return {
      success: true,
      exchange: "hyperliquid",
      account: account.label,
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

export async function hlClosePosition(ticker, side) {
  try {
    const account = getAccountForSide(side);

    if (!account.key || !account.address) {
      throw new Error(
        `Hyperliquid ${account.label} account is not configured.`,
      );
    }

    const asset = await hlGetAsset(ticker);
    if (!asset.found) return { error: `${ticker} not found on Hyperliquid` };

    console.log(
      `[HL] ${account.label} account — closing position ${asset.symbol}`,
    );

    const result = await account.sdk.custom.marketClose(asset.symbol);

    console.log("[HL] Close result:", JSON.stringify(result, null, 2));

    const statuses = result?.response?.data?.statuses || [];
    const errorStatus = statuses.find((s) => s.error);
    if (errorStatus) throw new Error(errorStatus.error);

    return {
      success: true,
      exchange: "hyperliquid",
      account: account.label,
      symbol: asset.symbol,
      result,
    };
  } catch (e) {
    console.error("[HL] Close error:", e.message);
    throw e;
  }
}

export const isHLConfigured = () => {
  // Configured if at least the long account (or legacy single account) is set
  return Boolean(
    (HL_PRIVATE_KEY_LONG && HL_ACCOUNT_ADDR_LONG) ||
      (process.env.HYPERLIQUID_PRIVATE_KEY &&
        process.env.HYPERLIQUID_ACCOUNT_ADDR),
  );
};

export const isDualAccountConfigured = () => {
  return Boolean(
    HL_PRIVATE_KEY_LONG &&
      HL_ACCOUNT_ADDR_LONG &&
      HL_PRIVATE_KEY_SHORT &&
      HL_ACCOUNT_ADDR_SHORT,
  );
};
