import { ethers } from 'ethers';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

export interface MEVProtectionConfig {
  enableFlashbots: boolean;
  enablePrivateMempool: boolean;
  maxSlippage: number;
  minPriorityFee: string;
  blockTolerance: number;
  sandwichDetection: boolean;
  dynamicSlippage: boolean;
  maxGasPrice: string;
}

export interface SandwichAttack {
  detected: boolean;
  fronthunningOrder?: ethers.Transaction;
  backrunningOrder?: ethers.Transaction;
  profit: string;
  gasSpent: string;
}

export interface PrivateTxRequest {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export class MEVProtectionService {
  private config: MEVProtectionConfig;
  private flashbotsProvider: any = null;
  private provider: ethers.JsonRpcProvider;

  constructor(
    provider: ethers.JsonRpcProvider,
    config: Partial<MEVProtectionConfig> = {}
  ) {
    this.provider = provider;
    this.config = {
      enableFlashbots: config.enableFlashbots ?? true,
      enablePrivateMempool: config.enablePrivateMempool ?? true,
      maxSlippage: config.maxSlippage ?? 0.005,
      minPriorityFee: config.minPriorityFee ?? '2000000000',
      blockTolerance: config.blockTolerance ?? 3,
      sandwichDetection: config.sandwichDetection ?? true,
      dynamicSlippage: config.dynamicSlippage ?? true,
      maxGasPrice: config.maxGasPrice ?? '100000000000'
    };
  }

  async initialize(flashbotsSigner?: ethers.Wallet): Promise<void> {
    if (this.config.enableFlashbots && flashbotsSigner) {
      try {
        const FlashbotsBundleProvider = await import('@flashbots/ethers-provider-bundle').then(m => m.FlashbotsBundleProvider);

        this.flashbotsProvider = await FlashbotsBundleProvider.create(
          this.provider,
          flashbotsSigner,
          'https://relay.flashbots.net'
        );

        logger.info('Flashbots provider initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize Flashbots provider:', error);
        this.config.enableFlashbots = false;
      }
    }
  }

  async detectSandwichAttack(tx: ethers.Transaction): Promise<SandwichAttack> {
    if (!this.config.sandwichDetection) {
      return { detected: false, profit: '0', gasSpent: '0' };
    }

    try {
      const block = await this.provider.getBlock('latest');
      const pendingTxs = await this.provider.send('txpool_content', []);

      const potentialAttacks: SandwichAttack[] = [];

      for (const [_, txs] of Object.entries(pendingTxs.pending)) {
        for (const pendingTx of txs) {
          if (!pendingTx) continue;

          const isSameContract = pendingTx.to === tx.to;
          const isFrontrun = pendingTx.gasPrice && tx.gasPrice
            ? BigInt(pendingTx.gasPrice) > BigInt(tx.gasPrice)
            : false;
          const isBackrun = pendingTx.gasPrice && tx.gasPrice
            ? BigInt(pendingTx.gasPrice) < BigInt(tx.gasPrice)
            : false;

          if (isSameContract && (isFrontrun || isBackrun)) {
            potentialAttacks.push({
              detected: true,
              fronthunningOrder: isFrontrun ? pendingTx : undefined,
              backrunningOrder: isBackrun ? pendingTx : undefined,
              profit: '0',
              gasSpent: pendingTx.gas || '0'
            });
          }
        }
      }

      if (potentialAttacks.length > 0) {
        logger.warn(`Detected ${potentialAttacks.length} potential sandwich attacks`);
        return potentialAttacks[0];
      }

      return { detected: false, profit: '0', gasSpent: '0' };
    } catch (error) {
      logger.error('Error detecting sandwich attack:', error);
      return { detected: false, profit: '0', gasSpent: '0' };
    }
  }

  async sendPrivateTransaction(request: PrivateTxRequest): Promise<ethers.TransactionResponse> {
    if (!this.config.enablePrivateMempool) {
      return this.sendPublicTransaction(request);
    }

    try {
      if (this.config.enableFlashbots && this.flashbotsProvider) {
        return await this.sendFlashbotsBundle(request);
      }

      const txHash = await this.provider.send('eth_sendPrivateTransaction', [{
        to: request.to,
        data: request.data,
        value: request.value || '0x0',
        gas: request.gasLimit,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas
      }]);

      logger.info(`Private transaction sent: ${txHash}`);

      const receipt = await this.provider.waitForTransaction(txHash, this.config.blockTolerance);
      return receipt as any;
    } catch (error) {
      logger.error('Private transaction failed, falling back to public:', error);
      return this.sendPublicTransaction(request);
    }
  }

  private async sendFlashbotsBundle(request: PrivateTxRequest): Promise<ethers.TransactionResponse> {
    if (!this.flashbotsProvider) {
      throw new Error('Flashbots provider not initialized');
    }

    const signedBundle = await this.flashbotsProvider.signBundle([
      {
        signer: await this.flashbotsProvider.getSigner(),
        transaction: request
      }
    ]);

    const simulation = await this.flashbotsProvider.simulate(signedBundle);

    if (!simulation.firstRelevancy || !simulation.firstRelevancy.isError()) {
      const bundleStats = await this.flashbotsProvider.sendRawBundle(signedBundle, await this.provider.getBlockNumber() + 1);

      logger.info('Flashbots bundle sent');

      const txResponse = await bundleStats.wait();
      return txResponse as any;
    } else {
      throw new Error(`Bundle simulation failed: ${simulation.firstRelevancy.error}`);
    }
  }

  private async sendPublicTransaction(request: PrivateTxRequest): Promise<ethers.TransactionResponse> {
    const tx = await this.provider.getSigner().sendTransaction({
      to: request.to as `0x${string}`,
      data: request.data as `0x${string}`,
      value: request.value ? BigInt(request.value) : 0n,
      gasLimit: request.gasLimit ? BigInt(request.gasLimit) : undefined,
      maxFeePerGas: request.maxFeePerGas ? BigInt(request.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas ? BigInt(request.maxPriorityFeePerGas) : undefined
    });

    logger.info(`Public transaction sent: ${tx.hash}`);
    return tx;
  }

  calculateDynamicSlippage(baseSlippage: number, volatility: number, orderSize: number, liquidity: number): number {
    if (!this.config.dynamicSlippage) {
      return baseSlippage;
    }

    const sizeFactor = Math.min(orderSize / liquidity, 0.5);
    const volatilityFactor = Math.min(volatility / 100, 0.5);

    const adjustedSlippage = baseSlippage * (1 + sizeFactor + volatilityFactor);

    return Math.min(adjustedSlippage, this.config.maxSlippage * 2);
  }

  async estimatePriorityFee(): Promise<string> {
    try {
      const feeData = await this.provider.getFeeData();

      const basePriorityFee = feeData.maxPriorityFeePerGas || 0n;
      const minFee = BigInt(this.config.minPriorityFee);

      return (basePriorityFee > minFee ? basePriorityFee : minFee).toString();
    } catch (error) {
      logger.error('Error estimating priority fee:', error);
      return this.config.minPriorityFee;
    }
  }

  async checkGasConditions(): Promise<boolean> {
    try {
      const feeData = await this.provider.getFeeData();
      const maxGasPrice = BigInt(this.config.maxGasPrice);

      if (feeData.gasPrice && feeData.gasPrice > maxGasPrice) {
        logger.warn(`Gas price too high: ${feeData.gasPrice.toString()}`);
        return false;
      }

      if (feeData.maxFeePerGas && feeData.maxFeePerGas > maxGasPrice) {
        logger.warn(`Max fee per gas too high: ${feeData.maxFeePerGas.toString()}`);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error checking gas conditions:', error);
      return false;
    }
  }

  async executeWithMEVProtection(
    txRequest: PrivateTxRequest,
    slippage: number,
    volatility?: number,
    orderSize?: number,
    liquidity?: number
  ): Promise<ethers.TransactionReceipt> {
    const attack = await this.detectSandwichAttack(txRequest as any);

    if (attack.detected) {
      logger.warn('Sandwich attack detected, adjusting strategy');

      const adjustedSlippage = this.calculateDynamicSlippage(
        slippage * 1.5,
        volatility || 0.01,
        orderSize || 1,
        liquidity || 1000
      );

      const newTx = this.adjustForSlippage(txRequest, adjustedSlippage);
      const tx = await this.sendPrivateTransaction(newTx);

      return await tx.wait();
    }

    const adjustedSlippage = this.calculateDynamicSlippage(
      slippage,
      volatility || 0.01,
      orderSize || 1,
      liquidity || 1000
    );

    const newTx = this.adjustForSlippage(txRequest, adjustedSlippage);
    const tx = await this.sendPrivateTransaction(newTx);

    return await tx.wait();
  }

  private adjustForSlippage(request: PrivateTxRequest, slippage: number): PrivateTxRequest {
    const encodedTx = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      ethers.hexlify(ethers.getBytes(request.data)).substring(10)
    );

    const [amountOut, tokenIn, , amountIn, ,] = encodedTx;

    const adjustedAmountOut = (BigInt(amountOut) * BigInt(Math.floor((1 - slippage) * 10000))) / 10000n;

    const newData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [adjustedAmountOut, tokenIn, encodedTx[2], amountIn, encodedTx[4], encodedTx[5]]
    );

    return {
      ...request,
      data: request.data.substring(0, 10) + ethers.hexlify(newData).substring(2)
    };
  }

  getConfig(): MEVProtectionConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<MEVProtectionConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('MEV protection config updated');
  }
}

export class EigenPhiAnalyzer {
  private apiKey: string;
  private baseUrl: string = 'https://api.eigenphi.io/api/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyzeMEVOpportunity(txHash: string): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/mev/opportunity/${txHash}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`EigenPhi API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error('Error analyzing MEV opportunity:', error);
      return null;
    }
  }

  async getTopMEVBots(limit: number = 10): Promise<any[]> {
    try {
      const response = await fetch(`${this.baseUrl}/mev/bots?limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`EigenPhi API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error('Error fetching top MEV bots:', error);
      return [];
    }
  }
}
