import axios from "axios";
import { log } from "./utils/logger";
import { BotState, PositionRecord, TradeRecord, saveState } from "./state";

// ---------------------------------------------------------------------------
// On-Chain Sync — fetches real positions from Polymarket's Data API.
// This is the SOURCE OF TRUTH. On every startup, we fetch positions
// from the API and merge with our local state.json.
//
// Priority: on-chain > state.json
// If on-chain says you have 100 shares but state.json says 50,
// we trust on-chain (100 shares).
// ---------------------------------------------------------------------------

const DATA_API = "https://data-api.polymarket.com";

interface OnChainPosition {
  asset: string; // token ID
  conditionId: string;
  size: number; // shares held
  avgPrice: number;
  initialValue: number; // cost basis
  currentValue: number;
  cashPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  eventId: string;
  endDate: string;
  redeemable: boolean;
}

interface OnChainTrade {
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  outcome: string;
  transactionHash: string;
}

// Fetch all positions from Polymarket Data API (with retry)
export async function fetchOnChainPositions(
  walletAddress: string
): Promise<OnChainPosition[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await axios.get(`${DATA_API}/positions`, {
        params: { user: walletAddress },
        timeout: 15000,
      });
      return resp.data as OnChainPosition[];
    } catch (err) {
      log.warn(`[Sync] Positions fetch attempt ${attempt}/3 failed: ${err}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  log.error("[Sync] Could not fetch positions after 3 attempts. Using local state.");
  return [];
}

// Fetch all trades from Polymarket Data API (with retry)
export async function fetchOnChainTrades(
  walletAddress: string
): Promise<OnChainTrade[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await axios.get(`${DATA_API}/trades`, {
        params: { user: walletAddress },
        timeout: 15000,
      });
      return resp.data as OnChainTrade[];
    } catch (err) {
      log.warn(`[Sync] Trades fetch attempt ${attempt}/3 failed: ${err}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  log.error("[Sync] Could not fetch trades after 3 attempts. Using local state.");
  return [];
}

// --- Cached position lookup for auto-sell verification ---
// Avoids hammering the API — caches for 30 seconds
let _posCache: OnChainPosition[] = [];
let _posCacheTime = 0;
const POS_CACHE_TTL = 30_000;

export async function getVerifiedShares(
  walletAddress: string,
  tokenId: string
): Promise<number> {
  if (Date.now() - _posCacheTime > POS_CACHE_TTL) {
    _posCache = await fetchOnChainPositions(walletAddress);
    _posCacheTime = Date.now();
  }
  const pos = _posCache.find((p) => p.asset === tokenId);
  return pos ? pos.size : 0;
}

// Invalidate cache (call after a sell to force re-fetch)
export function invalidatePositionCache(): void {
  _posCacheTime = 0;
}

// Sync on-chain positions with local state
// Priority: on-chain is the source of truth
export async function syncState(
  state: BotState,
  walletAddress: string
): Promise<void> {
  log.info("[Sync] Fetching positions from Polymarket...");

  const onChainPositions = await fetchOnChainPositions(walletAddress);
  const onChainTrades = await fetchOnChainTrades(walletAddress);

  if (onChainPositions.length === 0 && onChainTrades.length === 0) {
    log.info("[Sync] No on-chain positions or trades found.");
    return;
  }

  log.info(
    `[Sync] Found ${onChainPositions.length} positions, ${onChainTrades.length} trades on-chain`
  );

  // Merge positions: on-chain is truth
  let added = 0;
  let updated = 0;

  for (const pos of onChainPositions) {
    if (pos.size <= 0) continue; // skip zero positions
    if (pos.curPrice <= 0.005) {
      log.info(`[Sync] Skipping resolved market: "${pos.title}" (price: $${pos.curPrice})`);
      continue; // skip resolved markets — don't re-add dead positions
    }

    const existing = state.positions[pos.asset];

    if (existing) {
      // Position exists in state — update with on-chain data
      if (existing.totalShares !== pos.size) {
        log.info(
          `[Sync] Updated "${pos.title}" — shares: ${existing.totalShares} → ${pos.size}`
        );
        updated++;
      }
      existing.totalShares = pos.size;
      existing.avgPrice = pos.avgPrice;
      existing.totalCost = pos.initialValue;
      existing.currentPrice = pos.curPrice;
      existing.unrealizedPnL = pos.cashPnl;
    } else {
      // New position not in state — add it
      state.positions[pos.asset] = {
        marketId: pos.conditionId,
        marketQuestion: pos.title,
        tokenId: pos.asset,
        outcome: pos.outcome,
        totalShares: pos.size,
        avgPrice: pos.avgPrice,
        totalCost: pos.initialValue,
        currentPrice: pos.curPrice,
        unrealizedPnL: pos.cashPnl,
        firstBoughtAt: Date.now(),
      };

      // Track as traded market
      if (!state.tradedMarketIds.includes(pos.conditionId)) {
        state.tradedMarketIds.push(pos.conditionId);
      }

      log.info(
        `[Sync] Added "${pos.title}" — ${pos.size} ${pos.outcome} shares @ $${pos.avgPrice.toFixed(3)} (current: $${pos.curPrice.toFixed(3)}, P&L: $${pos.cashPnl.toFixed(2)})`
      );
      added++;
    }
  }

  // Remove positions that no longer exist on-chain (resolved/sold)
  const onChainTokenIds = new Set(
    onChainPositions.filter((p) => p.size > 0).map((p) => p.asset)
  );
  const toRemove: string[] = [];
  for (const tokenId of Object.keys(state.positions)) {
    if (!onChainTokenIds.has(tokenId)) {
      const pos = state.positions[tokenId];
      log.info(
        `[Sync] Removed "${pos.marketQuestion}" — no longer on-chain (resolved or sold)`
      );
      // Add to realized P&L if we can estimate
      toRemove.push(tokenId);
    }
  }
  for (const tokenId of toRemove) {
    delete state.positions[tokenId];
  }

  // Sync trade history (add missing trades from on-chain)
  const existingTxHashes = new Set(
    state.trades.filter((t) => t.txHash).map((t) => t.txHash)
  );
  let tradesAdded = 0;

  for (const trade of onChainTrades) {
    if (trade.transactionHash && existingTxHashes.has(trade.transactionHash)) {
      continue; // already tracked
    }

    state.trades.push({
      id: trade.transactionHash || `onchain_${Date.now()}_${tradesAdded}`,
      marketId: trade.conditionId,
      marketQuestion: trade.title,
      tokenId: trade.asset,
      outcome: trade.outcome,
      side: trade.side,
      shares: trade.size,
      price: trade.price,
      cost: trade.size * trade.price,
      timestamp: trade.timestamp * 1000,
      status: "filled",
      txHash: trade.transactionHash,
    });
    tradesAdded++;
  }

  // Recalculate total invested from ON-CHAIN positions only (avoids double counting)
  state.totalInvested = 0;
  for (const pos of Object.values(state.positions)) {
    state.totalInvested += pos.totalCost;
  }

  log.success(
    `[Sync] Done: ${added} added, ${updated} updated, ${toRemove.length} removed, ${tradesAdded} trades synced`
  );

  // Print summary
  let totalValue = 0;
  let totalPnL = 0;
  for (const pos of Object.values(state.positions)) {
    totalValue += pos.currentPrice * pos.totalShares;
    totalPnL += pos.unrealizedPnL;
  }
  log.info(`[Sync] Portfolio value: $${totalValue.toFixed(2)}`);
  log.info(`[Sync] Total invested:  $${state.totalInvested.toFixed(2)}`);
  log.info(`[Sync] Unrealized P&L:  $${totalPnL.toFixed(2)}`);

  saveState(state);
}
