import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

// Check all Polymarket-related allowances and balances
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ERC1155_ABI = parseAbi([
  "function isApprovedForAll(address account, address operator) view returns (bool)",
]);

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const client = createPublicClient({
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });

  console.log(`Wallet: ${account.address}\n`);

  // USDC.e balance
  const balance = await client.readContract({
    address: USDC_E, abi: ERC20_ABI, functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`USDC.e balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  // POL for gas
  const pol = await client.getBalance({ address: account.address });
  console.log(`POL (gas): ${(Number(pol) / 1e18).toFixed(4)}`);

  // USDC.e allowance for Exchange
  const a1 = await client.readContract({
    address: USDC_E, abi: ERC20_ABI, functionName: "allowance",
    args: [account.address, EXCHANGE],
  });
  console.log(`\nUSDC.e → CTF Exchange allowance: ${Number(a1) > 1e30 ? "UNLIMITED" : `$${(Number(a1) / 1e6).toFixed(2)}`}`);

  // USDC.e allowance for Neg Risk Exchange
  const a2 = await client.readContract({
    address: USDC_E, abi: ERC20_ABI, functionName: "allowance",
    args: [account.address, NEG_RISK_EXCHANGE],
  });
  console.log(`USDC.e → Neg Risk Exchange allowance: ${Number(a2) > 1e30 ? "UNLIMITED" : `$${(Number(a2) / 1e6).toFixed(2)}`}`);

  // CTF approval for Exchange
  const c1 = await client.readContract({
    address: CTF, abi: ERC1155_ABI, functionName: "isApprovedForAll",
    args: [account.address, EXCHANGE],
  });
  console.log(`CTF → CTF Exchange: ${c1 ? "APPROVED" : "NOT APPROVED"}`);

  // CTF approval for Neg Risk Exchange
  const c2 = await client.readContract({
    address: CTF, abi: ERC1155_ABI, functionName: "isApprovedForAll",
    args: [account.address, NEG_RISK_EXCHANGE],
  });
  console.log(`CTF → Neg Risk Exchange: ${c2 ? "APPROVED" : "NOT APPROVED"}`);

  // Verdict
  console.log("\n--- VERDICT ---");
  if (Number(a1) < 1e12 || Number(a2) < 1e12) {
    console.log("USDC.e allowance is LOW or ZERO! Run: npx tsx src/scripts/set-allowance.ts");
  } else if (!c1 || !c2) {
    console.log("CTF token approval missing! Run: npx tsx src/scripts/set-allowance.ts");
  } else {
    console.log("All allowances look OK. The 'not enough balance' error may be from something else.");
  }
}

main().catch(console.error);
