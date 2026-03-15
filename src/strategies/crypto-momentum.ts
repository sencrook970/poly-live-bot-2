import axios from "axios";
import { Strategy } from "./types";
import { Opportunity } from "../markets/analyzer";
import { fetchActiveMarkets, Market } from "../markets/scanner";
import { config } from "../config";
import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// CRYPTO MOMENTUM STRATEGY v2
//
// FIXED: The old version was buying DOWN when BTC was UP because it
// compared momentum to the market price incorrectly. The market price
// for "BTC Up or Down" reflects where BTC is NOW vs where it OPENED,
// not general momentum. If the market says 91% UP, BTC is probably up
// for the day — don't bet against it.
//
// New logic:
// - For Up/Down markets: DON'T trade. These are already priced correctly
//   based on the current BTC price. No edge from momentum.
// - For price target markets: Use real price vs target to find mispricing.
// ---------------------------------------------------------------------------

interface CryptoPrice {
  symbol: string;
  price: number;
  change1h: number;
  change24h: number;
  change7d: number;
}

async function getCryptoPrices(): Promise<CryptoPrice[]> {
  try {
    const resp = await axios.get(
      "https://api.coingecko.com/api/v3/coins/markets",
      {
        params: {
          vs_currency: "usd",
          ids: "bitcoin,ethereum,solana",
          price_change_percentage: "1h,24h,7d",
        },
      }
    );

    return (resp.data as Record<string, unknown>[]).map(
      (coin: Record<string, unknown>) => ({
        symbol: (coin.symbol as string).toUpperCase(),
        price: coin.current_price as number,
        change1h: (coin.price_change_percentage_1h_in_currency as number) || 0,
        change24h: (coin.price_change_percentage_24h_in_currency as number) || 0,
        change7d: (coin.price_change_percentage_7d_in_currency as number) || 0,
      })
    );
  } catch (err) {
    log.error(`[Crypto] Failed to fetch prices: ${err}`);
    return [];
  }
}

function isCryptoMarket(question: string): {
  isCrypto: boolean;
  asset: string;
  type: string;
} {
  const q = question.toLowerCase();

  // "Will Bitcoin reach $X by..."
  if (q.includes("bitcoin") && q.includes("reach")) {
    return { isCrypto: true, asset: "BTC", type: "price_target" };
  }
  if (q.includes("ethereum") && q.includes("reach")) {
    return { isCrypto: true, asset: "ETH", type: "price_target" };
  }
  // "Will the price of Bitcoin be above $X..."
  if (q.includes("bitcoin") && (q.includes("above") || q.includes("below"))) {
    return { isCrypto: true, asset: "BTC", type: "price_level" };
  }
  if (q.includes("ethereum") && (q.includes("above") || q.includes("below"))) {
    return { isCrypto: true, asset: "ETH", type: "price_level" };
  }
  // "Bitcoin Up or Down" — SKIP these, no edge from momentum
  if (q.includes("up or down") || q.includes("up/down")) {
    return { isCrypto: false, asset: "", type: "" }; // deliberately skip
  }

  return { isCrypto: false, asset: "", type: "" };
}

function extractPriceTarget(question: string): number | null {
  const match = question.match(/\$([0-9,]+)/);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ""));
}

export class CryptoMomentumStrategy implements Strategy {
  name = "Crypto Momentum";
  description = "Uses real-time BTC/ETH prices to trade crypto price target markets";

  async findOpportunities(): Promise<Opportunity[]> {
    log.info("[Crypto] Fetching live crypto prices...");

    const prices = await getCryptoPrices();
    if (prices.length === 0) return [];

    for (const p of prices) {
      log.info(
        `[Crypto] ${p.symbol}: $${p.price.toLocaleString()} | 1h: ${p.change1h > 0 ? "+" : ""}${p.change1h.toFixed(2)}% | 24h: ${p.change24h > 0 ? "+" : ""}${p.change24h.toFixed(2)}%`
      );
    }

    log.info("[Crypto] Scanning for crypto markets on Polymarket...");

    const markets = await fetchActiveMarkets(200);
    const cryptoMarkets: { market: Market; asset: string; type: string }[] = [];

    for (const market of markets) {
      const check = isCryptoMarket(market.question);
      if (check.isCrypto && market.active && !market.closed) {
        cryptoMarkets.push({ market, asset: check.asset, type: check.type });
      }
    }

    log.info(`[Crypto] Found ${cryptoMarkets.length} crypto price target markets`);

    const opportunities: Opportunity[] = [];

    for (const { market, asset, type } of cryptoMarkets) {
      const priceData = prices.find((p) => p.symbol === asset);
      if (!priceData) continue;

      const opp = this.analyzePriceTarget(market, priceData);
      if (opp) {
        opportunities.push(opp);
        log.opportunity(`[Crypto] EDGE: "${market.question.substring(0, 50)}..." — ${opp.description}`);
      } else {
        log.info(`[Crypto]   No edge: "${market.question.substring(0, 50)}..." — market price looks fair`);
      }
    }

    log.info(`[Crypto] Results: ${opportunities.length} opportunities from ${cryptoMarkets.length} crypto markets`);
    return opportunities;
  }

  private analyzePriceTarget(market: Market, price: CryptoPrice): Opportunity | null {
    const yesPrice = market.outcomePrices[0];
    if (!yesPrice || yesPrice <= 0.03 || yesPrice >= 0.97) return null;

    const target = extractPriceTarget(market.question);
    if (!target) return null;

    const distancePercent = ((target - price.price) / price.price) * 100;

    let daysLeft = 30;
    if (market.endDate) {
      const endTime = new Date(market.endDate).getTime();
      daysLeft = Math.max(0, (endTime - Date.now()) / (1000 * 60 * 60 * 24));
    }

    let estimatedYesProb: number | null = null;

    if (distancePercent > 50 && daysLeft < 30) {
      estimatedYesProb = 0.01;
    } else if (distancePercent > 30 && daysLeft < 30) {
      estimatedYesProb = 0.03;
    } else if (distancePercent > 20 && daysLeft < 14) {
      estimatedYesProb = 0.05;
    } else if (distancePercent > 10 && daysLeft < 7) {
      estimatedYesProb = 0.08;
    } else if (distancePercent < -10) {
      estimatedYesProb = 0.95; // already above target
    } else if (Math.abs(distancePercent) < 5) {
      estimatedYesProb = 0.50;
    } else {
      return null;
    }

    const edge = Math.abs(estimatedYesProb - yesPrice);
    const edgePercent = edge * 100;

    if (edgePercent < config.minEdgePercent) return null;

    const buyYes = estimatedYesProb > yesPrice;
    const confidence = edgePercent > 20 ? 0.85 : edgePercent > 10 ? 0.70 : 0.55;

    return {
      type: "AI_EDGE",
      market,
      edgePercent,
      expectedProfit: edge,
      confidence,
      description: `${price.symbol} @ $${price.price.toLocaleString()} vs target $${target.toLocaleString()} (${distancePercent > 0 ? "+" : ""}${distancePercent.toFixed(1)}% away, ${daysLeft.toFixed(0)}d left). Est: ${(estimatedYesProb * 100).toFixed(0)}% vs market ${(yesPrice * 100).toFixed(0)}%.`,
      action: {
        side: "BUY",
        tokenId: buyYes ? market.clobTokenIds[0] : market.clobTokenIds[1],
        price: buyYes ? yesPrice : market.outcomePrices[1],
        outcome: buyYes ? market.outcomes[0] : market.outcomes[1],
      },
    };
  }
}
