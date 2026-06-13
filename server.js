import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { initDatabase, getConfig, setConfig, getAllConfig, addInvoUser, removeInvoUser, getInvoUsers } from './database.js';
import { startInvoPoller } from './invo_poller.js';

// Initialize database first
initDatabase();

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Serve built React frontend in production
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

// ── Alpaca config ─────────────────────────────────────────────────
const ALPACA_KEY    = process.env.ALPACA_KEY    || 'PK7FVW3V4B3SIYZ5ILOEEONJPZ';
const ALPACA_SECRET = process.env.ALPACA_SECRET || 'BRPgtEn6mbM57jirhZ4ftn4fXT8NK4QRugVL8Eaks52u';
const ALPACA_BASE   = 'https://paper-api.alpaca.markets/v2';
const DATA_BASE     = 'https://data.alpaca.markets/v2';
const CRYPTO_BASE   = 'https://data.alpaca.markets/v1beta3/crypto/us';

const HEADERS = {
  'APCA-API-KEY-ID':     ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type':        'application/json',
};

// Track pending order symbols to avoid duplicate orders
const pendingOrders = new Set();

async function isMarketOpen() {
  try {
    const r = await fetch(`${ALPACA_BASE}/clock`, { headers: HEADERS });
    const d = await r.json();
    return d.is_open === true;
  } catch { return false; }
}

async function hasPendingOrder(symbol) {
  try {
    const r = await fetch(`${ALPACA_BASE}/orders?status=open&limit=100`, { headers: HEADERS });
    const orders = await r.json();
    return orders.some(o => o.symbol === symbol);
  } catch { return false; }
}

const CRYPTO_MAP = {
  'BTC-USD':'BTC/USD','ETH-USD':'ETH/USD','SOL-USD':'SOL/USD',
  'XRP-USD':'XRP/USD','DOGE-USD':'DOGE/USD','LTC-USD':'LTC/USD',
  'LINK-USD':'LINK/USD','AVAX-USD':'AVAX/USD','ADA-USD':'ADA/USD',
  'SHIB-USD':'SHIB/USD',
};

const isCrypto     = t => t.endsWith('-USD');
const alpacaSym    = t => isCrypto(t) ? (CRYPTO_MAP[t] || t.replace('-','/')) : t;
const displayName  = t => isCrypto(t) ? t.replace('-USD','') : t;

// ── Bot state ─────────────────────────────────────────────────────
let invoState = {
  running: false,
  intervalId: null,
};

let state = {
  botRunning: false,
  lastScan:   null,
  signals:    {},
  prices:     {},
  positions:  {},
  trades:     [],
  account:    null,
  startupScans: 0,
  cooldowns:  {},   // ticker -> { until: timestamp, reason: string }
  ranges:     {},   // ticker -> { support, resistance, isRanging }
  recentSells: {},  // ticker -> timestamp — prevent duplicate sells
};

const defaultConfig = {
  tickers: ['AAPL','MSFT','NVDA','TSLA','ETH-USD','SOL-USD',
            'XRP-USD','DOGE-USD','AVAX-USD','LINK-USD','LTC-USD'],
  maxPositionUsd:  20,
  totalBudgetUsd:  500,
  minConfidence:   0.60,
  rsiOversold:     38,
  rsiOverbought:   62,
  profitTargetPct: 1.5,
  stopLossPct:     3.0,
  scanIntervalSec: 60,
  paperMode:       false,
};

function loadConfig() {
  const saved = getAllConfig();
  if (Object.keys(saved).length > 0) {
    console.log('[CONFIG] Loaded config from database');
    return { ...defaultConfig, ...saved };
  }
  return { ...defaultConfig };
}

function saveConfig() {
  for (const [key, value] of Object.entries(config)) {
    setConfig(key, value);
  }
  console.log('[CONFIG] Saved config to database');
}

let config = loadConfig();

let botTimer = null;

// ── Alpaca helpers ────────────────────────────────────────────────
async function alpacaGet(path, base = ALPACA_BASE) {
  const r = await fetch(`${base}${path}`, { headers: HEADERS });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text}`);
  return JSON.parse(text);
}

async function alpacaPost(path, body) {
  const r = await fetch(`${ALPACA_BASE}${path}`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function alpacaDelete(path) {
  const r = await fetch(`${ALPACA_BASE}${path}`, { method: 'DELETE', headers: HEADERS });
  if (!r.ok && r.status !== 204) throw new Error(`${r.status}`);
  return true;
}

// ── Market data ───────────────────────────────────────────────────
async function fetchBars(ticker, limit = 200) {
  try {
    const sym = alpacaSym(ticker);
    // Use a start date 6 months back to get enough history for indicators
    const start = new Date();
    start.setMonth(start.getMonth() - 6);
    const startStr = start.toISOString().split('T')[0];

    if (isCrypto(ticker)) {
      const symEncoded = encodeURIComponent(sym);
      const url = `${CRYPTO_BASE}/bars?symbols=${symEncoded}&timeframe=1Day&start=${startStr}&limit=${limit}`;
      console.log(`[DATA] Fetching crypto bars: ${url}`);
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      const bars = d.bars?.[sym] || [];
      console.log(`[DATA] ${ticker}: ${bars.length} bars`);
      return bars.map(b => ({ c:b.c, o:b.o, h:b.h, l:b.l, v:b.v }));
    } else {
      const url = `${DATA_BASE}/stocks/bars?symbols=${sym}&timeframe=1Day&start=${startStr}&limit=${limit}&feed=iex&adjustment=raw`;
      console.log(`[DATA] Fetching stock bars: ${url}`);
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      const bars = d.bars?.[sym] || [];
      console.log(`[DATA] ${ticker}: ${bars.length} bars`);
      return bars.map(b => ({ c:b.c, o:b.o, h:b.h, l:b.l, v:b.v }));
    }
  } catch(e) {
    console.error(`[DATA] fetchBars ${ticker}:`, e.message);
    return [];
  }
}

async function fetch15MinBars(ticker, limit = 200) {
  // 200 x 15min bars = ~50 hours — 2 days crypto, 8 trading days stocks
  try {
    const sym = alpacaSym(ticker);
    const start = new Date();
    start.setDate(start.getDate() - 3); // go back 3 days — range trading needs CURRENT price action
    const startStr = start.toISOString().split('T')[0];

    if (isCrypto(ticker)) {
      const symEncoded = encodeURIComponent(sym);
      const url = `${CRYPTO_BASE}/bars?symbols=${symEncoded}&timeframe=15Min&start=${startStr}&limit=${limit}`;
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      const bars = d.bars?.[sym] || [];
      console.log(`[DATA] ${ticker} 15min bars: ${bars.length}`);
      return bars.map(b => ({ c:b.c, o:b.o, h:b.h, l:b.l, v:b.v, t:b.t }));
    } else {
      const url = `${DATA_BASE}/stocks/bars?symbols=${sym}&timeframe=15Min&start=${startStr}&limit=${limit}&feed=iex&adjustment=raw`;
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      const bars = d.bars?.[sym] || [];
      console.log(`[DATA] ${ticker} 15min bars: ${bars.length}`);
      return bars.map(b => ({ c:b.c, o:b.o, h:b.h, l:b.l, v:b.v, t:b.t }));
    }
  } catch(e) {
    console.error(`[DATA] fetch15MinBars ${ticker}:`, e.message);
    return [];
  }
}

async function fetchLatestPrice(ticker) {
  try {
    const sym = alpacaSym(ticker);
    if (isCrypto(ticker)) {
      const symEncoded = encodeURIComponent(sym);
      const url = `${CRYPTO_BASE}/latest/bars?symbols=${symEncoded}`;
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      return d.bars?.[sym]?.c || null;
    } else {
      const r = await fetch(
        `${DATA_BASE}/stocks/bars/latest?symbols=${sym}&feed=iex`,
        { headers: HEADERS }
      );
      const d = await r.json();
      return d.bars?.[sym]?.c || null;
    }
  } catch(e) {
    console.error(`[PRICE] ${ticker}:`, e.message);
    return null;
  }
}



// ── Technical indicators ──────────────────────────────────────────
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = deltas.slice(0, period).filter(d => d > 0).reduce((a,b) => a+b, 0) / period;
  let avgLoss = deltas.slice(0, period).filter(d => d < 0).reduce((a,b) => a+Math.abs(b), 0) / period;
  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period-1) + Math.max(0, deltas[i])) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(0, -deltas[i])) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeMACD(closes) {
  if (closes.length < 35) return {};
  const ema = (data, span) => {
    const k = 2 / (span + 1);
    return data.reduce((acc, v, i) => {
      acc.push(i === 0 ? v : v * k + acc[i-1] * (1-k));
      return acc;
    }, []);
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine   = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine.slice(-9), 9);
  return {
    macd:       macdLine[macdLine.length - 1],
    signal:     signalLine[signalLine.length - 1],
    macdPrev:   macdLine[macdLine.length - 2],
    signalPrev: signalLine[signalLine.length - 2],
  };
}

function computeBollinger(closes, period = 20) {
  if (closes.length < period) return {};
  const slice = closes.slice(-period);
  const mid = slice.reduce((a,b) => a+b, 0) / period;
  const std = Math.sqrt(slice.reduce((a,b) => a + (b-mid)**2, 0) / period);
  return { upper: mid + 2*std, lower: mid - 2*std };
}

function computeEMA(closes, span) {
  if (closes.length < span) return null;
  const k = 2 / (span + 1);
  return closes.reduce((acc, v, i) => i === 0 ? v : acc * (1-k) + v * k, closes[0]);
}

// ── Candlestick pattern helpers ──────────────────────────────────
function isBullishEngulfing(bars) {
  if (bars.length < 2) return false;
  const p = bars[bars.length - 2], c = bars[bars.length - 1];
  return p.c < p.o && c.c > c.o && c.o <= p.c && c.c >= p.o;
}
function isBearishEngulfing(bars) {
  if (bars.length < 2) return false;
  const p = bars[bars.length - 2], c = bars[bars.length - 1];
  return p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o;
}
function isHammer(b) {
  const body = Math.abs(b.c - b.o);
  const lw = Math.min(b.c, b.o) - b.l;
  const uw = b.h - Math.max(b.c, b.o);
  return lw > body * 2 && uw < body * 0.5 && body > 0;
}
function isShootingStar(b) {
  const body = Math.abs(b.c - b.o);
  const uw = b.h - Math.max(b.c, b.o);
  const lw = Math.min(b.c, b.o) - b.l;
  return uw > body * 2 && lw < body * 0.5 && body > 0;
}
function isDoji(b) {
  const body = Math.abs(b.c - b.o);
  const range = b.h - b.l;
  return range > 0 && body / range < 0.1;
}
function isDoubleBottom(closes, lb = 20) {
  if (closes.length < lb) return false;
  const s = closes.slice(-lb);
  const half = Math.floor(lb / 2);
  const min1 = Math.min(...s.slice(0, half));
  const min2 = Math.min(...s.slice(half));
  const mid  = Math.max(...s.slice(s.indexOf(min1), half + s.slice(half).indexOf(min2)));
  return Math.abs(min1 - min2) / min1 < 0.03 && mid > min1 * 1.02;
}
function isDoubleTop(closes, lb = 20) {
  if (closes.length < lb) return false;
  const s = closes.slice(-lb);
  const half = Math.floor(lb / 2);
  const max1 = Math.max(...s.slice(0, half));
  const max2 = Math.max(...s.slice(half));
  const mid  = Math.min(...s.slice(s.indexOf(max1), half + s.slice(half).indexOf(max2)));
  return Math.abs(max1 - max2) / max1 < 0.03 && mid < max1 * 0.98;
}
function isBullishBreakout(closes, lb = 20) {
  if (closes.length < lb + 1) return false;
  const resistance = Math.max(...closes.slice(-lb - 1, -1));
  return closes[closes.length - 1] > resistance * 1.01;
}
function isBearishBreakdown(closes, lb = 20) {
  if (closes.length < lb + 1) return false;
  const support = Math.min(...closes.slice(-lb - 1, -1));
  return closes[closes.length - 1] < support * 0.99;
}
function isHigherHighs(closes, lb = 10) {
  if (closes.length < lb) return false;
  const s = closes.slice(-lb);
  return s.filter((v, i) => i > 0 && v > s[i-1]).length > lb * 0.6;
}
function isLowerLows(closes, lb = 10) {
  if (closes.length < lb) return false;
  const s = closes.slice(-lb);
  return s.filter((v, i) => i > 0 && v < s[i-1]).length > lb * 0.6;
}

// ── Range detection ──────────────────────────────────────────────
function detectRange(bars, lookback = 20) {
  // Use last 20 bars (5 hours at 15min) — detect CURRENT ranges, not historical
  if (bars.length < lookback) return { isRanging: false };
  const slice = bars.slice(-lookback);
  const highs = slice.map(b => b.h);
  const lows  = slice.map(b => b.l);

  // Find support zone (average of bottom 25% lows) and resistance zone (average of top 25% highs)
  const sortedLows  = [...lows].sort((a,b) => a-b);
  const sortedHighs = [...highs].sort((a,b) => b-a);
  const quarter  = Math.max(2, Math.floor(lookback / 4));
  const support    = sortedLows.slice(0, quarter).reduce((a,b) => a+b, 0) / quarter;
  const resistance = sortedHighs.slice(0, quarter).reduce((a,b) => a+b, 0) / quarter;
  const rangeSize  = (resistance - support) / support;

  // Count touches — price within 2% of each level counts as a touch
  let supportTouches = 0, resistanceTouches = 0;
  const supportZone    = support * 1.02;
  const resistanceZone = resistance * 0.98;
  for (const bar of slice) {
    if (bar.l <= supportZone)    supportTouches++;
    if (bar.h >= resistanceZone) resistanceTouches++;
  }

  // Range criteria:
  // 1. Range size between 1% and 8% max — not too tight (noise) not too wide (trend)
  // 2. At least 2 touches of both support AND resistance
  // 3. Price must currently be inside the range (not broken out)
  const currentPrice  = slice[slice.length - 1].c;
  // Price must be inside the range — not broken above resistance or below support
  const aboveResistance = currentPrice > resistance * 1.005; // broken above resistance
  const belowSupport    = currentPrice < support * 0.995;   // broken below support
  const insideRange     = !aboveResistance && !belowSupport;
  // Range must be valid AND price must currently be inside it
  const isRanging     = rangeSize >= 0.02 && rangeSize <= 0.08
    && supportTouches >= 2 && resistanceTouches >= 2
    && insideRange;
  if (aboveResistance) console.log(`[RANGE] ${' '.padEnd(10)} broke ABOVE resistance $${resistance?.toFixed(4)} — range invalidated`);
  if (belowSupport)    console.log(`[RANGE] ${' '.padEnd(10)} broke BELOW support $${support?.toFixed(4)} — range invalidated`);

  return { isRanging, support, resistance, rangeSize, supportTouches, resistanceTouches };
}

// ── Trend reversal detection (for cooldown recovery) ─────────────
function isTrendReversing(bars) {
  if (bars.length < 50) return false;
  const closes = bars.map(b => b.c);
  const rsi    = computeRSI(closes);
  const ema20  = computeEMA(closes, 20);
  const ema50  = computeEMA(closes, 50);

  // Signs of reversal:
  // 1. RSI recovering from oversold (crossed back above 35)
  // 2. EMA20 starting to turn up (last 3 closes above EMA20)
  // 3. Recent price action making higher lows
  const rsiRecovering = rsi !== null && rsi > 35 && rsi < 55;
  const priceAboveEma20 = ema20 && closes[closes.length-1] > ema20;
  const ema20AboveEma50 = ema20 && ema50 && ema20 > ema50;

  // Higher lows in last 10 bars
  const recent = closes.slice(-10);
  const lows   = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i] < recent[i-1] && recent[i] < recent[i+1]) lows.push(recent[i]);
  }
  const higherLows = lows.length >= 2 && lows[lows.length-1] > lows[lows.length-2];

  return rsiRecovering && priceAboveEma20 && (ema20AboveEma50 || higherLows);
}

function detectSignal(bars) {
  if (!bars || bars.length < 50)
    return { action:'hold', confidence:0, reasons:['Insufficient data'], rsi:null, price: bars?.[bars.length-1]?.c || 0 };

  const closes = bars.map(b => b.c);
  const vols   = bars.map(b => b.v);
  const price  = closes[closes.length - 1];
  let votes = 0, total = 0;
  const reasons = [];

  // ── Step 1: Determine primary trend using EMA ─────────────────
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const isUptrend = ema20 && ema50 && ema20 > ema50;
  const trendLabel = isUptrend ? 'UPTREND' : 'DOWNTREND';

  // ── Step 2: Only count confirming indicators ──────────────────
  // In uptrend: positive votes = bullish signals (we want to BUY)
  // In downtrend: positive votes = bearish signals (we want to SELL)
  // votes > 0 means "go with the trend", votes < 0 means "counter-trend noise, ignore"

  // RSI — oversold in uptrend = buy opportunity, overbought in downtrend = sell opportunity
  const rsi = computeRSI(closes);
  if (rsi !== null) {
    if (isUptrend && rsi < config.rsiOversold) {
      total += 2; votes += 2;
      reasons.push(`RSI oversold (${rsi.toFixed(1)}) — uptrend dip buy`);
    } else if (!isUptrend && rsi > config.rsiOverbought) {
      total += 2; votes += 2;
      reasons.push(`RSI overbought (${rsi.toFixed(1)}) — downtrend sell`);
    } else {
      total += 1; // neutral RSI still counts as a data point
    }
  }

  // MACD — only count crossovers that align with trend
  const { macd, signal, macdPrev, signalPrev } = computeMACD(closes);
  if (macd != null) {
    if (isUptrend && macdPrev < signalPrev && macd > signal) {
      total += 2; votes += 2;
      reasons.push('MACD bullish crossover confirms uptrend');
    } else if (!isUptrend && macdPrev > signalPrev && macd < signal) {
      total += 2; votes += 2;
      reasons.push('MACD bearish crossover confirms downtrend');
    } else {
      total += 1;
    }
  }

  // Bollinger Bands — lower band in uptrend = buy, upper band in downtrend = sell
  const { upper, lower } = computeBollinger(closes);
  if (upper != null) {
    if (isUptrend && price <= lower) {
      total += 2; votes += 2;
      reasons.push('Price at lower Bollinger — uptrend support');
    } else if (!isUptrend && price >= upper) {
      total += 2; votes += 2;
      reasons.push('Price at upper Bollinger — downtrend resistance');
    } else {
      total += 1;
    }
  }

  // EMA strength — how far apart are the EMAs? Wider gap = stronger trend
  if (ema20 && ema50) {
    total += 1; votes += 1; // always adds to confidence when trend is clear
    reasons.push(`EMA20 ${isUptrend ? 'above' : 'below'} EMA50 (${trendLabel.toLowerCase()})`);
  }

  // Volume spike — confirms trend direction
  const avgVol  = vols.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const currVol = vols[vols.length - 1];
  if (avgVol > 0 && currVol > avgVol * 1.5) {
    total += 1; votes += 1;
    reasons.push(`Volume spike confirms ${trendLabel.toLowerCase()}`);
  }

  // Candlestick patterns — only count ones matching the trend
  if (isUptrend) {
    if (isBullishEngulfing(bars))        { total += 2; votes += 2; reasons.push('Bullish engulfing — uptrend continuation'); }
    if (isHammer(bars[bars.length - 1])) { total += 1; votes += 1; reasons.push('Hammer — uptrend reversal from dip'); }
    if (isDoubleBottom(closes))          { total += 3; votes += 3; reasons.push('Double bottom — uptrend confirmed'); }
    if (isBullishBreakout(closes))       { total += 2; votes += 2; reasons.push('Bullish breakout above resistance'); }
    if (isHigherHighs(closes))           { total += 1; votes += 1; reasons.push('Higher highs — uptrend strengthening'); }
    if (isDoji(bars[bars.length - 1]))   { total += 1; votes += 1; reasons.push('Doji — pause before uptrend continues'); }
  } else {
    if (isBearishEngulfing(bars))             { total += 2; votes += 2; reasons.push('Bearish engulfing — downtrend continuation'); }
    if (isShootingStar(bars[bars.length - 1])){ total += 1; votes += 1; reasons.push('Shooting star — downtrend reversal from peak'); }
    if (isDoubleTop(closes))                  { total += 3; votes += 3; reasons.push('Double top — downtrend confirmed'); }
    if (isBearishBreakdown(closes))           { total += 2; votes += 2; reasons.push('Bearish breakdown below support'); }
    if (isLowerLows(closes))                  { total += 1; votes += 1; reasons.push('Lower lows — downtrend strengthening'); }
    if (isDoji(bars[bars.length - 1]))        { total += 1; votes += 1; reasons.push('Doji — pause before downtrend continues'); }
  }

  if (total === 0) return { action:'hold', confidence:0, reasons:['No data'], rsi, price };

  const confidence = votes / total;
  let action = 'hold';

  // In uptrend — high confidence = BUY
  // In downtrend — high confidence = SELL
  if (confidence >= config.minConfidence) {
    action = isUptrend ? 'buy' : 'sell';
  }

  console.log(`[SIGNAL] ${trendLabel} ${action.padEnd(4)} conf=${(confidence*100).toFixed(0)}% votes=${votes}/${total} | ${reasons.slice(0,2).join(', ')}`);
  return {
    action,
    confidence: Math.round(confidence * 100) / 100,
    reasons: reasons.length ? reasons : ['No strong signal'],
    rsi: rsi ? Math.round(rsi * 10) / 10 : null,
    price,
    trend: trendLabel,
    votes, total
  };
}

// ── Account & position sync ───────────────────────────────────────
async function refreshAccount() {
  try {
    state.account = await alpacaGet('/account');
  } catch(e) { console.error('[ACCOUNT]', e.message); }
}

function matchTicker(alpacaSymbol) {
  // Try exact match first (e.g. AAPL)
  if (config.tickers.includes(alpacaSymbol)) return alpacaSymbol;
  // Try CRYPTO_MAP match (e.g. BTC/USD -> BTC-USD)
  const fromMap = Object.keys(CRYPTO_MAP).find(k => CRYPTO_MAP[k] === alpacaSymbol);
  if (fromMap) return fromMap;
  // Try ETHUSD -> ETH-USD (Alpaca sometimes returns without slash)
  const withDash = alpacaSymbol.replace(/([A-Z]+)(USD)$/, '$1-$2');
  if (config.tickers.includes(withDash)) return withDash;
  // Try ETH/USD -> ETH-USD
  const slashToDash = alpacaSymbol.replace('/', '-');
  if (config.tickers.includes(slashToDash)) return slashToDash;
  return null;
}

async function syncPositions() {
  try {
    const alpacaPos = await alpacaGet('/positions');
    console.log(`[SYNC] Found ${alpacaPos.length} positions on Alpaca`);
    const synced = {};
    for (const pos of alpacaPos) {
      console.log(`[SYNC] Raw position symbol: ${pos.symbol}`);
      const ticker = matchTicker(pos.symbol);
      if (!ticker) {
        console.log(`[SYNC] Could not match ${pos.symbol} to watchlist — skipping`);
        continue;
      }
      console.log(`[SYNC] Matched ${pos.symbol} -> ${ticker}`);
      synced[ticker] = {
        shares:        parseFloat(pos.qty),
        avg_cost:      parseFloat(pos.avg_entry_price),
        current_price: parseFloat(pos.current_price),
        pnl:           parseFloat(pos.unrealized_pl),
        pnl_pct:       parseFloat(pos.unrealized_plpc) * 100,
        asset_type:    isCrypto(ticker) ? 'crypto' : 'stock',
        synced:        true,
      };
    }
    // Keep paper positions that aren't in Alpaca
    for (const [t, p] of Object.entries(state.positions)) {
      if (!p.synced && !synced[t]) synced[t] = p;
    }
    state.positions = synced;
    console.log(`[SYNC] Done — ${Object.keys(synced).length} positions loaded`);
  } catch(e) { console.error('[SYNC]', e.message); }
}

// ── Trade execution ───────────────────────────────────────────────
async function executeBuy(ticker, price) {
  const shares = config.maxPositionUsd / price;
  const logEntry = {
    time: new Date().toISOString(), ticker, action: 'BUY',
    price, shares, paper: config.paperMode,
    asset_type: isCrypto(ticker) ? 'crypto' : 'stock',
  };

  if (!config.paperMode) {
    try {
      // Alpaca crypto orders use BTC/USD format with slash
      const orderSym = isCrypto(ticker)
        ? alpacaSym(ticker)  // e.g. BTC/USD
        : ticker;            // e.g. AAPL
      // For crypto, use qty instead of notional to avoid ambiguity
      // qty = dollars / price, rounded to 8 decimal places
      const orderPayload = isCrypto(ticker) ? {
        symbol:        orderSym,
        qty:           (config.maxPositionUsd / price).toFixed(8),
        side:          'buy',
        type:          'market',
        time_in_force: 'gtc',
      } : {
        symbol:        orderSym,
        notional:      config.maxPositionUsd.toFixed(2),
        side:          'buy',
        type:          'market',
        time_in_force: 'day',
      };
      console.log(`[ORDER] Placing buy payload: ${JSON.stringify(orderPayload)}`);
      const order = await alpacaPost('/orders', orderPayload);
      console.log(`[ORDER] BUY response: status=${order.status} id=${order.id} symbol=${order.symbol} asset_class=${order.asset_class} filled_qty=${order.filled_qty}`);
      logEntry.status   = order.status || 'submitted';
      logEntry.order_id = order.id;
    } catch(e) {
      logEntry.status = `error: ${e.message}`;
      console.error(`[ORDER] BUY ${ticker} failed:`, e.message);
      state.trades.unshift(logEntry);
      return e.message;
    }
  } else {
    logEntry.status = 'paper';
    state.positions[ticker] = {
      shares, avg_cost: price, current_price: price,
      pnl: 0, pnl_pct: 0,
      asset_type: isCrypto(ticker) ? 'crypto' : 'stock',
    };
  }

  state.trades.unshift(logEntry);
  if (!config.paperMode) await syncPositions();
  await refreshAccount();
  return null;
}

async function executeSell(ticker, price) {
  const pos = state.positions[ticker];
  if (!pos) return 'No position found';
  const pnl = (price - pos.avg_cost) * pos.shares;
  const logEntry = {
    time: new Date().toISOString(), ticker, action: 'SELL',
    price, shares: pos.shares, pnl, paper: config.paperMode,
    asset_type: pos.asset_type,
  };

  if (!config.paperMode) {
    try {
      const sellSym = isCrypto(ticker) ? alpacaSym(ticker) : ticker;  // BTC/USD or AAPL
      console.log(`[ORDER] Placing sell: symbol=${sellSym}`);
      // Position endpoint uses BTCUSD format (no slash) even though orders use BTC/USD
      const positionSym = sellSym.replace('/', '');
      await alpacaDelete(`/positions/${positionSym}`);
      logEntry.status = 'executed';
      console.log(`[ORDER] SELL ${ticker} @ ${price} pnl=${pnl.toFixed(2)}`);
    } catch(e) {
      logEntry.status = `error: ${e.message}`;
      console.error(`[ORDER] SELL ${ticker} failed:`, e.message);
      state.trades.unshift(logEntry);
      return e.message;
    }
  } else {
    logEntry.status = 'paper';
    delete state.positions[ticker];
  }

  state.trades.unshift(logEntry);
  if (!config.paperMode) await syncPositions();
  await refreshAccount();
  return null;
}

// ── Bot scan loop ─────────────────────────────────────────────────
async function runScan() {
  console.log(`[SCAN] Starting — ${config.tickers.length} tickers`);
  for (const ticker of config.tickers) {
    try {
      const bars       = await fetchBars(ticker, 100);
      const hourlyBars = await fetch15MinBars(ticker, 200);
      const signal     = detectSignal(bars);
      const price      = await fetchLatestPrice(ticker) || signal.price;
      signal.price     = price;
      state.signals[ticker] = signal;
      state.prices[ticker]  = price;

      // Update current price in positions
      if (state.positions[ticker]) {
        const pos = state.positions[ticker];
        pos.current_price = price;
        pos.pnl     = (price - pos.avg_cost) * pos.shares;
        pos.pnl_pct = (price - pos.avg_cost) / pos.avg_cost * 100;
      }

      const inPos = ticker in state.positions;

      // Exit logic — skip selling on first 2 scans after startup to avoid selling on restart
      if (inPos && price && price > 0 && state.startupScans > 2) {
        const pos = state.positions[ticker];
        const pct = (price - pos.avg_cost) / pos.avg_cost * 100;
        const range = state.ranges[ticker];
        const posIsRanging = range?.isRanging && pos.avg_cost <= range.support * 1.03;

        // Determine profit target — use range resistance if in range mode, else fixed %
        const profitTarget = posIsRanging && range?.resistance
          ? (range.resistance - pos.avg_cost) / pos.avg_cost * 100
          : config.profitTargetPct;

        // Safety override: if up more than profitTargetPct, always sell even in range mode
        const safetyOverride = pct >= config.profitTargetPct && posIsRanging;
        // Don't sell same ticker twice within 2 minutes — prevents duplicate sell orders
        const recentSell = state.recentSells[ticker];
        const soldRecently = recentSell && Date.now() - recentSell < 2 * 60 * 1000;

        if ((pct >= profitTarget || safetyOverride) && !soldRecently) {
          const reason = safetyOverride
            ? `safety override — up ${pct.toFixed(1)}% exceeds ${config.profitTargetPct}% minimum`
            : posIsRanging ? `range resistance hit ($${range.resistance?.toFixed(4)})`
            : `profit target (+${pct.toFixed(1)}%)`;
          console.log(`[BOT] Selling ${ticker} — ${reason}`);
          state.recentSells[ticker] = Date.now();
          await executeSell(ticker, price);
        } else if (pct <= -config.stopLossPct) {
          if (!soldRecently) {
            console.log(`[BOT] Selling ${ticker} — stop loss hit (${pct.toFixed(1)}%) — adding cooldown`);
            state.cooldowns[ticker] = {
              until:  Date.now() + 30 * 60 * 1000,
              reason: `stop loss @ $${price?.toFixed(4)}`,
            };
            state.recentSells[ticker] = Date.now();
            await executeSell(ticker, price);
          }
        } else if (signal.action === 'sell' && !posIsRanging && !soldRecently) {
          console.log(`[BOT] Selling ${ticker} — sell signal`);
          state.recentSells[ticker] = Date.now();
          await executeSell(ticker, price);
        }
      }

      // Detect range using hourly bars for intraday precision
      const rangeInfo = detectRange(hourlyBars.length >= 20 ? hourlyBars : bars);
      state.ranges[ticker] = rangeInfo;
      if (rangeInfo.isRanging) {
        console.log(`[RANGE] ${ticker} ranging $${rangeInfo.support?.toFixed(4)}–$${rangeInfo.resistance?.toFixed(4)} (${rangeInfo.rangeSize ? (rangeInfo.rangeSize*100).toFixed(1) : '?'}% range, ${rangeInfo.supportTouches} support / ${rangeInfo.resistanceTouches} resistance touches)`);
      }

      // Check cooldown
      const cooldown = state.cooldowns[ticker];
      const onCooldown = cooldown && Date.now() < cooldown.until;

      // If on cooldown, check if trend is reversing — if so, lift cooldown early
      if (onCooldown) {
        if (isTrendReversing(bars)) {
          console.log(`[BOT] ${ticker} trend reversing — lifting cooldown early`);
          delete state.cooldowns[ticker];
        } else {
          const remaining = Math.round((cooldown.until - Date.now()) / 60000);
          state.signals[ticker].blocked = `Cooldown: ${cooldown.reason} (${remaining}m left)`;
        }
      }

      // Entry logic
      const stillOnCooldown = state.cooldowns[ticker] && Date.now() < state.cooldowns[ticker].until;

      if (!inPos && !stillOnCooldown) {
        const deployed = Object.values(state.positions)
          .reduce((s, p) => s + p.avg_cost * p.shares, 0);

        if (deployed + config.maxPositionUsd > config.totalBudgetUsd) {
          state.signals[ticker].blocked = 'Budget cap reached';
        } else if (!isCrypto(ticker) && !(await isMarketOpen())) {
          state.signals[ticker].blocked = 'Market closed';
        } else {
          const sym = isCrypto(ticker) ? (CRYPTO_MAP[ticker] || ticker.replace('-','/')).replace('/','') : ticker;
          if (await hasPendingOrder(sym)) {
            state.signals[ticker].blocked = 'Order already pending';
          } else if (rangeInfo.isRanging) {
            // Range trading — but still respect market hours for stocks
            if (!isCrypto(ticker) && !(await isMarketOpen())) {
              state.signals[ticker].blocked = 'Market closed';
            } else {
              const currentPrice = price;
              const nearSupport  = currentPrice <= rangeInfo.support * 1.02;
              if (nearSupport) {
                console.log(`[BOT] ${ticker} RANGE BUY near support $${rangeInfo.support?.toFixed(4)} resistance $${rangeInfo.resistance?.toFixed(4)}`);
                state.signals[ticker].rangeMode = true;
                state.signals[ticker].support    = rangeInfo.support;
                state.signals[ticker].resistance = rangeInfo.resistance;
                await executeBuy(ticker, price);
              } else {
                state.signals[ticker].blocked = `Ranging — waiting for support ($${rangeInfo.support?.toFixed(4)})`;
              }
            }
          } else if (signal.action === 'buy') {
            console.log(`[BOT] Buying ${ticker} @ ${price}`);
            await executeBuy(ticker, price);
          }
        }
      }
    } catch(e) {
      console.error(`[SCAN] ${ticker} error:`, e.message);
    }
  }

  await syncPositions();
  await refreshAccount();
  state.lastScan = new Date().toISOString();
  state.startupScans++;
  console.log(`[SCAN] Done — ${Object.keys(state.signals).length} signals, ${Object.keys(state.positions).length} positions (scan #${state.startupScans})`);
}

// ── API routes ────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({
  botRunning: state.botRunning,
  lastScan:   state.lastScan,
  paperMode:  config.paperMode,
  tickers:    config.tickers,
}));

app.get('/api/account', (req, res) => {
  const deployed = Object.values(state.positions)
    .reduce((s, p) => s + (p.avg_cost * p.shares), 0);
  res.json({
    ...state.account,
    deployed_capital:  Math.round(deployed * 100) / 100,
    total_budget_usd:  config.totalBudgetUsd,
    budget_remaining:  Math.max(0, config.totalBudgetUsd - deployed),
    budget_used_pct:   config.totalBudgetUsd > 0 ? Math.round(deployed / config.totalBudgetUsd * 10000) / 100 : 0,
  });
});

app.get('/api/signals',   (req, res) => res.json(state.signals));

// ── Mirror trade endpoint (receives signals from Invo bot) ────────
app.post('/api/mirror-trade', async (req, res) => {
  const { ticker, action, source } = req.body;
  if (!ticker || !action) return res.status(400).json({ error: 'ticker and action required' });

  const price = state.prices[ticker] || await fetchLatestPrice(ticker);
  if (!price) return res.status(404).json({ error: `No price found for ${ticker}` });

  console.log(`[MIRROR] ${source || 'invo'} signal: ${action.toUpperCase()} ${ticker} @ ${price}`);

  try {
    if (action === 'buy') {
      // Check budget
      const deployed = Object.values(state.positions)
        .reduce((s, p) => s + p.avg_cost * p.shares, 0);
      if (deployed + config.maxPositionUsd > config.totalBudgetUsd) {
        return res.status(400).json({ error: 'Budget cap reached' });
      }
      if (state.positions[ticker]) {
        return res.status(400).json({ error: `Already have position in ${ticker}` });
      }
      await executeBuy(ticker, price);
      res.json({ success: true, action: 'buy', ticker, price });

    } else if (action === 'sell') {
      if (!state.positions[ticker]) {
        return res.status(400).json({ error: `No position in ${ticker} to sell` });
      }
      await executeSell(ticker, price);
      res.json({ success: true, action: 'sell', ticker, price });

    } else {
      res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch(e) {
    console.error(`[MIRROR] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Invo controls ────────────────────────────────────────────────
app.get('/api/invo/status', (req, res) => {
  res.json({ running: invoState.running, users: getInvoUsers() });
});

app.post('/api/invo/start', async (req, res) => {
  if (invoState.running) return res.json({ success: true, message: 'Already running' });
  invoState.running = true;
  console.log('[INVO] Poller started via API');
  startInvoPoller(invoState).catch(e => console.error('[INVO] Poller error:', e.message));
  res.json({ success: true, message: 'Invo poller started' });
});

app.post('/api/invo/stop', (req, res) => {
  if (!invoState.running) return res.json({ success: true, message: 'Already stopped' });
  invoState.running = false;
  if (invoState.intervalId) {
    clearInterval(invoState.intervalId);
    invoState.intervalId = null;
  }
  console.log('[INVO] Poller stopped via API');
  res.json({ success: true, message: 'Invo poller stopped' });
});

app.get('/api/invo/users', (req, res) => res.json(getInvoUsers()));

app.post('/api/invo/users/add', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  addInvoUser(username);
  res.json({ success: true, users: getInvoUsers() });
});

app.post('/api/invo/users/remove', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  removeInvoUser(username);
  res.json({ success: true, users: getInvoUsers() });
});
app.get('/api/cooldowns', (req, res) => res.json(state.cooldowns));
app.get('/api/ranges',    (req, res) => res.json(state.ranges));
app.get('/api/positions', (req, res) => res.json(state.positions));
app.get('/api/trades',    (req, res) => res.json(state.trades.slice(0, 50)));
app.get('/api/config',    (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  const allowed = ['tickers','maxPositionUsd','totalBudgetUsd','minConfidence',
    'rsiOversold','rsiOverbought','profitTargetPct','stopLossPct','scanIntervalSec','paperMode'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) config[key] = req.body[key];
  }
  saveConfig();
  res.json({ success: true, config });
});

app.post('/api/connect', async (req, res) => {
  try {
    const account = await alpacaGet('/account');
    state.account = account;
    await syncPositions();
    res.json({ success: true, account });
  } catch(e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/bot/start', async (req, res) => {
  if (state.botRunning) return res.json({ success: true, message: 'Already running' });
  state.botRunning = true;
  await runScan();
  botTimer = setInterval(runScan, config.scanIntervalSec * 1000);
  res.json({ success: true });
});

app.post('/api/bot/stop', (req, res) => {
  clearInterval(botTimer);
  state.botRunning = false;
  res.json({ success: true });
});

app.post('/api/scan', async (req, res) => {
  await runScan();
  res.json({ success: true, signals: state.signals, count: Object.keys(state.signals).length });
});

app.post('/api/sync', async (req, res) => {
  await syncPositions();
  await refreshAccount();
  res.json({ success: true, positions: state.positions });
});

app.post('/api/buy/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!config.tickers.includes(ticker))
    return res.status(400).json({ success: false, error: 'Ticker not in watchlist' });
  const price = await fetchLatestPrice(ticker) || state.prices[ticker];
  if (!price)
    return res.status(400).json({ success: false, error: 'No price available — run a scan first' });
  const err = await executeBuy(ticker, price);
  if (err) return res.status(400).json({ success: false, error: err });
  res.json({ success: true, ticker, price, amount: config.maxPositionUsd, paper: config.paperMode });
});

app.post('/api/sell/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!state.positions[ticker])
    return res.status(400).json({ success: false, error: `No open position for ${ticker}` });
  const price = await fetchLatestPrice(ticker) || state.positions[ticker].current_price;
  const err = await executeSell(ticker, price);
  if (err) return res.status(400).json({ success: false, error: err });
  res.json({ success: true, ticker, price, paper: config.paperMode });
});

// Serve React app for any non-API route
app.get('*', (req, res) => {
  const indexPath = join(__dirname, 'dist', 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ status: 'Trade engine API running', frontend: 'not built' });
  }
});

// ── Start server ──────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`[SERVER] Trade engine running on port ${PORT}`);
  await refreshAccount();
  await syncPositions();
  // Invo poller is controlled via API — don't auto-start
  console.log('[INVO] Poller ready — use /api/invo/start to begin');
  console.log(`[SERVER] Connected to Alpaca — paper mode: ${config.paperMode}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[SERVER] Port ${PORT} in use — waiting 3s then retrying...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, 3000);
  } else {
    console.error('[SERVER] Unexpected error:', err);
  }
});
