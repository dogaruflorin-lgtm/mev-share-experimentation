import * as convert from '../utils/conversions';

/**
 * Backrun Filter Module
 * Analyzes MEV-Share orders and identifies viable backrun opportunities
 */

export interface BackrunOpportunity {
  hash: string;
  score: number; // 0-100, higher = more profitable
  reasons: string[];
  gasPrice: number;
  gasLimit: number;
  value: string;
  to: string | null;
  isLikelyDex: boolean;
  isProfitable: boolean;
  timestamp: number;
  blocks_elapsed: number;
}

export interface BackrunFilterConfig {
  minGasPriceGwei: number; // Minimum gas price to consider
  minValueWei: string; // Minimum transaction value
  dexPatterns: string[]; // Known DEX contract addresses
  funcSignatures: string[]; // Function signatures that are backrunnable
}

class BackrunFilter {
  private config: BackrunFilterConfig;

  constructor(config?: Partial<BackrunFilterConfig>) {
    this.config = {
      minGasPriceGwei: config?.minGasPriceGwei || 30,
      minValueWei: config?.minValueWei || '0',
      dexPatterns: config?.dexPatterns || [
        '0x1111111111111111111111111111111111111111', // 1inch
        '0xdef1c0ded9bef7c1fb70af64971b92f2f61e54c7', // dodo
        '0xe592427a0aece92de3edee1f18e0157c05861564', // uniswap v3 router
        '0x68b3465833fb72B5A828cCEEAFb0B7dC093eaF6f', // uniswap v3 router2
        '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // uniswap v2 router
      ],
      funcSignatures: config?.funcSignatures || [
        '0x3593564c', // swap functions
        '0x09b81346', // swapExactTokensForTokens
        '0x38ed1739', // swapExactETHForTokens
        '0x7ff36ab5', // swapExactETHForTokens (alternative)
        '0x414bf389', // swap (curve)
      ],
    };
  }

  /**
   * Analyzes a transaction and determines if it's a viable backrun opportunity
   */
  public analyzeTransaction(
    tx: RawTransaction | Raw2930Transaction | Raw1559Transaction,
    blockNumber: number,
    receivedBlock: number
  ): BackrunOpportunity | null {
    const reasons: string[] = [];
    let score = 0;

    // Extract gas price - EIP-1559 transactions use maxPriorityFeePerGas + baseFee
    const gasPrice = this.extractGasPrice(tx);

    // Check if transaction has sufficient value/complexity
    if (!this.hasMinimumValue(tx)) {
      return null;
    }

    // 1. Check if it's likely a DEX interaction
    const isDex = this.isDexInteraction(tx);
    if (isDex) {
      score += 30;
      reasons.push('DEX interaction detected');
    }

    // 2. Check gas price competitiveness
    const gasPriceScore = this.scoreGasPrice(gasPrice);
    score += gasPriceScore;
    if (gasPriceScore > 0) {
      reasons.push(`Competitive gas price: ${gasPrice.toFixed(2)} gwei`);
    }

    // 3. Check transaction value
    const valueScore = this.scoreValue(tx);
    score += valueScore;
    if (valueScore > 0) {
      reasons.push(`High transaction value detected`);
    }

    // 4. Check input data patterns
    const inputScore = this.analyzeInputData(tx);
    score += inputScore;
    if (inputScore > 0) {
      reasons.push('Backrunnable function signature detected');
    }

    // 5. Check mempool age (blocks_elapsed)
    const ageScore = this.scoreAge(blockNumber - receivedBlock);
    score += ageScore;
    if (ageScore > 0) {
      reasons.push(
        `Recent transaction (${blockNumber - receivedBlock} blocks old)`
      );
    }

    // 6. Check if transaction to an EOA or contract
    const targetScore = this.scoreTarget(tx.to);
    score += targetScore;

    // Normalize score to 0-100
    score = Math.min(100, Math.max(0, score));

    const isProfitable = score >= 40; // Threshold for profitability

    if (!isProfitable && reasons.length === 0) {
      return null; // Not worth tracking
    }

    return {
      hash: tx.hash,
      score,
      reasons,
      gasPrice,
      gasLimit: parseInt(tx.gas, 16),
      value: tx.value,
      to: tx.to,
      isLikelyDex: isDex,
      isProfitable,
      timestamp: Date.now(),
      blocks_elapsed: blockNumber - receivedBlock,
    };
  }

  /**
   * Filters orders and returns only viable backrun opportunities
   */
  public filterOrders(
    orders: IOrder[],
    blockTxs: RawTransaction[],
    currentBlock: number
  ): BackrunOpportunity[] {
    const matchedOrders = new Map<string, IOrder>();

    // Create a map of orders for quick lookup
    for (const order of orders) {
      matchedOrders.set(order.hash, order);
    }

    const opportunities: BackrunOpportunity[] = [];

    for (const tx of blockTxs) {
      const order = matchedOrders.get(tx.hash);

      if (!order) continue;

      const opportunity = this.analyzeTransaction(
        tx,
        currentBlock,
        order.received_in
      );

      if (opportunity && opportunity.isProfitable) {
        opportunities.push(opportunity);
      }
    }

    return opportunities.sort((a, b) => b.score - a.score);
  }

  /**
   * Extracts effective gas price from transaction
   */
  private extractGasPrice(
    tx: RawTransaction | Raw2930Transaction | Raw1559Transaction
  ): number {
    if ('maxPriorityFeePerGas' in tx && tx.maxPriorityFeePerGas) {
      // EIP-1559 transaction - use maxPriorityFeePerGas as estimate
      return convert.toGwei(tx.maxPriorityFeePerGas, 'wei') || 0;
    }

    if (tx.gasPrice) {
      return convert.toGwei(tx.gasPrice, 'wei') || 0;
    }

    return 0;
  }

  /**
   * Checks if transaction has minimum value requirement
   */
  private hasMinimumValue(
    tx: RawTransaction | Raw2930Transaction | Raw1559Transaction
  ): boolean {
    const minValue = BigInt(this.config.minValueWei);
    const txValue = BigInt(tx.value || '0');
    return txValue > minValue;
  }

  /**
   * Detects if transaction interacts with known DEX contracts
   */
  private isDexInteraction(
    tx: RawTransaction | Raw2930Transaction | Raw1559Transaction
  ): boolean {
    if (!tx.to) return false;

    const toAddress = tx.to.toLowerCase();
    return this.config.dexPatterns.some(
      (pattern) => toAddress === pattern.toLowerCase()
    );
  }

  /**
   * Scores gas price for backrunning profitability
   */
  private scoreGasPrice(gasPrice: number): number {
    if (gasPrice < this.config.minGasPriceGwei) return 0;

    // Higher gas price = potentially more profitable opportunity
    if (gasPrice > 100) return 20;
    if (gasPrice > 50) return 15;
    if (gasPrice > this.config.minGasPriceGwei) return 10;

    return 0;
  }

  /**
   * Scores transaction value
   */
  private scoreValue(
    tx: RawTransaction | Raw2930Transaction | Raw1559Transaction
  ): boolean {
    const txValue = BigInt(tx.value || '0');
    const oneEther = BigInt('1000000000000000000');

    // Transactions with significant value are more likely to be profitable
    if (txValue > oneEther * BigInt(10)) return 20;
    if (txValue > oneEther) return 10;

    return 0;
  }

  /**
   * Analyzes input data for backrunnable function signatures
   */
  private analyzeInputData(
    tx: RawTransaction | Raw2930Transaction | Raw1559Transaction
  ): number {
    if (!tx.input || tx.input === '0x') return 0;

    const selector = tx.input.slice(0, 10).toLowerCase();

    if (this.config.funcSignatures.some((sig) => selector === sig)) {
      return 15;
    }

    // Check for common swap patterns in input
    if (
      tx.input.includes('swap') ||
      tx.input.includes('SWAP') ||
      tx.input.includes('dex') ||
      tx.input.includes('DEX')
    ) {
      return 5;
    }

    return 0;
  }

  /**
   * Scores transaction based on age (freshness)
   */
  private scoreAge(blocksOld: number): number {
    if (blocksOld < 1) return 25; // Very fresh
    if (blocksOld < 2) return 20;
    if (blocksOld < 3) return 15;
    if (blocksOld < 5) return 10;
    if (blocksOld < 10) return 5;

    return 0; // Too old to backrun
  }

  /**
   * Scores based on target address type
   */
  private scoreTarget(to: string | null): number {
    if (!to) return 0; // Contract creation, less likely to be backrunnable

    // Contract addresses are more interesting for backruns
    return 5;
  }

  /**
   * Sets a new configuration
   */
  public setConfig(config: Partial<BackrunFilterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Gets current configuration
   */
  public getConfig(): BackrunFilterConfig {
    return { ...this.config };
  }
}

export default BackrunFilter;
