import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// For EOA/MetaMask wallets (signatureType 0), you must approve USDC and
// Conditional Token spending for the Polymarket exchange contracts.
// This only needs to be done ONCE.
// ---------------------------------------------------------------------------

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon
const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC on Polygon
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // Conditional Tokens
const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // CTF Exchange
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"; // Neg Risk Exchange

const MAX_ALLOWANCE = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ERC1155_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
]);

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });

  console.log("=== Setting Polymarket Allowances ===");
  console.log(`Wallet: ${account.address}\n`);

  // Check USDC.e balance
  const balanceUSDCe = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`USDC.e balance: ${Number(balanceUSDCe) / 1e6}`);

  // Check native USDC balance
  const balanceUSDC = await publicClient.readContract({
    address: USDC_NATIVE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`USDC (native) balance: ${Number(balanceUSDC) / 1e6}`);

  // Check POL balance for gas
  const polBalance = await publicClient.getBalance({ address: account.address });
  console.log(`POL balance: ${Number(polBalance) / 1e18}`);

  if (Number(polBalance) < 0.01e18) {
    console.log("\nWARNING: You need POL for gas to approve transactions!");
    console.log("Send at least 0.1 POL to", account.address);
    return;
  }

  // Approve USDC.e for Exchange
  console.log("\n1. Approving USDC.e for CTF Exchange...");
  try {
    const hash1 = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [EXCHANGE, MAX_ALLOWANCE],
    });
    console.log(`   TX: ${hash1}`);
    await publicClient.waitForTransactionReceipt({ hash: hash1 });
    console.log("   Done!");
  } catch (e: any) {
    console.log(`   Skip (${e.message?.substring(0, 80)})`);
  }

  // Approve USDC.e for Neg Risk Exchange
  console.log("2. Approving USDC.e for Neg Risk Exchange...");
  try {
    const hash2 = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [NEG_RISK_EXCHANGE, MAX_ALLOWANCE],
    });
    console.log(`   TX: ${hash2}`);
    await publicClient.waitForTransactionReceipt({ hash: hash2 });
    console.log("   Done!");
  } catch (e: any) {
    console.log(`   Skip (${e.message?.substring(0, 80)})`);
  }

  // Approve native USDC for Exchange
  console.log("3. Approving native USDC for CTF Exchange...");
  try {
    const hash3 = await walletClient.writeContract({
      address: USDC_NATIVE,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [EXCHANGE, MAX_ALLOWANCE],
    });
    console.log(`   TX: ${hash3}`);
    await publicClient.waitForTransactionReceipt({ hash: hash3 });
    console.log("   Done!");
  } catch (e: any) {
    console.log(`   Skip (${e.message?.substring(0, 80)})`);
  }

  // Approve native USDC for Neg Risk Exchange
  console.log("4. Approving native USDC for Neg Risk Exchange...");
  try {
    const hash4 = await walletClient.writeContract({
      address: USDC_NATIVE,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [NEG_RISK_EXCHANGE, MAX_ALLOWANCE],
    });
    console.log(`   TX: ${hash4}`);
    await publicClient.waitForTransactionReceipt({ hash: hash4 });
    console.log("   Done!");
  } catch (e: any) {
    console.log(`   Skip (${e.message?.substring(0, 80)})`);
  }

  // Approve CTF tokens for Exchange
  console.log("5. Approving Conditional Tokens for CTF Exchange...");
  try {
    const hash5 = await walletClient.writeContract({
      address: CTF_ADDRESS,
      abi: ERC1155_ABI,
      functionName: "setApprovalForAll",
      args: [EXCHANGE, true],
    });
    console.log(`   TX: ${hash5}`);
    await publicClient.waitForTransactionReceipt({ hash: hash5 });
    console.log("   Done!");
  } catch (e: any) {
    console.log(`   Skip (${e.message?.substring(0, 80)})`);
  }

  // Approve CTF tokens for Neg Risk Exchange
  console.log("6. Approving Conditional Tokens for Neg Risk Exchange...");
  try {
    const hash6 = await walletClient.writeContract({
      address: CTF_ADDRESS,
      abi: ERC1155_ABI,
      functionName: "setApprovalForAll",
      args: [NEG_RISK_EXCHANGE, true],
    });
    console.log(`   TX: ${hash6}`);
    await publicClient.waitForTransactionReceipt({ hash: hash6 });
    console.log("   Done!");
  } catch (e: any) {
    console.log(`   Skip (${e.message?.substring(0, 80)})`);
  }

  console.log("\nAll approvals set! Now try running the test-order script again.");

  // Also try the CLOB client's built-in allowance update
  console.log("\n7. Using CLOB client to update allowances...");
  try {
    const client = new ClobClient(
      "https://clob.polymarket.com",
      137,
      walletClient,
      {
        key: process.env.CLOB_API_KEY!,
        secret: process.env.CLOB_SECRET!,
        passphrase: process.env.CLOB_PASSPHRASE!,
      },
      0,
      process.env.FUNDER_ADDRESS || undefined
    );

    const r1 = await client.updateBalanceAllowance({ asset_type: 0 }); // COLLATERAL
    console.log("   Collateral allowance:", JSON.stringify(r1));
    const r2 = await client.updateBalanceAllowance({ asset_type: 1 }); // CONDITIONAL
    console.log("   Conditional allowance:", JSON.stringify(r2));
  } catch (e: any) {
    console.log(`   CLOB allowance update failed: ${e.message?.substring(0, 100)}`);
  }

  console.log("\nDone! Now run: npx tsx src/scripts/test-order.ts");
}

main().catch(console.error);
