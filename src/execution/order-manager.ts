import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { getClient } from "../client";
import { config } from "../config";
import { log } from "../utils/logger";
import { Opportunity } from "../markets/analyzer";
import { PositionTracker } from "./position";
import { RiskManager } from "../risk/risk-manager";
import { calculateKelly, calculateArbSize } from "../risk/kelly";

// ---------------------------------------------------------------------------
// Order Manager — takes opportunities and turns them into actual trades.
//
// Flow:
// 1. Receive an opportunity from a strategy
// 2. Check with Risk Manager: "Are we allowed to trade this?"
// 3. Calculate position size with Kelly Criterion
// 4. In paper mode: log the trade but don't send it
// 5. In live mode: place a limit order on Polymarket
// ---------------------------------------------------------------------------

export class OrderManager {
  private riskManager: RiskManager;
  private positions: PositionTracker;
  private bankroll: number;

  constructor(
    riskManager: RiskManager,
    positions: PositionTracker,
    initialBankroll: number
  ) {
    this.riskManager = riskManager;
    this.positions = positions;
    this.bankroll = initialBankroll;
  }

  async executeOpportunity(opp: Opportunity): Promise<boolean> {
    log.info(`[Order] Evaluating: "${opp.market.question.substring(0, 50)}..." (${opp.type}, ${opp.edgePercent.toFixed(1)}% edge)`);

    // Step 1: Calculate how much to bet
    let tradeSize: number;

    if (opp.type === "ARBITRAGE" || opp.type === "MISPRICING") {
      tradeSize = calculateArbSize(
        opp.expectedProfit,
        this.bankroll,
        config.maxTradeSize
      );
      log.info(`[Order] Arb sizing: expectedProfit=$${opp.expectedProfit.toFixed(4)}, bankroll=$${this.bankroll.toFixed(2)}, tradeSize=$${tradeSize.toFixed(2)}`);
    } else {
      // AI prediction — use Kelly
      const estimatedProb = opp.action.price + opp.edgePercent / 100;
      const kelly = calculateKelly(
        estimatedProb,
        opp.action.price,
        this.bankroll,
        config.maxTradeSize,
        opp.confidence
      );
      tradeSize = kelly.suggestedSize;
      log.info(`[Kelly] ${kelly.reasoning}`);
    }

    if (tradeSize <= 0) {
      log.info(`[Order] SKIP — position size $0 for "${opp.market.question.substring(0, 40)}..."`);
      return false;
    }

    // Step 2: Risk check
    const riskCheck = this.riskManager.canTrade(opp, tradeSize);
    if (!riskCheck.allowed) {
      log.warn(`[Order] BLOCKED by risk manager: ${riskCheck.reason}`);
      return false;
    }
    log.info(`[Order] Risk check passed: ${riskCheck.reason}`);

    // Step 3: Enforce minimums — round up to $1 if edge is strong
    if (tradeSize < 1.0) {
      if (opp.edgePercent >= 10 && this.bankroll >= 2.0) {
        // Edge is strong enough — round up to $1 minimum
        tradeSize = 1.0;
        log.info(`[Order] Rounded up to $1.00 minimum (edge ${opp.edgePercent.toFixed(1)}% is strong)`);
      } else {
        log.info(`[Order] SKIP — below $1 minimum (tradeSize=$${tradeSize.toFixed(2)}, edge=${opp.edgePercent.toFixed(1)}%)`);
        return false;
      }
    }

    // Step 4: Calculate shares (Polymarket minimum is 5 shares)
    const shares = Math.floor(tradeSize / opp.action.price);
    if (shares < 5) {
      // Try rounding up to 5 shares if affordable
      const cost5 = 5 * opp.action.price;
      if (cost5 <= Math.min(this.bankroll * 0.3, config.maxTradeSize) && opp.edgePercent >= 10) {
        log.info(`[Order] Rounded up to 5 shares ($${cost5.toFixed(2)}) — min share requirement`);
        return config.paperTrade
          ? this.paperTrade(opp, 5, cost5)
          : this.liveTrade(opp, 5);
      }
      log.info(`[Order] SKIP — below 5 share minimum (${shares} shares, tradeSize=$${tradeSize.toFixed(2)})`);
      return false;
    }

    // Step 4: Execute
    if (config.paperTrade) {
      return this.paperTrade(opp, shares, tradeSize);
    } else {
      return this.liveTrade(opp, shares);
    }
  }

  // Paper trade — log everything but don't actually send orders
  private paperTrade(
    opp: Opportunity,
    shares: number,
    tradeSize: number
  ): boolean {
    log.paper(
      `${opp.action.side} ${shares} ${opp.action.outcome} shares @ $${opp.action.price.toFixed(3)}`
    );
    log.paper(`  Market: "${opp.market.question}"`);
    log.paper(`  Strategy: ${opp.type}`);
    log.paper(`  Edge: ${opp.edgePercent.toFixed(2)}%`);
    log.paper(`  Size: $${tradeSize.toFixed(2)}`);
    log.paper(`  ${opp.description}`);

    // Track the paper position
    this.positions.addPosition(
      opp.market.id,
      opp.market.question,
      opp.action.tokenId,
      opp.action.outcome,
      shares,
      opp.action.price
    );

    // Record in risk manager
    this.riskManager.recordTrade({
      timestamp: Date.now(),
      market: opp.market.question,
      side: opp.action.side,
      size: tradeSize,
      price: opp.action.price,
      pnl: 0, // Unknown until resolved
    });

    return true;
  }

  // Live trade — actually place orders on Polymarket
  private async liveTrade(opp: Opportunity, shares: number): Promise<boolean> {
    try {
      const client = await getClient();

      log.trade(
        `Placing ${opp.action.side} order: ${shares} ${opp.action.outcome} shares @ $${opp.action.price.toFixed(3)}`
      );
      log.trade(`  Market: "${opp.market.question}"`);

      // Get market-specific config
      const tickSize = await client.getTickSize(opp.action.tokenId);
      const negRisk = await client.getNegRisk(opp.action.tokenId);

      // Place a limit order (GTC = stays until filled or cancelled)
      const result = await client.createAndPostOrder(
        {
          tokenID: opp.action.tokenId,
          price: opp.action.price,
          side: opp.action.side === "BUY" ? Side.BUY : Side.SELL,
          size: shares,
        },
        { tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001", negRisk },
        OrderType.GTC
      );

      const resultAny = result as any;

      // Check if order actually succeeded
      if (resultAny.error || !resultAny.success) {
        log.error(`Order FAILED: ${resultAny.error || JSON.stringify(result)}`);
        return false;
      }

      log.success(`Order placed! Status: ${resultAny.status}, ID: ${resultAny.orderID}`);

      // Track position only if order succeeded
      this.positions.addPosition(
        opp.market.id,
        opp.market.question,
        opp.action.tokenId,
        opp.action.outcome,
        shares,
        opp.action.price
      );

      this.riskManager.recordTrade({
        timestamp: Date.now(),
        market: opp.market.question,
        side: opp.action.side,
        size: shares * opp.action.price,
        price: opp.action.price,
        pnl: 0,
      });

      return true;
    } catch (err) {
      log.error(`Order failed: ${err}`);
      return false;
    }
  }

  // Cancel all open orders (emergency)
  async cancelAll(): Promise<void> {
    if (config.paperTrade) {
      log.paper("Would cancel all orders (paper mode).");
      return;
    }

    try {
      const client = await getClient();
      await client.cancelAll();
      log.success("All orders cancelled.");
    } catch (err) {
      log.error(`Failed to cancel orders: ${err}`);
    }
  }

  // Update bankroll
  setBankroll(amount: number): void {
    this.bankroll = amount;
    log.info(`Bankroll updated: $${amount.toFixed(2)}`);
  }
}
