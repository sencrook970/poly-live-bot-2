import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

// Test script: tries to place a tiny $0.10 order to debug the signature issue

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const funder = process.env.FUNDER_ADDRESS!;
  const sigType = parseInt(process.env.SIGNATURE_TYPE || "1");

  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  console.log("=== Order Test ===");
  console.log(`EOA (signer): ${account.address}`);
  console.log(`Funder:       ${funder}`);
  console.log(`Sig type:     ${sigType}`);
  console.log("");

  // Try all 3 signature types
  for (const tryType of [0, 1, 2]) {
    console.log(`\n--- Testing signatureType: ${tryType} ---`);

    try {
      const client = new ClobClient(
        "https://clob.polymarket.com",
        137,
        wallet,
        {
          key: process.env.CLOB_API_KEY!,
          secret: process.env.CLOB_SECRET!,
          passphrase: process.env.CLOB_PASSPHRASE!,
        },
        tryType as 0 | 1 | 2,
        funder
      );

      // First test: check balance (this should work regardless)
      console.log("Checking balance...");
      const balance = await client.getBalanceAllowance({
        asset_type: 0, // COLLATERAL = USDC
      });
      console.log("Balance:", JSON.stringify(balance));

      // Try to create an order (but don't post it yet)
      // Using a very low price so it won't fill
      // Token ID for a popular market - "US forces enter Iran by March 31?" NO side
      const tokenId = "81697486240392901899167649997008736380137911909662773455994395620863894931973";

      console.log("Creating order...");
      const tickSize = await client.getTickSize(tokenId);
      const negRisk = await client.getNegRisk(tokenId);
      console.log(`Tick size: ${tickSize}, negRisk: ${negRisk}`);

      // Try placing a very small order at a low price (won't fill, just tests signing)
      console.log("Posting order (BUY 1 share @ $0.01)...");
      const result = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: 0.01,
          side: Side.BUY,
          size: 1,
        },
        { tickSize: tickSize as "0.01" | "0.001" | "0.0001" | "0.1", negRisk },
        OrderType.GTC
      );

      console.log("Result:", JSON.stringify(result));

      if (result && !(result as any).error) {
        console.log(`\n*** SUCCESS with signatureType ${tryType}! ***`);
        console.log("Update your .env: SIGNATURE_TYPE=" + tryType);

        // Cancel the test order
        if ((result as any).orderID) {
          await client.cancelOrder({ orderID: (result as any).orderID });
          console.log("Test order cancelled.");
        }
        return;
      } else {
        console.log(`Failed with type ${tryType}: ${JSON.stringify(result)}`);
      }
    } catch (err: any) {
      console.log(`Error with type ${tryType}: ${err.message || err}`);
    }
  }

  console.log("\n--- All signature types failed ---");
  console.log("This usually means the private key doesn't match your Polymarket account.");
  console.log("Make sure you exported it from: https://reveal.magic.link/polymarket");
}

main().catch(console.error);
