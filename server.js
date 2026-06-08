import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app  = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// ── Alpaca config ─────────────────────────────────────────────────
const ALPACA_KEY    = 'PK7FVW3V4B3SIYZ5ILOEEONJPZ';
const ALPACA_SECRET = 'BRPgtEn6mbM57jirhZ4ftn4fXT8NK4QRugVL8Eaks52u';
const ALPACA_BASE   = 'https://paper-api.alpaca.markets/v2';
const DATA_BASE     = 'https://data.alpaca.markets/v2';

const HEADERS = {
  'APCA-API-KEY-ID':     ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type':        'application/json',
};

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
let state = {
  botRunning: false,
  lastScan:   null,
  signals:    {},
  prices:     {},
  positions:  {},
  trades:     [],
  account:    null,
};

let config = {
  tickers: ['AAPL','MSFT','NVDA','BTC-USD','ETH-USD','SOL-USD',
            'XRP-USD','DOGE-USD','AVAX-USD','LINK-USD','LTC-USD'],
  maxPositionUsd:  10,
  totalBudgetUsd:  50,
  minConfidence:   0.60,
  rsiOversold:     38,
  rsiOverbought:   62,
  profitTargetPct: 3.0,
  stopLossPct:     2.0,
  scanIntervalSec: 120,
  paperMode:       true,
};

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
async function fetchBars(ticker, limit = 100) {
  try {
    const sym = alpacaSym(ticker);
    if (isCrypto(ticker)) {
      // Crypto needs more history — use 200 bars to ensure enough for indicators
      const url = `${DATA_BASE}/crypto/us/bars?symbols=${encodeURIComponent(sym)}&timeframe=1Day&limit=200`;
      console.log(`[DATA] Fetching crypto bars: ${url}`);
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      console.log(`[DATA] ${ticker} crypto response keys:`, Object.keys(d));
      // Alpaca returns bars nested under the symbol
      const bars = d.bars?.[sym] || d.bars?.[sym.replace('/','%2F')] || [];
      console.log(`[DATA] ${ticker}: ${bars.length} bars returned`);
      return bars.map(b => ({ c:b.c, o:b.o, h:b.h, l:b.l, v:b.v }));
    } else {
      // Stocks — use daily bars for more history (hourly can be sparse)
      const url = `${DATA_BASE}/stocks/bars?symbols=${sym}&timeframe=1Day&limit=200&feed=iex`;
      console.log(`[DATA] Fetching stock bars: ${url}`);
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      const bars = d.bars?.[sym] || [];
      console.log(`[DATA] ${ticker}: ${bars.length} bars returned`);
      return bars.map(b => ({ c:b.c, o:b.o, h:b.h, l:b.l, v:b.v }));
    }
  } catch(e) {
    console.error(`[DATA] fetchBars ${ticker}:`, e.message);
    return [];
  }
}

async function fetchLatestPrice(ticker) {
  try {
    const sym = alpacaSym(ticker);
    if (isCrypto(ticker)) {
      const url = `${DATA_BASE}/crypto/us/latest/bars?symbols=${encodeURIComponent(sym)}`;
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      console.log(`[PRICE] ${ticker} latest response:`, JSON.stringify(d).slice(0, 200));
      return d.bars?.[sym]?.c || null;
    } else {
      const r = await fetch(
        `${DATA_BASE}/stocks/trades/latest?symbols=${sym}&feed=iex`,
        { headers: HEADERS }
      );
      const d = await r.json();
      return d.trades?.[sym]?.p || null;
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

function detectSignal(bars) {
  if (!bars || bars.length < 50)
    return { action:'hold', confidence:0, reasons:['Insufficient data'], rsi:null, price: bars?.[bars.length-1]?.c || 0 };

  const closes = bars.map(b => b.c);
  const vols   = bars.map(b => b.v);
  const price  = closes[closes.length - 1];
  let buyVotes = 0, sellVotes = 0, total = 0;
  const reasons = [];

  const rsi = computeRSI(closes);
  if (rsi !== null) {
    total += 2;
    if (rsi < config.rsiOversold)     { buyVotes  += 2; reasons.push(`RSI oversold (${rsi.toFixed(1)})`); }
    else if (rsi > config.rsiOverbought) { sellVotes += 2; reasons.push(`RSI overbought (${rsi.toFixed(1)})`); }
  }

  const { macd, signal, macdPrev, signalPrev } = computeMACD(closes);
  if (macd != null) {
    total += 2;
    if (macdPrev < signalPrev && macd > signal)   { buyVotes  += 2; reasons.push('MACD bullish crossover'); }
    else if (macdPrev > signalPrev && macd < signal) { sellVotes += 2; reasons.push('MACD bearish crossover'); }
  }

  const { upper, lower } = computeBollinger(closes);
  if (upper != null) {
    total += 2;
    if (price <= lower) { buyVotes  += 2; reasons.push('Price at lower Bollinger Band'); }
    else if (price >= upper) { sellVotes += 2; reasons.push('Price at upper Bollinger Band'); }
  }

  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  if (ema20 && ema50) {
    total += 1;
    if (ema20 > ema50) { buyVotes  += 1; reasons.push('EMA20 above EMA50 (uptrend)'); }
    else               { sellVotes += 1; reasons.push('EMA20 below EMA50 (downtrend)'); }
  }

  const avgVol  = vols.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const currVol = vols[vols.length - 1];
  if (avgVol > 0 && currVol > avgVol * 1.5) {
    total += 1;
    if (buyVotes > sellVotes) { buyVotes  += 1; reasons.push('Volume spike confirms bullish'); }
    else                      { sellVotes += 1; reasons.push('Volume spike confirms bearish'); }
  }

  if (total === 0) return { action:'hold', confidence:0, reasons:['No data'], rsi, price };

  const confidence = Math.max(buyVotes, sellVotes) / total;
  let action = 'hold';
  if (buyVotes > sellVotes && confidence >= config.minConfidence) action = 'buy';
  else if (sellVotes > buyVotes && confidence >= config.minConfidence) action = 'sell';

  console.log(`[SIGNAL] ${' '.padEnd(12)} action=${action} conf=${(confidence*100).toFixed(0)}% buy=${buyVotes} sell=${sellVotes}/${total}`);
  return { action, confidence: Math.round(confidence*100)/100, reasons: reasons.length ? reasons : ['No strong signal'], rsi: rsi ? Math.round(rsi*10)/10 : null, price };
}

// ── Account & position sync ───────────────────────────────────────
async function refreshAccount() {
  try {
    state.account = await alpacaGet('/account');
  } catch(e) { console.error('[ACCOUNT]', e.message); }
}

async function syncPositions() {
  try {
    const alpacaPos = await alpacaGet('/positions');
    const synced = {};
    for (const pos of alpacaPos) {
      const ticker = Object.keys(CRYPTO_MAP).find(k => CRYPTO_MAP[k] === pos.symbol) || pos.symbol;
      if (!config.tickers.includes(ticker)) continue;
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
      const order = await alpacaPost('/orders', {
        symbol:        alpacaSym(ticker),
        notional:      config.maxPositionUsd.toString(),
        side:          'buy',
        type:          'market',
        time_in_force: isCrypto(ticker) ? 'gtc' : 'day',
      });
      logEntry.status   = 'executed';
      logEntry.order_id = order.id;
      console.log(`[ORDER] BUY ${ticker} $${config.maxPositionUsd} @ ${price} — order ${order.id}`);
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
      await alpacaDelete(`/positions/${encodeURIComponent(alpacaSym(ticker))}`);
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
      const bars   = await fetchBars(ticker, 100);
      const signal = detectSignal(bars);
      const price  = await fetchLatestPrice(ticker) || signal.price;
      signal.price = price;
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

      // Exit logic
      if (inPos) {
        const pos = state.positions[ticker];
        const pct = (price - pos.avg_cost) / pos.avg_cost * 100;
        if (pct >= config.profitTargetPct) {
          console.log(`[BOT] Selling ${ticker} — profit target hit (+${pct.toFixed(1)}%)`);
          await executeSell(ticker, price);
        } else if (pct <= -config.stopLossPct) {
          console.log(`[BOT] Selling ${ticker} — stop loss hit (${pct.toFixed(1)}%)`);
          await executeSell(ticker, price);
        } else if (signal.action === 'sell') {
          console.log(`[BOT] Selling ${ticker} — sell signal`);
          await executeSell(ticker, price);
        }
      }

      // Entry logic
      if (!inPos && signal.action === 'buy') {
        const deployed = Object.values(state.positions)
          .reduce((s, p) => s + p.avg_cost * p.shares, 0);
        if (deployed + config.maxPositionUsd <= config.totalBudgetUsd) {
          console.log(`[BOT] Buying ${ticker} @ ${price}`);
          await executeBuy(ticker, price);
        } else {
          state.signals[ticker].blocked = 'Budget cap reached';
        }
      }
    } catch(e) {
      console.error(`[SCAN] ${ticker} error:`, e.message);
    }
  }

  await syncPositions();
  await refreshAccount();
  state.lastScan = new Date().toISOString();
  console.log(`[SCAN] Done — ${Object.keys(state.signals).length} signals, ${Object.keys(state.positions).length} positions`);
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
app.get('/api/positions', (req, res) => res.json(state.positions));
app.get('/api/trades',    (req, res) => res.json(state.trades.slice(0, 50)));
app.get('/api/config',    (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  const allowed = ['tickers','maxPositionUsd','totalBudgetUsd','minConfidence',
    'rsiOversold','rsiOverbought','profitTargetPct','stopLossPct','scanIntervalSec','paperMode'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) config[key] = req.body[key];
  }
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

// ── Start server ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[SERVER] Trade engine running on port ${PORT}`);
  await refreshAccount();
  await syncPositions();
  console.log(`[SERVER] Connected to Alpaca — paper mode: ${config.paperMode}`);
});
