import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import "./App.css";

type Status = {
  equity: number;
  unrealized_pnl: number;
  drawdown_pct: number;
  daily_pnl: number;
  portfolio_heat: number;
  win_rate: number;
  total_trades: number;
  open_positions: number;
  positions: Array<{
    symbol: string;
    side: string;
    size: number;
    entry_price: number;
    current_price: number;
    pnl: number;
    leverage: number;
  }>;
};

type Coin = {
  symbol: string;
  name: string;
  price: number;
  change_24h: number;
  volume_24h: number;
  market_cap: number;
};

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Indicator = {
  rsi: number;
  macd: number;
  stoch_k: number;
  adx: number;
  atr: number;
  bb_width: number;
  ema_cross: number;
  volume_ratio: number;
};

type Orderbook = {
  symbol: string;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  spread: number;
};

type DexPool = {
  dex: string;
  pair: string;
  tvl: number;
  volume_24h: number;
  chain: string;
};

type NewsItem = {
  title: string;
  source: string;
  sentiment: string;
  ts: string;
};

type LogItem = {
  level: string;
  message: string;
  ts: string;
};

type AutoState = {
  enabled: boolean;
  mode: "paper" | "live";
  updated_at: string;
  uptime_seconds: number;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function sparklinePath(values: number[], width: number, height: number): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * width;
      const y = height - ((v - min) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [indicators, setIndicators] = useState<Indicator | null>(null);
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [dexPools, setDexPools] = useState<DexPool[]>([]);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [autoState, setAutoState] = useState<AutoState | null>(null);
  const [fearGreed, setFearGreed] = useState<{ value: number; classification: string } | null>(null);
  const [symbol, setSymbol] = useState("BTC");
  const [timeframe, setTimeframe] = useState("1m");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [size, setSize] = useState(0.01);
  const [leverage, setLeverage] = useState(1);
  const [stopLoss, setStopLoss] = useState(2);
  const [takeProfit, setTakeProfit] = useState(4);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Connected to bridge API");

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [statusData, marketData, candleData, indicatorData, fgData, obData, poolsData, newsData, logsData, autoData] = await Promise.all([
          getJSON<Status>("/status"),
          getJSON<{ coins: Coin[] }>("/market?per_page=12"),
          getJSON<{ candles: Candle[] }>(`/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=160`),
          getJSON<Indicator>(`/indicators/${encodeURIComponent(symbol)}`),
          getJSON<{ value: number; classification: string }>("/feargreed"),
          getJSON<Orderbook>(`/orderbook?symbol=${encodeURIComponent(`${symbol}/USDT`)}`),
          getJSON<{ pools: DexPool[] }>("/dex/pools"),
          getJSON<{ items: NewsItem[] }>("/news"),
          getJSON<{ logs: LogItem[] }>("/logs/recent"),
          getJSON<AutoState>("/auto/status"),
        ]);

        if (!active) return;
        setStatus(statusData);
        setCoins(marketData.coins);
        setCandles(candleData.candles);
        setIndicators(indicatorData);
        setFearGreed(fgData);
        setOrderbook(obData);
        setDexPools(poolsData.pools ?? []);
        setNewsItems(newsData.items ?? []);
        setLogs(logsData.logs ?? []);
        setAutoState(autoData);
      } catch (error: any) {
        if (!active) return;
        setMessage(`Data refresh failed: ${error?.message ?? "unknown"}`);
      }
    };

    void load();
    const id = window.setInterval(() => void load(), 4000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [symbol, timeframe]);

  const activeCoin = useMemo(() => coins.find((c) => c.symbol === symbol), [coins, symbol]);
  const closeSeries = useMemo(() => candles.map((c) => c.close), [candles]);
  const chartPath = useMemo(() => sparklinePath(closeSeries, 820, 380), [closeSeries]);

  const submitTrade = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("Sending execution request...");
    try {
      const res = await fetch(`${API_BASE}/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: `${symbol}/USDT`,
          side,
          size,
          leverage,
          stop_loss_pct: stopLoss,
          take_profit_pct: takeProfit,
          venue: "sim",
          model: "gpt-5.3-codex",
        }),
      });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setMessage(`Order sent: ${body.order.side.toUpperCase()} ${body.order.quantity} ${body.order.symbol}`);
    } catch (error: any) {
      setMessage(`Trade failed: ${error?.message ?? "unknown"}`);
    } finally {
      setLoading(false);
    }
  };

  const closeAll = async () => {
    try {
      const res = await fetch(`${API_BASE}/positions/close-all`, { method: "POST" });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setMessage(`Close-all accepted: ${body.closed_positions} positions`);
    } catch (error: any) {
      setMessage(`Close-all failed: ${error?.message ?? "unknown"}`);
    }
  };

  const toggleAuto = async () => {
    try {
      const enabled = !(autoState?.enabled ?? false);
      const res = await fetch(`${API_BASE}/auto/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, mode: autoState?.mode ?? "paper" }),
      });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setAutoState({ ...(body.state as AutoState), uptime_seconds: autoState?.uptime_seconds ?? 0 });
      setMessage(`Auto mode ${enabled ? "enabled" : "disabled"}`);
    } catch (error: any) {
      setMessage(`Auto toggle failed: ${error?.message ?? "unknown"}`);
    }
  };

  return (
    <div className="nt-shell">
      <header className="ticker-strip">
        <div className="brand">NEURALTRADER</div>
        <div className="ticker-main">
          <div className="coin-pill">{activeCoin?.symbol ?? symbol}</div>
          <div>
            <strong>{activeCoin?.name ?? "Bitcoin"}</strong>
            <p>{symbol}/USDT</p>
          </div>
          <div className="px">${activeCoin?.price?.toLocaleString() ?? "-"}</div>
          <div className={Number(activeCoin?.change_24h ?? 0) >= 0 ? "delta pos" : "delta neg"}>
            {activeCoin?.change_24h?.toFixed(2) ?? "0.00"}%
          </div>
        </div>
        <div className="strip-metrics">
          <span>24H VOL ${activeCoin?.volume_24h?.toLocaleString() ?? "-"}</span>
          <span>EQUITY ${status?.equity?.toLocaleString() ?? "-"}</span>
          <span>UNREALIZED ${status?.unrealized_pnl?.toFixed(2) ?? "0.00"}</span>
          <span>DRAWDOWN {status?.drawdown_pct?.toFixed(2) ?? "0.00"}%</span>
          <span className="mode">PAPER</span>
          <span>AUTO {autoState?.enabled ? "ON" : "OFF"}</span>
        </div>
      </header>

      <nav className="menu-row">
        <button className="tab active">Chart</button>
        <button className="tab">Signals</button>
        <button className="tab">Portfolio</button>
        <button className="tab">Backtest</button>
        <button className="tab">News</button>
        <button className="tab">Logs</button>
        <button className="tab">Auto</button>
      </nav>

      <main className="workspace-grid">
        <aside className="pane left-rail">
          <section className="panel-block">
            <div className="panel-title">Markets</div>
            <input className="search" placeholder="Search symbols..." />
            <div className="market-table-head">
              <span>Symbol</span>
              <span>Price</span>
              <span>24h</span>
            </div>
            <div className="market-list">
              {coins.slice(0, 8).map((c) => (
                <button key={c.symbol} className="market-row" onClick={() => setSymbol(c.symbol)}>
                  <span>{c.symbol}</span>
                  <span>${c.price.toLocaleString()}</span>
                  <span className={c.change_24h >= 0 ? "pos" : "neg"}>{c.change_24h.toFixed(2)}%</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel-block">
            <div className="panel-title">Technical Analysis</div>
            {[
              ["RSI (14)", indicators?.rsi ?? 0],
              ["MACD", Math.abs(indicators?.macd ?? 0) * 10],
              ["Stochastic %K", indicators?.stoch_k ?? 0],
              ["ADX", indicators?.adx ?? 0],
              ["ATR", Math.min(100, (indicators?.atr ?? 0) * 2)],
              ["BB Width", Math.min(100, (indicators?.bb_width ?? 0) * 1000)],
              ["Volume Ratio", Math.min(100, (indicators?.volume_ratio ?? 0) * 45)],
            ].map(([label, value]) => (
              <div className="ta-row" key={String(label)}>
                <div className="ta-head">
                  <span>{label}</span>
                  <span>{Number(value).toFixed(1)}</span>
                </div>
                <div className="ta-track">
                  <div className="ta-fill" style={{ width: `${Math.max(2, Number(value))}%` }} />
                </div>
              </div>
            ))}
          </section>

          <section className="panel-block sentiment">
            <div className="panel-title">Market Sentiment</div>
            <div className="gauge">
              <div className="gauge-ring" style={{ "--pct": `${fearGreed?.value ?? 50}%` } as CSSProperties} />
              <strong>{fearGreed?.value ?? "--"}</strong>
              <p>{fearGreed?.classification ?? "Loading..."}</p>
            </div>
          </section>
        </aside>

        <section className="pane center-core">
          <article className="panel-block chart-block">
            <div className="chart-top">
              <div className="ohlc">O --  H --  L --  C --</div>
              <div className="tf-row">
                {[
                  ["1m", "1m"],
                  ["5m", "5m"],
                  ["15m", "15m"],
                  ["1h", "1H"],
                  ["4h", "4H"],
                  ["1d", "1D"],
                ].map(([v, label]) => (
                  <button key={v} className={timeframe === v ? "tf active" : "tf"} onClick={() => setTimeframe(v)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <svg viewBox="0 0 820 380" className="chart" role="img" aria-label="price chart">
              <path d={chartPath} />
            </svg>
          </article>

          <article className="panel-block positions-block">
            <div className="positions-head">
              <span>Positions</span>
              <button onClick={closeAll}>Close All</button>
            </div>
            <div className="pos-table-head">
              <span>Symbol</span>
              <span>Side</span>
              <span>Size</span>
              <span>PnL</span>
            </div>
            <div className="pos-list">
              {(status?.positions ?? []).slice(0, 6).map((p) => (
                <div className="pos-row" key={`${p.symbol}-${p.side}`}>
                  <span>{p.symbol}</span>
                  <span>{p.side.toUpperCase()}</span>
                  <span>{p.size.toFixed(3)}</span>
                  <span className={p.pnl >= 0 ? "pos" : "neg"}>{p.pnl.toFixed(2)}</span>
                </div>
              ))}
              {(status?.positions ?? []).length === 0 && <div className="empty">No open positions</div>}
            </div>
          </article>
        </section>

        <aside className="pane right-stack">
          <section className="panel-block">
            <div className="panel-title">Order Book</div>
            <div className="ob-grid">
              <div>
                <p>Asks</p>
                {(orderbook?.asks ?? []).slice(0, 5).map((a, i) => (
                  <div className="ob-row" key={`a-${i}`}>
                    <span>{a.price.toFixed(2)}</span>
                    <span>{a.quantity.toFixed(4)}</span>
                  </div>
                ))}
              </div>
              <div>
                <p>Bids</p>
                {(orderbook?.bids ?? []).slice(0, 5).map((b, i) => (
                  <div className="ob-row" key={`b-${i}`}>
                    <span>{b.price.toFixed(2)}</span>
                    <span>{b.quantity.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel-block">
            <div className="panel-title">Risk Metrics</div>
            {[
              ["Portfolio Heat", status?.portfolio_heat ?? 0],
              ["Drawdown", status?.drawdown_pct ?? 0],
              ["Daily PnL", Math.min(100, Math.abs(status?.daily_pnl ?? 0) / 20)],
              ["Exposure", Math.min(100, (status?.open_positions ?? 0) * 12)],
            ].map(([label, value]) => (
              <div className="risk-row" key={String(label)}>
                <div className="risk-head">
                  <span>{label}</span>
                  <span>{Number(value).toFixed(1)}%</span>
                </div>
                <div className="risk-track">
                  <div className="risk-fill" style={{ width: `${Math.max(1, Number(value))}%` }} />
                </div>
              </div>
            ))}
          </section>

          <section className="panel-block">
            <div className="panel-title">Trade</div>
            <form onSubmit={submitTrade} className="trade-form">
              <div className="form-row two">
                <label>
                  Symbol
                  <input value={`${symbol}/USDT`} readOnly />
                </label>
                <label>
                  Type
                  <select>
                    <option>Market</option>
                  </select>
                </label>
              </div>
              <div className="form-row two">
                <label>
                  Size
                  <input type="number" step="0.001" min="0.001" value={size} onChange={(e) => setSize(Number(e.target.value))} />
                </label>
                <label>
                  Leverage
                  <input type="number" min="1" max="20" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
                </label>
              </div>
              <div className="form-row two">
                <label>
                  Stop Loss %
                  <input type="number" min="0" step="0.1" value={stopLoss} onChange={(e) => setStopLoss(Number(e.target.value))} />
                </label>
                <label>
                  Take Profit %
                  <input type="number" min="0" step="0.1" value={takeProfit} onChange={(e) => setTakeProfit(Number(e.target.value))} />
                </label>
              </div>
              <div className="side-row">
                <button type="button" className={side === "BUY" ? "side buy active" : "side buy"} onClick={() => setSide("BUY")}>
                  BUY
                </button>
                <button type="button" className={side === "SELL" ? "side sell active" : "side sell"} onClick={() => setSide("SELL")}>
                  SELL
                </button>
              </div>
              <button type="submit" disabled={loading} className="execute">
                {loading ? "Executing..." : `${side} MARKET`}
              </button>
            </form>
            <p className="message">{message}</p>
          </section>

          <section className="panel-block mini-grid">
            <div>
              <div className="panel-title">Dex Liquidity</div>
              {dexPools.slice(0, 2).map((p) => (
                <div key={`${p.dex}-${p.pair}`} className="mini-row">
                  <span>{p.pair}</span>
                  <span>${Math.round(p.tvl / 1_000_000)}M</span>
                </div>
              ))}
            </div>
            <div>
              <div className="panel-title">News</div>
              {newsItems.slice(0, 2).map((n) => (
                <div className="mini-row" key={n.ts}>
                  <span>{n.title.slice(0, 28)}</span>
                  <span>{n.sentiment}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel-block">
            <div className="panel-title">Auto + Logs</div>
            <button className="execute" onClick={toggleAuto}>
              {autoState?.enabled ? "Disable Auto" : "Enable Auto"}
            </button>
            {logs.slice(0, 2).map((l, idx) => (
              <div className="mini-row" key={`${l.ts}-${idx}`}>
                <span>{l.level}</span>
                <span>{l.message.slice(0, 24)}</span>
              </div>
            ))}
          </section>
        </aside>
      </main>
    </div>
  );
}
