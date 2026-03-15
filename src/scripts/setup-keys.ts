import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Run this once to generate your API keys.
//
// Usage: npm run setup-keys
//
// It will print your API key, secret, and passphrase.
// Copy those values into your .env file.
// ---------------------------------------------------------------------------

dotenv.config();

async function main(): Promise<void> {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("Set PRIVATE_KEY in your .env file first.");
    process.exit(1);
  }

  const sigType = parseInt(process.env.SIGNATURE_TYPE || "0") as 0 | 1;
  const funder = process.env.FUNDER_ADDRESS || "";

  console.log("Deriving API keys from your wallet...\n");

  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  console.log(`Wallet address: ${account.address}`);

  const client = new ClobClient(
    "https://clob.polymarket.com",
    137,
    wallet,
    undefined,
    sigType,
    funder || undefined
  );

  const creds = await client.createOrDeriveApiKey();

  console.log("\nAPI keys generated! Add these to your .env file:\n");
  console.log(`CLOB_API_KEY=${creds.key}`);
  console.log(`CLOB_SECRET=${creds.secret}`);
  console.log(`CLOB_PASSPHRASE=${creds.passphrase}`);
  console.log("\nDone.");
}

main().catch(console.error);
