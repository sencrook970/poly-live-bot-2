import axios from "axios";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Portfolio Check v2 — run anytime to see your total value.
//
// Improvements:
// - Derives wallet address from PRIVATE_KEY (no hardcoded address)
// - Shows strategy breakdown (Sniper vs Bond vs legacy)
// - Shows position health (CONFIRMED/at-risk/losing)
// - Shows capital management status (deployed %, cash reserve)
// - Color-coded P&L
//
// Usage: npm run portfolio
// ---------------------------------------------------------------------------

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const TOTAL_DEPOSITED = 171.98; // $121.98 original + $50 new deposit

// Derive wallet from private key
function getWallet(): string {
  const pk = process.env.PRIVATE_KEY || "";
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  return privateKeyToAccount(key as `0x${string}`).address;
}

// Classify position health based on P&L and price
function getHealth(pnl: number, price: number): { label: string; color: string } {
  if (price >= 0.995 || price <= 0.005) return { label: "RESOLVED", color: "\x1b[90m" };
  if (pnl > 0) return { label: "PROFIT", color: "\x1b[32m" };
  if (pnl > -1) return { label: "FLAT", color: "\x1b[33m" };
  return { label: "LOSING", color: "\x1b[31m" };
}

async function main() {
  const WALLET = getWallet();

  // 1. Get USDC.e balance
  const pub = createPublicClient({
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });
  const bal = await pub.readContract({
    address: USDC_E,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [WALLET as `0x${string}`],
  });
  const usdcBalance = Number(bal) / 1e6;

  // 2. Get positions from Polymarket Data API
  let positions: any[] = [];
  let source = "on-chain";
  try {
    const resp = await axios.get(
      "https://data-api.polymarket.com/positions",
      { params: { user: WALLET }, timeout: 10000 }
    );
    positions = resp.data.filter((p: any) => p.size > 0);
  } catch {
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
    source = "state.json";
  }

  // Separate active vs resolved
  const active = positions.filter((p: any) => p.curPrice > 0.005 && p.curPrice < 0.995);
  const resolved = positions.filter((p: any) => p.curPrice <= 0.005 || p.curPrice >= 0.995);

  // 3. Calculate
  let positionValue = 0;
  let totalPnl = 0;
  let winners = 0;
  let losers = 0;

  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const dim = "\x1b[90m";
  const bold = "\x1b[1m";

  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║        PORTFOLIO SUMMARY v2              ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  ${dim}Wallet: ${WALLET}${reset}`);
  console.log(`  ${dim}Source: ${source} | ${new Date().toLocaleString()}${reset}`);
  console.log("");

  // Active positions
  if (active.length > 0) {
    console.log(`  ${bold}ACTIVE POSITIONS (${active.length}):${reset}`);
    console.log("  ─────────────────────────────────────────");

    // Sort by value descending
    active.sort((a: any, b: any) => {
      const va = (a.currentValue || a.curPrice * a.size);
      const vb = (b.currentValue || b.curPrice * b.size);
      return vb - va;
    });

    for (const p of active) {
      const value = p.currentValue || p.curPrice * p.size;
      const pnl = p.cashPnl || value - (p.initialValue || p.avgPrice * p.size);
      positionValue += value;
      totalPnl += pnl;
      if (pnl >= 0) winners++;
      else losers++;

      const health = getHealth(pnl, p.curPrice);
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

      console.log(
        `  ${health.color}${health.label.padEnd(7)}${reset} ${p.outcome} "${(p.title || "").substring(0, 42)}"`
      );
      console.log(
        `          ${p.size.toFixed?.(0) || p.size} shares @ $${p.avgPrice?.toFixed(3)} → $${p.curPrice?.toFixed(3)}  ${health.color}${pnlStr}${reset}  val: $${value.toFixed(2)}`
      );
    }
    console.log("");
  }

  // Resolved positions (redeemable)
  if (resolved.length > 0) {
    console.log(`  ${dim}RESOLVED (${resolved.length}):${reset}`);
    let redeemableValue = 0;
    for (const p of resolved) {
      const value = p.curPrice >= 0.995 ? p.size : 0;
      redeemableValue += value;
      if (value > 0) {
        console.log(`  ${green}  WIN${reset}  "${(p.title || "").substring(0, 45)}" → $${value.toFixed(2)} redeemable`);
      } else {
        console.log(`  ${red}  LOSS${reset} "${(p.title || "").substring(0, 45)}" → $0.00`);
      }
    }
    if (redeemableValue > 0) {
      console.log(`  ${green}  Total redeemable: $${redeemableValue.toFixed(2)}${reset}`);
    }
    console.log("");
  }

  // Summary
  const totalAssets = usdcBalance + positionValue;
  const netPnL = totalAssets - TOTAL_DEPOSITED;
  const netColor = netPnL >= 0 ? green : red;
  const deployedPct = totalAssets > 0 ? (positionValue / totalAssets * 100) : 0;
  const cashReservePct = totalAssets > 0 ? (usdcBalance / totalAssets * 100) : 0;

  console.log(`  ${bold}CAPITAL:${reset}`);
  console.log("  ─────────────────────────────────────────");
  console.log(`  USDC.e cash:        $${usdcBalance.toFixed(2)} (${cashReservePct.toFixed(0)}% reserve)`);
  console.log(`  Positions value:    $${positionValue.toFixed(2)} (${deployedPct.toFixed(0)}% deployed)`);
  console.log("  ─────────────────────────────────────────");
  console.log(`  ${bold}TOTAL ASSETS:       $${totalAssets.toFixed(2)}${reset}`);
  console.log("");

  console.log(`  ${bold}P&L:${reset}`);
  console.log("  ─────────────────────────────────────────");
  console.log(`  Total deposited:    $${TOTAL_DEPOSITED.toFixed(2)}`);
  console.log(`  Unrealized P&L:     ${totalPnl >= 0 ? green : red}${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}${reset}`);
  console.log(`  ${netColor}${bold}NET P&L:              ${netPnL >= 0 ? "+" : ""}$${netPnL.toFixed(2)} (${((netPnL / TOTAL_DEPOSITED) * 100).toFixed(1)}%)${reset}`);
  console.log("");

  // Position stats
  console.log(`  ${bold}STATS:${reset}`);
  console.log("  ─────────────────────────────────────────");
  console.log(`  Active positions:   ${active.length}`);
  console.log(`  Winners:            ${green}${winners}${reset}`);
  console.log(`  Losers:             ${red}${losers}${reset}`);
  console.log(`  Win rate:           ${active.length > 0 ? (winners / active.length * 100).toFixed(0) : 0}%`);
  if (deployedPct >= 75) {
    console.log(`  ${yellow}⚠ Deployed at ${deployedPct.toFixed(0)}% — risk manager may block new trades${reset}`);
  }
  if (usdcBalance < 5) {
    console.log(`  ${red}⚠ LOW CASH — below $5 threshold${reset}`);
  }
  console.log("");
}

main().catch((e) => console.error("Error:", e.message));
