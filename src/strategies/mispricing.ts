import { Strategy } from "./types";
import { Opportunity, findMispricings } from "../markets/analyzer";
import { getTradeableMarkets } from "../markets/scanner";
import { config } from "../config";
import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// MISPRICING STRATEGY
//
// How it works:
// In a binary market (Yes/No), the prices should always add up to $1.00.
//   YES = $0.60 + NO = $0.40 = $1.00 ← correct
//
// Sometimes they don't, especially in low-liquidity markets:
//   YES = $0.55 + NO = $0.42 = $0.97 ← mispriced!
//
// If total < $1.00: Buy BOTH Yes and No shares.
//   You spend $0.97, and when the market resolves, one side pays $1.00.
//   Guaranteed $0.03 profit per share.
// ---------------------------------------------------------------------------

export class MispricingStrategy implements Strategy {
  name = "Mispricing";
  description =
    "Finds binary markets where YES + NO prices don't add up to $1.00";

  async findOpportunities(): Promise<Opportunity[]> {
    log.info("[Mispricing] Scanning binary markets...");

    const markets = await getTradeableMarkets(500, 100);
    const binaryMarkets = markets.filter(
      (m) => !m.negRisk && m.outcomes.length === 2
    );

    log.info(
      `[Mispricing] Analyzing ${binaryMarkets.length} binary markets...`
    );

    // Log a few sample markets with their YES+NO sums
    for (const m of binaryMarkets.slice(0, 3)) {
      const sum = m.outcomePrices[0] + m.outcomePrices[1];
      log.info(
        `[Mispricing]   "${m.question.substring(0, 50)}..." — YES: $${m.outcomePrices[0].toFixed(3)} + NO: $${m.outcomePrices[1].toFixed(3)} = $${sum.toFixed(3)}`
      );
    }

    const opportunities = findMispricings(binaryMarkets, config.minEdgePercent);

    if (opportunities.length === 0) {
      log.info(
        "[Mispricing] No mispricings found (all markets properly priced)"
      );
    } else {
      for (const opp of opportunities) {
        log.opportunity(
          `[Mispricing] ${opp.market.question}: ${opp.description} (edge: ${opp.edgePercent.toFixed(2)}%)`
        );
      }
    }

    return opportunities;
  }
}
