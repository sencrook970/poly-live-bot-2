import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

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

  console.log("=== Checking Positions for", account.address, "===\n");

  // Check open orders
  console.log("--- Open Orders ---");
  try {
    const orders = await client.getOpenOrders();
    if (Array.isArray(orders) && orders.length > 0) {
      for (const o of orders) {
        console.log(`  ${(o as any).side} ${(o as any).original_size} shares @ $${(o as any).price} — ${(o as any).market || (o as any).asset_id} [${(o as any).status}]`);
      }
    } else {
      console.log("  No open orders (all filled or cancelled)");
      console.log("  Raw:", JSON.stringify(orders).substring(0, 200));
    }
  } catch (e: any) {
    console.log("  Error:", e.message?.substring(0, 100));
  }

  // Check trades history
  console.log("\n--- Recent Trades ---");
  try {
    const trades = await client.getTrades();
    if (Array.isArray(trades) && trades.length > 0) {
      for (const t of trades.slice(0, 20)) {
        const side = (t as any).side;
        const size = (t as any).size;
        const price = (t as any).price;
        const market = (t as any).market || (t as any).asset_id || "";
        const status = (t as any).status || (t as any).match_time || "";
        console.log(`  ${side} ${size} @ $${price} — ${market.substring(0, 40)} [${status}]`);
      }
    } else {
      console.log("  No trades found");
      console.log("  Raw:", JSON.stringify(trades).substring(0, 500));
    }
  } catch (e: any) {
    console.log("  Error:", e.message?.substring(0, 100));
  }

  console.log("\nDone.");
}

main().catch(console.error);
