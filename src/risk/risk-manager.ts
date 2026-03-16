import { config } from "../config";
import { log } from "../utils/logger";
import { Opportunity } from "../markets/analyzer";
import { PositionRecord } from "../state";

// ---------------------------------------------------------------------------
// Risk Manager v2 — prevents the bot from losing money through:
//
// 1. Daily loss limit (existing)
// 2. Max trade size (existing)
// 3. Kill switch (existing)
// 4. LOW CASH MODE: stop new trades when cash < threshold (NEW)
// 5. DAILY CAPITAL CAP: limit total new capital deployed per day (NEW)
// 6. MAX DEPLOYED: limit total % of assets in positions (NEW)
// 7. BTC CORRELATION: limit BTC-specific exposure (NEW)
// 8. MAX NEW MARKETS PER DAY: prevent overtrading (NEW)
// ---------------------------------------------------------------------------

interface TradeRecord {
  timestamp: number;
  market: string;
  side: string;
  size: number;
  price: number;
  pnl: number;
}

interface RiskContext {
  cashBalance: number;
  positions: Record<string, PositionRecord>;
  totalAssets: number; // cash + positions value
}

export class RiskManager {
  private trades: TradeRecord[] = [];
  private killed = false;
  private dailyPnL = 0;

  // Daily tracking
  private dailyCapitalDeployed = 0;
  private dailyNewMarkets = new Set<string>();
  private dailyDate = new Date().toISOString().split("T")[0];

  // Context set each scan by the main loop
  private ctx: RiskContext = { cashBalance: 0, positions: {}, totalAssets: 0 };

  // Update context with current portfolio state (call before each scan)
  setContext(ctx: RiskContext): void {
    this.ctx = ctx;

    // Reset daily counters if new day
    const today = new Date().toISOString().split("T")[0];
    if (today !== this.dailyDate) {
      this.dailyDate = today;
      this.dailyPnL = 0;
      this.dailyCapitalDeployed = 0;
      this.dailyNewMarkets.clear();
      this.trades = [];
      log.info("[Risk] Daily counters reset for new day.");
    }
  }

  // Main check: is this trade allowed?
  canTrade(
    opportunity: Opportunity,
    proposedSize: number
  ): { allowed: boolean; reason: string } {
    // Kill switch
    if (this.killed) {
      return { allowed: false, reason: "Kill switch activated." };
    }

    // Paper trade always allowed
    if (config.paperTrade) {
      return { allowed: true, reason: "Paper trade mode." };
    }

    // --- Check 1: Daily loss limit ---
    if (this.dailyPnL <= -config.dailyLossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit hit ($${config.dailyLossLimit}).`,
      };
    }

    // --- Check 2: Max trade size ---
    if (proposedSize > config.maxTradeSize) {
      return {
        allowed: false,
        reason: `Trade $${proposedSize.toFixed(2)} exceeds max $${config.maxTradeSize}.`,
      };
    }

    // --- Check 3: Min edge ---
    if (opportunity.edgePercent < config.minEdgePercent) {
      return {
        allowed: false,
        reason: `Edge ${opportunity.edgePercent.toFixed(1)}% below min ${config.minEdgePercent}%.`,
      };
    }

    // --- Check 4: LOW CASH MODE ---
    if (this.ctx.cashBalance < config.lowCashThreshold) {
      return {
        allowed: false,
        reason: `LOW CASH: $${this.ctx.cashBalance.toFixed(2)} < $${config.lowCashThreshold} threshold. Only managing existing positions.`,
      };
    }

    // --- Check 5: DAILY CAPITAL CAP ---
    const maxDailyDeploy = this.ctx.totalAssets * config.maxDailyDeployPercent;
    if (this.dailyCapitalDeployed + proposedSize > maxDailyDeploy) {
      return {
        allowed: false,
        reason: `Daily capital cap: deployed $${this.dailyCapitalDeployed.toFixed(2)} + $${proposedSize.toFixed(2)} > limit $${maxDailyDeploy.toFixed(2)} (${(config.maxDailyDeployPercent * 100).toFixed(0)}% of $${this.ctx.totalAssets.toFixed(2)}).`,
      };
    }

    // --- Check 6: MAX DEPLOYED % ---
    const positionsValue = Object.values(this.ctx.positions).reduce(
      (sum, p) => sum + p.currentPrice * p.totalShares,
      0
    );
    const deployedPercent = positionsValue / Math.max(1, this.ctx.totalAssets);
    if (deployedPercent >= config.maxDeployedPercent) {
      return {
        allowed: false,
        reason: `Max deployed: ${(deployedPercent * 100).toFixed(0)}% >= ${(config.maxDeployedPercent * 100).toFixed(0)}% limit. Need cash reserve.`,
      };
    }

    // --- Check 7: BTC CORRELATION ---
    const q = opportunity.market.question.toLowerCase();
    if (q.includes("bitcoin") || q.includes("btc")) {
      const btcPositionCount = this.countBtcPositions();
      if (btcPositionCount >= config.maxBtcPositions) {
        return {
          allowed: false,
          reason: `BTC limit: already ${btcPositionCount} BTC positions (max ${config.maxBtcPositions}).`,
        };
      }

      const btcExposure = this.getBtcExposure();
      const maxBtcExposure = this.ctx.totalAssets * config.maxBtcExposurePercent;
      if (btcExposure + proposedSize > maxBtcExposure) {
        return {
          allowed: false,
          reason: `BTC exposure: $${btcExposure.toFixed(2)} + $${proposedSize.toFixed(2)} > limit $${maxBtcExposure.toFixed(2)} (${(config.maxBtcExposurePercent * 100).toFixed(0)}% of assets).`,
        };
      }
    }

    // --- Check 8: MAX NEW MARKETS PER DAY ---
    const isNewMarket = !this.dailyNewMarkets.has(opportunity.market.id);
    if (isNewMarket && this.dailyNewMarkets.size >= config.maxNewMarketsPerDay) {
      return {
        allowed: false,
        reason: `Daily market cap: ${this.dailyNewMarkets.size} new markets today (max ${config.maxNewMarketsPerDay}).`,
      };
    }

    // --- Check 9: Market ending very soon ---
    if (opportunity.market.endDate) {
      const hoursLeft =
        (new Date(opportunity.market.endDate).getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursLeft < 1 && hoursLeft > 0) {
        return {
          allowed: false,
          reason: `Market ends in ${hoursLeft.toFixed(1)} hours — too risky.`,
        };
      }
    }

    return { allowed: true, reason: "All checks passed." };
  }

  // Record a completed trade
  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    this.dailyPnL += trade.pnl;
    this.dailyCapitalDeployed += trade.size;

    if (trade.pnl < 0) {
      log.warn(
        `[Risk] Daily P&L: $${this.dailyPnL.toFixed(2)} (limit: -$${config.dailyLossLimit})`
      );
    }
  }

  // Track a new market traded today
  recordNewMarket(marketId: string): void {
    this.dailyNewMarkets.add(marketId);
  }

  // Count BTC positions in current portfolio
  private countBtcPositions(): number {
    let count = 0;
    for (const pos of Object.values(this.ctx.positions)) {
      if (pos.totalShares <= 0) continue;
      const q = pos.marketQuestion.toLowerCase();
      if (q.includes("bitcoin") || q.includes("btc")) count++;
    }
    return count;
  }

  // Get total capital in BTC positions
  private getBtcExposure(): number {
    let exposure = 0;
    for (const pos of Object.values(this.ctx.positions)) {
      if (pos.totalShares <= 0) continue;
      const q = pos.marketQuestion.toLowerCase();
      if (q.includes("bitcoin") || q.includes("btc")) {
        exposure += pos.currentPrice * pos.totalShares;
      }
    }
    return exposure;
  }

  // Emergency stop
  kill(): void {
    this.killed = true;
    log.error("KILL SWITCH ACTIVATED — all trading stopped.");
  }

  resume(): void {
    this.killed = false;
    log.success("Kill switch deactivated. Trading resumed.");
  }

  // Get stats for logging
  getStats(): {
    trades: number;
    dailyPnL: number;
    dailyCapitalDeployed: number;
    dailyNewMarkets: number;
    killed: boolean;
  } {
    return {
      trades: this.trades.length,
      dailyPnL: this.dailyPnL,
      dailyCapitalDeployed: this.dailyCapitalDeployed,
      dailyNewMarkets: this.dailyNewMarkets.size,
      killed: this.killed,
    };
  }
}
