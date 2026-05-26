/**
 * Strict Backrun Opportunity Analyzer
 * 
 * PRINCIPII:
 * 1. Filtrare AGRESIVA - doar oportunități cu profit cert (>1 ETH)
 * 2. Bundle execution - TX merge NUMAI cu victim TX (sandwich bundle)
 * 3. Zero waste - nu se trimite nimic dacă nu intră în bundle
 * 4. Fast calculation - max 200ms per oportunitate
 * 5. Mempool awareness - evita conflicte cu alte bots
 */

export interface StrictBackrunOpportunity {
  hash: string;
  victimTxHash: string;
  
  /* Profit Analysis */
  grossProfit: string; // Wei, profit inainte de fees
  netProfit: string; // Wei, profit dupa fees
  profitPercentage: number; // %
  
  /* Gas Analysis */
  estimatedGasUsed: number;
  estimatedGasCost: string; // Wei
  minProfitThreshold: string; // Wei - minim necesar pentru profitabilitate
  
  /* Bundle Info */
  bundleOrder: 'FRONT_RUN' | 'BACK_RUN' | 'SANDWICH'; // Pozitia in bundle
  victimGasPrice: number; // gwei
  ourGasPrice: number; // gwei - trebuie mai mare decat victim
  bundleSize: number; // numar TX in bundle
  
  /* Risk Metrics */
  riskScore: number; // 0-100, lower = safer
  failureReason?: string; // Daca nu e profitabil, de ce
  
  timestamp: number;
  calculationTime: number; // ms
}

export interface AnalyzerConfig {
  minNetProfitWei: string; // Default: 0.5 ETH
  maxCalculationTimeMs: number; // Default: 200ms
  maxGasPrice: string; // Nu merge cu gwei mai mare
  minProfitMargin: number; // Default: 1.1 (10% margin over fees)
  riskTolerance: number; // 0-100, lower = more conservative
}

class StrictBackrunAnalyzer {
  private config: AnalyzerConfig;
  private lastAnalyzedHashes = new Set<string>();
  private opportunityCache = new Map<string, StrictBackrunOpportunity>();

  constructor(config?: Partial<AnalyzerConfig>) {
    this.config = {
      minNetProfitWei: config?.minNetProfitWei || '500000000000000000', // 0.5 ETH
      maxCalculationTimeMs: config?.maxCalculationTimeMs || 200,
      maxGasPrice: config?.maxGasPrice || '150000000000', // 150 gwei
      minProfitMargin: config?.minProfitMargin || 1.15, // 15% margin
      riskTolerance: config?.riskTolerance || 30,
    };
  }

  /**
   * MAIN FILTER - Analizeaza STRICT o oportunitate
   * Returns null daca nu e profitabila sau nu merge sa intre in bundle
   */
  public analyzeStrict(
    victimTx: RawTransaction | Raw1559Transaction | Raw2930Transaction,
    estimatedSwapOutput: string,
    currentGasPrice: number,
    blockNumber: number,
    receivedBlock: number
  ): StrictBackrunOpportunity | null {
    const startTime = performance.now();

    // 1. RAPID PROFITABILITY CHECK (fail fast)
    const profitCheck = this.quickProfitCheck(
      victimTx,
      estimatedSwapOutput,
      currentGasPrice
    );

    if (!profitCheck.isProfitable) {
      return null; // Nu-i worth analyzing
    }

    // 2. STRICT GAS ANALYSIS
    const gasAnalysis = this.analyzeGasMetrics(victimTx, currentGasPrice);

    if (!gasAnalysis.isViable) {
      return null; // Prea scump sa execute
    }

    // 3. BUNDLE COMPATIBILITY CHECK
    const bundleInfo = this.analyzeBundleCompatibility(
      victimTx,
      currentGasPrice,
      gasAnalysis.estimatedGasUsed
    );

    if (!bundleInfo.canBundle) {
      return null; // Nu se poate face sandwich
    }

    // 4. DETAILED PROFIT CALCULATION
    const profitAnalysis = this.calculateNetProfit(
      estimatedSwapOutput,
      victimTx,
      gasAnalysis,
      bundleInfo
    );

    if (profitAnalysis.netProfitBI <= BigInt(this.config.minNetProfitWei)) {
      return null; // Sub minimum threshold
    }

    // 5. RISK ASSESSMENT
    const riskScore = this.assessRisk(victimTx, bundleInfo, blockNumber - receivedBlock);

    if (riskScore > 85) {
      return null; // Prea riscant
    }

    const calculationTime = performance.now() - startTime;

    // 6. TIMEOUT CHECK
    if (calculationTime > this.config.maxCalculationTimeMs) {
      console.warn(
        `[StrictAnalyzer] Calculation took ${calculationTime.toFixed(2)}ms, exceeds ${this.config.maxCalculationTimeMs}ms`
      );
      return null; // Took too long, market moved
    }

    // BUILD OPPORTUNITY OBJECT
    const opportunity: StrictBackrunOpportunity = {
      hash: victimTx.hash,
      victimTxHash: victimTx.hash,
      
      grossProfit: profitAnalysis.grossProfit.toString(),
      netProfit: profitAnalysis.netProfitBI.toString(),
      profitPercentage: profitAnalysis.profitPercentage,
      
      estimatedGasUsed: gasAnalysis.estimatedGasUsed,
      estimatedGasCost: gasAnalysis.gasCostWei.toString(),
      minProfitThreshold: this.config.minNetProfitWei,
      
      bundleOrder: bundleInfo.order,
      victimGasPrice: this.extractGasPrice(victimTx),
      ourGasPrice: currentGasPrice,
      bundleSize: 3, // us + victim + miner tip
      
      riskScore,
      timestamp: Date.now(),
      calculationTime,
    };

    return opportunity;
  }

  /**
   * RAPID PROFITABILITY CHECK - max 50ms
   * Fail fast daca obvious nu-i profitabil
   */
  private quickProfitCheck(
    victimTx: RawTransaction | Raw1559Transaction | Raw2930Transaction,
    estimatedSwapOutput: string,
    currentGasPrice: number
  ): { isProfitable: boolean } {
    const grossProfit = BigInt(estimatedSwapOutput) - BigInt(victimTx.value || '0');

    // Estimate gas cost quickly
    const estimatedGas = 400000; // Average backrun cost
    const gasCost = BigInt(estimatedGas) * BigInt(currentGasPrice);

    // Flashloan fee (0.05%)
    const flashloanFee = (BigInt(victimTx.value || '0') * BigInt(5)) / BigInt(10000);

    const netProfit = grossProfit - gasCost - flashloanFee;

    // Must have at least 0.1 ETH profit after all fees
    return {
      isProfitable: netProfit > BigInt('100000000000000000'),
    };
  }

  /**
   * ANALYZE GAS METRICS
   */
  private analyzeGasMetrics(
    victimTx: RawTransaction | Raw1559Transaction | Raw2930Transaction,
    currentGasPrice: number
  ): {
    isViable: boolean;
    estimatedGasUsed: number;
    gasCostWei: bigint;
  } {
    // Backrun typical cost: 350k-450k gas
    const estimatedGasUsed = 400000;

    // We need to pay MORE than victim to get included
    const victimGasPrice = this.extractGasPrice(victimTx);
    const ourGasPrice = Math.max(
      victimGasPrice * 1.2, // At least 20% more
      currentGasPrice * 1.1 // Or 10% more than current
    );

    const gasCostWei = BigInt(Math.ceil(estimatedGasUsed * ourGasPrice * 1e9));

    // Check against max
    if (BigInt(this.config.maxGasPrice) < gasCostWei) {
      return {
        isViable: false,
        estimatedGasUsed,
        gasCostWei,
      };
    }

    return {
      isViable: true,
      estimatedGasUsed,
      gasCostWei,
    };
  }

  /**
   * BUNDLE COMPATIBILITY CHECK
   * Verifica daca putem face sandwich (front + victim + back)
   */
  private analyzeBundleCompatibility(
    victimTx: RawTransaction | Raw1559Transaction | Raw2930Transaction,
    currentGasPrice: number,
    ourGasUsed: number
  ): {
    canBundle: boolean;
    order: 'FRONT_RUN' | 'BACK_RUN' | 'SANDWICH';
    bundleScore: number;
  } {
    // Backrun = victim executa, apoi noi (POST-RUN position)
    // Nu-i SANDWICH daca victim nu-i DEX swap

    const isDexSwap = this.isDexInteraction(victimTx);

    if (!isDexSwap) {
      return {
        canBundle: false,
        order: 'BACK_RUN',
        bundleScore: 0,
      };
    }

    // Verify bundle can be atomic
    const victimGasPrice = this.extractGasPrice(victimTx);
    const ourGasPrice = victimGasPrice * 1.25; // Need premium

    // Check if gas price difference is reasonable
    if (ourGasPrice > 500) {
      // > 500 gwei, too expensive
      return {
        canBundle: false,
        order: 'BACK_RUN',
        bundleScore: 0,
      };
    }

    return {
      canBundle: true,
      order: 'BACK_RUN',
      bundleScore: 85,
    };
  }

  /**
   * CALCULATE NET PROFIT PRECISELY
   */
  private calculateNetProfit(
    estimatedSwapOutput: string,
    victimTx: RawTransaction | Raw1559Transaction | Raw2930Transaction,
    gasAnalysis: any,
    bundleInfo: any
  ): {
    grossProfit: bigint;
    netProfitBI: bigint;
    profitPercentage: number;
  } {
    const swapOutput = BigInt(estimatedSwapOutput);
    const inputAmount = BigInt(victimTx.value || '0');

    const grossProfit = swapOutput - inputAmount;

    // Deduct all fees
    const flashloanFee = (inputAmount * BigInt(5)) / BigInt(10000); // 0.05%
    const gasCost = gasAnalysis.gasCostWei;
    const minerTip = (gasCost * BigInt(10)) / BigInt(100); // 10% tip

    const netProfit = grossProfit - flashloanFee - gasCost - minerTip;

    const profitPercentage =
      Number(grossProfit) > 0
        ? (Number(netProfit) / Number(grossProfit)) * 100
        : 0;

    return {
      grossProfit,
      netProfitBI: netProfit > BigInt(0) ? netProfit : BigInt(0),
      profitPercentage,
    };
  }

  /**
   * RISK ASSESSMENT
   * Evaluates probability of execution failure
   */
  private assessRisk(
    victimTx: RawTransaction | Raw1559Transaction | Raw2930Transaction,
    bundleInfo: any,
    blocksOld: number
  ): number {
    let riskScore = 0;

    // Risk factor 1: TX age (stale = higher risk)
    if (blocksOld > 0) riskScore += blocksOld * 10;
    if (blocksOld > 2) return 100; // Too old, skip

    // Risk factor 2: Input data complexity
    if (victimTx.input && victimTx.input.length > 1000) riskScore += 15;

    // Risk factor 3: Large value (more likely to fail)
    const valueWei = BigInt(victimTx.value || '0');
    const oneEther = BigInt('1000000000000000000');
    if (valueWei > oneEther * BigInt(100)) riskScore += 20;

    // Risk factor 4: Unknown contract
    // (hard to assess on-chain, default to moderate risk)
    if (!this.isKnownDex(victimTx.to)) riskScore += 10;

    // Risk factor 5: MEV contention (others probably see same tx)
    riskScore += 15; // Base contention risk

    return Math.min(100, riskScore);
  }

  /**
   * HELPER: Extract gas price from TX
   */
  private extractGasPrice(
    tx: RawTransaction | Raw1559Transaction | Raw2930Transaction
  ): number {
    if ('maxPriorityFeePerGas' in tx && tx.maxPriorityFeePerGas) {
      return Math.round(parseInt(tx.maxPriorityFeePerGas, 16) / 1e9);
    }
    if (tx.gasPrice) {
      return Math.round(parseInt(tx.gasPrice, 16) / 1e9);
    }
    return 30; // Default fallback
  }

  /**
   * HELPER: Check if TX interacts with known DEX
   */
  private isDexInteraction(
    tx: RawTransaction | Raw1559Transaction | Raw2930Transaction
  ): boolean {
    if (!tx.to) return false;

    const knownDexes = [
      '0x1111111111111111111111111111111111111111',
      '0xdef1c0ded9bef7c1fb70af64971b92f2f61e54c7',
      '0xe592427a0aece92de3edee1f18e0157c05861564',
      '0x68b3465833fb72B5A828cCEEAFb0B7dC093eaF6f',
      '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    ];

    return knownDexes.some((dex) => dex.toLowerCase() === tx.to?.toLowerCase());
  }

  /**
   * HELPER: Check if DEX is in whitelist
   */
  private isKnownDex(address?: string): boolean {
    if (!address) return false;

    const knownDexes = [
      '0x1111111111111111111111111111111111111111',
      '0xdef1c0ded9bef7c1fb70af64971b92f2f61e54c7',
      '0xe592427a0aece92de3edee1f18e0157c05861564',
      '0x68b3465833fb72B5A828cCEEAFb0B7dC093eaF6f',
      '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    ];

    return knownDexes.some((dex) => dex.toLowerCase() === address.toLowerCase());
  }

  /**
   * GET/SET CONFIG
   */
  public setConfig(config: Partial<AnalyzerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public getConfig(): AnalyzerConfig {
    return { ...this.config };
  }

  /**
   * STATS
   */
  public getStats(): {
    opportunitiesAnalyzed: number;
    opportunitiesFound: number;
    cacheSize: number;
  } {
    return {
      opportunitiesAnalyzed: this.lastAnalyzedHashes.size,
      opportunitiesFound: this.opportunityCache.size,
      cacheSize: this.opportunityCache.size,
    };
  }
}

export default StrictBackrunAnalyzer;
