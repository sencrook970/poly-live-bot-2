import axios from "axios";
import { Side, OrderType } from "@polymarket/clob-client";
import { getClient } from "./client";
import { config } from "./config";
import { log } from "./utils/logger";
import { BotState, saveState } from "./state";
import { fetchOnChainPositions } from "./sync";

// ---------------------------------------------------------------------------
// PORTFOLIO OPTIMIZER
//
// Runs on startup and periodically to clean up the portfolio:
// 1. Detects contradictory positions (e.g., BTC >$76k YES + BTC >$70k NO)
// 2. Detects near-certain losers (price dropped to near 0)
// 3. Detects deeply underwater positions with no recovery path
// 4. Auto-sells bad positions to free up capital
//
// Uses on-chain data as source of truth, NOT state.json.
// ---------------------------------------------------------------------------

interface PositionAnalysis {
  tokenId: string;
  title: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  action: "keep" | "sell";
  reason: string;
}

// Get current BTC price for contradiction detection
async function getBtcPrice(): Promise<number> {
  try {
    const resp = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      { params: { ids: "bitcoin", vs_currencies: "usd" }, timeout: 5000 }
    );
    return resp.data.bitcoin.usd;
  } catch {
    return 0;
  }
}

// Parse BTC price level from a market question
// Returns the dollar threshold and whether "YES" means "above" that level
function parseBtcLevel(
  question: string
): { level: number; yesIsAbove: boolean } | null {
  const q = question.toLowerCase();
  if (!q.includes("bitcoin") && !q.includes("btc")) return null;

  const match = question.match(/\$([0-9,]+)/);
  if (!match) return null;

  const level = parseFloat(match[1].replace(/,/g, ""));
  if (level < 1000) return null; // not a BTC price level

  // "Will Bitcoin be above $76,000?" → YES = above
  // "BTC > $76k" → YES = above
  const yesIsAbove =
    q.includes("above") || q.includes(">") || q.includes("hit") || q.includes("reach");

  return { level, yesIsAbove };
}

// Sync the CLOB server's internal balance with on-chain.
// The CLOB has its own balance ledger. When positions resolve and USDC.e
// returns to your wallet, or when you deposit, the CLOB doesn't know.
// This function tells the CLOB to re-check on-chain.
async function syncClobBalance(): Promise<void> {
  if (config.paperTrade) return;

  try {
    const client = await getClient();
    log.info("[Optimizer] Syncing CLOB balance with on-chain...");

    // The SDK's updateBalanceAllowance sends a GET to /balance-allowance/update
    // Some SDK versions need different params. Try multiple approaches.
    let synced = false;

    // The SDK's updateBalanceAllowance() is broken — it returns errors but doesn't throw.
    // Skip it and go straight to on-chain re-approve which always works.
    {
      try {
        const { createWalletClient, createPublicClient, http, parseAbi } = await import("viem");
        const { polygon } = await import("viem/chains");
        const { privateKeyToAccount } = await import("viem/accounts");

        const pk = config.privateKey.startsWith("0x") ? config.privateKey : `0x${config.privateKey}`;
        const account = privateKeyToAccount(pk as `0x${string}`);
        const walletClient = createWalletClient({
          account,
          chain: polygon,
          transport: http("https://polygon-bor-rpc.publicnode.com"),
        });
        const publicClient = createPublicClient({
          chain: polygon,
          transport: http("https://polygon-bor-rpc.publicnode.com"),
        });

        const ERC20_ABI = parseAbi([
          "function approve(address spender, uint256 amount) returns (bool)",
        ]);
        const MAX = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");
        const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as `0x${string}`;
        const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as `0x${string}`;
        const NEG_RISK = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as `0x${string}`;

        log.info("[Optimizer] Re-approving USDC.e for exchanges (forces balance sync)...");
        const h1 = await walletClient.writeContract({
          address: USDC_E, abi: ERC20_ABI, functionName: "approve",
          args: [EXCHANGE, MAX],
        });
        await publicClient.waitForTransactionReceipt({ hash: h1 });

        const h2 = await walletClient.writeContract({
          address: USDC_E, abi: ERC20_ABI, functionName: "approve",
          args: [NEG_RISK, MAX],
        });
        await publicClient.waitForTransactionReceipt({ hash: h2 });

        log.success("[Optimizer] USDC.e re-approved — CLOB should recognize balance now.");
        synced = true;
      } catch (e2: any) {
        log.warn(`[Optimizer] On-chain approve failed: ${e2?.message?.substring(0, 80)}`);
      }
    }

    if (!synced) {
      log.warn("[Optimizer] On-chain approve failed. Run manually: npx tsx src/scripts/set-allowance.ts");
    }

    // Also try the SDK method as a fallback (it may partially work for some exchange types)
    try {
      await client.updateBalanceAllowance({ asset_type: 0 as any });
      await client.updateBalanceAllowance({ asset_type: 1 as any });
    } catch {}

  } catch (err) {
    log.warn(`[Optimizer] Balance sync error: ${err}`);
  }
}

// Cancel all open/pending orders to free up locked USDC.e
// This is critical on startup because old unfilled orders consume balance
export async function cancelAllOpenOrders(): Promise<void> {
  if (config.paperTrade) return;

  try {
    const client = await getClient();
    log.info("[Optimizer] Cancelling all open orders to free locked USDC.e...");
    await client.cancelAll();
    log.success("[Optimizer] All open orders cancelled.");
  } catch (err) {
    log.warn(`[Optimizer] Could not cancel orders: ${err}`);
  }

  // Sync the CLOB server's internal balance with on-chain reality.
  // Without this, the CLOB rejects orders with "not enough balance / allowance"
  // because it doesn't know about USDC.e from resolved positions or new deposits.
  await syncClobBalance();
}

export async function optimizePortfolio(
  state: BotState,
  walletAddress: string
): Promise<void> {
  if (!config.autoCleanup) {
    log.info("[Optimizer] Auto-cleanup disabled.");
    return;
  }

  log.info("[Optimizer] ══════════════════════════════════════");
  log.info("[Optimizer] Running portfolio cleanup...");

  // First: cancel all open orders so USDC.e is not locked
  await cancelAllOpenOrders();

  // Re-sync from on-chain first (source of truth)
  const onChainPositions = await fetchOnChainPositions(walletAddress);
  if (onChainPositions.length === 0) {
    log.info("[Optimizer] No on-chain positions found.");
    return;
  }

  // Get current BTC price
  const btcPrice = await getBtcPrice();
  if (btcPrice > 0) {
    log.info(`[Optimizer] Current BTC: $${btcPrice.toLocaleString()}`);
  }

  // Step 1: Clean resolved markets (price 0 or 1) — just remove from state, don't try to sell
  // Resolved markets have their orderbook deleted, so CLOB sells will fail with "orderbook does not exist"
  let cleaned = 0;
  for (const pos of onChainPositions) {
    if (pos.size <= 0) continue;
    if (pos.curPrice <= 0.005 || pos.curPrice >= 0.995) {
      log.info(
        `[Optimizer] RESOLVED: "${pos.title.substring(0, 50)}..." — price $${pos.curPrice.toFixed(3)}, removing from state`
      );
      delete state.positions[pos.asset];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    saveState(state);
    log.info(`[Optimizer] Cleaned ${cleaned} resolved markets from state.`);
  }

  const analyses: PositionAnalysis[] = [];

  for (const pos of onChainPositions) {
    if (pos.size <= 0) continue;
    // Skip already-resolved markets (handled above)
    if (pos.curPrice <= 0.005 || pos.curPrice >= 0.995) continue;

    const analysis: PositionAnalysis = {
      tokenId: pos.asset,
      title: pos.title,
      outcome: pos.outcome,
      shares: pos.size,
      avgPrice: pos.avgPrice,
      currentPrice: pos.curPrice,
      pnl: pos.cashPnl,
      action: "keep",
      reason: "Position looks OK",
    };

    // Check 1: Near-certain loser (very low price but not fully resolved)
    if (pos.curPrice <= 0.03 && pos.size > 0) {
      analysis.action = "sell";
      analysis.reason = `Price $${pos.curPrice.toFixed(3)} near zero — almost certain loss`;
      analyses.push(analysis);
      continue;
    }

    // Check 2: BTC-specific contradictions
    if (btcPrice > 0) {
      const btcInfo = parseBtcLevel(pos.title);
      if (btcInfo) {
        const isYes = pos.outcome.toLowerCase() === "yes";

        // Holding NO on "BTC above $X" when BTC is well above X → losing
        if (!isYes && btcInfo.yesIsAbove && btcPrice > btcInfo.level * 1.05) {
          analysis.action = "sell";
          analysis.reason = `BTC $${btcPrice.toLocaleString()} is ${((btcPrice / btcInfo.level - 1) * 100).toFixed(0)}% above $${btcInfo.level.toLocaleString()} — NO likely loses`;
        }

        // Holding YES on "BTC above $X" when BTC is far below X → losing
        if (isYes && btcInfo.yesIsAbove && btcPrice < btcInfo.level * 0.90) {
          analysis.action = "sell";
          analysis.reason = `BTC $${btcPrice.toLocaleString()} is ${((1 - btcPrice / btcInfo.level) * 100).toFixed(0)}% below $${btcInfo.level.toLocaleString()} — YES likely loses`;
        }
      }
    }

    // Check 3: Deep loss with very low current price (recovery unlikely)
    if (pos.curPrice < 0.08 && pos.cashPnl < -1) {
      analysis.action = "sell";
      analysis.reason = `Price $${pos.curPrice.toFixed(3)} with P&L $${pos.cashPnl.toFixed(2)} — recovery unlikely, free up capital`;
    }

    analyses.push(analysis);
  }

  // Execute sells
  const toSell = analyses.filter((a) => a.action === "sell");
  const toKeep = analyses.filter((a) => a.action === "keep");

  log.info(`[Optimizer] Analysis: ${toKeep.length} keep, ${toSell.length} sell`);

  for (const a of toKeep) {
    const pnlStr = a.pnl >= 0 ? `+$${a.pnl.toFixed(2)}` : `-$${Math.abs(a.pnl).toFixed(2)}`;
    log.info(
      `[Optimizer]   KEEP ${a.outcome} "${a.title.substring(0, 50)}..." — ${a.shares} shares (${pnlStr})`
    );
  }

  if (toSell.length === 0) {
    log.info("[Optimizer] No bad positions to clean up.");
    log.info("[Optimizer] ══════════════════════════════════════");
    return;
  }

  for (const a of toSell) {
    log.warn(
      `[Optimizer]   SELL ${a.shares} ${a.outcome} "${a.title.substring(0, 50)}..." — ${a.reason}`
    );
  }

  if (config.paperTrade) {
    log.paper("[Optimizer] Paper mode — skipping actual sells.");
    log.info("[Optimizer] ══════════════════════════════════════");
    return;
  }

  // Execute each sell
  for (const a of toSell) {
    try {
      const sold = await sellPositionDirect(a.tokenId, a.shares, a.currentPrice);
      if (sold) {
        // Update state to reflect the sell
        const pnl = (a.currentPrice - a.avgPrice) * a.shares;
        state.realizedPnL += pnl;
        state.totalReturned += a.currentPrice * a.shares;
        delete state.positions[a.tokenId];
        saveState(state);
        log.success(
          `[Optimizer] Sold "${a.title.substring(0, 45)}..." — realized P&L: $${pnl.toFixed(2)}`
        );
      }
    } catch (err) {
      log.error(
        `[Optimizer] Failed to sell "${a.title.substring(0, 40)}...": ${err}`
      );
    }
  }

  log.info("[Optimizer] ══════════════════════════════════════");
}

async function sellPositionDirect(
  tokenId: string,
  shares: number,
  currentPrice: number
): Promise<boolean> {
  try {
    const client = await getClient();
    const tickSize = await client.getTickSize(tokenId);
    const negRisk = await client.getNegRisk(tokenId);

    // Sell slightly below current price for quick fill
    const sellPrice = Math.max(
      0.01,
      Math.round((currentPrice - 0.01) * 1000) / 1000
    );

    log.trade(
      `[Optimizer] Placing SELL: ${shares} shares @ $${sellPrice.toFixed(3)} (market: $${currentPrice.toFixed(3)})`
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
      log.success(`[Optimizer] Sell order placed: ${r.status} (ID: ${r.orderID})`);
      return true;
    } else {
      log.error(`[Optimizer] Sell failed: ${r.error || JSON.stringify(result)}`);
      return false;
    }
  } catch (err) {
    log.error(`[Optimizer] Sell error: ${err}`);
    return false;
  }
}
