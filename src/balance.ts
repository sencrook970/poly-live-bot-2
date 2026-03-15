import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { config } from "./config";
import { log } from "./utils/logger";

// ---------------------------------------------------------------------------
// Balance Checker — reads real USDC.e balance from on-chain every scan.
// No restart needed when you deposit — the bot checks every scan.
// ---------------------------------------------------------------------------

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

const publicClient = createPublicClient({
  chain: polygon,
  transport: http("https://polygon-bor-rpc.publicnode.com"),
});

// Get the wallet address from private key
function getWalletAddress(): `0x${string}` {
  const { privateKeyToAccount } = require("viem/accounts");
  const pk = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;
  return privateKeyToAccount(pk as `0x${string}`).address;
}

let cachedAddress: `0x${string}` | null = null;

function getAddress(): `0x${string}` {
  if (!cachedAddress) cachedAddress = getWalletAddress();
  return cachedAddress;
}

// Fetch real USDC.e balance from blockchain
export async function getUsdcBalance(): Promise<number> {
  try {
    const balance = await publicClient.readContract({
      address: USDC_E,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [getAddress()],
    });
    return Number(balance) / 1e6; // USDC has 6 decimals
  } catch (err) {
    log.warn(`Could not fetch USDC.e balance: ${err}`);
    return -1; // Return -1 to indicate error
  }
}
