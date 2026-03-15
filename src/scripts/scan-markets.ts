import { fetchActiveMarkets, fetchActiveEvents } from "../markets/scanner";
import { findMispricings, findArbitrageInEvents } from "../markets/analyzer";

// ---------------------------------------------------------------------------
// Quick script to scan markets without trading.
// Shows you what's available and where the opportunities are.
//
// Usage: npm run scan
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== POLYMARKET MARKET SCANNER ===\n");

  // Fetch markets
  console.log("Fetching active markets...\n");
  const markets = await fetchActiveMarkets(50);

  console.log("--- Top 20 Markets by 24h Volume ---\n");
  for (const m of markets.slice(0, 20)) {
    const prices = m.outcomePrices
      .map((p, i) => `${m.outcomes[i]}: $${p.toFixed(3)}`)
      .join(" | ");
    console.log(`  "${m.question}"`);
    console.log(`    ${prices}`);
    console.log(
      `    Vol: $${m.volume24hr.toFixed(0)} | Liq: $${m.liquidity.toFixed(0)} | Spread: ${(m.spread * 100).toFixed(1)}%`
    );
    console.log("");
  }

  // Check for mispricings
  console.log("\n--- Mispricing Check (binary markets) ---\n");
  const mispricings = findMispricings(markets, 1);
  if (mispricings.length === 0) {
    console.log("  No mispricings found (all markets properly priced).");
  } else {
    for (const opp of mispricings) {
      console.log(`  ${opp.description}`);
      console.log(`    Edge: ${opp.edgePercent.toFixed(2)}%\n`);
    }
  }

  // Fetch events for arbitrage
  console.log("\n--- Arbitrage Check (multi-outcome events) ---\n");
  const events = await fetchActiveEvents(50);
  const negRiskEvents = events.filter((e) => e.negRisk);
  console.log(`  Found ${negRiskEvents.length} multi-outcome events.\n`);

  const arbOpps = findArbitrageInEvents(negRiskEvents, 0.5);
  if (arbOpps.length === 0) {
    console.log("  No arbitrage opportunities found.");
  } else {
    for (const opp of arbOpps) {
      console.log(`  ${opp.description}`);
      console.log(`    Edge: ${opp.edgePercent.toFixed(2)}%\n`);
    }
  }

  // Summary of market categories
  console.log("\n--- Event Categories ---\n");
  const tagCounts = new Map<string, number>();
  for (const event of events) {
    for (const tag of event.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tag, count] of sorted.slice(0, 15)) {
    console.log(`  ${tag}: ${count} events`);
  }

  console.log("\nDone.\n");
}

main().catch(console.error);
