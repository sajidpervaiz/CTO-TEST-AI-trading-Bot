import { UniswapV3Executor } from "./executor";
import type { DEXConfig } from "../common/types";

const mockConfig: DEXConfig = {
  network: {
    rpcHttp: "http://localhost:8545",
    chainId: 1,
    name: "ethereum",
  },
  maxSlippageBps: 50,
};

describe("UniswapV3Executor", () => {
  it("should instantiate without throwing", () => {
    expect(() => new UniswapV3Executor(mockConfig)).not.toThrow();
  });

  it("should estimate price impact correctly", () => {
    const executor = new UniswapV3Executor(mockConfig);
    const impact = (executor as any)._estimatePriceImpact(1000n, 997n);
    expect(typeof impact).toBe("number");
    expect(impact).toBeGreaterThanOrEqual(0);
  });

  it("should handle zero amountOut in price impact", () => {
    const executor = new UniswapV3Executor(mockConfig);
    const impact = (executor as any)._estimatePriceImpact(1000n, 0n);
    expect(impact).toBe(100);
  });
});
