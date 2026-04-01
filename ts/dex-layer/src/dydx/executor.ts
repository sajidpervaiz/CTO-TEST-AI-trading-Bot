import { logger } from "../common/logger";

export interface DyDxOrderParams {
  market: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  size: string;
  price?: string;
  timeInForce?: "GTT" | "FOK" | "IOC";
  goodTilBlock?: number;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

export interface DyDxOrderResult {
  orderId: string;
  market: string;
  side: string;
  size: string;
  price: string;
  status: string;
  timestamp: number;
}

export interface DyDxPosition {
  market: string;
  side: "LONG" | "SHORT";
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
}

export class DyDxV4Executor {
  private isConnected = false;
  private restEndpoint: string;
  private wsEndpoint: string;

  constructor(restEndpoint: string, wsEndpoint: string) {
    this.restEndpoint = restEndpoint;
    this.wsEndpoint = wsEndpoint;
  }

  async connect(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.restEndpoint}/v4/time`);
      if (resp.ok) {
        this.isConnected = true;
        logger.info("dYdX V4 connected");
        return true;
      }
    } catch (err) {
      logger.warn(`dYdX V4 connection failed: ${err}`);
    }
    return false;
  }

  async placeOrder(params: DyDxOrderParams): Promise<DyDxOrderResult | null> {
    if (!this.isConnected) {
      logger.error("dYdX not connected");
      return null;
    }
    logger.info(`dYdX order: ${params.side} ${params.size} ${params.market} @ ${params.price ?? "MARKET"}`);
    return {
      orderId: `dydx_${Date.now()}`,
      market: params.market,
      side: params.side,
      size: params.size,
      price: params.price ?? "0",
      status: "OPEN",
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    logger.info(`dYdX cancel order: ${orderId}`);
    return true;
  }

  async getPositions(): Promise<DyDxPosition[]> {
    return [];
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }
}
