import WebSocket from "ws";
import axios from "axios";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import { log } from "../utils/logger";

dotenv.config();

// ---------------------------------------------------------------------------
// BTC 5-MINUTE DIRECTIONAL TRADING BOT
//
// Strategy: "Snipe" the winning side in the last 10-15 seconds of each
// 5-minute BTC window. BTC's direction is ~85% determined by then.
//
// Run: npm run btc-bot
// ---------------------------------------------------------------------------

// --- Config ---
const BET_SIZE = parseFloat(process.env.BTC_BOT_BET_SIZE || "2");
const MIN_PRICE_DIFF = parseFloat(process.env.BTC_BOT_MIN_DIFF || "30");
const SNIPE_WINDOW_SECONDS = 15;
const MAKER_PRICE = 0.95;
const WINDOW_SECONDS = 300;

// --- State ---
let btcPrice = 0;
let btcPriceUpdatedAt = 0;
let windowOpenPrice = 0;
let currentWindowTs = 0;
let tradedThisWindow = false;
let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let totalPnL = 0;
let totalSkips = 0;
let windowCount = 0;
let highPrice = 0;
let lowPrice = Infinity;
let lastMarketSlug = "";

// --- Polymarket Client ---
let clobClient: ClobClient | null = null;

async function getClient(): Promise<ClobClient> {
  if (clobClient) return clobClient;

  const pk = process.env.PRIVATE_KEY!;
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain: polygon, transport: http() });

  log.info("[BTC-Bot] Creating Polymarket client...");
  log.info(`[BTC-Bot] Wallet: ${account.address}`);

  clobClient = new ClobClient(
    "https://clob.polymarket.com",
    137,
    wallet,
    {
      key: process.env.CLOB_API_KEY!,
      secret: process.env.CLOB_SECRET!,
      passphrase: process.env.CLOB_PASSPHRASE!,
    },
    0
  );

  log.success("[BTC-Bot] Polymarket client ready");
  return clobClient;
}

// --- Binance WebSocket ---
function connectBinance(): void {
  log.info("[BTC-Bot] Connecting to Binance WebSocket...");
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@ticker");

  ws.on("open", () => {
    log.success("[BTC-Bot] Binance WebSocket connected — streaming BTC price");
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const parsed = JSON.parse(data.toString());
      btcPrice = parseFloat(parsed.c);
      btcPriceUpdatedAt = Date.now();
    } catch {}
  });

  ws.on("close", () => {
    log.warn("[BTC-Bot] Binance disconnected. Reconnecting in 3s...");
    setTimeout(connectBinance, 3000);
  });

  ws.on("error", (err) => {
    log.error(`[BTC-Bot] Binance error: ${err.message}`);
  });
}

// --- Find Active 5-Min Market ---
async function findCurrentMarket(): Promise<{
  slug: string;
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
  tickSize: string;
  negRisk: boolean;
  upPrice: number;
  downPrice: number;
} | null> {
  try {
    log.info("[BTC-Bot] Searching for active BTC 5-min market...");

    const resp = await axios.get("https://gamma-api.polymarket.com/markets", {
      params: {
        active: true,
        closed: false,
        limit: 50,
        order: "volume24hr",
        ascending: false,
      },
      timeout: 5000,
    });

    const markets = resp.data as any[];
    log.info(`[BTC-Bot] Fetched ${markets.length} markets, filtering for BTC 5-min...`);

    // Find BTC Up/Down markets (not already resolved)
    // Search for BTC Up/Down markets — daily, 6h, or 5-min windows
    const btcMarkets = markets.filter((m: any) => {
      const q = (m.question || "").toLowerCase();
      const prices = JSON.parse(m.outcomePrices || "[0,0]").map(Number);
      const isBtcUpDown =
        q.includes("bitcoin") &&
        (q.includes("up or down") || q.includes("up/down"));
      const notResolved = prices[0] > 0.05 && prices[0] < 0.95;
      return isBtcUpDown && !m.closed && m.active && notResolved;
    });

    log.info(`[BTC-Bot] Found ${btcMarkets.length} active BTC Up/Down markets`);

    if (btcMarkets.length === 0) {
      // Log what we found for debugging
      const btcAny = markets.filter((m: any) => {
        const q = (m.question || "").toLowerCase();
        return q.includes("bitcoin") && (q.includes("up") || q.includes("down"));
      });
      if (btcAny.length > 0) {
        for (const m of btcAny.slice(0, 3)) {
          const prices = JSON.parse(m.outcomePrices || "[0,0]").map(Number);
          log.info(
            `[BTC-Bot]   Found but filtered: "${m.question}" — prices: ${prices[0].toFixed(3)}/${prices[1].toFixed(3)} active:${m.active} closed:${m.closed}`
          );
        }
      } else {
        log.info("[BTC-Bot]   No BTC markets found at all in top 50 by volume");
      }
      return null;
    }

    // Pick the one that's closest to 50/50 (most active/tradeable)
    const btcMarket = btcMarkets[0];
    const outcomes = JSON.parse(btcMarket.outcomes || '["Up","Down"]');
    const tokenIds = JSON.parse(btcMarket.clobTokenIds || '["",""]');
    const prices = JSON.parse(btcMarket.outcomePrices || "[0.5,0.5]").map(Number);

    let upIdx = 0;
    let downIdx = 1;
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i].toLowerCase();
      if (o === "up" || o.includes("up")) upIdx = i;
      if (o === "down" || o.includes("down")) downIdx = i;
    }

    log.info(
      `[BTC-Bot] Market: "${btcMarket.question}" | Up: $${prices[upIdx].toFixed(3)} | Down: $${prices[downIdx].toFixed(3)} | Vol24h: $${(btcMarket.volume24hr || 0).toFixed(0)} | Liq: $${parseFloat(btcMarket.liquidity || "0").toFixed(0)}`
    );

    lastMarketSlug = btcMarket.slug;

    return {
      slug: btcMarket.slug,
      upTokenId: tokenIds[upIdx],
      downTokenId: tokenIds[downIdx],
      conditionId: btcMarket.conditionId,
      tickSize: btcMarket.orderPriceMinTickSize?.toString() || "0.01",
      negRisk: btcMarket.negRisk || false,
      upPrice: prices[upIdx],
      downPrice: prices[downIdx],
    };
  } catch (err: any) {
    log.error(`[BTC-Bot] Market search failed: ${err.message?.substring(0, 100)}`);
    return null;
  }
}

// --- Place Maker Order ---
async function placeMakerOrder(
  tokenId: string,
  direction: string,
  price: number,
  size: number,
  tickSize: string,
  negRisk: boolean,
  marketPrice: number
): Promise<boolean> {
  try {
    const client = await getClient();
    const shares = Math.floor(size / price);

    if (shares < 5) {
      log.warn(
        `[BTC-Bot] Trade too small: ${shares} shares (need 5+). Increase BTC_BOT_BET_SIZE in .env`
      );
      return false;
    }

    const cost = shares * price;

    log.trade(`[BTC-Bot] ──────────────────────────────────`);
    log.trade(`[BTC-Bot] PLACING ORDER`);
    log.trade(`[BTC-Bot]   Direction: ${direction}`);
    log.trade(`[BTC-Bot]   Shares: ${shares} @ $${price.toFixed(3)}`);
    log.trade(`[BTC-Bot]   Cost: $${cost.toFixed(2)}`);
    log.trade(`[BTC-Bot]   Market price: $${marketPrice.toFixed(3)}`);
    log.trade(`[BTC-Bot]   Post-only: YES (zero fees)`);
    log.trade(`[BTC-Bot]   If win: $${shares.toFixed(2)} payout → $${(shares - cost).toFixed(2)} profit`);
    log.trade(`[BTC-Bot] ──────────────────────────────────`);

    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side: Side.BUY,
        size: shares,
      },
      {
        tickSize: tickSize as "0.01" | "0.001" | "0.0001" | "0.1",
        negRisk,
      },
      OrderType.GTC,
      false, // deferExec
      true   // postOnly — guarantees maker (zero fees!)
    );

    const r = result as any;
    if (r.success) {
      log.success(`[BTC-Bot] ORDER PLACED: ${r.status} (ID: ${r.orderID})`);
      if (r.transactionsHashes) {
        log.success(`[BTC-Bot] TX: ${r.transactionsHashes[0]}`);
      }
      return true;
    } else {
      log.error(`[BTC-Bot] ORDER FAILED: ${r.error || JSON.stringify(result)}`);
      return false;
    }
  } catch (err: any) {
    log.error(`[BTC-Bot] Order error: ${err.message?.substring(0, 150)}`);
    return false;
  }
}

// --- Main Loop ---
async function main(): Promise<void> {
  console.log("\n");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     BTC 5-MIN DIRECTIONAL TRADING BOT   ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  log.info(`Config:`);
  log.info(`  Bet size:       $${BET_SIZE}`);
  log.info(`  Min BTC move:   $${MIN_PRICE_DIFF}`);
  log.info(`  Snipe window:   ${SNIPE_WINDOW_SECONDS}s before close`);
  log.info(`  Maker price:    $${MAKER_PRICE}`);
  log.info(`  Window size:    ${WINDOW_SECONDS}s (5 min)`);
  console.log("");

  // Connect to Binance
  connectBinance();
  log.info("[BTC-Bot] Waiting for first BTC price...");
  await new Promise((r) => setTimeout(r, 3000));

  if (btcPrice <= 0) {
    log.error("[BTC-Bot] No BTC price received. Check internet connection.");
    process.exit(1);
  }

  log.success(`[BTC-Bot] BTC price: $${btcPrice.toLocaleString()}`);
  log.info("[BTC-Bot] Bot is now running. Monitoring 5-min windows...\n");

  // Main loop — runs every second
  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const windowTs = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
    const windowEnd = windowTs + WINDOW_SECONDS;
    const secondsLeft = windowEnd - now;

    // Check if Binance feed is alive
    if (Date.now() - btcPriceUpdatedAt > 10000) {
      log.warn("[BTC-Bot] BTC price stale (>10s since last update)");
    }

    // New window started?
    if (windowTs !== currentWindowTs) {
      currentWindowTs = windowTs;
      windowOpenPrice = btcPrice;
      highPrice = btcPrice;
      lowPrice = btcPrice;
      tradedThisWindow = false;
      windowCount++;

      const windowTime = new Date(windowTs * 1000)
        .toISOString()
        .substring(11, 19);

      console.log(""); // blank line for readability
      log.info(`╔═══════════════════════════════════════════════╗`);
      log.info(`║  Window #${windowCount}: ${windowTime} UTC`);
      log.info(`║  BTC Open: $${windowOpenPrice.toLocaleString()}`);
      log.info(`╚═══════════════════════════════════════════════╝`);
    }

    // Track high/low within window
    if (btcPrice > highPrice) highPrice = btcPrice;
    if (btcPrice < lowPrice) lowPrice = btcPrice;

    // Countdown logs — every 60 seconds show time remaining
    if (
      secondsLeft > SNIPE_WINDOW_SECONDS &&
      secondsLeft % 60 === 0 &&
      secondsLeft < WINDOW_SECONDS
    ) {
      const diff = btcPrice - windowOpenPrice;
      const direction = diff > 0 ? "UP" : diff < 0 ? "DOWN" : "FLAT";
      const color =
        diff > 0 ? "\x1b[32m" : diff < 0 ? "\x1b[31m" : "\x1b[33m";
      const reset = "\x1b[0m";
      const range = highPrice - lowPrice;
      log.info(
        `[BTC-Bot] ${Math.floor(secondsLeft / 60)}m left | BTC: $${btcPrice.toLocaleString()} | ${color}${direction} $${Math.abs(diff).toFixed(2)}${reset} | Range: $${range.toFixed(2)}`
      );
    }

    // 30 second warning
    if (secondsLeft === 30 && !tradedThisWindow) {
      const diff = btcPrice - windowOpenPrice;
      const absDiff = Math.abs(diff);
      const willTrade = absDiff >= MIN_PRICE_DIFF;
      log.info(
        `[BTC-Bot] ⏱ 30s left | Move: $${absDiff.toFixed(2)} ${diff > 0 ? "UP" : "DOWN"} | Need $${MIN_PRICE_DIFF}+ | ${willTrade ? "LIKELY TRADE" : "Probably skip"}`
      );
    }

    // In the snipe window (last N seconds)?
    if (
      secondsLeft <= SNIPE_WINDOW_SECONDS &&
      secondsLeft > 3 &&
      !tradedThisWindow
    ) {
      const diff = btcPrice - windowOpenPrice;
      const absDiff = Math.abs(diff);

      // Log every 3 seconds in snipe window
      if (secondsLeft % 3 === 0) {
        const direction = diff > 0 ? "UP" : diff < 0 ? "DOWN" : "FLAT";
        const color =
          diff > 0 ? "\x1b[32m" : diff < 0 ? "\x1b[31m" : "\x1b[33m";
        const reset = "\x1b[0m";
        const signal = absDiff >= MIN_PRICE_DIFF ? " ← TRADEABLE!" : "";
        log.info(
          `[BTC-Bot] T-${secondsLeft}s | BTC: $${btcPrice.toLocaleString()} | ${color}${direction} $${absDiff.toFixed(2)}${reset} from open${signal}`
        );
      }

      // Enough movement to trade? Only try ONCE per window.
      if (absDiff >= MIN_PRICE_DIFF && secondsLeft === SNIPE_WINDOW_SECONDS) {
        const direction = diff > 0 ? "Up" : "Down";

        log.opportunity(
          `[BTC-Bot] ══════════════════════════════════════`
        );
        log.opportunity(
          `[BTC-Bot] SIGNAL DETECTED at T-${secondsLeft}s`
        );
        log.opportunity(
          `[BTC-Bot]   BTC: $${btcPrice.toLocaleString()} → ${direction} $${absDiff.toFixed(2)} from open $${windowOpenPrice.toLocaleString()}`
        );
        log.opportunity(
          `[BTC-Bot]   Confidence: ${absDiff >= MIN_PRICE_DIFF * 2 ? "HIGH" : "MEDIUM"} (${absDiff.toFixed(0)} > ${MIN_PRICE_DIFF} threshold)`
        );
        log.opportunity(
          `[BTC-Bot] ══════════════════════════════════════`
        );

        // Find the market
        const market = await findCurrentMarket();
        if (!market) {
          log.warn(
            "[BTC-Bot] No active BTC 5-min market found on Polymarket"
          );
          log.warn(
            "[BTC-Bot] Markets may not be available right now. They typically run during US trading hours."
          );
        } else {
          const tokenId =
            direction === "Up" ? market.upTokenId : market.downTokenId;
          const marketPrice =
            direction === "Up" ? market.upPrice : market.downPrice;

          log.info(
            `[BTC-Bot] Market "${market.slug}" | ${direction} token: ${tokenId.substring(0, 20)}...`
          );

          const success = await placeMakerOrder(
            tokenId,
            direction,
            MAKER_PRICE,
            BET_SIZE,
            market.tickSize,
            market.negRisk,
            marketPrice
          );

          if (success) {
            tradedThisWindow = true;
            totalTrades++;
            log.success(
              `[BTC-Bot] ✓ Trade #${totalTrades} complete | Total: ${totalTrades} trades, ${totalSkips} skips`
            );
          }
        }
      }
    }

    // Window just ended — log summary
    if (secondsLeft <= 1) {
      if (!tradedThisWindow && windowOpenPrice > 0) {
        const diff = btcPrice - windowOpenPrice;
        const absDiff = Math.abs(diff);
        totalSkips++;
        log.info(
          `[BTC-Bot] Window ended — SKIPPED (BTC moved $${absDiff.toFixed(2)}, needed $${MIN_PRICE_DIFF}+) | Total skips: ${totalSkips}`
        );
      } else if (tradedThisWindow) {
        const diff = btcPrice - windowOpenPrice;
        log.info(
          `[BTC-Bot] Window ended — TRADED | BTC close: $${btcPrice.toLocaleString()} (${diff > 0 ? "+" : ""}$${diff.toFixed(2)} from open)`
        );
      }
    }

    // Sleep 1 second
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("");
  log.warn("[BTC-Bot] Shutting down...");
  log.info("[BTC-Bot] ──────────────────────────────────");
  log.info(`[BTC-Bot] Session summary:`);
  log.info(`[BTC-Bot]   Windows watched: ${windowCount}`);
  log.info(`[BTC-Bot]   Trades placed:   ${totalTrades}`);
  log.info(`[BTC-Bot]   Windows skipped: ${totalSkips}`);
  log.info(`[BTC-Bot]   Win rate:        ${totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : "N/A"}%`);
  log.info(`[BTC-Bot]   P&L:             $${totalPnL.toFixed(2)}`);
  log.info("[BTC-Bot] ──────────────────────────────────");
  process.exit(0);
});

main().catch((err) => {
  log.error(`[BTC-Bot] Fatal: ${err}`);
  process.exit(1);
});
