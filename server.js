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
    if (isDoubleTop(closes))                  { total += 3; votes += 3; reasons.push('Double top — downtrend c