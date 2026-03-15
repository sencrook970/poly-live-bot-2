import { Market, Event } from "./scanner";
import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// Market Analyzer — looks at markets and detects opportunities.
//
// Three types of opportunities:
// 1. ARBITRAGE  — multi-outcome event where YES prices sum < $1 (risk-free)
// 2. MISPRICING — binary market where YES + NO < $1 (near risk-free)
// 3. AI_EDGE    — AI thinks market price is wrong by >X% (directional bet)
//
// IMPORTANT: We only BUY, never SELL short. On Polymarket you can't sell
// shares you don't own. So we only look for underpriced opportunities.
// ---------------------------------------------------------------------------

export type OpportunityType = "ARBITRAGE" | "MISPRICING" | "AI_EDGE";

export interface Opportunity {
  type: OpportunityType;
  market: Market;
  event?: Event;
  edgePercent: number; // How much edge we have (higher = better)
  expectedProfit: number; // Estimated profit in USDC for a $1 bet
  confidence: number; // 0-1, how confident we are
  description: string; // Human-readable explanation
  action: {
    side: "BUY" | "SELL";
    tokenId: string;
    price: number;
    outcome: string;
  };
}

// ---------------------------------------------------------------------------
// STRATEGY 1: Binary Mispricing
// In a binary market, YES + NO should always equal $1.00.
// If YES + NO < $1.00, we buy both sides for guaranteed profit.
// ---------------------------------------------------------------------------
export function findMispricings(markets: Market[], minEdge = 2): Opportunity[] {
  const opportunities: Opportunity[] = [];

  for (const market of markets) {
    if (market.negRisk || market.outcomes.length !== 2) continue;
    if (market.outcomePrices.length !== 2) continue;

    const [yesPrice, noPrice] = market.outcomePrices;
    const sum = yesPrice + noPrice;

    // If sum < 1.0, we can buy both YES and NO for less than $1.
    // When the market resolves, one of them pays $1 → guaranteed profit.
    if (sum < 1.0) {
      const edge = ((1.0 - sum) / sum) * 100;
      if (edge >= minEdge) {
        opportunities.push({
          type: "MISPRICING",
          market,
          edgePercent: edge,
          expectedProfit: 1.0 - sum,
          confidence: 0.95,
          description: `YES ($${yesPrice.toFixed(3)}) + NO ($${noPrice.toFixed(3)}) = $${sum.toFixed(3)} < $1.00. Buy both → guaranteed $${(1 - sum).toFixed(3)} profit per share.`,
          action: {
            side: "BUY",
            tokenId: market.clobTokenIds[0], // Buy YES (we'll also buy NO)
            price: yesPrice,
            outcome: "Yes",
          },
        });
      }
    }

    // NOTE: We skip "sum > $1.00" because that requires selling shares
    // you already own. We can't short sell on Polymarket.
  }

  if (opportunities.length > 0) {
    log.opportunity(`Found ${opportunities.length} mispricing opportunities`);
  }

  return opportunities;
}

// ---------------------------------------------------------------------------
// STRATEGY 2: Multi-Outcome Arbitrage
// In a negative-risk event (e.g., "Who wins the election?"), there are
// multiple markets — each with YES/NO. Only ONE outcome can win.
//
// If the sum of all YES prices < $1.00, buying all YES shares is free money.
// One outcome WILL win and pay $1.00. You spent less than $1.00.
//
// We SKIP "sum > $1.00" because that requires selling/shorting which
// needs existing inventory we don't have.
// ---------------------------------------------------------------------------
export function findArbitrageInEvents(
  events: Event[],
  minEdge = 1
): Opportunity[] {
  const opportunities: Opportunity[] = [];

  for (const event of events) {
    if (!event.negRisk) continue;
    if (event.markets.length < 2) continue;

    // Sum up the YES prices across all outcomes
    let totalYesPrice = 0;
    const validMarkets: Market[] = [];

    for (const market of event.markets) {
      if (market.outcomePrices.length >= 1 && market.outcomePrices[0] > 0) {
        totalYesPrice += market.outcomePrices[0];
        validMarkets.push(market);
      }
    }

    if (validMarkets.length < 2) continue;

    // Only act when total YES < $1.00 (we can BUY all for guaranteed profit)
    if (totalYesPrice < 1.0) {
      const edge = ((1.0 - totalYesPrice) / totalYesPrice) * 100;
      if (edge >= minEdge) {
        // Buy the cheapest outcome — best value entry point
        const cheapest = validMarkets.reduce((a, b) =>
          a.outcomePrices[0] < b.outcomePrices[0] ? a : b
        );

        opportunities.push({
          type: "ARBITRAGE",
          market: cheapest,
          event,
          edgePercent: edge,
          expectedProfit: 1.0 - totalYesPrice,
          confidence: 0.98,
          description: `Event "${event.title}": ${validMarkets.length} outcomes sum to $${totalYesPrice.toFixed(3)} < $1.00. Buy all YES → guaranteed $${(1 - totalYesPrice).toFixed(3)} profit.`,
          action: {
            side: "BUY",
            tokenId: cheapest.clobTokenIds[0],
            price: cheapest.outcomePrices[0],
            outcome: cheapest.outcomes[0] || "Yes",
          },
        });
      }
    }

    // Log overpriced events for awareness but DON'T create a trade
    if (totalYesPrice > 1.05) {
      log.info(
        `[Info] Event "${event.title}": ${validMarkets.length} outcomes sum to $${totalYesPrice.toFixed(3)} > $1.00 (overpriced, but we can't short)`
      );
    }
  }

  if (opportunities.length > 0) {
    log.opportunity(`Found ${opportunities.length} arbitrage opportunities`);
  }

  return opportunities;
}

// Sort opportunities by edge (best first)
export function rankOpportunities(opps: Opportunity[]): Opportunity[] {
  return opps.sort((a, b) => {
    // Arbitrage first (safest), then mispricing, then AI
    const typeOrder = { ARBITRAGE: 0, MISPRICING: 1, AI_EDGE: 2 };
    const typeDiff = typeOrder[a.type] - typeOrder[b.type];
    if (typeDiff !== 0) return typeDiff;

    // Within same type, higher edge first
    return b.edgePercent - a.edgePercent;
  });
}
