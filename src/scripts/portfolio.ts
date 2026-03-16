import axios from "axios";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Portfolio Check — run anytime to see your total value.
//
// Usage: npx tsx src/scripts/portfolio.ts
// ---------------------------------------------------------------------------

const WALLET = "0xBBF2DFc8ACC5021292dD039abC80E8429C9A3B5F";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const TOTAL_DEPOSITED = 121.98; // ~$22 + $20 + $20 + $20

async function main() {
  // 1. Get USDC.e balance
  const pub = createPublicClient({
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });
  const bal = await pub.readContract({
    address: USDC_E,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [WALLET],
  });
  const usdcBalance = Number(bal) / 1e6;

  // 2. Get positions from Polymarket
  let positions: any[] = [];
  try {
    const resp = await axios.get(
      "https://data-api.polymarket.com/positions",
      { params: { user: WALLET }, timeout: 10000 }
    );
    positions = resp.data.filter((p: any) => p.size > 0 && p.curPrice > 0.005);
  } catch {
    // Fallback to state.json
    const fs = require("fs");
    const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
    positions = Object.values(state.positions)
      .filter((p: any) => p.totalShares > 0)
      .map((p: any) => ({
        title: p.marketQuestion,
        outcome: p.outcome,
        size: p.totalShares,
        avgPrice: p.avgPrice,
        curPrice: p.currentPrice,
        currentValue: p.currentPrice * p.totalShares,
        initialValue: p.totalCost,
        cashPnl: (p.currentPrice - p.avgPrice) * p.totalShares,
      }));
    console.log("(Data API unreachable — using state.json)\n");
  }

  // 3. Calculate
  let positionValue = 0;
  let positionCost = 0;

  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║           PORTFOLIO SUMMARY              ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  if (positions.length > 0) {
    console.log("  POSITIONS:");
    console.log("  ─────────────────────────────────────────");
    for (const p of positions) {
      const value = p.currentValue || p.curPrice * p.size;
      const cost = p.initialValue || p.avgPrice * p.size;
      const pnl = p.cashPnl || value - cost;
      positionValue += value;
      positionCost += cost;

      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const pnlColor = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
      const reset = "\x1b[0m";

      console.log(
        `  ${p.outcome} "${(p.title || "").substring(0, 45)}"`
      );
      console.log(
        `    ${p.size} shares @ $${p.avgPrice?.toFixed(3)} → $${p.curPrice?.toFixed(3)}  ${pnlColor}${pnlStr}${reset}  value: $${value.toFixed(2)}`
      );
    }
    console.log("");
  }

  const totalAssets = usdcBalance + positionValue;
  const netPnL = totalAssets - TOTAL_DEPOSITED;
  const netColor = netPnL >= 0 ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";

  console.log("  SUMMARY:");
  console.log("  ─────────────────────────────────────────");
  console.log(`  USDC.e cash:        $${usdcBalance.toFixed(2)}`);
  console.log(`  Positions value:    $${positionValue.toFixed(2)}`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  TOTAL ASSETS:       $${totalAssets.toFixed(2)}`);
  console.log("");
  console.log(`  Total deposited:    $${TOTAL_DEPOSITED.toFixed(2)}`);
  console.log(`  ${netColor}NET P&L:              ${netPnL >= 0 ? "+" : ""}$${netPnL.toFixed(2)} (${((netPnL / TOTAL_DEPOSITED) * 100).toFixed(1)}%)${reset}`);
  console.log("");
}

main().catch((e) => console.error("Error:", e.message));
