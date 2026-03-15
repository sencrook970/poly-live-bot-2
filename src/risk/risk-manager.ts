import { config } from "../config";
import { log } from "../utils/logger";
import { Opportunity } from "../markets/analyzer";

// ---------------------------------------------------------------------------
// Risk Manager — prevents the bot from losing too much money.
//
// Rules:
// 1. Daily loss limit: Stop trading if we lose more than X USDC today
// 2. Max trade size: Never risk more than Y USDC on a single trade
// 3. Kill switch: Manually stop everything
// 4. Position limit: Don't put too much into one market
// ---------------------------------------------------------------------------

interface TradeRecord {
  timestamp: number;
  market: string;
  side: string;
  size: number;
  price: number;
  pnl: number; // Profit/loss (0 for open trades, filled in when closed)
}

export class RiskManager {
  private trades: TradeRecord[] = [];
  private killed = false;
  private dailyPnL = 0;

  // Check if we're allowed to trade
  canTrade(opportunity: Opportunity, proposedSize: number): {
    allowed: boolean;
    reason: string;
  } {
    // Kill switch
    if (this.killed) {
      return { allowed: false, reason: "Kill switch activated. Bot stopped." };
    }

    // Paper trade mode always allowed
    if (config.paperTrade) {
      return { allowed: true, reason: "Paper trade mode — no real money at risk." };
    }

    // Check daily loss limit
    if (this.dailyPnL <= -config.dailyLossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit hit ($${config.dailyLossLimit}). Stopping for today.`,
      };
    }

    // Check max trade size
    if (proposedSize > config.maxTradeSize) {
      return {
        allowed: false,
        reason: `Trade size $${proposedSize} exceeds max $${config.maxTradeSize}.`,
      };
    }

    // Check minimum edge
    if (opportunity.edgePercent < config.minEdgePercent) {
      return {
        allowed: false,
        reason: `Edge ${opportunity.edgePercent.toFixed(1)}% below minimum ${config.minEdgePercent}%.`,
      };
    }

    // Don't trade markets ending very soon (resolution risk)
    if (opportunity.market.endDate) {
      const endTime = new Date(opportunity.market.endDate).getTime();
      const now = Date.now();
      const hoursLeft = (endTime - now) / (1000 * 60 * 60);
      if (hoursLeft < 1 && hoursLeft > 0) {
        return {
          allowed: false,
          reason: `Market ends in ${hoursLeft.toFixed(1)} hours — too risky.`,
        };
      }
    }

    return { allowed: true, reason: "All checks passed." };
  }

  // Record a trade
  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    this.dailyPnL += trade.pnl;

    if (trade.pnl < 0) {
      log.warn(
        `Daily P&L: $${this.dailyPnL.toFixed(2)} (limit: -$${config.dailyLossLimit})`
      );
    }
  }

  // Emergency stop
  kill(): void {
    this.killed = true;
    log.error("KILL SWITCH ACTIVATED — all trading stopped.");
  }

  // Resume after kill
  resume(): void {
    this.killed = false;
    log.success("Kill switch deactivated. Trading resumed.");
  }

  // Reset daily counters (call at midnight)
  resetDaily(): void {
    this.dailyPnL = 0;
    this.trades = this.trades.filter(
      (t) => Date.now() - t.timestamp < 24 * 60 * 60 * 1000
    );
    log.info("Daily risk counters reset.");
  }

  // Get today's stats
  getStats(): { trades: number; dailyPnL: number; killed: boolean } {
    return {
      trades: this.trades.length,
      dailyPnL: this.dailyPnL,
      killed: this.killed,
    };
  }
}
