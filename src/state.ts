import fs from "fs";
import path from "path";
import { log } from "./utils/logger";

// ---------------------------------------------------------------------------
// Persistent State — saves everything to state.json so nothing is lost
// on restart. The bot loads this file on startup and writes to it after
// every trade or scan.
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(__dirname, "..", "state.json");

export interface TradeRecord {
  id: string; // order ID from Polymarket
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  outcome: string; // "Yes" or "No"
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  cost: number; // total USDC spent
  timestamp: number;
  status: "filled" | "pending" | "cancelled";
  txHash?: string;
}

export interface PositionRecord {
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  outcome: string;
  totalShares: number;
  avgPrice: number;
  totalCost: number;
  currentPrice: number;
  unrealizedPnL: number;
  firstBoughtAt: number;
}

export interface BotState {
  // When this state was last saved
  lastSaved: number;

  // All trades ever made (append-only log)
  trades: TradeRecord[];

  // Current open positions (derived from trades)
  positions: Record<string, PositionRecord>; // keyed by tokenId

  // Markets we've already traded (for deduplication)
  tradedMarketIds: string[];

  // Running totals
  totalInvested: number; // Total USDC spent on trades
  totalReturned: number; // Total USDC received from resolved markets
  realizedPnL: number; // Closed position P&L

  // Daily tracking
  dailyStats: {
    date: string; // YYYY-MM-DD
    trades: number;
    spent: number;
    pnl: number;
  };
}

function defaultState(): BotState {
  return {
    lastSaved: Date.now(),
    trades: [],
    positions: {},
    tradedMarketIds: [],
    totalInvested: 0,
    totalReturned: 0,
    realizedPnL: 0,
    dailyStats: {
      date: new Date().toISOString().split("T")[0],
      trades: 0,
      spent: 0,
      pnl: 0,
    },
  };
}

// Load state from file, or create a new one
export function loadState(): BotState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(raw) as BotState;
      log.success(
        `State loaded: ${state.trades.length} trades, ${Object.keys(state.positions).length} positions, $${state.totalInvested.toFixed(2)} invested`
      );

      // Reset daily stats if new day
      const today = new Date().toISOString().split("T")[0];
      if (state.dailyStats.date !== today) {
        state.dailyStats = { date: today, trades: 0, spent: 0, pnl: 0 };
      }

      return state;
    }
  } catch (err) {
    log.warn(`Could not load state file: ${err}. Starting fresh.`);
  }

  log.info("No previous state found. Starting fresh.");
  return defaultState();
}

// Save state to file
export function saveState(state: BotState): void {
  state.lastSaved = Date.now();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error(`Failed to save state: ${err}`);
  }
}

// Record a new trade
export function recordTrade(state: BotState, trade: TradeRecord): void {
  state.trades.push(trade);

  // Update or create position
  const pos = state.positions[trade.tokenId];
  if (pos) {
    // Add to existing position
    const newTotalShares = pos.totalShares + trade.shares;
    pos.avgPrice =
      (pos.avgPrice * pos.totalShares + trade.price * trade.shares) /
      newTotalShares;
    pos.totalShares = newTotalShares;
    pos.totalCost += trade.cost;
  } else {
    // New position
    state.positions[trade.tokenId] = {
      marketId: trade.marketId,
      marketQuestion: trade.marketQuestion,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
      totalShares: trade.shares,
      avgPrice: trade.price,
      totalCost: trade.cost,
      currentPrice: trade.price,
      unrealizedPnL: 0,
      firstBoughtAt: trade.timestamp,
    };
  }

  // Track the market as traded
  const marketKey = trade.marketId;
  if (!state.tradedMarketIds.includes(marketKey)) {
    state.tradedMarketIds.push(marketKey);
  }

  // Update totals
  state.totalInvested += trade.cost;
  state.dailyStats.trades++;
  state.dailyStats.spent += trade.cost;

  saveState(state);
}

// Update current prices for positions
export function updatePositionPrices(
  state: BotState,
  priceUpdates: { tokenId: string; price: number }[]
): void {
  for (const update of priceUpdates) {
    const pos = state.positions[update.tokenId];
    if (pos) {
      pos.currentPrice = update.price;
      pos.unrealizedPnL =
        (update.price - pos.avgPrice) * pos.totalShares;
    }
  }
  saveState(state);
}

// Check if we already have a position in a market
export function hasPosition(state: BotState, marketId: string): boolean {
  return state.tradedMarketIds.includes(marketId);
}

// Check if we hold the OPPOSITE side of a market
// e.g., if we hold NO and the opportunity wants to buy YES → conflict
export function hasConflictingPosition(
  state: BotState,
  marketQuestion: string,
  proposedOutcome: string
): { conflict: boolean; existingOutcome: string; existingShares: number } {
  for (const pos of Object.values(state.positions)) {
    // Match by question (since market IDs can differ between YES and NO tokens)
    if (pos.marketQuestion === marketQuestion && pos.totalShares > 0) {
      if (pos.outcome !== proposedOutcome) {
        return {
          conflict: true,
          existingOutcome: pos.outcome,
          existingShares: pos.totalShares,
        };
      }
    }
  }
  return { conflict: false, existingOutcome: "", existingShares: 0 };
}

// Get all unique market questions we have positions in
export function getPositionMarketQuestions(state: BotState): Set<string> {
  const questions = new Set<string>();
  for (const pos of Object.values(state.positions)) {
    if (pos.totalShares > 0) {
      questions.add(pos.marketQuestion);
    }
  }
  return questions;
}

// Count how many positions are in a category (for correlation limit)
export function countPositionsInCategory(
  state: BotState,
  keywords: string[]
): number {
  let count = 0;
  for (const pos of Object.values(state.positions)) {
    if (pos.totalShares <= 0) continue;
    const q = pos.marketQuestion.toLowerCase();
    if (keywords.some((kw) => q.includes(kw.toLowerCase()))) {
      count++;
    }
  }
  return count;
}

// Get total unrealized P&L
export function getTotalUnrealizedPnL(state: BotState): number {
  let total = 0;
  for (const pos of Object.values(state.positions)) {
    total += pos.unrealizedPnL;
  }
  return total;
}

// Get portfolio value (current value of all positions)
export function getPortfolioValue(state: BotState): number {
  let total = 0;
  for (const pos of Object.values(state.positions)) {
    total += pos.currentPrice * pos.totalShares;
  }
  return total;
}

// Print a summary
export function printStateSummary(state: BotState): void {
  const positions = Object.values(state.positions);
  const unrealizedPnL = getTotalUnrealizedPnL(state);
  const portfolioValue = getPortfolioValue(state);

  if (positions.length === 0) {
    log.info("No open positions.");
    return;
  }

  log.info(`\n--- Portfolio (${positions.length} positions) ---`);
  for (const pos of positions) {
    const pnl = pos.unrealizedPnL;
    const pnlStr =
      pnl >= 0
        ? `+$${pnl.toFixed(2)}`
        : `-$${Math.abs(pnl).toFixed(2)}`;
    log.info(
      `  ${pos.outcome} "${pos.marketQuestion.substring(0, 50)}..." — ` +
        `${pos.totalShares} shares @ $${pos.avgPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)} (${pnlStr})`
    );
  }
  log.info(`  Portfolio value:    $${portfolioValue.toFixed(2)}`);
  log.info(`  Total invested:     $${state.totalInvested.toFixed(2)}`);
  log.info(`  Unrealized P&L:     $${unrealizedPnL.toFixed(2)}`);
  log.info(`  Realized P&L:       $${state.realizedPnL.toFixed(2)}`);
  log.info(
    `  Today: ${state.dailyStats.trades} trades, $${state.dailyStats.spent.toFixed(2)} spent`
  );
  log.info("---\n");
}
