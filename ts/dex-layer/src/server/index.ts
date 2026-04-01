import { createServer, Server } from "http";
import { logger } from "../common/logger";
import { UniswapV3Executor } from "../uniswap/executor";
import { SushiSwapExecutor } from "../sushiswap/executor";
import { PancakeSwapExecutor } from "../pancakeswap/executor";
import { DyDxV4Executor } from "../dydx/executor";
import type { DEXConfig, DEXQuote, NetworkConfig } from "../common/types";
import { Redis } from "ioredis";

interface Config {
  httpPort: number;
  redisUrl: string;
  networks: Record<string, NetworkConfig>;
  maxSlippageBps: number;
  walletPrivateKey?: string;
}

function loadConfig(): Config {
  return {
    httpPort: parseInt(process.env.HTTP_PORT ?? "3001"),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    networks: {
      ethereum: {
        rpcHttp: process.env.ETH_RPC_HTTP ?? "",
        rpcWs: process.env.ETH_RPC_WS,
        chainId: 1,
        name: "ethereum",
      },
      bsc: {
        rpcHttp: process.env.BSC_RPC_HTTP ?? "",
        chainId: 56,
        name: "bsc",
      },
    },
    maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS ?? "50"),
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("DEX layer starting…");

  const ethConfig: DEXConfig = {
    network: config.networks["ethereum"],
    maxSlippageBps: config.maxSlippageBps,
    walletPrivateKey: config.walletPrivateKey,
  };
  const bscConfig: DEXConfig = {
    network: config.networks["bsc"],
    maxSlippageBps: config.maxSlippageBps,
    walletPrivateKey: config.walletPrivateKey,
  };

  const uniswap = new UniswapV3Executor(ethConfig);
  const sushiswap = new SushiSwapExecutor(ethConfig);
  const pancakeswap = new PancakeSwapExecutor(bscConfig);
  const dydx = new DyDxV4Executor(
    process.env.DYDX_REST_ENDPOINT ?? "https://indexer.dydx.trade",
    process.env.DYDX_WS_ENDPOINT ?? "wss://indexer.dydx.trade/v4/ws"
  );

  let redis: Redis | null = null;
  try {
    redis = new Redis(config.redisUrl, { lazyConnect: true });
    await redis.connect();
    logger.info("Redis connected");
    setupRedisSubscriptions(redis, uniswap, sushiswap, pancakeswap, dydx);
  } catch (err) {
    logger.warn(`Redis unavailable: ${err}`);
  }

  const server = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
    } else if (req.url === "/quote" && req.method === "POST") {
      handleQuoteRequest(req, res, uniswap, sushiswap, pancakeswap);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(config.httpPort, () => {
    logger.info(`DEX layer HTTP server listening on :${config.httpPort}`);
  });

  process.on("SIGINT", async () => {
    logger.info("DEX layer shutting down…");
    server.close();
    if (redis) await redis.quit();
    await dydx.disconnect();
    process.exit(0);
  });
}

function setupRedisSubscriptions(
  redis: Redis,
  uniswap: UniswapV3Executor,
  sushiswap: SushiSwapExecutor,
  pancakeswap: PancakeSwapExecutor,
  dydx: DyDxV4Executor
): void {
  const sub = redis.duplicate();
  sub.subscribe("dex:quote_requests").catch((err) =>
    logger.error(`Redis subscribe error: ${err}`)
  );
  sub.on("message", async (channel, message) => {
    if (channel !== "dex:quote_requests") return;
    try {
      const req = JSON.parse(message);
      const quotes = await Promise.all([
        uniswap.getQuote(req.tokenIn, req.tokenOut, BigInt(req.amountIn)),
        sushiswap.getQuote(req.tokenIn, req.tokenOut, BigInt(req.amountIn)),
      ]);
      const valid = quotes.filter(Boolean) as DEXQuote[];
      const best = valid.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1))[0];
      if (best) {
        await redis.publish("dex:quotes", JSON.stringify({
          ...best,
          amountIn: best.amountIn.toString(),
          amountOut: best.amountOut.toString(),
          gasEstimate: best.gasEstimate.toString(),
        }));
      }
    } catch (err) {
      logger.error(`Quote request error: ${err}`);
    }
  });
}

function handleQuoteRequest(
  req: import("http").IncomingMessage,
  res: import("http").ServerResponse,
  uniswap: UniswapV3Executor,
  sushiswap: SushiSwapExecutor,
  pancakeswap: PancakeSwapExecutor
): void {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    try {
      const params = JSON.parse(body);
      const quotes = await Promise.all([
        uniswap.getQuote(params.tokenIn, params.tokenOut, BigInt(params.amountIn)),
        sushiswap.getQuote(params.tokenIn, params.tokenOut, BigInt(params.amountIn)),
      ]);
      const valid = quotes.filter(Boolean) as DEXQuote[];
      const best = valid.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1))[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(best ? {
        ...best,
        amountIn: best.amountIn.toString(),
        amountOut: best.amountOut.toString(),
        gasEstimate: best.gasEstimate.toString(),
      } : null));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

main().catch((err) => {
  logger.error(`DEX layer startup error: ${err}`);
  process.exit(1);
});
