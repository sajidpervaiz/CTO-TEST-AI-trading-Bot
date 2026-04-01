import { JsonRpcProvider, Contract, Wallet } from "ethers";
import type { DEXConfig, DEXQuote, SwapResult } from "../common/types";
import { logger } from "../common/logger";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

const SUSHISWAP_ROUTER_ETH = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

export class SushiSwapExecutor {
  private provider: JsonRpcProvider;
  private router: Contract;
  private config: DEXConfig;
  private wallet?: Wallet;

  constructor(config: DEXConfig, routerAddress: string = SUSHISWAP_ROUTER_ETH) {
    this.config = config;
    this.provider = new JsonRpcProvider(config.network.rpcHttp);
    this.router = new Contract(routerAddress, ROUTER_ABI, this.provider);
    if (config.walletPrivateKey) {
      this.wallet = new Wallet(config.walletPrivateKey, this.provider);
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<DEXQuote | null> {
    try {
      const amounts: bigint[] = await this.router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
      if (!amounts || amounts.length < 2) {
        return null;
      }
      const amountOut = amounts[1];
      const now = Math.floor(Date.now() / 1000);
      return {
        dex: "sushiswap",
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        priceImpactPct: this._estimatePriceImpact(amountIn, amountOut),
        gasEstimate: 180_000n,
        route: [tokenIn, tokenOut],
        timestamp: now,
        validUntil: now + 30,
      };
    } catch (err) {
      logger.debug(`SushiSwap quote error: ${err}`);
      return null;
    }
  }

  async executeSwap(quote: DEXQuote): Promise<SwapResult | null> {
    if (!this.wallet) {
      logger.error("Wallet not configured for SushiSwap");
      return null;
    }
    const routerWithSigner = this.router.connect(this.wallet) as Contract;
    const slippageBps = this.config.maxSlippageBps;
    const minOut = (quote.amountOut * BigInt(10000 - slippageBps)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    try {
      const tx = await routerWithSigner.swapExactTokensForTokens(
        quote.amountIn,
        minOut,
        [quote.tokenIn, quote.tokenOut],
        await this.wallet.getAddress(),
        deadline
      );
      const receipt = await tx.wait();
      return {
        txHash: receipt.hash,
        dex: "sushiswap",
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        gasUsed: BigInt(receipt.gasUsed),
        status: receipt.status === 1 ? "success" : "reverted",
        timestamp: Math.floor(Date.now() / 1000),
      };
    } catch (err) {
      logger.error(`SushiSwap swap failed: ${err}`);
      return null;
    }
  }

  private _estimatePriceImpact(amountIn: bigint, amountOut: bigint): number {
    if (amountOut === 0n) return 100;
    return Math.max(0, (Number(amountIn) / Number(amountOut) - 1) * 100);
  }
}
