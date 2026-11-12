const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function checkHedera() {
  console.log("=== Hedera Testnet Connectivity & Status Check ===");

  const rpcUrl = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";
  const privateKey = process.env.FACULTY_PRIVATE_KEY;
  const contractAddressFromEnv = process.env.CONTRACT_ADDRESS;

  console.log(`RPC Relay URL: ${rpcUrl}`);

  let provider;
  try {
    provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    console.log(`[PASS] Connected to Network: Chain ID ${network.chainId.toString()} (Hedera Testnet expected: 296)`);
    if (network.chainId !== 296n) {
      console.warn(`[WARN] Warning: Chain ID ${network.chainId} does not match Hedera Testnet 296!`);
    }
  } catch (err) {
    console.error(`[FAIL] Failed to connect to RPC Relay at ${rpcUrl}:`, err.message);
    process.exit(1);
  }

  // Check Wallet
  if (!privateKey || privateKey.startsWith("0x0000000000000000000000000000000000000000000000000000000000000001")) {
    console.log("[INFO] No custom FACULTY_PRIVATE_KEY configured in .env (or placeholder used).");
    console.log("       To deploy to Hedera Testnet, create an account on portal.hedera.com and set FACULTY_PRIVATE_KEY.");
  } else {
    try {
      const wallet = new ethers.Wallet(privateKey, provider);
      console.log(`[PASS] Wallet Address (EVM): ${wallet.address}`);
      const balance = await provider.getBalance(wallet.address);
      const hbar = ethers.formatEther(balance);
      console.log(`       Balance: ${hbar} HBAR`);
      if (balance === 0n) {
        console.warn("       [WARN] Wallet has 0 HBAR. Fund it using the Hedera Portal faucet: https://portal.hedera.com");
      }
    } catch (err) {
      console.error(`[FAIL] Invalid private key: ${err.message}`);
    }
  }

  // Check Contract
  let targetAddress = contractAddressFromEnv;
  if (!targetAddress) {
    const deploymentPath = path.join(__dirname, "../deployments/hedera_testnet.json");
    if (fs.existsSync(deploymentPath)) {
      try {
        const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
        targetAddress = deployment.address;
        console.log(`[INFO] Found deployed address from deployments/hedera_testnet.json: ${targetAddress}`);
      } catch (e) {
        // ignore
      }
    }
  }

  if (targetAddress) {
    try {
      const code = await provider.getCode(targetAddress);
      if (code && code !== "0x") {
        console.log(`[PASS] Contract is deployed at: ${targetAddress}`);
        console.log(`       Bytecode length: ${(code.length - 2) / 2} bytes`);
        console.log(`       HashScan Link: https://hashscan.io/testnet/contract/${targetAddress}`);
      } else {
        console.log(`[FAIL] No bytecode found at ${targetAddress} (code is empty). Contract is NOT deployed.`);
      }
    } catch (err) {
      console.error(`[FAIL] Error querying contract at ${targetAddress}:`, err.message);
    }
  } else {
    console.log("[INFO] No contract address provided in .env or deployments/hedera_testnet.json.");
  }

  console.log("==================================================");
}

checkHedera().catch(console.error);

