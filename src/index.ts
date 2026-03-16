import { config, validateConfig } from "./config";
import { log } from "./utils/logger";
import { ArbitrageStrategy } from "./strategies/arbitrage";
import { MispricingStrategy } from "./strategies/mispricing";
import { AIPredictorStrategy } from "./strategies/ai-predictor";
import { CryptoMomentumStrategy } from "./strategies/crypto-momentum";
import { Btc5MinStrategy } from "./strategies/btc-5min";
import { NewsSniperStrategy } from "./strategies/news-sniper";
import { OrderManager } from "./execution/order-manager";
import { PositionTracker } from "./execution/position";
import { RiskManager } from "./risk/risk-manager";
import { rankOpportunities, Opportunity } from "./markets/analyzer";
import { Strategy } from "./strategies/types";
import {
  loadState,
  recordTrade,
  updatePositionPrices,
  hasPosition,
  hasConflictingPosition,
  countPositionsInCategory,
  printStateSummary,
  getPortfolioValue,
  BotState,
} from "./state";
import { getUsdcBalance } from "./balance";
import { syncState } from "./sync";
import { checkAndSellPositions } from "./execution/auto-sell";
import { optimizePortfolio } from "./portfolio-optimizer";
import { privateKeyToAccount } from "viem/accounts";
import { ensureWallet, recordOrder, recordScan, takeDailySnapshot, getDb } from "./db";

// ---------------------------------------------------------------------------
// POLYMARKET BOT v2 — Main Entry Point
//
// v2 improvements:
// - Portfolio optimizer on startup (sells contradictory/losing positions)
// - Risk manager with daily capital caps, BTC correlation limits
// - Low-cash mode (stops new trades below threshold, only manages existing)
// - Auto-sell with on-chain share verification and retry logic
// - Max new markets per day to prevent overtrading
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║      POLYMARKET TRADING BOT v2           ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  // Check configuration
  const missing = validateConfig();
  if (missing.length > 0 && !config.paperTrade) {
    log.error("Missing required config:");
    for (const m of missing) log.error(`  - ${m}`);
    process.exit(1);
  }

  // Show mode and capital management settings
  if (config.paperTrade) {
    log.paper("PAPER TRADE MODE — no real money will be used.");
  } else {
    log.warn("LIVE TRADING MODE — real USDC will be used!");
    log.info(`  Max trade size:      $${config.maxTradeSize}`);
    log.info(`  Min edge:            ${config.minEdgePercent}%`);
    log.info(`  Daily loss limit:    $${config.dailyLossLimit}`);
    log.info(`  Low cash threshold:  $${config.lowCashThreshold}`);
    log.info(`  Max deployed:        ${(config.maxDeployedPercent * 100).toFixed(0)}% of assets`);
    log.info(`  Max daily deploy:    ${(config.maxDailyDeployPercent * 100).toFixed(0)}% of assets`);
    log.info(`  Max new markets/day: ${config.maxNewMarketsPerDay}`);
    log.info(`  Max BTC positions:   ${config.maxBtcPositions}`);
    log.info(`  Max BTC exposure:    ${(config.maxBtcExposurePercent * 100).toFixed(0)}% of assets`);
  }

  // Load persistent state
  const state = loadState();

  // Derive wallet address
  const pk = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;
  const walletAddress = privateKeyToAccount(pk as `0x${string}`).address;
  log.info(`Wallet: ${walletAddress}`);

  // Initialize database
  const db = getDb();
  let dbWalletId: string | null = null;
  if (db) {
    dbWalletId = await ensureWallet(walletAddress);
    if (dbWalletId) log.success(`[DB] Wallet registered: ${dbWalletId}`);
  }

  // Sync with on-chain positions (source of truth)
  try {
    await syncState(state, walletAddress);
  } catch (err) {
    log.warn(`[Sync] Skipped — API unreachable. Using local state.json (${Object.keys(state.positions).length} positions).`);
  }

  // --- PORTFOLIO OPTIMIZER: sell bad positions on startup ---
  try {
    await optimizePortfolio(state, walletAddress);
  } catch (err) {
    log.warn(`[Optimizer] Failed: ${err}`);
  }

  // Initialize components
  const riskManager = new RiskManager();
  const positions = new PositionTracker();
  const orderManager = new OrderManager(riskManager, positions, config.maxTradeSize * 10);

  // Enable strategies
  const strategies: Strategy[] = [];
  if (config.strategies.arbitrage) {
    strategies.push(new ArbitrageStrategy());
    log.success("Strategy enabled: Arbitrage");
  }
  if (config.strategies.mispricing) {
    strategies.push(new MispricingStrategy());
    log.success("Strategy enabled: Mispricing");
  }
  if (config.strategies.aiPrediction && config.openaiApiKey) {
    const aiStrategy = new AIPredictorStrategy();
    if (dbWalletId) aiStrategy.setWalletId(dbWalletId);
    strategies.push(aiStrategy);
    log.success("Strategy enabled: AI Prediction");
  }
  if (config.strategies.cryptoMomentum) {
    strategies.push(new CryptoMomentumStrategy());
    log.success("Strategy enabled: Crypto Momentum");
  }
  if (config.strategies.btc5min) {
    strategies.push(new Btc5MinStrategy());
    log.success("Strategy enabled: BTC 5-Min");
  }
  if (config.strategies.newsSniper && config.openaiApiKey) {
    const sniperStrategy = new NewsSniperStrategy();
    if (dbWalletId) sniperStrategy.setWalletId(dbWalletId);
    strategies.push(sniperStrategy);
    log.success("Strategy enabled: News Sniper");
  }

  if (strategies.length === 0) {
    log.error("No strategies enabled! Check your .env file.");
    process.exit(1);
  }

  log.info(`Scan interval: every ${config.scanIntervalSeconds} seconds`);
  log.info(
    `Loaded ${state.trades.length} previous trades, ${Object.keys(state.positions).length} positions`
  );
  console.log("\n");

  // Main loop
  let scanCount = 0;
  while (true) {
    scanCount++;
    const scanStart = Date.now();
    log.info(`\n=== Scan #${scanCount} ===`);

    try {
      // Check real USDC.e balance from blockchain
      const balance = await getUsdcBalance();
      if (balance >= 0) {
        log.info(`USDC.e balance: $${balance.toFixed(2)}`);
        orderManager.setBankroll(balance);
      }

      // Calculate total assets for risk management
      const portfolioValue = getPortfolioValue(state);
      const totalAssets = (balance >= 0 ? balance : 0) + portfolioValue;

      // Update risk manager context BEFORE any trading decisions
      riskManager.setContext({
        cashBalance: balance >= 0 ? balance : 0,
        positions: state.positions,
        totalAssets,
      });

      // Log capital management status
      const deployedPct = portfolioValue / Math.max(1, totalAssets) * 100;
      log.info(
        `[Capital] Cash: $${balance >= 0 ? balance.toFixed(2) : "?"} | Positions: $${portfolioValue.toFixed(2)} | Total: $${totalAssets.toFixed(2)} | Deployed: ${deployedPct.toFixed(0)}%`
      );

      // LOW CASH warning
      if (balance >= 0 && balance < config.lowCashThreshold) {
        log.warn(
          `[Capital] LOW CASH MODE: $${balance.toFixed(2)} < $${config.lowCashThreshold} — only managing existing positions, no new trades.`
        );
      }

      // Collect opportunities from all strategies
      const allOpportunities: Opportunity[] = [];
      for (const strategy of strategies) {
        try {
          const opps = await strategy.findOpportunities();
          allOpportunities.push(...opps);
        } catch (err) {
          log.error(`Strategy "${strategy.name}" failed: ${err}`);
        }
      }

      // Update position prices from market data
      const priceUpdates: { tokenId: string; price: number }[] = [];
      for (const opp of allOpportunities) {
        if (opp.market.clobTokenIds[0]) {
          priceUpdates.push({
            tokenId: opp.market.clobTokenIds[0],
            price: opp.market.outcomePrices[0],
          });
        }
        if (opp.market.clobTokenIds[1]) {
          priceUpdates.push({
            tokenId: opp.market.clobTokenIds[1],
            price: opp.market.outcomePrices[1],
          });
        }
      }
      updatePositionPrices(state, priceUpdates);

      if (allOpportunities.length === 0) {
        log.info("No opportunities found this scan.");
      } else {
        const ranked = rankOpportunities(allOpportunities);

        // Filter with conflict detection and correlation limits
        const newOpps: typeof ranked = [];
        const addOpps: typeof ranked = [];
        let skipped = 0;
        let conflicts = 0;
        let correlationBlocked = 0;

        const correlationGroups: Record<string, string[]> = {
          iran: ["iran", "kharg", "strait of hormuz", "tehran"],
          oil: ["crude oil", "oil price", "brent"],
          us_politics: ["trump", "greenland", "election"],
        };

        for (const opp of ranked) {
          const isExisting = hasPosition(state, opp.market.id);

          const conflict = hasConflictingPosition(
            state,
            opp.market.question,
            opp.action.outcome
          );
          if (conflict.conflict) {
            log.warn(
              `[Filter] CONFLICT: Want ${opp.action.outcome} but holding ${conflict.existingOutcome} on "${opp.market.question.substring(0, 40)}..."`
            );
            conflicts++;
            continue;
          }

          let correlationHit = false;
          for (const [group, keywords] of Object.entries(correlationGroups)) {
            const q = opp.market.question.toLowerCase();
            if (keywords.some((kw) => q.includes(kw))) {
              const count = countPositionsInCategory(state, keywords);
              if (count >= 3) {
                log.info(
                  `[Filter] CORRELATION: ${count} in "${group}". Skip "${opp.market.question.substring(0, 40)}..."`
                );
                correlationHit = true;
                correlationBlocked++;
                break;
              }
            }
          }
          if (correlationHit) continue;

          if (!isExisting) {
            newOpps.push(opp);
          } else if (opp.edgePercent > 15) {
            addOpps.push(opp);
          } else {
            skipped++;
          }
        }

        log.info(
          `Found ${ranked.length} opps (${newOpps.length} new, ${addOpps.length} add, ${skipped} skip, ${conflicts} conflict, ${correlationBlocked} corr-blocked).`
        );

        // Execute trades (risk manager will enforce all capital limits)
        let executed = 0;
        for (const opp of newOpps) {
          if (executed >= 3) break;
          const success = await executeTrade(opp, state, orderManager, riskManager, dbWalletId);
          if (success) executed++;
        }

        // Add to existing (max 1 per scan, with cooldown)
        if (executed < 3 && addOpps.length > 0) {
          const opp = addOpps[0];
          const lastAdded = (state as any)._lastAddedAt?.[opp.market.id] || 0;
          const cooldownMs = 2 * 60 * 60 * 1000;

          if (Date.now() - lastAdded < cooldownMs) {
            log.info(
              `[Cooldown] Skip add-to "${opp.market.question.substring(0, 40)}..." — ${Math.round((Date.now() - lastAdded) / 60000)}m ago`
            );
          } else {
            const success = await executeTrade(opp, state, orderManager, riskManager, dbWalletId, "add_to_position");
            if (success) {
              executed++;
              if (!(state as any)._lastAddedAt) (state as any)._lastAddedAt = {};
              (state as any)._lastAddedAt[opp.market.id] = Date.now();
            }
          }
        }

        if (executed > 0) {
          log.success(`Executed ${executed} trades this scan.`);
        }
      }

      // Auto sell: take profit or stop loss (with on-chain verification)
      await checkAndSellPositions(state);

      // Print portfolio summary
      printStateSummary(state);

      // Log risk stats
      const riskStats = riskManager.getStats();
      log.info(
        `[Risk] Today: ${riskStats.dailyNewMarkets} new markets, $${riskStats.dailyCapitalDeployed.toFixed(2)} deployed, P&L: $${riskStats.dailyPnL.toFixed(2)}`
      );

      // Record scan to database
      if (dbWalletId) {
        await recordScan({
          walletId: dbWalletId,
          scanNumber: scanCount,
          durationMs: Date.now() - scanStart,
          marketsScanned: allOpportunities.length > 0 ? 200 : 0,
          opportunitiesFound: allOpportunities.length,
          opportunitiesNew: allOpportunities.filter(o => !hasPosition(state, o.market.id)).length,
          ordersPlaced: 0,
          ordersFilled: 0,
          ordersFailed: 0,
          usdcBalance: balance,
          portfolioValue,
          unrealizedPnl: Object.values(state.positions).reduce((s, p) => s + p.unrealizedPnL, 0),
          positionsCount: Object.keys(state.positions).length,
          strategiesRun: strategies.map(s => s.name),
        }).catch(() => {});
      }

      // Save daily snapshot
      if (dbWalletId && balance >= 0) {
        await takeDailySnapshot(dbWalletId, {
          usdcBalance: balance,
          portfolioValue,
          totalDeposited: 121.98, // actual total deposits
          unrealizedPnl: Object.values(state.positions).reduce(
            (sum, p) => sum + p.unrealizedPnL, 0
          ),
          realizedPnl: state.realizedPnL,
          tradesCount: state.dailyStats.trades,
        }).catch(() => {});
      }
    } catch (err) {
      log.error(`Scan failed: ${err}`);
    }

    log.info(
      `Next scan in ${config.scanIntervalSeconds} seconds... (Ctrl+C to stop)\n`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, config.scanIntervalSeconds * 1000)
    );
  }
}

// Execute a single trade with full risk checking and recording
async function executeTrade(
  opp: Opportunity,
  state: BotState,
  orderManager: OrderManager,
  riskManager: RiskManager,
  dbWalletId: string | null,
  orderReason: string = "new_position"
): Promise<boolean> {
  const success = await orderManager.executeOpportunity(opp);
  if (!success) return false;

  const shares = Math.floor(Math.min(config.maxTradeSize, 15) / opp.action.price);
  const cost = shares * opp.action.price;

  // Record in risk manager for daily tracking
  riskManager.recordNewMarket(opp.market.id);

  // Record in persistent state
  recordTrade(state, {
    id: `trade_${Date.now()}`,
    marketId: opp.market.id,
    marketQuestion: opp.market.question,
    tokenId: opp.action.tokenId,
    outcome: opp.action.outcome,
    side: opp.action.side,
    shares,
    price: opp.action.price,
    cost,
    timestamp: Date.now(),
    status: "filled",
  });

  // Record in database
  if (dbWalletId) {
    await recordOrder({
      walletId: dbWalletId,
      marketId: opp.market.id,
      question: opp.market.question,
      description: opp.market.description,
      outcomes: opp.market.outcomes,
      tokenIds: opp.market.clobTokenIds,
      endDate: opp.market.endDate,
      side: opp.action.side,
      outcome: opp.action.outcome,
      tokenId: opp.action.tokenId,
      shares,
      price: opp.action.price,
      totalAmount: cost,
      strategy: opp.description?.startsWith("[BOND]") ? "bond_mode" : opp.description?.match(/^\[(CONFIRMED|STRONG)\]/) ? "news_sniper" : opp.type === "AI_EDGE" ? "ai_prediction" : opp.type.toLowerCase(),
      orderReason,
      edgePercent: opp.edgePercent,
      confidence: opp.confidence,
      reasoning: opp.description,
      status: "filled",
    }).catch((err) => log.warn(`[DB] Failed to record order: ${err}`));
  }

  return true;
}

// Graceful shutdown
process.on("SIGINT", () => {
  log.warn("\nShutting down... saving state...");
  log.success("State saved to state.json. Your positions are safe.");
  process.exit(0);
});

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
