import { Strategy } from "./types";
import { Opportunity, findArbitrageInEvents } from "../markets/analyzer";
import { fetchActiveEvents } from "../markets/scanner";
import { config } from "../config";
import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// ARBITRAGE STRATEGY
//
// How it works:
// In multi-outcome events (like "Who wins the election?"), each outcome has
// a YES price. All YES prices should add up to $1.00 because exactly one
// outcome will win.
//
// If they add up to LESS than $1.00, you buy YES on ALL outcomes.
// One of them WILL win and pay $1.00. You spent less than $1.00 total.
// That's guaranteed profit.
//
// We ONLY buy when sum < $1.00. We NEVER try to short/sell overpriced
// markets because that requires owning shares first.
// ---------------------------------------------------------------------------

export class ArbitrageStrategy implements Strategy {
  name = "Arbitrage";
  description =
    "Finds multi-outcome events where buying all YES shares costs less than $1.00";

  async findOpportunities(): Promise<Opportunity[]> {
    log.info("[Arbitrage] Scanning multi-outcome events...");

    const events = await fetchActiveEvents(100);
    const negRiskEvents = events.filter((e) => e.negRisk);

    log.info(
      `[Arbitrage] Found ${negRiskEvents.length} multi-outcome events to analyze`
    );

    // Log a few sample events so we can see what's being scanned
    for (const event of negRiskEvents.slice(0, 3)) {
      const yesSum = event.markets.reduce(
        (sum, m) => sum + (m.outcomePrices[0] || 0),
        0
      );
      log.info(
        `[Arbitrage]   "${event.title}" — ${event.markets.length} outcomes, YES sum: $${yesSum.toFixed(3)}`
      );
    }

    const opportunities = findArbitrageInEvents(
      negRiskEvents,
      config.minEdgePercent
    );

    if (opportunities.length === 0) {
      log.info("[Arbitrage] No underpriced events found (all sums >= $1.00)");
    } else {
      for (const opp of opportunities) {
        log.opportunity(
          `[Arbitrage] ${opp.description} (edge: ${opp.edgePercent.toFixed(2)}%)`
        );
      }
    }

    return opportunities;
  }
}
