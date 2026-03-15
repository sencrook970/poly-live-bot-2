import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Seed the database with existing positions and trade history.
// Run once to populate the DB with data from before the DB was set up.
//
// Usage: npx tsx src/scripts/seed-db.ts
// ---------------------------------------------------------------------------

const WALLET = "0xBBF2DFc8ACC5021292dD039abC80E8429C9A3B5F";
const DATA_API = "https://data-api.polymarket.com";

async function main() {
  const db = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
  );

  console.log("=== Seeding Database ===\n");

  // 1. Ensure wallet exists
  const { data: wallet } = await db
    .from("wallets")
    .upsert(
      { platform_id: "polymarket", address: WALLET, label: "main", signature_type: 0 },
      { onConflict: "platform_id,address" }
    )
    .select("id")
    .single();

  if (!wallet) {
    console.log("Failed to create wallet");
    return;
  }
  console.log(`Wallet ID: ${wallet.id}\n`);

  // 2. Fetch positions from Polymarket Data API
  console.log("Fetching positions from Polymarket...");
  let positions: any[] = [];
  try {
    const resp = await axios.get(`${DATA_API}/positions`, {
      params: { user: WALLET },
      timeout: 15000,
    });
    positions = resp.data;
    console.log(`Found ${positions.length} positions\n`);
  } catch (e) {
    console.log("Data API unreachable. Using state.json...");
    const fs = require("fs");
    const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
    positions = Object.values(state.positions).map((p: any) => ({
      asset: p.tokenId,
      conditionId: p.marketId,
      title: p.marketQuestion,
      outcome: p.outcome,
      size: p.totalShares,
      avgPrice: p.avgPrice,
      curPrice: p.currentPrice,
      initialValue: p.totalCost,
      currentValue: p.currentPrice * p.totalShares,
      cashPnl: (p.currentPrice - p.avgPrice) * p.totalShares,
    }));
  }

  // 3. Seed positions
  for (const pos of positions) {
    if (pos.size <= 0) continue;

    // Upsert market
    await db.from("markets").upsert(
      {
        id: pos.conditionId,
        platform_id: "polymarket",
        question: pos.title,
        last_price_yes: pos.curPrice,
        last_updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

    // Upsert position
    const { error } = await db.from("positions").upsert(
      {
        wallet_id: wallet.id,
        market_id: pos.conditionId,
        platform_id: "polymarket",
        token_id: pos.asset,
        outcome: pos.outcome,
        total_shares: pos.size,
        avg_price: pos.avgPrice,
        total_cost: pos.initialValue,
        current_price: pos.curPrice,
        current_value: pos.currentValue || pos.curPrice * pos.size,
        unrealized_pnl: pos.cashPnl,
        status: pos.curPrice <= 0.005 ? "resolved_lost" : pos.curPrice >= 0.995 ? "resolved_won" : "open",
      },
      { onConflict: "wallet_id,token_id" }
    );

    const status = pos.curPrice <= 0.005 ? "LOST" : pos.curPrice >= 0.995 ? "WON" : "OPEN";
    console.log(
      `  ${status} ${pos.outcome} "${pos.title?.substring(0, 45)}..." — ${pos.size} shares @ $${pos.avgPrice?.toFixed(3)} → $${pos.curPrice?.toFixed(3)}`
    );
    if (error) console.log(`    Error: ${error.message}`);
  }

  // 4. Seed trade history
  console.log("\nFetching trade history...");
  try {
    const resp = await axios.get(`${DATA_API}/trades`, {
      params: { user: WALLET },
      timeout: 15000,
    });
    const trades = resp.data;
    console.log(`Found ${trades.length} trades\n`);

    for (const t of trades) {
      // Upsert market
      await db.from("markets").upsert(
        {
          id: t.conditionId,
          platform_id: "polymarket",
          question: t.title,
          last_updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

      // Insert order (skip if tx_hash already exists)
      const { error } = await db.from("orders").insert({
        wallet_id: wallet.id,
        market_id: t.conditionId,
        platform_id: "polymarket",
        side: t.side,
        outcome: t.outcome,
        token_id: t.asset,
        shares: t.size,
        price: t.price,
        total_amount: t.size * t.price,
        strategy: "ai_prediction",
        order_reason: "new_position",
        status: "filled",
        tx_hash: t.transactionHash,
        filled_at: new Date(t.timestamp * 1000).toISOString(),
        placed_at: new Date(t.timestamp * 1000).toISOString(),
      });

      if (error && !error.message.includes("duplicate")) {
        console.log(`  Trade error: ${error.message}`);
      } else {
        console.log(`  ${t.side} ${t.size} ${t.outcome} @ $${t.price?.toFixed(3)} — ${t.title?.substring(0, 40)}...`);
      }
    }
  } catch (e: any) {
    console.log(`Trade fetch failed: ${e.message}`);
  }

  // 5. Record deposits
  console.log("\nRecording deposits...");
  await db.from("wallet_activity").upsert([
    {
      wallet_id: wallet.id,
      type: "deposit",
      amount: 21.73,
      token: "USDC.e",
      notes: "First deposit (MetaMask EOA)",
    },
    {
      wallet_id: wallet.id,
      type: "deposit",
      amount: 20.00,
      token: "USDC.e",
      notes: "Second deposit",
    },
  ]);
  console.log("  Recorded 2 deposits ($21.73 + $20.00)");

  // 6. Take initial snapshot
  const totalValue = positions
    .filter((p: any) => p.size > 0 && p.curPrice > 0.005)
    .reduce((sum: number, p: any) => sum + (p.currentValue || p.curPrice * p.size), 0);

  await db.from("daily_snapshots").upsert(
    {
      wallet_id: wallet.id,
      date: new Date().toISOString().split("T")[0],
      usdc_balance: 4.75,
      portfolio_value: totalValue,
      total_assets: 4.75 + totalValue,
      total_deposited: 41.73,
      net_pnl: 4.75 + totalValue - 41.73,
    },
    { onConflict: "wallet_id,date" }
  );
  console.log(`  Snapshot: assets=$${(4.75 + totalValue).toFixed(2)}, deposited=$41.73`);

  console.log("\nDone! Check Supabase tables.");
}

main().catch(console.error);
