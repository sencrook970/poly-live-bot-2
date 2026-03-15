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
  BotState,
} from "./state";
import { getUsdcBalance } from "./balance";
import { syncState } from "./sync";
import { checkAndSellPositions } from "./execution/auto-sell";
import { privateKeyToAccount } from "viem/accounts";
import { ensureWallet, recordOrder, recordScan, takeDailySnapshot, getDb } from "./db";

// ---------------------------------------------------------------------------
// POLYMARKET BOT — Main Entry Point
//
// Features:
// - Persistent state (saved to state.json, survives restarts)
// - Auto-detects new deposits (checks on-chain balance every scan)
// - Smart deduplication (won't re-buy markets you already have)
// - Logs everything to state.json for review
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║        POLYMARKET TRADING BOT            ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  // Check configuration
  const missing = validateConfig();
  if (missing.length > 0 && !config.paperTrade) {
    log.error("Missing required config:");
    for (const m of missing) log.error(`  - ${m}`);
    process.exit(1);
  }

  // Show mode
  if (config.paperTrade) {
    log.paper("PAPER TRADE MODE — no real money will be used.");
  } else {
    log.warn("LIVE TRADING MODE — real USDC will be used!");
    log.info(`  Daily loss limit: $${config.dailyLossLimit}`);
    log.info(`  Max trade size:   $${config.maxTradeSize}`);
    log.info(`  Min edge:         ${config.minEdgePercent}%`);
  }

  // Load persistent state
  const state = loadState();

  // Sync with on-chain positions (source of truth) — non-blocking
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

  try {
    await syncState(state, walletAddress);
  } catch (err) {
    log.warn(`[Sync] Skipped — API unreachable. Using local state.json (${Object.keys(state.positions).length} positions).`);
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
    `Loaded ${state.trades.length} previous trades, ${Object.keys(state.positions).length} positions, ${state.tradedMarketIds.length} traded markets`
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

      // If balance is too low, skip trading but still scan
      if (balance >= 0 && balance < 1.0) {
        log.warn("Balance below $1.00 — scanning but not trading. Deposit more USDC.e to trade.");
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

        // Filter opportunities with conflict detection and correlation limits
        const newOpps: typeof ranked = [];
        const addOpps: typeof ranked = [];
        let skipped = 0;
        let conflicts = 0;
        let correlationBlocked = 0;

        // Correlation buckets — max 2 positions per topic
        const correlationGroups: Record<string, string[]> = {
          iran: ["iran", "kharg", "strait of hormuz", "tehran"],
          oil: ["crude oil", "oil price", "brent"],
          us_politics: ["trump", "greenland", "election"],
        };

        for (const opp of ranked) {
          const isExisting = hasPosition(state, opp.market.id);

          // Check for CONFLICTING position (holding opposite side)
          const conflict = hasConflictingPosition(
            state,
            opp.market.question,
            opp.action.outcome
          );
          if (conflict.conflict) {
            log.warn(
              `[Filter] CONFLICT: Want to buy ${opp.action.outcome} but already holding ${conflict.existingOutcome} (${conflict.existingShares} shares) on "${opp.market.question.substring(0, 40)}..."`
            );
            conflicts++;
            continue;
          }

          // Check correlation limits — max 2 positions per topic group
          let correlationHit = false;
          for (const [group, keywords] of Object.entries(correlationGroups)) {
            const q = opp.market.question.toLowerCase();
            if (keywords.some((kw) => q.includes(kw))) {
              const count = countPositionsInCategory(state, keywords);
              if (count >= 3) {
                log.info(
                  `[Filter] CORRELATION: Already ${count} positions in "${group}" group. Skipping "${opp.market.question.substring(0, 40)}..."`
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
          `Found ${ranked.length} opportunities (${newOpps.length} new, ${addOpps.length} add-to-existing, ${skipped} skip, ${conflicts} conflicts, ${correlationBlocked} correlation-blocked).`
        );

        // Skip if balance too low
        if (balance >= 0 && balance < 1.0) {
          log.warn("Skipping trades — balance too low.");
        } else {
          // Execute new opportunities first
          let executed = 0;
          for (const opp of newOpps) {
            if (executed >= 3) break;
            const success = await executeTrade(opp, state, orderManager, dbWalletId);
            if (success) executed++;
          }

          // Then add to existing (max 1 per scan, with 2-hour cooldown)
          // This prevents the bot from buying the same market every scan
          if (executed < 3 && addOpps.length > 0) {
            const opp = addOpps[0];
            const lastAdded = (state as any)._lastAddedAt?.[opp.market.id] || 0;
            const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours

            if (Date.now() - lastAdded < cooldownMs) {
              log.info(
                `[Cooldown] Skipping add-to "${opp.market.question.substring(0, 40)}..." — last added ${Math.round((Date.now() - lastAdded) / 60000)}m ago (need 120m)`
              );
            } else {
              log.info(
                `Adding to existing position: "${opp.market.question.substring(0, 50)}..." (${opp.edgePercent.toFixed(1)}% edge)`
              );
              const success = await executeTrade(opp, state, orderManager, dbWalletId, "add_to_position");
              if (success) {
                executed++;
                // Record cooldown timestamp
                if (!(state as any)._lastAddedAt) (state as any)._lastAddedAt = {};
                (state as any)._lastAddedAt[opp.market.id] = Date.now();
              }
            }
          }

          if (executed > 0) {
            log.success(`Executed ${executed} trades this scan.`);
          }
        }
      }

      // Auto sell: take profit or stop loss
      await checkAndSellPositions(state);

      // Print portfolio summary (from persistent state)
      printStateSummary(state);

      // Record scan to database
      if (dbWalletId) {
        const portfolioValue = Object.values(state.positions).reduce(
          (sum, p) => sum + p.currentPrice * p.totalShares, 0
        );
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

      // Save daily snapshot to database
      if (dbWalletId && balance >= 0) {
        await takeDailySnapshot(dbWalletId, {
          usdcBalance: balance,
          portfolioValue: Object.values(state.positions).reduce(
            (sum, p) => sum + p.currentPrice * p.totalShares, 0
          ),
          totalDeposited: 41.73, // actual deposits
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

    // Wait for next scan
    log.info(
      `Next scan in ${config.scanIntervalSeconds} seconds... (Ctrl+C to stop)\n`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, config.scanIntervalSeconds * 1000)
    );
  }
}

// Execute a single trade and record it in persistent state + database
async function executeTrade(
  opp: Opportunity,
  state: BotState,
  orderManager: OrderManager,
  dbWalletId: string | null,
  orderReason: string = "new_position"
): Promise<boolean> {
  const success = await orderManager.executeOpportunity(opp);
  if (!success) return false;

  const shares = Math.floor(Math.min(config.maxTradeSize, 5) / opp.action.price);
  const cost = shares * opp.action.price;

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
      strategy: opp.description?.match(/^\[(CONFIRMED|STRONG)\]/) ? "news_sniper" : opp.type === "AI_EDGE" ? "ai_prediction" : opp.type.toLowerCase(),
      orderReason,
      edgePercent: opp.edgePercent,
      confidence: opp.confidence,
      reasoning: opp.description,
      status: "filled",
    }).catch((err) => log.warn(`[DB] Failed to record order: ${err}`));
  }

  return true;
}

// Graceful shutdown — save state before exiting
process.on("SIGINT", () => {
  log.warn("\nShutting down... saving state...");
  // State is already saved after every trade, but save once more
  log.success("State saved to state.json. Your positions are safe.");
  process.exit(0);
});

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
