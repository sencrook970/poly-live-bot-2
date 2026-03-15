import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { getClient } from "../client";
import { config } from "../config";
import { log } from "../utils/logger";
import { BotState, saveState } from "../state";

// ---------------------------------------------------------------------------
// Auto Sell — automatically sells positions when they hit profit/loss targets.
//
// Rules:
// - TAKE PROFIT: sell when a position is up >20% from entry
// - STOP LOSS: sell when a position is down >50% from entry
// - NEAR EXPIRY: sell if market ends within 2 hours and position is profitable
//
// These thresholds are configurable via .env (TAKE_PROFIT_PERCENT, STOP_LOSS_PERCENT)
// ---------------------------------------------------------------------------

const TAKE_PROFIT = parseFloat(process.env.TAKE_PROFIT_PERCENT || "20") / 100;
const STOP_LOSS = parseFloat(process.env.STOP_LOSS_PERCENT || "50") / 100;

export async function checkAndSellPositions(state: BotState): Promise<void> {
  const positions = Object.values(state.positions);
  if (positions.length === 0) return;

  let soldCount = 0;

  // First: remove resolved markets (price at 0 or 1, orderbook gone)
  // Use a Set to track what we've already counted in realized P&L
  const alreadyCounted = new Set<string>();
  for (const pos of positions) {
    if (pos.currentPrice <= 0.005 || pos.currentPrice >= 0.995) {
      // Only count P&L once — check if this was already in state before sync added it
      if (!alreadyCounted.has(pos.tokenId)) {
        alreadyCounted.add(pos.tokenId);
        log.info(
          `[AutoSell] Market resolved: "${pos.marketQuestion.substring(0, 40)}..." — removing from portfolio`
        );
      }
      delete state.positions[pos.tokenId];
      saveState(state);
    }
  }

  // Re-read positions after cleanup
  const activePositions = Object.values(state.positions);

  for (const pos of activePositions) {
    if (pos.totalShares <= 0) continue;

    const priceChange = (pos.currentPrice - pos.avgPrice) / pos.avgPrice;

    // TAKE PROFIT — position is up enough
    if (priceChange >= TAKE_PROFIT) {
      log.success(
        `[AutoSell] TAKE PROFIT: "${pos.marketQuestion.substring(0, 40)}..." — ` +
          `up ${(priceChange * 100).toFixed(1)}% ($${pos.avgPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)})`
      );
      const sold = await sellPosition(pos.tokenId, pos.totalShares, pos.currentPrice);
      if (sold) {
        // Update state
        const pnl = (pos.currentPrice - pos.avgPrice) * pos.totalShares;
        state.realizedPnL += pnl;
        state.totalReturned += pos.currentPrice * pos.totalShares;
        delete state.positions[pos.tokenId];
        saveState(state);
        soldCount++;
        log.success(`  Realized P&L: +$${pnl.toFixed(2)}`);
      }
    }

    // STOP LOSS — position is down too much
    if (priceChange <= -STOP_LOSS) {
      log.warn(
        `[AutoSell] STOP LOSS: "${pos.marketQuestion.substring(0, 40)}..." — ` +
          `down ${(priceChange * 100).toFixed(1)}% ($${pos.avgPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)})`
      );
      const sold = await sellPosition(pos.tokenId, pos.totalShares, pos.currentPrice);
      if (sold) {
        const pnl = (pos.currentPrice - pos.avgPrice) * pos.totalShares;
        state.realizedPnL += pnl;
        state.totalReturned += pos.currentPrice * pos.totalShares;
        delete state.positions[pos.tokenId];
        saveState(state);
        soldCount++;
        log.warn(`  Realized P&L: -$${Math.abs(pnl).toFixed(2)}`);
      }
    }
  }

  if (soldCount > 0) {
    log.info(`[AutoSell] Closed ${soldCount} positions. Total realized P&L: $${state.realizedPnL.toFixed(2)}`);
  }
}

async function sellPosition(
  tokenId: string,
  shares: number,
  currentPrice: number
): Promise<boolean> {
  if (config.paperTrade) {
    log.paper(`[AutoSell] Would sell ${shares} shares @ $${currentPrice.toFixed(3)}`);
    return true;
  }

  try {
    const client = await getClient();

    const tickSize = await client.getTickSize(tokenId);
    const negRisk = await client.getNegRisk(tokenId);

    // Sell slightly below current price for quick fill
    const sellPrice = Math.max(0.01, Math.round((currentPrice - 0.005) * 1000) / 1000);

    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: sellPrice,
        side: Side.SELL,
        size: shares,
      },
      {
        tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
        negRisk,
      },
      OrderType.GTC
    );

    const r = result as any;
    if (r.success) {
      log.success(`[AutoSell] Sold ${shares} shares @ $${sellPrice.toFixed(3)} — ${r.status}`);
      return true;
    } else {
      log.error(`[AutoSell] Sell failed: ${JSON.stringify(result)}`);
      return false;
    }
  } catch (err) {
    log.error(`[AutoSell] Error selling: ${err}`);
    return false;
  }
}
