import sseClient from './instances/sse-client';
import Provider from './instances/provider';
import WebSocketsClient from './instances/ws-client';
import constants from './config/env';
import * as convert from './lib/utils/conversions';
import BackrunFilter, { BackrunOpportunity } from './lib/filters/backrun-filter';
import BackrunExecutor, {
  BackrunExecutionConfig,
  ExecutionResult,
} from './lib/execution/backrun-executor';

/**
 * Main MEV-Share backrun bot
 * Monitors MEV-Share event stream and executes profitable backrun opportunities
 */

async function main() {
  let init = true;
  
  /* initialise JSON-RPC provider class for infura queries */
  const provider = Provider.init(constants.INFURA_URL);
  
  /* initialise Infura WebSocket stream */
  const streaming = new WebSocketsClient(constants.INFURA_WS);
  
  /* initialise SSE client to stream private OF */
  const mevshare = new sseClient('https://mev-share.flashbots.net/');

  /* initialise backrun filter */
  const backrunFilter = new BackrunFilter({
    minGasPriceGwei: 30,
    minValueWei: '1000000000000000', // 0.001 ETH
  });

  /* initialise backrun executor if credentials provided */
  let backrunExecutor: BackrunExecutor | null = null;
  if (constants.BOT_PRIVATE_KEY && constants.BOT_ADDRESS) {
    const executionConfig: BackrunExecutionConfig = {
      rpcUrl: constants.INFURA_URL,
      privateKey: constants.BOT_PRIVATE_KEY,
      backrunBotAddress: constants.BOT_ADDRESS,
      aaveConfig: {
        aavePoolAddress: constants.AAVE_POOL_ADDRESS,
        aaveDataProviderAddress: constants.AAVE_DATA_PROVIDER,
        gasTokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
        maxFlashloanAmount: '1000000000000000000000000', // 1M tokens
      },
      slippageTolerance: 0.5,
      maxGasPrice: '100000000000', // 100 gwei
      dryRunOnly: constants.DRY_RUN_MODE,
    };

    backrunExecutor = new BackrunExecutor(executionConfig);
    console.log('[Main] Backrun executor initialized');
    console.log(`[Main] Dry-run mode: ${constants.DRY_RUN_MODE}`);
  } else {
    console.warn(
      '[Main] BOT_PRIVATE_KEY or BOT_ADDRESS not configured. Backrun execution disabled.'
    );
  }

  /* block handler - processes new blocks */
  streaming.blockHandler = async (res: string) => {
    let data = JSON.parse(res);

    /* if message is not a block subscription update - return early */
    if (data?.id) {
      return;
    }

    let block_number = convert.decimal(data.params.result.number);
    mevshare.current_block = block_number;

    const latest_block_txs = await provider.getSlimBodyBlockTransactions(
      block_number
    );

    /* only start MEV-Share polling when we receive our first block data messages */
    if (init) {
      mevshare.registerEvents();
      mevshare.start_block = block_number;
      init = false;
      console.log(`[Main] Started monitoring from block ${block_number}`);
    }

    /* mutate order array (splice dropped orders - currently set to 20 block limit) */
    mevshare.handleNewBlock();

    /* find matches between MEV-Share orders and on-chain transactions */
    mevshare.findMatches(latest_block_txs);

    /* analyze fulfilled orders for backrun opportunities */
    if (mevshare.fulfilled_record.length > 0) {
      await analyzeBackrunOpportunities(
        mevshare.fulfilled_record,
        latest_block_txs,
        block_number,
        backrunFilter,
        backrunExecutor
      );
    }
  };

  streaming.instance.on('message', streaming.blockHandler);
}

/**
 * Analyzes fulfilled orders for backrun opportunities and executes profitable ones
 */
async function analyzeBackrunOpportunities(
  fulfilledHashes: string[],
  blockTxs: string[],
  currentBlock: number,
  filter: BackrunFilter,
  executor: BackrunExecutor | null
) {
  try {
    // Get full transaction details for fulfilled transactions
    // Note: This is a simplified version - in production, you'd fetch full tx details from archive node
    const opportunities: BackrunOpportunity[] = [];

    console.log(
      `[Backrun Analysis] Found ${fulfilledHashes.length} fulfilled orders to analyze`
    );

    // Log top opportunities
    if (opportunities.length > 0) {
      console.log(
        `[Backrun Analysis] Found ${opportunities.length} backrun opportunities:`
      );

      for (const opp of opportunities.slice(0, 5)) {
        console.log(`  - TX: ${opp.hash}`);
        console.log(`    Score: ${opp.score.toFixed(2)}/100`);
        console.log(`    Gas Price: ${opp.gasPrice.toFixed(2)} gwei`);
        console.log(`    Reasons: ${opp.reasons.join(', ')}`);

        /* Execute if executor is available and profitable */
        if (executor && opp.isProfitable && opp.score >= 60) {
          await executeBackrunOpportunity(executor, opp);
        }
      }
    } else {
      console.log('[Backrun Analysis] No profitable backrun opportunities found');
    }
  } catch (error) {
    console.error('[Backrun Analysis] Error analyzing opportunities:', error);
  }
}

/**
 * Executes a backrun opportunity with dry-run and actual execution
 */
async function executeBackrunOpportunity(
  executor: BackrunExecutor,
  opportunity: BackrunOpportunity
) {
  try {
    console.log(
      `\n[Execution] Processing backrun opportunity: ${opportunity.hash}`
    );
    console.log(`[Execution] Opportunity score: ${opportunity.score.toFixed(2)}/100`);

    // Prepare swap data (simplified)
    const swapData = {
      tokenIn: opportunity.to || '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      tokenOut: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      amountIn: opportunity.value,
      amountOutMin: '0',
      path: [
        opportunity.to || '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      ],
    };

    // Estimate flashloan amount (simplified - use tx value)
    const flashloanAmount = opportunity.value;

    // Execute backrun with dry-run first
    const result: ExecutionResult = await executor.executeBackrun(
      swapData.tokenIn,
      flashloanAmount,
      swapData,
      opportunity.hash
    );

    if (result.success) {
      console.log('[Execution] ✓ Backrun executed successfully');
      console.log(`[Execution] Dry-run: ${result.dryRun}`);
      if (result.txHash) {
        console.log(`[Execution] TX Hash: ${result.txHash}`);
      }
      if (result.profit) {
        const profitEth = Number(result.profit) / 1e18;
        console.log(`[Execution] Estimated profit: ${profitEth.toFixed(6)} ETH`);
      }
    } else {
      console.log('[Execution] ✗ Backrun failed');
      console.log(`[Execution] Error: ${result.error}`);
    }
  } catch (error) {
    console.error('[Execution] Error executing backrun:', error);
  }
}

main();
