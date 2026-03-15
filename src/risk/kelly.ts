// ---------------------------------------------------------------------------
// Kelly Criterion — Position Sizing
//
// The Kelly Criterion tells you what fraction of your bankroll to bet
// given your edge and the odds. It maximizes long-term growth.
//
// But FULL Kelly is too aggressive — one bad streak wipes you out.
// So we use QUARTER Kelly (divide by 4). This is what top traders use.
//
// Formula for prediction markets:
//   Full Kelly = (trueProb - marketPrice) / (1 - marketPrice)
//   Quarter Kelly = Full Kelly / 4
//
// Example:
//   You think an event has 60% chance. Market price is 40%.
//   Full Kelly = (0.60 - 0.40) / (1 - 0.40) = 0.333 (33.3% of bankroll)
//   Quarter Kelly = 0.333 / 4 = 0.083 (8.3% of bankroll)
//   If bankroll = $1000, bet $83.
// ---------------------------------------------------------------------------

export interface KellyResult {
  fullKelly: number;      // Full Kelly fraction (0-1)
  quarterKelly: number;   // Quarter Kelly fraction (0-1, what we actually use)
  suggestedSize: number;  // Dollar amount to bet
  reasoning: string;      // Human explanation
}

export function calculateKelly(
  trueProb: number,       // Your estimated probability (0-1)
  marketPrice: number,    // Current market price (0-1)
  bankroll: number,       // Total available USDC
  maxBetSize: number,     // Maximum single bet in USDC
  confidence: number = 1  // How confident in your estimate (0-1)
): KellyResult {
  // No edge? Don't bet.
  const edge = trueProb - marketPrice;
  if (edge <= 0) {
    return {
      fullKelly: 0,
      quarterKelly: 0,
      suggestedSize: 0,
      reasoning: "No positive edge — skip this trade.",
    };
  }

  // Kelly formula for binary outcomes
  const fullKelly = edge / (1 - marketPrice);

  // Scale by confidence and use quarter-Kelly
  const adjustedKelly = fullKelly * confidence;
  const quarterKelly = adjustedKelly / 4;

  // Calculate dollar amount, capped by max bet size
  let suggestedSize = Math.min(quarterKelly * bankroll, maxBetSize);
  suggestedSize = Math.max(0, Math.round(suggestedSize * 100) / 100);

  return {
    fullKelly: Math.round(fullKelly * 10000) / 10000,
    quarterKelly: Math.round(quarterKelly * 10000) / 10000,
    suggestedSize,
    reasoning:
      `Edge: ${(edge * 100).toFixed(1)}%. ` +
      `Full Kelly: ${(fullKelly * 100).toFixed(1)}%. ` +
      `Quarter Kelly: ${(quarterKelly * 100).toFixed(1)}%. ` +
      `Bet: $${suggestedSize.toFixed(2)} of $${bankroll.toFixed(2)} bankroll.`,
  };
}

// For arbitrage/mispricing (near-certain outcomes), size more aggressively
export function calculateArbSize(
  expectedProfit: number,  // Expected profit per $1 spent
  bankroll: number,
  maxBetSize: number
): number {
  // For arb, we can be more aggressive since it's near risk-free
  // Use 50% of bankroll, capped by max bet size
  const size = Math.min(bankroll * 0.5, maxBetSize);

  // But only if the expected profit justifies the effort
  // (fees might eat tiny arbs)
  if (expectedProfit < 0.005) return 0; // Less than 0.5% profit? Not worth it.

  return Math.round(size * 100) / 100;
}
