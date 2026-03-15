import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const funder = process.env.FUNDER_ADDRESS || "";

  console.log("=== Order Test V2 ===");
  console.log(`EOA: ${account.address}`);
  console.log(`Funder: ${funder || "(none)"}`);

  // Test 1: WITHOUT funder, sig type 0
  console.log("\n--- Test 1: No funder, type 0 ---");
  try {
    const c1 = new ClobClient("https://clob.polymarket.com", 137, wallet);
    const creds1 = await c1.createOrDeriveApiKey();
    console.log(`API Key: ${creds1.key}`);
    c1.set_api_creds(creds1);

    const order1 = await c1.createAndPostOrder(
      { tokenID: "81697486240392901899167649997008736380137911909662773455994395620863894931973", price: 0.01, side: Side.BUY, size: 1 },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC
    );
    console.log("Result:", JSON.stringify(order1));
    if (!(order1 as any).error) console.log("*** SUCCESS! Use: no funder, type 0 ***");
  } catch (e: any) { console.log("Error:", e.message?.substring(0, 100)); }

  // Test 2: WITH funder, sig type 0, fresh creds
  console.log("\n--- Test 2: With funder, type 0, fresh creds ---");
  try {
    const c2 = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, 0, funder);
    const creds2 = await c2.createOrDeriveApiKey();
    console.log(`API Key: ${creds2.key}`);
    c2.set_api_creds(creds2);

    const order2 = await c2.createAndPostOrder(
      { tokenID: "81697486240392901899167649997008736380137911909662773455994395620863894931973", price: 0.01, side: Side.BUY, size: 1 },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC
    );
    console.log("Result:", JSON.stringify(order2));
    if (!(order2 as any).error) console.log("*** SUCCESS! Use: with funder, type 0 ***");
  } catch (e: any) { console.log("Error:", e.message?.substring(0, 100)); }

  // Test 3: WITH funder, sig type 1, fresh creds
  console.log("\n--- Test 3: With funder, type 1, fresh creds ---");
  try {
    const c3 = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, 1, funder);
    const creds3 = await c3.createOrDeriveApiKey();
    console.log(`API Key: ${creds3.key}`);
    c3.set_api_creds(creds3);

    const order3 = await c3.createAndPostOrder(
      { tokenID: "81697486240392901899167649997008736380137911909662773455994395620863894931973", price: 0.01, side: Side.BUY, size: 1 },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC
    );
    console.log("Result:", JSON.stringify(order3));
    if (!(order3 as any).error) console.log("*** SUCCESS! Use: with funder, type 1 ***");
  } catch (e: any) { console.log("Error:", e.message?.substring(0, 100)); }

  // Test 4: WITHOUT funder, sig type 0, use set_api_creds instead of constructor
  console.log("\n--- Test 4: No funder, type 0, explicit set_api_creds ---");
  try {
    const c4 = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, 0);
    const creds4 = await c4.createOrDeriveApiKey();
    console.log(`API Key: ${creds4.key}`);

    // Re-create with creds
    const c4b = new ClobClient("https://clob.polymarket.com", 137, wallet, creds4, 0);
    const order4 = await c4b.createAndPostOrder(
      { tokenID: "81697486240392901899167649997008736380137911909662773455994395620863894931973", price: 0.01, side: Side.BUY, size: 1 },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC
    );
    console.log("Result:", JSON.stringify(order4));
    if (!(order4 as any).error) console.log("*** SUCCESS! Use: no funder, type 0, re-create ***");
  } catch (e: any) { console.log("Error:", e.message?.substring(0, 100)); }

  console.log("\nDone.");
}

main().catch(console.error);
