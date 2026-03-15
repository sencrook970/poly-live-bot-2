import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// Position Tracker — keeps track of what we own.
//
// Tracks:
// - What shares we hold (YES/NO tokens in which markets)
// - Average buy price
// - Current value
// - Unrealized P&L
// ---------------------------------------------------------------------------

export interface Position {
  marketId: string;
  question: string;
  tokenId: string;
  outcome: string; // "Yes" or "No"
  shares: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  openedAt: number; // timestamp
}

export class PositionTracker {
  private positions: Map<string, Position> = new Map();

  // Add or update a position after a buy
  addPosition(
    marketId: string,
    question: string,
    tokenId: string,
    outcome: string,
    shares: number,
    price: number
  ): void {
    const existing = this.positions.get(tokenId);

    if (existing) {
      // Update average price
      const totalShares = existing.shares + shares;
      existing.avgPrice =
        (existing.avgPrice * existing.shares + price * shares) / totalShares;
      existing.shares = totalShares;
      existing.currentPrice = price;
    } else {
      this.positions.set(tokenId, {
        marketId,
        question,
        tokenId,
        outcome,
        shares,
        avgPrice: price,
        currentPrice: price,
        unrealizedPnL: 0,
        openedAt: Date.now(),
      });
    }

    log.info(
      `Position updated: ${outcome} on "${question}" — ${shares} shares @ $${price.toFixed(3)}`
    );
  }

  // Remove shares (after a sell or market resolution)
  removeShares(tokenId: string, shares: number): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;

    pos.shares -= shares;
    if (pos.shares <= 0) {
      this.positions.delete(tokenId);
      log.info(`Position closed: ${pos.outcome} on "${pos.question}"`);
    }
  }

  // Update current prices
  updatePrice(tokenId: string, currentPrice: number): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    pos.unrealizedPnL = (currentPrice - pos.avgPrice) * pos.shares;
  }

  // Get all open positions
  getAll(): Position[] {
    return Array.from(this.positions.values());
  }

  // Get total unrealized P&L
  getTotalUnrealizedPnL(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.unrealizedPnL;
    }
    return total;
  }

  // Print a summary table
  printSummary(): void {
    const positions = this.getAll();
    if (positions.length === 0) {
      log.info("No open positions.");
      return;
    }

    log.info(`\n--- Open Positions (${positions.length}) ---`);
    for (const pos of positions) {
      const pnl = pos.unrealizedPnL;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      log.info(
        `  ${pos.outcome} "${pos.question.substring(0, 50)}..." — ` +
          `${pos.shares} shares @ $${pos.avgPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)} (${pnlStr})`
      );
    }
    log.info(
      `  Total unrealized P&L: $${this.getTotalUnrealizedPnL().toFixed(2)}`
    );
    log.info("---\n");
  }
}
