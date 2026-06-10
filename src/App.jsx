import { useState, useEffect, useCallback, useRef } from "react";

const API = "/api";
const fetcher = (url, opts) =>
  fetch(url, { headers: { "Content-Type": "application/json" }, ...opts }).then(r => r.json());

const isCrypto    = t => t.endsWith("-USD");
const displayName = t => isCrypto(t) ? t.replace("-USD","") : t;

const fmtPrice = v => {
  if (v == null) return "—";
  const n = parseFloat(v);
  if (n < 0.0001) return `$${n.toFixed(8)}`;
  if (n < 0.01)   return `$${n.toFixed(6)}`;
  if (n < 1)      return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmt$ = (v, forceDecimals = false) => {
  if (v == null) return "—";
  const n = parseFloat(v);
  if (forceDecimals && Math.abs(n) < 1 && n !== 0)
    return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// ── Design tokens ─────────────────────────────────────────────────
const C = {
  bg: "#07090F", surface: "#0D1420", surface2: "#111C2E",
  border: "#1A2840", borderFaint: "#0F1A28",
  text: "#DDE8F5", textMuted: "#344D66", textDim: "#5E7A96",
  green: "#00E5A0", greenDim: "#021F16",
  red: "#FF3D5A", redDim: "#260410",
  amber: "#FFAA33", amberDim: "#261A00",
  blue: "#3B9EFF", blueDim: "#081830",
  purple: "#A78BFA", purpleDim: "#160E38",
};

function Pill({ label, variant }) {
  const map = {
    buy:    [C.greenDim, C.green],
    sell:   [C.redDim,   C.red],
    hold:   [C.surface2, C.textDim],
    BUY:    [C.blueDim,  C.blue],
    SELL:   [C.amberDim, C.amber],
    crypto: [C.purpleDim,C.purple],
    stock:  [C.greenDim, C.green],
    paper:  [C.amberDim, C.amber],
    live:   [C.redDim,   C.red],
    on:     [C.greenDim, C.green],
    off:    [C.surface2, C.textDim],
  };
  const [bg, color] = map[variant] || map[label] || map.hold;
  return (
    <span style={{
      background: bg, color, fontSize: 9, fontWeight: 800,
      padding: "3px 7px", borderRadius: 3, letterSpacing: "0.08em",
      textTransform: "uppercase", border: `1px solid ${color}22`,
      whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function Btn({ children, onClick, disabled, color = "default" }) {
  const col = color === "green" ? C.green : color === "red" ? C.red : C.textDim;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: "none", border: `1px solid ${col}33`, borderRadius: 5,
      padding: "6px 14px", fontSize: 10, cursor: disabled ? "not-allowed" : "pointer",
      color: col, fontWeight: 800, letterSpacing: "0.08em",
      textTransform: "uppercase", opacity: disabled ? 0.4 : 1,
      fontFamily: "inherit", transition: "opacity 0.15s",
    }}>{children}</button>
  );
}

const Card = ({ children, style }) => (
  <div style={{
    background: C.surface, border: `1px solid ${C.border}`,
    borderRadius: 8, overflow: "hidden", ...style,
  }}>{children}</div>
);

const SectionLabel = ({ children }) => (
  <p style={{
    fontSize: 9, fontWeight: 800, textTransform: "uppercase",
    letterSpacing: "0.14em", color: C.textMuted,
    padding: "9px 16px 7px", borderBottom: `1px solid ${C.borderFaint}`,
    margin: 0,
  }}>{children}</p>
);

function Metric({ label, value, color }) {
  return (
    <div style={{ background: C.surface2, borderRadius: 7, padding: "12px 14px" }}>
      <p style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase",
        letterSpacing: "0.12em", color: C.textMuted, margin: "0 0 6px" }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 800, margin: 0,
        fontVariantNumeric: "tabular-nums", color: color || C.text }}>{value ?? "—"}</p>
    </div>
  );
}

function SignalRow({ ticker, signal, onBuy }) {
  const [buying, setBuying] = useState(false);
  const crypto = isCrypto(ticker);
  const confColor = signal.confidence >= 0.7 ? C.green
    : signal.confidence >= 0.5 ? C.amber : C.textDim;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "100px 90px 48px 1fr 58px 50px 55px",
      gap: 10, padding: "9px 16px", borderBottom: `1px solid ${C.borderFaint}`,
      alignItems: "center", fontSize: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontWeight: 700, color: C.text }}>{displayName(ticker)}</span>
        <Pill label={crypto ? "crypto" : "stock"} variant={crypto ? "crypto" : "stock"} />
      </div>
      <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{fmtPrice(signal.price)}</span>
      <span style={{ color: C.textDim, fontSize: 11 }}>{signal.rsi?.toFixed(1) || "—"}</span>
      <span style={{ fontSize: 10, color: signal.blocked ? C.amber : signal.rangeMode ? C.purple : C.textDim, overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {signal.blocked ? `⚠ ${signal.blocked}` : signal.rangeMode ? `↔ Range $${signal.support?.toFixed(3)}–$${signal.resistance?.toFixed(3)}` : signal.reasons?.[0] || "—"}
      </span>
      <Pill label={signal.action} variant={signal.action} />
      <span style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: confColor }}>
        {Math.round((signal.confidence || 0) * 100)}%
      </span>
      <button onClick={async () => { setBuying(true); await onBuy(); setBuying(false); }}
        disabled={buying} style={{
          background: buying ? C.borderFaint : C.greenDim,
          border: `1px solid ${C.green}33`, borderRadius: 4,
          padding: "4px 0", fontSize: 10, cursor: "pointer",
          color: C.green, fontWeight: 700, width: "100%",
          opacity: buying ? 0.5 : 1, fontFamily: "inherit",
        }}>{buying ? "..." : "Buy"}</button>
    </div>
  );
}

function PositionRow({ ticker, pos, onSell }) {
  const [selling, setSelling] = useState(false);
  const crypto = isCrypto(ticker);
  const up = (pos.pnl || 0) >= 0;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "110px 90px 90px 1fr 120px 60px",
      gap: 10, padding: "9px 16px", borderBottom: `1px solid ${C.borderFaint}`,
      alignItems: "center", fontSize: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontWeight: 700, color: C.text }}>{displayName(ticker)}</span>
        <Pill label={crypto ? "crypto" : "stock"} variant={crypto ? "crypto" : "stock"} />
      </div>
      <span style={{ color: C.textDim }}>{fmtPrice(pos.avg_cost)}</span>
      <span style={{ color: C.text }}>{fmtPrice(pos.current_price)}</span>
      <span style={{ color: C.textDim, fontSize: 11 }}>{pos.shares?.toFixed(6)}</span>
      <span style={{ textAlign: "right", fontWeight: 700, color: up ? C.green : C.red }}>
        {up ? "+" : ""}{fmt$(pos.pnl, true)} ({up ? "+" : ""}{pos.pnl_pct?.toFixed(2)}%)
      </span>
      <button onClick={async () => {
          if (!window.confirm(`Sell all ${displayName(ticker)}?`)) return;
          setSelling(true); await onSell(); setSelling(false);
        }} disabled={selling} style={{
          background: selling ? C.borderFaint : C.redDim,
          border: `1px solid ${C.red}33`, borderRadius: 4,
          padding: "4px 0", fontSize: 10, cursor: "pointer",
          color: C.red, fontWeight: 700, width: "100%",
          opacity: selling ? 0.5 : 1, fontFamily: "inherit",
        }}>{selling ? "..." : "Sell"}</button>
    </div>
  );
}

function TradeRow({ trade }) {
  const isBuy = trade.action === "BUY";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "130px 50px 80px 1fr 80px",
      gap: 10, padding: "9px 16px", borderBottom: `1px solid ${C.borderFaint}`,
      alignItems: "center", fontSize: 11,
    }}>
      <span style={{ color: C.textDim }}>
        {new Date(trade.time).toLocaleString([], { month:"short", day:"numeric",
          hour:"2-digit", minute:"2-digit" })}
      </span>
      <Pill label={trade.action} variant={isBuy ? "BUY" : "SELL"} />
      <span style={{ fontWeight: 700, color: C.text }}>{displayName(trade.ticker)}</span>
      <span style={{ color: C.textDim }}>{trade.shares?.toFixed(6)} @ {fmtPrice(trade.price)}</span>
      {trade.pnl !== undefined
        ? <span style={{ textAlign: "right", fontWeight: 700,
            color: trade.pnl >= 0 ? C.green : C.red }}>
            {trade.pnl >= 0 ? "+" : ""}{fmt$(trade.pnl)}
          </span>
        : <span style={{ textAlign: "right", color: C.textMuted, fontSize: 10 }}>
            {trade.paper ? "paper" : "live"}
          </span>
      }
    </div>
  );
}

// ── Reckless toggle ───────────────────────────────────────────────
function RecklessToggle({ config, fetcher, API, showToast, refresh }) {
  const [reckless, setReckless] = useState(config?.minConfidence <= 0.25);

  useEffect(() => {
    setReckless(config?.minConfidence <= 0.25);
  }, [config?.minConfidence]);

  const toggle = async () => {
    const next = !reckless;
    const newSettings = next
      ? { minConfidence: 0.25, rsiOversold: 55, rsiOverbought: 45 }
      : { minConfidence: 0.60, rsiOversold: 38, rsiOverbought: 62 };
    setReckless(next); // optimistic update
    await fetcher(`${API}/config`, { method: "POST", body: JSON.stringify(newSettings) });
    showToast(next ? "🔥 Reckless mode on — trades on almost anything" : "Normal mode on", next ? "error" : "info");
    refresh();
  };

  return (
    <button onClick={toggle} style={{
      background: reckless ? "#260410" : "none",
      border: `1px solid ${reckless ? "#FF3D5A" : "#6B829E55"}`,
      borderRadius: 5, padding: "6px 14px", fontSize: 10, cursor: "pointer",
      color: reckless ? "#FF3D5A" : "#6B829E",
      fontWeight: 800, letterSpacing: "0.08em",
      textTransform: "uppercase", fontFamily: "inherit",
      transition: "all 0.2s",
    }}>
      {reckless ? "🔥 Reckless" : "Reckless mode"}
    </button>
  );
}

// ── Main app ──────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("overview");
  const [status, setStatus] = useState(null);
  const [account, setAccount] = useState(null);
  const [signals, setSignals] = useState({});
  const [positions, setPositions] = useState({});
  const [trades, setTrades] = useState([]);
  const [config, setConfig] = useState(null);
  const [cooldowns, setCooldowns] = useState({});
  const [ranges, setRanges] = useState({});
  const [editConfig, setEditConfig] = useState({});
  const isEditingConfig = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    document.body.style.background = C.bg;
    document.body.style.margin = "0";
    document.documentElement.style.background = C.bg;
  }, []);

  const showToast = (text, type = "info") => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3500);
  };

  const refresh = useCallback(async () => {
    try {
      const [s, acc, sig, pos, t, c, cd, rng] = await Promise.all([
        fetcher(`${API}/status`).catch(() => null),
        fetcher(`${API}/account`).catch(() => null),
        fetcher(`${API}/signals`).catch(() => null),
        fetcher(`${API}/positions`).catch(() => null),
        fetcher(`${API}/trades`).catch(() => null),
        fetcher(`${API}/config`).catch(() => null),
      ]);
      if (s)   setStatus(s);
      if (acc) setAccount(acc);
      if (sig && typeof sig === "object") setSignals(sig);
      if (pos) setPositions(pos);
      if (t)   setTrades(t);
      if (c)   { setConfig(c); setEditConfig(prev => Object.keys(prev).length ? prev : c); }
    } catch(e) { console.error("Refresh:", e); }
  }, []);

  useEffect(() => {
    refresh();
    // Use direct fetch in interval to avoid stale closure issues
    const id = setInterval(async () => {
      try {
        const [s, acc, sig, pos, t, c, cd, rng] = await Promise.all([
          fetch('/api/status').then(r => r.json()).catch(() => null),
          fetch('/api/account').then(r => r.json()).catch(() => null),
          fetch('/api/signals').then(r => r.json()).catch(() => null),
          fetch('/api/positions').then(r => r.json()).catch(() => null),
          fetch('/api/trades').then(r => r.json()).catch(() => null),
          fetch('/api/config').then(r => r.json()).catch(() => null),
          fetch('/api/cooldowns').then(r => r.json()).catch(() => null),
          fetch('/api/ranges').then(r => r.json()).catch(() => null),
        ]);
        if (s)   setStatus(s);
        if (acc) setAccount(acc);
        if (sig && typeof sig === 'object') setSignals(sig);
        if (pos) setPositions(pos);
        if (t)   setTrades(t);
        if (c)   setConfig(c);  // never touch editConfig during polling
        if (cd)  setCooldowns(cd);
        if (rng) setRanges(rng);
      } catch(e) { console.error('Poll error:', e); }
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const handleScan = async () => {
    setScanning(true);
    const res = await fetcher(`${API}/scan`, { method: "POST" }).catch(() => null);
    if (res?.signals) setSignals(res.signals);
    await refresh();
    setScanning(false);
    showToast(`Scan complete — ${res?.count || 0} tickers`, "success");
  };

  const handleSaveConfig = async () => {
    isEditingConfig.current = false;
    const payload = { ...editConfig };
    if (typeof payload.tickers === "string")
      payload.tickers = payload.tickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
    ["maxPositionUsd","totalBudgetUsd","rsiOversold","rsiOverbought","scanIntervalSec"]
      .forEach(k => { if (payload[k] !== undefined) payload[k] = Number(payload[k]); });
    ["minConfidence","profitTargetPct","stopLossPct"]
      .forEach(k => { if (payload[k] !== undefined) payload[k] = parseFloat(payload[k]); });
    await fetcher(`${API}/config`, { method: "POST", body: JSON.stringify(payload) });
    showToast("Settings saved — restart bot to apply", "success");
    refresh();
  };

  const totalPnl   = Object.values(positions).reduce((s, p) => s + (p.pnl || 0), 0);
  const buySignals = Object.values(signals).filter(s => s.action === "buy").length;
  const toastColor = { success: C.green, error: C.red, info: C.blue };
  const tabs       = ["overview","signals","positions","trades","settings"];

  const inp = {
    background: "#070C14", border: `1px solid ${C.border}`, borderRadius: 5,
    padding: "8px 12px", fontSize: 12, color: C.text, width: "100%",
    outline: "none", boxSizing: "border-box", fontFamily: "inherit",
  };

  return (
    <div style={{
      maxWidth: 940, margin: "0 auto", padding: "20px 16px",
      fontFamily: "'DM Mono','Fira Code','Courier New',monospace",
      background: C.bg, minHeight: "100vh", color: C.text,
    }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between",
        alignItems: "flex-start", marginBottom: 22,
        paddingBottom: 18, borderBottom: `1px solid ${C.border}` }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800,
            letterSpacing: "-0.02em", color: C.text }}>
            <span style={{ color: C.green }}>▸</span> trade engine
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 10, color: C.textMuted, letterSpacing: "0.04em" }}>
            {status?.lastScan
              ? `last scan ${new Date(status.lastScan).toLocaleTimeString()}`
              : "awaiting first scan"}
            {status?.tickers && ` · ${status.tickers.length} tickers · alpaca paper`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          {status?.paperMode !== undefined && (
            <Pill label={status.paperMode ? "paper" : "live"} variant={status.paperMode ? "paper" : "live"} />
          )}
          <Pill label={status?.botRunning ? "running" : "idle"} variant={status?.botRunning ? "on" : "off"} />
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          padding: "9px 14px", marginBottom: 14, borderRadius: 5, fontSize: 11,
          background: `${toastColor[toast.type]}11`,
          border: `1px solid ${toastColor[toast.type]}33`,
          color: toastColor[toast.type], fontWeight: 700, letterSpacing: "0.04em",
        }}>{toast.text}</div>
      )}

      {/* Account bar */}
      {account && (
        <Card style={{ marginBottom: 12 }}>
          <SectionLabel>Alpaca account</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)" }}>
            {[
              { label: "Portfolio",    value: fmt$(account.portfolio_value) },
              { label: "Buying power", value: fmt$(account.buying_power) },
              { label: "Cash",         value: fmt$(account.cash) },
              { label: "Budget left",  value: fmt$(account.budget_remaining),
                color: account.budget_used_pct > 85 ? C.red
                     : account.budget_used_pct > 60 ? C.amber : C.green },
            ].map((m, i) => (
              <div key={m.label} style={{
                padding: "12px 16px",
                borderRight: i < 3 ? `1px solid ${C.borderFaint}` : "none",
              }}>
                <p style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase",
                  letterSpacing: "0.12em", color: C.textMuted, margin: "0 0 5px" }}>{m.label}</p>
                <p style={{ fontSize: 16, fontWeight: 800, margin: 0,
                  color: m.color || C.text, fontVariantNumeric: "tabular-nums" }}>{m.value}</p>
              </div>
            ))}
          </div>
          <div style={{ padding: "10px 16px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between",
              fontSize: 10, color: C.textMuted, marginBottom: 5 }}>
              <span>Deployed: <span style={{ color: C.text }}>{fmt$(account.deployed_capital)}</span></span>
              <span>Limit: <span style={{ color: C.text }}>{fmt$(account.total_budget_usd)}</span></span>
            </div>
            <div style={{ height: 3, background: C.borderFaint, borderRadius: 99 }}>
              <div style={{
                height: "100%", borderRadius: 99,
                width: `${Math.min(100, account.budget_used_pct || 0)}%`,
                background: (account.budget_used_pct||0) > 85 ? C.red
                          : (account.budget_used_pct||0) > 60 ? C.amber : C.green,
                boxShadow: `0 0 8px ${C.green}44`, transition: "width 0.5s",
              }} />
            </div>
            <p style={{ fontSize: 10, margin: "4px 0 0", textAlign: "right",
              fontWeight: 700, color: C.green }}>{(account.budget_used_pct||0).toFixed(1)}% used</p>
          </div>
        </Card>
      )}

      {/* Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, marginBottom: 18 }}>
        <Metric label="Positions"     value={Object.keys(positions).length} />
        <Metric label="Unrealized P&L"
          value={`${totalPnl >= 0 ? "+" : ""}${fmt$(totalPnl, true)}`}
          color={totalPnl >= 0 ? C.green : C.red} />
        <Metric label="Buy signals"   value={buySignals} color={buySignals > 0 ? C.green : C.text} />
        <Metric label="Trades"        value={trades.length} />
        <Metric label="Per-trade"     value={fmt$(config?.maxPositionUsd)} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => {
            setTab(t);
            // When opening settings, sync editConfig from latest server config
            if (t === 'settings') {
              isEditingConfig.current = false;
              setEditConfig(config || {});
            }
          }} style={{
            background: "none", border: "none", padding: "7px 14px", fontSize: 9,
            cursor: "pointer", letterSpacing: "0.12em", fontWeight: 800,
            textTransform: "uppercase", fontFamily: "inherit",
            color: tab === t ? C.green : C.textMuted,
            borderBottom: `2px solid ${tab === t ? C.green : "transparent"}`,
            marginBottom: -1,
          }}>{t}</button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === "overview" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <Btn color={status?.botRunning ? "red" : "green"}
              onClick={() => fetcher(`${API}/bot/${status?.botRunning ? "stop" : "start"}`,
                { method: "POST" }).then(refresh)}>
              {status?.botRunning ? "Stop bot" : "Start bot"}
            </Btn>
            <Btn onClick={handleScan} disabled={scanning}>
              {scanning ? "Scanning…" : "Scan now"}
            </Btn>
            <Btn onClick={() => fetcher(`${API}/sync`, { method: "POST" })
              .then(() => { showToast("Positions synced", "success"); refresh(); })}>
              Sync positions
            </Btn>
            <RecklessToggle config={config} fetcher={fetcher} API={API} showToast={showToast} refresh={refresh} />
          </div>

          <Card style={{ marginBottom: 12 }}>
            <SectionLabel>Latest signals</SectionLabel>
            {Object.keys(signals).length === 0 ? (
              <p style={{ padding: "24px 16px", color: C.textMuted, fontSize: 11, textAlign: "center" }}>
                No signals — hit <span style={{ color: C.green }}>Scan now</span> to start
              </p>
            ) : (
              <>
                <div style={{ display: "grid",
                  gridTemplateColumns: "100px 90px 48px 1fr 58px 50px 55px",
                  gap: 10, padding: "6px 16px", borderBottom: `1px solid ${C.borderFaint}` }}>
                  {["Ticker","Price","RSI","Top reason","Action","Conf",""].map(h => (
                    <span key={h} style={{ fontSize: 9, fontWeight: 800,
                      textTransform: "uppercase", letterSpacing: "0.1em", color: C.textMuted }}>{h}</span>
                  ))}
                </div>
                {Object.entries(signals).map(([ticker, sig]) => (
                  <SignalRow key={ticker} ticker={ticker} signal={sig}
                    onBuy={async () => {
                      const res = await fetcher(`${API}/buy/${ticker}`, { method: "POST" });
                      if (res.success) showToast(`${res.paper?"Paper ":""}Bought ${displayName(ticker)} @ ${fmtPrice(res.price)}`, "success");
                      else showToast(`Buy failed: ${res.error}`, "error");
                      refresh();
                    }} />
                ))}
              </>
            )}
          </Card>

          {trades.length > 0 && (
            <Card>
              <SectionLabel>Recent trades</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "130px 50px 80px 1fr 80px",
                gap: 10, padding: "6px 16px", borderBottom: `1px solid ${C.borderFaint}` }}>
                {["Time","Type","Ticker","Details","P&L"].map(h => (
                  <span key={h} style={{ fontSize: 9, fontWeight: 800,
                    textTransform: "uppercase", letterSpacing: "0.1em", color: C.textMuted }}>{h}</span>
                ))}
              </div>
              {trades.slice(0,5).map((t,i) => <TradeRow key={i} trade={t} />)}
            </Card>
          )}
        </>
      )}

      {/* ── SIGNALS ── */}
      {tab === "signals" && (
        <Card>
          <SectionLabel>All signals</SectionLabel>
          <div style={{ display: "grid",
            gridTemplateColumns: "100px 90px 48px 1fr 58px 50px 55px",
            gap: 10, padding: "6px 16px", borderBottom: `1px solid ${C.borderFaint}` }}>
            {["Ticker","Price","RSI","Top reason","Action","Conf",""].map(h => (
              <span key={h} style={{ fontSize: 9, fontWeight: 800,
                textTransform: "uppercase", letterSpacing: "0.1em", color: C.textMuted }}>{h}</span>
            ))}
          </div>
          {Object.keys(signals).length === 0
            ? <p style={{ padding: "24px 16px", color: C.textMuted, fontSize: 11 }}>Run a scan first</p>
            : Object.entries(signals).map(([ticker, sig]) => (
              <SignalRow key={ticker} ticker={ticker} signal={sig}
                onBuy={async () => {
                  const res = await fetcher(`${API}/buy/${ticker}`, { method: "POST" });
                  if (res.success) showToast(`Bought ${displayName(ticker)}`, "success");
                  else showToast(`Buy failed: ${res.error}`, "error");
                  refresh();
                }} />
            ))
          }
        </Card>
      )}

      {/* ── POSITIONS ── */}
      {tab === "positions" && (
        <Card>
          <SectionLabel>Open positions</SectionLabel>
          <div style={{ display: "grid",
            gridTemplateColumns: "110px 90px 90px 1fr 120px 60px",
            gap: 10, padding: "6px 16px", borderBottom: `1px solid ${C.borderFaint}` }}>
            {["Ticker","Avg cost","Current","Shares","P&L",""].map(h => (
              <span key={h} style={{ fontSize: 9, fontWeight: 800,
                textTransform: "uppercase", letterSpacing: "0.1em", color: C.textMuted }}>{h}</span>
            ))}
          </div>
          {Object.keys(positions).length === 0
            ? <p style={{ padding: "24px 16px", color: C.textMuted, fontSize: 11 }}>
                No positions — hit Sync positions if you own stocks/crypto on Alpaca
              </p>
            : Object.entries(positions).map(([ticker, pos]) => (
              <PositionRow key={ticker} ticker={ticker} pos={pos}
                onSell={async () => {
                  const res = await fetcher(`${API}/sell/${ticker}`, { method: "POST" });
                  if (res.success) showToast(`${res.paper?"Paper ":""}Sold ${displayName(ticker)}`, "success");
                  else showToast(`Sell failed: ${res.error}`, "error");
                  refresh();
                }} />
            ))
          }
        </Card>
      )}

      {/* ── TRADES ── */}
      {tab === "trades" && (
        <Card>
          <SectionLabel>Trade history</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "130px 50px 80px 1fr 80px",
            gap: 10, padding: "6px 16px", borderBottom: `1px solid ${C.borderFaint}` }}>
            {["Time","Type","Ticker","Details","P&L"].map(h => (
              <span key={h} style={{ fontSize: 9, fontWeight: 800,
                textTransform: "uppercase", letterSpacing: "0.1em", color: C.textMuted }}>{h}</span>
            ))}
          </div>
          {trades.length === 0
            ? <p style={{ padding: "24px 16px", color: C.textMuted, fontSize: 11 }}>No trades yet</p>
            : trades.map((t,i) => <TradeRow key={i} trade={t} />)
          }
        </Card>
      )}

      {/* ── SETTINGS ── */}
      {tab === "settings" && editConfig && (
        <div style={{ display: "grid", gap: 10 }}>

          <Card>
            <SectionLabel>Aggression level</SectionLabel>
            <div style={{ padding: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 14 }}>
                {[
                  { label: "Conservative", confidence: 0.75, oversold: 30, overbought: 70, color: C.blue },
                  { label: "Moderate",     confidence: 0.60, oversold: 38, overbought: 62, color: C.green },
                  { label: "Aggressive",   confidence: 0.45, oversold: 45, overbought: 55, color: C.amber },
                  { label: "Very aggro",   confidence: 0.35, oversold: 50, overbought: 50, color: C.red },
                ].map(p => {
                  const active = parseFloat(editConfig.minConfidence) === p.confidence
                    && parseFloat(editConfig.rsiOversold) === p.oversold;
                  return (
                    <button key={p.label} onClick={() => { isEditingConfig.current = true; setEditConfig(e => ({
                      ...e, minConfidence: p.confidence,
                      rsiOversold: p.oversold, rsiOverbought: p.overbought,
                    })); }} style={{
                      background: active ? `${p.color}11` : C.surface2,
                      border: `1px solid ${active ? p.color : C.border}`,
                      borderRadius: 5, padding: "10px 8px",
                      cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                    }}>
                      <p style={{ fontSize: 10, fontWeight: 800, color: active ? p.color : C.text,
                        margin: "0 0 2px", letterSpacing: "0.04em" }}>{p.label}</p>
                      <p style={{ fontSize: 9, color: active ? p.color : C.textDim, margin: 0 }}>
                        {p.confidence * 100}% confidence
                      </p>
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                {[
                  { key: "minConfidence", label: "Min confidence", step: "0.05" },
                  { key: "rsiOversold",   label: "RSI oversold" },
                  { key: "rsiOverbought", label: "RSI overbought" },
                ].map(f => (
                  <div key={f.key}>
                    <p style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase",
                      letterSpacing: "0.1em", color: C.textMuted, margin: "0 0 5px" }}>{f.label}</p>
                    <input type="number" step={f.step || "1"} value={editConfig[f.key] ?? ""}
                      onChange={e => { isEditingConfig.current = true; setEditConfig(p => ({ ...p, [f.key]: e.target.value })); }}
                      style={inp} />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <SectionLabel>Tickers</SectionLabel>
            <div style={{ padding: 14 }}>
              <input
                value={editConfig._tickersRaw !== undefined ? editConfig._tickersRaw : (Array.isArray(editConfig.tickers) ? editConfig.tickers.join(", ") : "")}
                onChange={e => {
                  isEditingConfig.current = true;
                  // Store raw string while typing so user can edit freely
                  setEditConfig(p => ({ ...p, _tickersRaw: e.target.value }));
                }}
                onBlur={e => {
                  // Only parse into array when user leaves the field
                  const parsed = e.target.value.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
                  setEditConfig(p => ({ ...p, tickers: parsed, _tickersRaw: undefined }));
                }}
                placeholder="AAPL, MSFT, BTC-USD, ETH-USD"
                style={inp} />
              <p style={{ fontSize: 9, color: C.textMuted, margin: "6px 0 0" }}>
                Stocks: AAPL, NVDA · Crypto: BTC-USD, ETH-USD, SOL-USD
              </p>
            </div>
          </Card>

          <Card>
            <SectionLabel>Budget</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              {[
                { key: "totalBudgetUsd", label: "Total budget cap ($)", step: "10" },
                { key: "maxPositionUsd", label: "Per-trade limit ($)",  step: "5"  },
              ].map((f, i) => (
                <div key={f.key} style={{
                  padding: 14,
                  borderRight: i === 0 ? `1px solid ${C.borderFaint}` : "none",
                }}>
                  <p style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase",
                    letterSpacing: "0.1em", color: C.textMuted, margin: "0 0 6px" }}>{f.label}</p>
                  <input type="number" step={f.step} value={editConfig[f.key] ?? ""}
                    onChange={e => { isEditingConfig.current = true; setEditConfig(p => ({ ...p, [f.key]: e.target.value })); }}
                    style={inp} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionLabel>Trading parameters</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              {[
                { key: "profitTargetPct", label: "Profit target (%)", step: "0.5" },
                { key: "stopLossPct",     label: "Stop loss (%)",     step: "0.5" },
                { key: "scanIntervalSec", label: "Scan interval (sec)" },
              ].map((f, i) => (
                <div key={f.key} style={{
                  padding: 14,
                  borderBottom: i < 1 ? `1px solid ${C.borderFaint}` : "none",
                  borderRight: i % 2 === 0 ? `1px solid ${C.borderFaint}` : "none",
                }}>
                  <p style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase",
                    letterSpacing: "0.1em", color: C.textMuted, margin: "0 0 6px" }}>{f.label}</p>
                  <input type="number" step={f.step || "1"} value={editConfig[f.key] ?? ""}
                    onChange={e => { isEditingConfig.current = true; setEditConfig(p => ({ ...p, [f.key]: e.target.value })); }}
                    style={inp} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionLabel>Mode</SectionLabel>
            <div style={{ padding: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10,
                fontSize: 11, cursor: "pointer", color: C.text }}>
                <input type="checkbox"
                  checked={editConfig.paperMode !== undefined ? editConfig.paperMode : true}
                  onChange={e => setEditConfig(p => ({ ...p, paperMode: e.target.checked }))} />
                Paper mode — simulate trades, no real orders sent to Alpaca
              </label>
            </div>
          </Card>

          <Btn color="green" onClick={handleSaveConfig}>Save settings</Btn>
        </div>
      )}
    </div>
  );
}
