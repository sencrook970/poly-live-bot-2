import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// SELL ALL POSITIONS — emergency script to close everything.
//
// Usage: npm run sell-all
//        npx tsx src/scripts/sell-all.ts
//
// This will sell ALL your shares at market price. Use when you want to
// exit everything — profit or loss doesn't matter.
// ---------------------------------------------------------------------------

const DATA_API = "https://data-api.polymarket.com";

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain: polygon, transport: http() });

  const client = new ClobClient(
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

  console.log("=== SELL ALL POSITIONS ===\n");
  console.log(`Wallet: ${account.address}\n`);

  // Fetch positions from Data API
  const resp = await axios.get(`${DATA_API}/positions`, {
    params: { user: account.address },
  });
  const positions = resp.data as any[];
  const active = positions.filter((p: any) => p.size > 0);

  if (active.length === 0) {
    console.log("No open positions to sell.");
    return;
  }

  console.log(`Found ${active.length} positions to sell:\n`);

  let totalSold = 0;
  let totalValue = 0;

  for (const pos of active) {
    const tokenId = pos.asset;
    const shares = pos.size;
    const currentPrice = pos.curPrice;
    const title = pos.title;
    const outcome = pos.outcome;

    console.log(`Selling: ${shares} ${outcome} shares of "${title}" @ ~$${currentPrice.toFixed(3)}`);

    try {
      // Get market config
      const tickSize = await client.getTickSize(tokenId);
      const negRisk = await client.getNegRisk(tokenId);

      // Place a sell order at slightly below current price for quick fill
      const sellPrice = Math.max(0.01, Math.round((currentPrice - 0.01) * 100) / 100);

      const result = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: sellPrice,
          side: Side.SELL,
          size: shares,
        },
        {
          tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
          negRisk,
        },
        OrderType.GTC
      );

      const resultAny = result as any;
      if (resultAny.success) {
        const status = resultAny.status;
        const value = shares * sellPrice;
        totalSold++;
        totalValue += value;
        console.log(`  OK — ${status} (est. $${value.toFixed(2)})`);
      } else {
        console.log(`  FAILED: ${JSON.stringify(result)}`);
      }
    } catch (err: any) {
      console.log(`  ERROR: ${err.message?.substring(0, 100)}`);
    }

    console.log("");
  }

  console.log(`\nSold ${totalSold}/${active.length} positions.`);
  console.log(`Estimated value recovered: ~$${totalValue.toFixed(2)}`);
  console.log("\nNote: Some orders may be resting on the book. Check Polymarket.");
}

main().catch(console.error);
