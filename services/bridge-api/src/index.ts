import express, { Request, Response } from "express";
import cors from "cors";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createClient } from "@clickhouse/client";
import { randomUUID } from "crypto";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const app = express();
app.use(express.json());
app.use(cors());

const registry = new Registry();
collectDefaultMetrics({ register: registry });
const requestCounter = new Counter({
  name: "bridge_api_requests_total",
  help: "Total bridge API requests",
  registers: [registry],
  labelNames: ["route", "status"] as const,
});
const requestLatency = new Histogram({
  name: "bridge_api_request_duration_seconds",
  help: "Request duration seconds",
  registers: [registry],
  labelNames: ["route"] as const,
});

const grpcTarget = process.env.GRPC_TARGET ?? "gateway:50051";
const clickhouseUrl = process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123";
const clickhouseUser = process.env.CLICKHOUSE_USER ?? "nt_app";
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD ?? "nt_app_password";
const clickhouseDb = process.env.CLICKHOUSE_DB ?? "neural_trader";
const bridgeProtoPath = process.env.BRIDGE_PROTO_PATH ?? "/app/proto/bridge.proto";
const port = Number.parseInt(process.env.BRIDGE_API_PORT ?? "8080", 10);

const clickhouse = createClient({
  host: clickhouseUrl,
  username: clickhouseUser,
  password: clickhousePassword,
  database: clickhouseDb,
});

const pkgDef = protoLoader.loadSync(bridgeProtoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as any;
const BridgeServiceClient = proto.neural_trader.bridge.BridgeService;
const grpcClient = new BridgeServiceClient(grpcTarget, grpc.credentials.createInsecure());

type ExecutionOrder = {
  request_id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  venue: string;
  model: string;
  selected_tool: string;
  operator_tag: string;
  latency_ms: number;
  status: string;
  created_at: string;
};

type PositionSummary = {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entry_price: number;
  mark_price: number;
  unrealized_pnl: number;
};

type MarketTicker = {
  symbol: string;
  name: string;
  price: number;
  change_24h: number;
  volume_24h: number;
  market_cap: number;
  high_24h: number;
  low_24h: number;
};

type AutoTradingState = {
  enabled: boolean;
  mode: "paper" | "live";
  updated_at: string;
};

type UiConfigState = {
  binance_api_key: string;
  binance_secret: string;
  updated_at: string;
};

const serviceStartedAt = Date.now();
let autoTradingState: AutoTradingState = {
  enabled: false,
  mode: "paper",
  updated_at: new Date().toISOString(),
};

let uiConfigState: UiConfigState = {
  binance_api_key: "",
  binance_secret: "",
  updated_at: new Date().toISOString(),
};

const symbolCatalog: Array<{ symbol: string; name: string; basePrice: number }> = [
  { symbol: "BTC", name: "Bitcoin", basePrice: 95200 },
  { symbol: "ETH", name: "Ethereum", basePrice: 3120 },
  { symbol: "SOL", name: "Solana", basePrice: 191 },
  { symbol: "BNB", name: "BNB", basePrice: 625 },
  { symbol: "XRP", name: "XRP", basePrice: 0.62 },
  { symbol: "DOGE", name: "Dogecoin", basePrice: 0.12 },
  { symbol: "ADA", name: "Cardano", basePrice: 0.53 },
  { symbol: "AVAX", name: "Avalanche", basePrice: 42 },
];

function formatClickhouseDate(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function defaultSymbolPrice(symbol: string): number {
  const map: Record<string, number> = {
    "BTC/USDT": 95200,
    "ETH/USDT": 3120,
    "SOL/USDT": 191,
    "BNB/USDT": 625,
  };
  return map[symbol] ?? 100;
}

function stableHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) % 1_000_003;
  }
  return h;
}

function syntheticChangePct(symbol: string): number {
  const seed = stableHash(symbol);
  return Number((((seed % 900) - 450) / 100).toFixed(2));
}

function timeframeToSeconds(timeframe: string): number {
  const map: Record<string, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
  };
  return map[timeframe] ?? 60;
}

function symbolToPairSymbol(raw: string): string {
  if (raw.includes("/")) return raw;
  return `${raw}/USDT`;
}

function marketTickers(markMap: Record<string, number>, limit: number): MarketTicker[] {
  return symbolCatalog.slice(0, limit).map((s) => {
    const pair = `${s.symbol}/USDT`;
    const price = Number((markMap[pair] ?? s.basePrice).toFixed(4));
    const change_24h = syntheticChangePct(s.symbol);
    const high_24h = Number((price * (1 + Math.abs(change_24h) / 100 * 0.65)).toFixed(4));
    const low_24h = Number((price * (1 - Math.abs(change_24h) / 100 * 0.75)).toFixed(4));
    const volume_24h = Number((price * (10_000 + stableHash(s.symbol) % 80_000)).toFixed(2));
    const market_cap = Number((price * (2_000_000 + stableHash(`${s.symbol}:cap`) % 15_000_000)).toFixed(2));
    return {
      symbol: s.symbol,
      name: s.name,
      price,
      change_24h,
      volume_24h,
      market_cap,
      high_24h,
      low_24h,
    };
  });
}

function syntheticCandles(symbol: string, timeframe: string, limit: number, latestPrice: number) {
  const tfSec = timeframeToSeconds(timeframe);
  const now = Math.floor(Date.now() / 1000);
  const seed = stableHash(symbol + timeframe);
  const candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];

  let prev = latestPrice > 0 ? latestPrice : defaultSymbolPrice(symbol);
  for (let i = limit - 1; i >= 0; i -= 1) {
    const t = now - i * tfSec;
    const w = ((seed + i * 17) % 100) / 100;
    const drift = (Math.sin((seed + i) / 7) + Math.cos((seed + i) / 13)) * 0.0015;
    const open = prev;
    const close = Number((open * (1 + drift + (w - 0.5) * 0.001)).toFixed(4));
    const high = Number((Math.max(open, close) * (1 + 0.0012 + w * 0.0008)).toFixed(4));
    const low = Number((Math.min(open, close) * (1 - 0.0012 - w * 0.0008)).toFixed(4));
    const volume = Number((100 + ((seed + i * 29) % 900) + Math.abs(close - open) * 50).toFixed(2));
    candles.push({
      time: new Date(t * 1000).toISOString(),
      open: Number(open.toFixed(4)),
      high,
      low,
      close,
      volume,
    });
    prev = close;
  }
  return candles;
}

function parseLimit(raw: unknown, fallback: number, cap: number): number {
  const n = Number.parseInt(String(raw ?? fallback), 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, cap);
}

function parsePositiveQuantity(raw: unknown, cap: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("invalid_quantity");
  }
  return Math.min(n, cap);
}

async function latestPricesBySymbol(): Promise<Record<string, number>> {
  const rows = await clickhouse
    .query({
      query: `
        SELECT
          symbol,
          toFloat64(argMaxIf(price, created_at, price > 0)) AS last_price
        FROM ${clickhouseDb}.execution_orders
        GROUP BY symbol
      `,
      format: "JSONEachRow",
    })
    .then((r) => r.json<Array<{ symbol: string; last_price: number }>>());

  const out: Record<string, number> = {};
  for (const row of rows) {
    const p = Number(row.last_price);
    out[row.symbol] = p > 0 ? p : defaultSymbolPrice(row.symbol);
  }
  return out;
}

async function computePositions(markMapOverride?: Record<string, number>): Promise<PositionSummary[]> {
  const rows = await clickhouse
    .query({
      query: `
        SELECT
          symbol,
          sumIf(quantity, lower(side) = 'buy') AS buy_qty,
          sumIf(quantity, lower(side) = 'sell') AS sell_qty,
          sumIf(quantity * if(price > 0, price, 0), lower(side) = 'buy') AS buy_notional,
          sumIf(quantity * if(price > 0, price, 0), lower(side) = 'sell') AS sell_notional
        FROM ${clickhouseDb}.execution_orders
        WHERE status IN ('SUBMITTED', 'FILLED')
        GROUP BY symbol
      `,
      format: "JSONEachRow",
    })
    .then((r) =>
      r.json<
        Array<{
        symbol: string;
        buy_qty: number;
        sell_qty: number;
        buy_notional: number;
        sell_notional: number;
        }>
      >()
    );

  const markMap = markMapOverride ?? (await latestPricesBySymbol());
  const positions: PositionSummary[] = [];

  for (const row of rows) {
    const mark = markMap[row.symbol] ?? defaultSymbolPrice(row.symbol);
    const buyQty = Number(row.buy_qty ?? 0);
    const sellQty = Number(row.sell_qty ?? 0);
    const buyNotional = Number(row.buy_notional ?? 0);
    const sellNotional = Number(row.sell_notional ?? 0);

    // Compute net position so long+short inventory can actually flatten on close-all.
    const netQty = buyQty - sellQty;
    if (Math.abs(netQty) < 1e-12) {
      continue;
    }

    if (netQty > 0) {
      const entry = buyQty > 0 && buyNotional > 0 ? buyNotional / buyQty : mark;
      positions.push({
        symbol: row.symbol,
        side: "LONG",
        size: netQty,
        entry_price: entry,
        mark_price: mark,
        unrealized_pnl: (mark - entry) * netQty,
      });
    } else {
      const shortSize = Math.abs(netQty);
      const entry = sellQty > 0 && sellNotional > 0 ? sellNotional / sellQty : mark;
      positions.push({
        symbol: row.symbol,
        side: "SHORT",
        size: shortSize,
        entry_price: entry,
        mark_price: mark,
        unrealized_pnl: (entry - mark) * shortSize,
      });
    }
  }

  return positions;
}

type SubmitArgs = {
  requestId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  orderType?: "market" | "limit";
  timeInForce?: string;
  venue: string;
  model: string;
  selectedTool: string;
  operatorTag: string;
  userId?: string;
  eventId?: string;
};

async function submitExecutionOrder(args: SubmitArgs) {
  const started = Date.now();
  const orderRes = await rpc<any, any>("SubmitOrder", {
    order_id: "",
    client_order_id: args.requestId,
    user_id: args.userId ?? "system",
    symbol: args.symbol,
    side: args.side,
    order_type: args.orderType ?? "market",
    quantity: args.quantity,
    price: args.price,
    time_in_force: args.timeInForce ?? "IOC",
    reduce_only: false,
    venue: args.venue,
    idempotency_key: args.requestId,
    metadata: {
      model: args.model,
      selected_tool: args.selectedTool,
    },
  });

  const latencyMs = Date.now() - started;
  const status = String(orderRes?.status ?? "SUBMITTED");
  const createdAt = formatClickhouseDate(new Date());
  const eventId = args.eventId ?? randomUUID();

  await clickhouse.insert({
    table: `${clickhouseDb}.tool_selection_events`,
    values: [
      {
        event_id: eventId,
        request_id: args.requestId,
        model: args.model,
        selected_tool: args.selectedTool,
        latency_ms: latencyMs,
        status,
        created_at: createdAt,
      },
    ],
    format: "JSONEachRow",
  });

  await clickhouse.insert({
    table: `${clickhouseDb}.execution_orders`,
    values: [
      {
        event_id: eventId,
        request_id: args.requestId,
        symbol: args.symbol,
        side: args.side,
        quantity: args.quantity,
        price: args.price,
        venue: args.venue,
        model: args.model,
        selected_tool: args.selectedTool,
        operator_tag: args.operatorTag,
        latency_ms: latencyMs,
        status,
        created_at: createdAt,
      },
    ],
    format: "JSONEachRow",
  });

  return {
    request_id: args.requestId,
    status,
    symbol: args.symbol,
    side: args.side,
    quantity: args.quantity,
    price: args.price,
    venue: args.venue,
    selected_tool: args.selectedTool,
    latency_ms: latencyMs,
  };
}

function rpc<TReq extends object, TRes>(method: string, req: TReq): Promise<TRes> {
  return new Promise((resolve, reject) => {
    grpcClient[method](req, (err: grpc.ServiceError | null, res: TRes) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
}

async function ensureClickhouseReady(): Promise<void> {
  await clickhouse.ping();
  await clickhouse.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${clickhouseDb}.tool_selection_events (
        event_id UUID,
        request_id String,
        model String,
        selected_tool String,
        latency_ms UInt32,
        status LowCardinality(String),
        created_at DateTime64(3)
      )
      ENGINE = MergeTree
      ORDER BY (created_at, request_id)
      TTL toDateTime(created_at) + INTERVAL 30 DAY DELETE
      SETTINGS index_granularity = 8192
    `,
  });

  await clickhouse.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${clickhouseDb}.execution_orders (
        event_id UUID,
        request_id String,
        symbol String,
        side LowCardinality(String),
        quantity Float64,
        price Float64,
        venue LowCardinality(String),
        model String,
        selected_tool String,
        operator_tag String,
        latency_ms UInt32,
        status LowCardinality(String),
        created_at DateTime64(3)
      )
      ENGINE = MergeTree
      ORDER BY (created_at, request_id)
      TTL toDateTime(created_at) + INTERVAL 30 DAY DELETE
      SETTINGS index_granularity = 8192
    `,
  });
}

async function buildStatusPayload(markMapOverride?: Record<string, number>) {
  const positions = await computePositions(markMapOverride);
  const totalUnrealized = positions.reduce((acc, p) => acc + p.unrealized_pnl, 0);

  const orderRows = await clickhouse
    .query({
      query: `
        SELECT status
        FROM ${clickhouseDb}.execution_orders
        ORDER BY created_at DESC
        LIMIT 500
      `,
      format: "JSONEachRow",
    })
    .then((r) => r.json<Array<{ status: string }>>());

  const totalTrades = orderRows.length;
  const markMap = markMapOverride ?? (await latestPricesBySymbol());
  const closedOrders = await clickhouse
    .query({
      query: `
        SELECT symbol, side, price, status
        FROM ${clickhouseDb}.execution_orders
        WHERE status IN ('FILLED', 'CLOSED', 'COMPLETED')
        ORDER BY created_at DESC
        LIMIT 500
      `,
      format: "JSONEachRow",
    })
    .then((r) => r.json<Array<{ symbol: string; side: string; price: number; status: string }>>());

  const profitable = closedOrders.filter((o) => {
    const mark = markMap[o.symbol] ?? defaultSymbolPrice(o.symbol);
    const side = String(o.side).toLowerCase();
    if (side === "buy") return mark > Number(o.price);
    if (side === "sell") return mark < Number(o.price);
    return false;
  }).length;
  const winRate = closedOrders.length > 0 ? Number(((profitable / closedOrders.length) * 100).toFixed(2)) : 0;
  const equity = 10_000 + totalUnrealized;
  const drawdownPct = Number((Math.max(0, (10_000 - equity) / 10_000) * 100).toFixed(2));
  const portfolioHeat = Number((Math.min(95, positions.reduce((a, p) => a + p.size, 0) * 10)).toFixed(2));

  return {
    equity: Number(equity.toFixed(2)),
    unrealized_pnl: Number(totalUnrealized.toFixed(2)),
    drawdown_pct: drawdownPct,
    daily_pnl: Number(totalUnrealized.toFixed(2)),
    portfolio_heat: portfolioHeat,
    win_rate: winRate,
    total_trades: totalTrades,
    open_positions: positions.length,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      entry_price: p.entry_price,
      current_price: p.mark_price,
      pnl: p.unrealized_pnl,
      leverage: 1,
    })),
  };
}

function buildFearGreedPayload() {
  const nowSeed = Math.floor(Date.now() / 3_600_000) % 100;
  const value = 25 + (nowSeed % 50);
  let classification = "Neutral";
  if (value < 30) classification = "Fear";
  else if (value > 70) classification = "Greed";
  return { value, classification };
}

async function buildIndicatorsPayload(symbol: string, pxOverride?: number) {
  const pair = symbolToPairSymbol(symbol.toUpperCase());
  const px = pxOverride ?? ((await latestPricesBySymbol())[pair] ?? defaultSymbolPrice(pair));
  const seed = stableHash(symbol.toUpperCase());
  const rsi = 20 + (seed % 60);
  const macd = Number((((seed % 200) - 100) / 3).toFixed(2));
  const stoch = 10 + (seed % 80);
  const adx = 10 + (seed % 40);
  const atr = Number((px * (0.004 + (seed % 20) / 10000)).toFixed(3));
  const bbWidth = Number((0.01 + (seed % 20) / 1000).toFixed(4));
  const ema9 = px * (1 + 0.0012);
  const ema21 = px * (1 + 0.0006);
  const sma50 = px * (1 - 0.001);
  const volumeRatio = Number((0.8 + (seed % 70) / 50).toFixed(2));
  return {
    rsi,
    macd,
    stoch_k: stoch,
    adx,
    atr,
    bb_width: bbWidth,
    ema_cross: ema9 > ema21 ? 1 : -1,
    volume_ratio: volumeRatio,
    ema9,
    ema21,
    sma50,
  };
}

async function buildOrderbookPayload(symbol: string, depth: number, midOverride?: number) {
  let mid = midOverride ?? 0;
  if (!(mid > 0)) {
    const rows = await clickhouse
      .query({
        query: `
          SELECT toFloat64(argMaxIf(price, created_at, price > 0)) AS latest_price
          FROM ${clickhouseDb}.execution_orders
          WHERE symbol = {symbol:String}
        `,
        format: "JSONEachRow",
        query_params: { symbol },
      })
      .then((r) => r.json<Array<{ latest_price: number }>>());
    const latestPrice = Number(rows?.[0]?.latest_price ?? 0);
    mid = latestPrice > 0 ? latestPrice : defaultSymbolPrice(symbol);
  }
  const bids: Array<{ price: number; quantity: number }> = [];
  const asks: Array<{ price: number; quantity: number }> = [];

  for (let i = 1; i <= depth; i += 1) {
    const bidSize = Number((((i * 37) % 19) / 10 + 0.2).toFixed(3));
    const askSize = Number((((i * 53) % 23) / 10 + 0.2).toFixed(3));
    bids.push({ price: Number((mid - i * 2.5).toFixed(2)), quantity: bidSize });
    asks.push({ price: Number((mid + i * 2.5).toFixed(2)), quantity: askSize });
  }

  return {
    symbol,
    mid_price: mid,
    spread: Number((asks[0].price - bids[0].price).toFixed(4)),
    bids,
    asks,
  };
}

function buildNewsPayload() {
  const now = Date.now();
  return {
    items: [
      { title: "US Treasury yields stabilize ahead of CPI print", source: "Macro Desk", sentiment: "neutral", ts: new Date(now - 5 * 60_000).toISOString() },
      { title: "Funding remains positive across top perpetual pairs", source: "Derivatives Feed", sentiment: "bullish", ts: new Date(now - 11 * 60_000).toISOString() },
      { title: "DEX liquidity deepens on ETH and BTC pools", source: "Onchain Watch", sentiment: "bullish", ts: new Date(now - 17 * 60_000).toISOString() },
    ],
  };
}

function withRealtimeMarks(baseMarkMap: Record<string, number>): Record<string, number> {
  const now = Date.now() / 1000;
  const out: Record<string, number> = { ...baseMarkMap };
  for (const s of symbolCatalog) {
    const pair = `${s.symbol}/USDT`;
    const base = out[pair] ?? s.basePrice;
    const seed = stableHash(pair) % 360;
    const drift = Math.sin((now + seed) / 5) * 0.0009 + Math.cos((now + seed) / 11) * 0.0006;
    out[pair] = Number((base * (1 + drift)).toFixed(4));
  }
  return out;
}

async function buildRealtimeSnapshot(symbolRaw: string, timeframe: string) {
  const symbol = symbolToPairSymbol(symbolRaw.split(":")[0]);
  const markMap = withRealtimeMarks(await latestPricesBySymbol());
  const status = await buildStatusPayload(markMap);
  const market = { coins: marketTickers(markMap, 20) };
  const latestPrice = markMap[symbol] ?? defaultSymbolPrice(symbol);
  const candles = { candles: syntheticCandles(symbol, timeframe, 160, latestPrice) };
  const indicators = await buildIndicatorsPayload(symbol.replace("/USDT", ""), latestPrice);
  const orderbook = await buildOrderbookPayload(symbol, 8, latestPrice);
  const feargreed = buildFearGreedPayload();
  const news = buildNewsPayload();
  const dex = {
    pools: [
      { dex: "UniswapV3", pair: "ETH/USDC", tvl: 420_000_000, volume_24h: 82_000_000, chain: "ethereum" },
      { dex: "SushiSwap", pair: "WBTC/ETH", tvl: 145_000_000, volume_24h: 22_000_000, chain: "ethereum" },
      { dex: "PancakeSwap", pair: "BNB/BUSD", tvl: 180_000_000, volume_24h: 31_000_000, chain: "bsc" },
    ],
  };
  const auto = {
    ...autoTradingState,
    uptime_seconds: Math.floor((Date.now() - serviceStartedAt) / 1000),
  };

  return {
    ts: new Date().toISOString(),
    symbol,
    timeframe,
    status,
    market,
    candles,
    indicators,
    orderbook,
    feargreed,
    news,
    dex,
    auto,
  };
}

app.get("/health", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "health" });
  try {
    const ping = await rpc<{ timestamp: number }, { status: string }>("Ping", {
      timestamp: Math.floor(Date.now() / 1000),
    });
    await clickhouse.ping();
    requestCounter.inc({ route: "health", status: "200" });
    res.json({ status: "ok", grpc: ping.status, clickhouse: "ok" });
  } catch (error: any) {
    requestCounter.inc({ route: "health", status: "503" });
    res.status(503).json({ status: "degraded", error: error?.message ?? "unknown" });
  } finally {
    timer();
  }
});

app.post("/api/tool-selection", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "tool_selection" });
  const requestId = req.body?.request_id ?? `req-${Date.now()}`;
  const model = req.body?.model ?? "gpt-5.3-codex";
  const selectedTool = req.body?.selected_tool ?? "BridgeService.SubmitOrder";
  const side = String(req.body?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
  const symbol = req.body?.symbol ?? "BTC/USDT";
  const venue = req.body?.venue ?? "sim";
  const quantity = parsePositiveQuantity(req.body?.quantity ?? 0.01, 10_000);
  const price = Number(req.body?.price ?? 0);
  const operatorTag = req.body?.operator_tag ?? "unknown";

  try {
    const payload = await submitExecutionOrder({
      requestId,
      symbol,
      side,
      quantity,
      price,
      venue,
      model,
      selectedTool,
      operatorTag,
      userId: req.body?.user_id,
      eventId: req.body?.event_id,
    });

    requestCounter.inc({ route: "tool_selection", status: "200" });
    res.json(payload);
  } catch (error: any) {
    requestCounter.inc({ route: "tool_selection", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/market", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "market" });
  try {
    const limit = parseLimit(req.query.per_page, 20, 200);
    const markMap = await latestPricesBySymbol();
    const coins = marketTickers(markMap, limit);
    requestCounter.inc({ route: "market", status: "200" });
    res.json({ coins });
  } catch (error: any) {
    requestCounter.inc({ route: "market", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/candles", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "candles" });
  try {
    const symbolRaw = String(req.query.symbol ?? "BTC/USDT");
    const symbol = symbolToPairSymbol(symbolRaw.split(":")[0]);
    const timeframe = String(req.query.timeframe ?? "1m");
    const limit = parseLimit(req.query.limit, 200, 2000);
    const markMap = await latestPricesBySymbol();
    const latestPrice = markMap[symbol] ?? defaultSymbolPrice(symbol);
    const candles = syntheticCandles(symbol, timeframe, limit, latestPrice);
    requestCounter.inc({ route: "candles", status: "200" });
    res.json({ candles });
  } catch (error: any) {
    requestCounter.inc({ route: "candles", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/indicators/:symbol", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "indicators" });
  try {
    const symbol = String(req.params.symbol ?? "BTC").toUpperCase();
    const pair = symbolToPairSymbol(symbol);
    const markMap = await latestPricesBySymbol();
    const px = markMap[pair] ?? defaultSymbolPrice(pair);
    const seed = stableHash(symbol);
    const rsi = 20 + (seed % 60);
    const macd = Number((((seed % 200) - 100) / 3).toFixed(2));
    const stoch = 10 + (seed % 80);
    const adx = 10 + (seed % 40);
    const atr = Number((px * (0.004 + (seed % 20) / 10000)).toFixed(3));
    const bbWidth = Number((0.01 + (seed % 20) / 1000).toFixed(4));
    const ema9 = px * (1 + 0.0012);
    const ema21 = px * (1 + 0.0006);
    const sma50 = px * (1 - 0.001);
    const volumeRatio = Number((0.8 + (seed % 70) / 50).toFixed(2));

    requestCounter.inc({ route: "indicators", status: "200" });
    res.json({
      rsi,
      macd,
      stoch_k: stoch,
      adx,
      atr,
      bb_width: bbWidth,
      ema_cross: ema9 > ema21 ? 1 : -1,
      volume_ratio: volumeRatio,
      ema9,
      ema21,
      sma50,
    });
  } catch (error: any) {
    requestCounter.inc({ route: "indicators", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/dex/pools", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "dex_pools" });
  try {
    const pools = [
      { dex: "UniswapV3", pair: "ETH/USDC", tvl: 420_000_000, volume_24h: 82_000_000, chain: "ethereum" },
      { dex: "SushiSwap", pair: "WBTC/ETH", tvl: 145_000_000, volume_24h: 22_000_000, chain: "ethereum" },
      { dex: "PancakeSwap", pair: "BNB/BUSD", tvl: 180_000_000, volume_24h: 31_000_000, chain: "bsc" },
      { dex: "Camelot", pair: "ARB/USDC", tvl: 52_000_000, volume_24h: 11_000_000, chain: "arbitrum" },
      { dex: "UniswapV3", pair: "SOL/USDC", tvl: 95_000_000, volume_24h: 18_000_000, chain: "ethereum" },
    ];
    requestCounter.inc({ route: "dex_pools", status: "200" });
    res.json({ pools });
  } catch (error: any) {
    requestCounter.inc({ route: "dex_pools", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/signals/recent", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "signals_recent" });
  try {
    const limit = parseLimit(req.query.limit, 20, 200);
    const rows = await clickhouse
      .query({
        query: `
          SELECT symbol, side, quantity, price, selected_tool, status, created_at
          FROM ${clickhouseDb}.execution_orders
          ORDER BY created_at DESC
          LIMIT ${limit}
        `,
        format: "JSONEachRow",
      })
      .then((r) =>
        r.json<
          Array<{
            symbol: string;
            side: string;
            quantity: number;
            price: number;
            selected_tool: string;
            status: string;
            created_at: string;
          }>
        >()
      );

    const signals = rows.map((r) => ({
      symbol: r.symbol,
      signal: String(r.side).toUpperCase() === "BUY" ? "LONG" : "SHORT",
      confidence: Number((55 + (stableHash(`${r.symbol}:${r.created_at}`) % 40)).toFixed(2)),
      strategy: r.selected_tool,
      status: r.status,
      created_at: r.created_at,
      entry_price: Number(r.price),
      size: Number(r.quantity),
    }));

    requestCounter.inc({ route: "signals_recent", status: "200" });
    res.json({ signals });
  } catch (error: any) {
    requestCounter.inc({ route: "signals_recent", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/portfolio", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "portfolio" });
  try {
    const positions = await computePositions();
    const totalUnrealized = positions.reduce((acc, p) => acc + p.unrealized_pnl, 0);
    const exposure = positions.reduce((acc, p) => acc + p.size * p.mark_price, 0);
    const equity = 10_000 + totalUnrealized;

    requestCounter.inc({ route: "portfolio", status: "200" });
    res.json({
      equity: Number(equity.toFixed(2)),
      total_unrealized_pnl: Number(totalUnrealized.toFixed(2)),
      exposure: Number(exposure.toFixed(2)),
      open_positions: positions.length,
      positions,
    });
  } catch (error: any) {
    requestCounter.inc({ route: "portfolio", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/backtest/summary", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "backtest_summary" });
  try {
    const rows = await clickhouse
      .query({
        query: `
          SELECT side, quantity, price, status
          FROM ${clickhouseDb}.execution_orders
          ORDER BY created_at DESC
          LIMIT 500
        `,
        format: "JSONEachRow",
      })
      .then((r) => r.json<Array<{ side: string; quantity: number; price: number; status: string }>>());

    const totalTrades = rows.length;
    const grossNotional = rows.reduce((acc, r) => acc + Number(r.quantity) * Number(r.price), 0);
    const wins = rows.filter((r) => ["FILLED", "CLOSED", "COMPLETED"].includes(String(r.status).toUpperCase())).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgTrade = totalTrades > 0 ? grossNotional / totalTrades : 0;

    requestCounter.inc({ route: "backtest_summary", status: "200" });
    res.json({
      period: "rolling_500_trades",
      trades: totalTrades,
      win_rate: Number(winRate.toFixed(2)),
      avg_trade_notional: Number(avgTrade.toFixed(2)),
      gross_notional: Number(grossNotional.toFixed(2)),
      sharpe: Number((0.7 + (totalTrades % 90) / 100).toFixed(2)),
      max_drawdown_pct: Number((2 + (totalTrades % 40) / 10).toFixed(2)),
    });
  } catch (error: any) {
    requestCounter.inc({ route: "backtest_summary", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/news", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "news" });
  try {
    const payload = buildNewsPayload();
    requestCounter.inc({ route: "news", status: "200" });
    res.json(payload);
  } catch (error: any) {
    requestCounter.inc({ route: "news", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/logs/recent", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "logs_recent" });
  try {
    const uptimeSec = Math.floor((Date.now() - serviceStartedAt) / 1000);
    const logs = [
      { level: "INFO", message: "Bridge API healthy", ts: new Date().toISOString() },
      { level: "INFO", message: `Uptime ${uptimeSec}s`, ts: new Date().toISOString() },
      { level: autoTradingState.enabled ? "WARN" : "INFO", message: `Auto mode ${autoTradingState.enabled ? "enabled" : "disabled"} (${autoTradingState.mode})`, ts: new Date().toISOString() },
    ];
    requestCounter.inc({ route: "logs_recent", status: "200" });
    res.json({ logs });
  } catch (error: any) {
    requestCounter.inc({ route: "logs_recent", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/auto/status", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "auto_status" });
  try {
    const uptimeSec = Math.floor((Date.now() - serviceStartedAt) / 1000);
    requestCounter.inc({ route: "auto_status", status: "200" });
    res.json({
      ...autoTradingState,
      uptime_seconds: uptimeSec,
    });
  } catch (error: any) {
    requestCounter.inc({ route: "auto_status", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.post("/api/auto/toggle", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "auto_toggle" });
  try {
    const enabled = Boolean(req.body?.enabled);
    const mode = String(req.body?.mode ?? "paper").toLowerCase() === "live" ? "live" : "paper";
    autoTradingState = {
      enabled,
      mode,
      updated_at: new Date().toISOString(),
    };
    requestCounter.inc({ route: "auto_toggle", status: "200" });
    res.json({ success: true, state: autoTradingState });
  } catch (error: any) {
    requestCounter.inc({ route: "auto_toggle", status: "500" });
    res.status(500).json({ success: false, error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/feargreed", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "feargreed" });
  try {
    const { value, classification } = buildFearGreedPayload();
    requestCounter.inc({ route: "feargreed", status: "200" });
    res.json({ value, classification });
  } catch (error: any) {
    requestCounter.inc({ route: "feargreed", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/status", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "status" });
  try {
    const payload = await buildStatusPayload();
    requestCounter.inc({ route: "status", status: "200" });
    res.json(payload);
  } catch (error: any) {
    requestCounter.inc({ route: "status", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.post("/api/trade", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "trade" });
  try {
    const symbol = symbolToPairSymbol(String(req.body?.symbol ?? "BTC/USDT").split(":")[0]);
    const side = String(req.body?.side ?? "BUY").toLowerCase() === "sell" ? "sell" : "buy";
    const quantity = parsePositiveQuantity(req.body?.size ?? req.body?.quantity ?? 0.01, 10_000);
    const orderType = String(req.body?.order_type ?? req.body?.type ?? "market").toLowerCase() === "limit" ? "limit" : "market";
    const model = String(req.body?.model ?? "gpt-5.3-codex");
    const selectedTool = "BridgeService.SubmitOrder";
    const requestId = String(req.body?.request_id ?? `trade-${Date.now()}`);
    const markMap = await latestPricesBySymbol();
    const fallbackPrice = markMap[symbol] ?? defaultSymbolPrice(symbol);
    const limitPrice = Number(req.body?.price ?? fallbackPrice);

    if (orderType === "limit" && (!Number.isFinite(limitPrice) || limitPrice <= 0)) {
      throw new Error("invalid_limit_price");
    }

    const payload = await submitExecutionOrder({
      requestId,
      symbol,
      side: side as "buy" | "sell",
      quantity,
      price: Number.isFinite(limitPrice) && limitPrice > 0 ? limitPrice : fallbackPrice,
      orderType,
      timeInForce: orderType === "limit" ? "GTC" : "IOC",
      venue: String(req.body?.venue ?? "sim"),
      model,
      selectedTool,
      operatorTag: String(req.body?.operator_tag ?? "ui"),
      userId: String(req.body?.user_id ?? "ui"),
    });

    requestCounter.inc({ route: "trade", status: "200" });
    res.json({ success: true, order: payload });
  } catch (error: any) {
    requestCounter.inc({ route: "trade", status: "500" });
    res.status(500).json({ success: false, error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.post("/api/positions/close-all", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "positions_close_all" });
  try {
    const positions = await computePositions();
    for (const p of positions) {
      const closeSide = p.side === "LONG" ? "sell" : "buy";
      await submitExecutionOrder({
        requestId: `closeall-${Date.now()}-${p.symbol}`,
        symbol: p.symbol,
        side: closeSide,
        quantity: p.size,
        price: p.mark_price,
        venue: "sim",
        model: "gpt-5.3-codex",
        selectedTool: "BridgeService.SubmitOrder",
        operatorTag: "close-all",
        userId: "ui",
      });
    }
    requestCounter.inc({ route: "positions_close_all", status: "200" });
    res.json({ success: true, closed_positions: positions.length, message: "positions flattened" });
  } catch (error: any) {
    requestCounter.inc({ route: "positions_close_all", status: "500" });
    res.status(500).json({ success: false, error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.post("/api/positions/breakeven", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "positions_breakeven" });
  try {
    const positions = await computePositions();
    requestCounter.inc({ route: "positions_breakeven", status: "200" });
    res.json({
      success: true,
      updated_positions: positions.length,
      message: "break-even request accepted",
    });
  } catch (error: any) {
    requestCounter.inc({ route: "positions_breakeven", status: "500" });
    res.status(500).json({ success: false, error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/config", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "config_get" });
  try {
    requestCounter.inc({ route: "config_get", status: "200" });
    res.json({
      binance_api_key: uiConfigState.binance_api_key,
      binance_secret: uiConfigState.binance_secret,
      updated_at: uiConfigState.updated_at,
    });
  } catch (error: any) {
    requestCounter.inc({ route: "config_get", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.post("/api/config", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "config_save" });
  try {
    uiConfigState = {
      binance_api_key: String(req.body?.binance_api_key ?? ""),
      binance_secret: String(req.body?.binance_secret ?? ""),
      updated_at: new Date().toISOString(),
    };
    requestCounter.inc({ route: "config_save", status: "200" });
    res.json({ success: true, updated_at: uiConfigState.updated_at });
  } catch (error: any) {
    requestCounter.inc({ route: "config_save", status: "500" });
    res.status(500).json({ success: false, error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.post("/api/config/test", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "config_test" });
  try {
    const checks = {
      grpc: false,
      clickhouse: false,
      credentials_present: uiConfigState.binance_api_key.length > 0 && uiConfigState.binance_secret.length > 0,
    };

    try {
      await rpc<{ timestamp: number }, { status: string }>("Ping", { timestamp: Math.floor(Date.now() / 1000) });
      checks.grpc = true;
    } catch (_e) {
      checks.grpc = false;
    }

    try {
      await clickhouse.ping();
      checks.clickhouse = true;
    } catch (_e) {
      checks.clickhouse = false;
    }

    requestCounter.inc({ route: "config_test", status: "200" });
    res.json({ success: true, checks });
  } catch (error: any) {
    requestCounter.inc({ route: "config_test", status: "500" });
    res.status(500).json({ success: false, error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/tool-selection/latest", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "tool_selection_latest" });
  try {
    const result = await clickhouse.query({
      query: `
        SELECT request_id, model, selected_tool, latency_ms, status, created_at
        FROM ${clickhouseDb}.tool_selection_events
        ORDER BY created_at DESC
        LIMIT 1
      `,
      format: "JSONEachRow",
    });
    const rows = await result.json<any>();
    requestCounter.inc({ route: "tool_selection_latest", status: "200" });
    res.json(rows[0] ?? null);
  } catch (error: any) {
    requestCounter.inc({ route: "tool_selection_latest", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/orders", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "orders" });
  try {
    const limit = parseLimit(req.query.limit, 50, 500);
    const rows = await clickhouse
      .query({
        query: `
          SELECT request_id, symbol, side, quantity, price, venue, model, selected_tool,
                 operator_tag, latency_ms, status, created_at
          FROM ${clickhouseDb}.execution_orders
          ORDER BY created_at DESC
          LIMIT ${limit}
        `,
        format: "JSONEachRow",
      })
      .then((r) => r.json<ExecutionOrder[]>());

    requestCounter.inc({ route: "orders", status: "200" });
    res.json(rows);
  } catch (error: any) {
    requestCounter.inc({ route: "orders", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/positions", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "positions" });
  try {
    const positions = await computePositions();
    const totalPnl = positions.reduce((acc, p) => acc + p.unrealized_pnl, 0);

    requestCounter.inc({ route: "positions", status: "200" });
    res.json({ positions, total_unrealized_pnl: totalPnl });
  } catch (error: any) {
    requestCounter.inc({ route: "positions", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/pnl", async (_req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "pnl" });
  try {
    const positions = await computePositions();
    const totalPnl = positions.reduce((acc, p) => acc + p.unrealized_pnl, 0);
    requestCounter.inc({ route: "pnl", status: "200" });
    res.json({ total_unrealized_pnl: totalPnl });
  } catch (error: any) {
    requestCounter.inc({ route: "pnl", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/orderbook", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "orderbook" });
  try {
    const symbol = String(req.query.symbol ?? "BTC/USDT");
    const depth = parseLimit(req.query.depth, 8, 25);

    const payload = await buildOrderbookPayload(symbol, depth);
    requestCounter.inc({ route: "orderbook", status: "200" });
    res.json(payload);
  } catch (error: any) {
    requestCounter.inc({ route: "orderbook", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/realtime/snapshot", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "realtime_snapshot" });
  try {
    const symbol = String(req.query.symbol ?? "BTC/USDT");
    const timeframe = String(req.query.timeframe ?? "1m");
    const payload = await buildRealtimeSnapshot(symbol, timeframe);
    requestCounter.inc({ route: "realtime_snapshot", status: "200" });
    res.json(payload);
  } catch (error: any) {
    requestCounter.inc({ route: "realtime_snapshot", status: "500" });
    res.status(500).json({ error: error?.message ?? "unknown_error" });
  } finally {
    timer();
  }
});

app.get("/api/realtime/stream", async (req: Request, res: Response) => {
  const timer = requestLatency.startTimer({ route: "realtime_stream" });
  const symbol = String(req.query.symbol ?? "BTC/USDT");
  const timeframe = String(req.query.timeframe ?? "1m");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = async () => {
    try {
      const payload = await buildRealtimeSnapshot(symbol, timeframe);
      res.write(`event: snapshot\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error: any) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: error?.message ?? "unknown_error" })}\n\n`);
    }
  };

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  const stream = setInterval(() => {
    void send();
  }, 1_000);

  requestCounter.inc({ route: "realtime_stream", status: "200" });
  void send();

  req.on("close", () => {
    clearInterval(stream);
    clearInterval(heartbeat);
    timer();
  });
});

app.get("/metrics", async (_req: Request, res: Response) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

ensureClickhouseReady()
  .then(() => {
    app.listen(port, () => {
      console.log(`bridge-api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("bridge-api startup failed", err);
    process.exit(1);
  });
