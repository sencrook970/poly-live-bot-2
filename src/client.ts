import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { log } from "./utils/logger";

// ---------------------------------------------------------------------------
// Creates and returns an authenticated Polymarket CLOB client.
// This is the single connection to Polymarket used by the whole bot.
// Uses viem (which is what the SDK expects internally).
// ---------------------------------------------------------------------------

let clientInstance: ClobClient | null = null;

function createWallet() {
  const pk = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });
}

export async function getClient(): Promise<ClobClient> {
  if (clientInstance) return clientInstance;

  log.info("Connecting to Polymarket...");

  const wallet = createWallet();

  // If we have saved API keys, use them directly
  if (config.clobApiKey && config.clobSecret && config.clobPassphrase) {
    clientInstance = new ClobClient(
      config.clobUrl,
      config.chainId,
      wallet,
      {
        key: config.clobApiKey,
        secret: config.clobSecret,
        passphrase: config.clobPassphrase,
      },
      config.signatureType,
      config.funderAddress || undefined
    );
    log.success("Connected with saved API keys");
    return clientInstance;
  }

  // Otherwise, derive new keys
  const tempClient = new ClobClient(
    config.clobUrl,
    config.chainId,
    wallet,
    undefined,
    config.signatureType,
    config.funderAddress || undefined
  );

  const creds = await tempClient.createOrDeriveApiKey();
  log.success("API keys derived. Save these to your .env file:");
  log.info(`  CLOB_API_KEY=${creds.key}`);
  log.info(`  CLOB_SECRET=${creds.secret}`);
  log.info(`  CLOB_PASSPHRASE=${creds.passphrase}`);

  clientInstance = new ClobClient(
    config.clobUrl,
    config.chainId,
    wallet,
    creds,
    config.signatureType,
    config.funderAddress || undefined
  );

  return clientInstance;
}

// Read-only client for fetching market data (no auth needed)
export function getPublicClient(): ClobClient {
  return new ClobClient(config.clobUrl, config.chainId);
}
