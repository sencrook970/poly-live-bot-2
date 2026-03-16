import { Side, OrderType } from "@polymarket/clob-client";
import { getClient } from "../client";
import { config } from "../config";
import { log } from "../utils/logger";
import { BotState, saveState } from "../state";
import { getVerifiedShares, invalidatePositionCache } from "../sync";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Auto Sell v2 — sells positions when they hit profit/loss targets.
//
// Improvements over v1:
// 1. VERIFY actual shares on-chain before selling (prevents "not enough balance" errors)
// 2. RETRY TRACKING: after N failures, stop trying and log "manual required"
// 3. COOLDOWN: don't retry the same sell more than once per cooldown period
// 4. Handles resolved markets (price 0 or 1) cleanly
// ---------------------------------------------------------------------------

const TAKE_PROFIT = parseFloat(process.env.TAKE_PROFIT_PERCENT || "20") / 100;
const STOP_LOSS = parseFloat(process.env.STOP_LOSS_PERCENT || "50") / 100;

// Track sell attempts per token to avoid infinite retry spam
const sellAttempts = new Map<string, { count: number; lastAttempt: number }>();
// Positions marked as "manual required" after too many failures
const manualRequired = new Set<string>();

function getWalletAddress(): string {
  const pk = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;
  return privateKeyToAccount(pk as `0x${string}`).address;
}

export async function checkAndSellPositions(state: BotState): Promise<void> {
  const positions = Object.values(state.positions);
  if (positions.length === 0) return;

  let soldCount = 0;

  // First: remove resolved markets (price at 0 or 1, orderbook gone)
  for (const pos of positions) {
    if (pos.currentPrice <= 0.005 || pos.currentPrice >= 0.995) {
      log.info(
        `[AutoSell] Market resolved: "${pos.marketQuestion.substring(0, 40)}..." — removing from portfolio`
      );
      // Clean up tracking
      sellAttempts.delete(pos.tokenId);
      manualRequired.delete(pos.tokenId);
      delete state.positions[pos.tokenId];
      saveState(state);
    }
  }

  // Re-read positions after cleanup
  const activePositions = Object.values(state.positions);
  const walletAddress = getWalletAddress();

  for (const pos of activePositions) {
    if (pos.totalShares <= 0) continue;

    // Skip if marked as "manual required" (too many failed sells)
    if (manualRequired.has(pos.tokenId)) {
      continue; // logged once when marked, don't spam
    }

    const priceChange = (pos.currentPrice - pos.avgPrice) / pos.avgPrice;

    let shouldSell = false;
    let sellReason = "";

    // TAKE PROFIT — position is up enough
    if (priceChange >= TAKE_PROFIT) {
      shouldSell = true;
      sellReason = `TAKE PROFIT: up ${(priceChange * 100).toFixed(1)}% ($${pos.avgPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)})`;
    }

    // STOP LOSS — position is down too much
    if (priceChange <= -STOP_LOSS) {
      shouldSell = true;
      sellReason = `STOP LOSS: down ${(priceChange * 100).toFixed(1)}% ($${pos.avgPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)})`;
    }

    if (!shouldSell) continue;

    // --- COOLDOWN CHECK ---
    const attempts = sellAttempts.get(pos.tokenId);
    if (attempts) {
      const cooldownMs = config.sellCooldownMinutes * 60 * 1000;
      if (Date.now() - attempts.lastAttempt < cooldownMs) {
        continue; // still in cooldown, skip silently
      }
      if (attempts.count >= config.maxSellRetries) {
        manualRequired.add(pos.tokenId);
        log.error(
          `[AutoSell] MANUAL REQUIRED: "${pos.marketQuestion.substring(0, 40)}..." — ${attempts.count} sell attempts failed. Sell manually on polymarket.com`
        );
        continue;
      }
    }

    // --- VERIFY ACTUAL SHARES ON-CHAIN ---
    let verifiedShares = pos.totalShares;
    try {
      const onChainShares = await getVerifiedShares(walletAddress, pos.tokenId);
      if (onChainShares <= 0) {
        log.info(
          `[AutoSell] No shares on-chain for "${pos.marketQuestion.substring(0, 40)}..." — removing from state`
        );
        delete state.positions[pos.tokenId];
        saveState(state);
        continue;
      }
      if (onChainShares < pos.totalShares) {
        log.info(
          `[AutoSell] Clamping shares: state says ${pos.totalShares} but on-chain has ${onChainShares}`
        );
        verifiedShares = onChainShares;
      }
    } catch (err) {
      log.warn(`[AutoSell] Could not verify shares — using state.json count (${pos.totalShares})`);
    }

    // --- EXECUTE SELL ---
    if (priceChange >= TAKE_PROFIT) {
      log.success(`[AutoSell] ${sellReason} — "${pos.marketQuestion.substring(0, 45)}..."`);
    } else {
      log.warn(`[AutoSell] ${sellReason} — "${pos.marketQuestion.substring(0, 45)}..."`);
    }

    const sold = await sellPosition(pos.tokenId, verifiedShares, pos.currentPrice);

    // Track attempt
    const prev = sellAttempts.get(pos.tokenId) || { count: 0, lastAttempt: 0 };
    sellAttempts.set(pos.tokenId, {
      count: sold ? 0 : prev.count + 1, // reset on success
      lastAttempt: Date.now(),
    });

    if (sold) {
      const pnl = (pos.currentPrice - pos.avgPrice) * verifiedShares;
      state.realizedPnL += pnl;
      state.totalReturned += pos.currentPrice * verifiedShares;
      delete state.positions[pos.tokenId];
      saveState(state);
      invalidatePositionCache(); // force re-fetch next time
      soldCount++;

      if (pnl >= 0) {
        log.success(`  Realized P&L: +$${pnl.toFixed(2)}`);
      } else {
        log.warn(`  Realized P&L: -$${Math.abs(pnl).toFixed(2)}`);
      }
    } else {
      const retries = sellAttempts.get(pos.tokenId)!;
      log.warn(
        `[AutoSell] Sell failed (attempt ${retries.count}/${config.maxSellRetries}). Will retry after ${config.sellCooldownMinutes}min cooldown.`
      );
    }
  }

  if (soldCount > 0) {
    log.info(
      `[AutoSell] Closed ${soldCount} positions. Total realized P&L: $${state.realizedPnL.toFixed(2)}`
    );
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
    const sellPrice = Math.max(
      0.01,
      Math.round((currentPrice - 0.005) * 1000) / 1000
    );

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
      log.error(`[AutoSell] Sell failed: ${r.error || JSON.stringify(result)}`);
      return false;
    }
  } catch (err) {
    log.error(`[AutoSell] Error selling: ${err}`);
    return false;
  }
}
