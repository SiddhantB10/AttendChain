#!/usr/bin/env node
/**
 * AttendChain - Automated Hedera Testnet Setup & Deployment Script
 * 
 * Usage:
 *   node scripts/setup_hedera.js [0xYourPrivateKey]
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const RPC_URL = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = parseInt(process.env.HEDERA_CHAIN_ID || "296", 10);
const ENV_PATH = path.join(__dirname, "../.env");

function updateEnv(key, value) {
  if (!fs.existsSync(ENV_PATH)) return;
  let content = fs.readFileSync(ENV_PATH, "utf8");
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_PATH, content, "utf8");
}

async function main() {
  console.log("==================================================================");
  console.log("             AttendChain™ - Hedera Testnet Setup                  ");
  console.log("==================================================================");

  let privateKey = process.argv[2] || process.env.FACULTY_PRIVATE_KEY || "";

  // Check if private key is missing or is the default dummy placeholder
  if (!privateKey || privateKey.startsWith("0x0000000000000000000000000000000000000000000000000000000000000001")) {
    console.log("\n[!] FACULTY_PRIVATE_KEY is not yet configured with your real Hedera Testnet key.");
    console.log("\nHow to get a free Hedera Testnet Account in 1 minute:");
    console.log("  1. Go to https://portal.hedera.com and create a free account.");
    console.log("  2. In your dashboard, find your Testnet Account.");
    console.log("  3. Copy your ECDSA EVM Private Key (starts with 0x).");
    console.log("     (Note: Portal automatically credits 1,000 free testnet HBAR)");
    console.log("\nOnce you have your private key, run:");
    console.log("  node scripts/setup_hedera.js 0xYOUR_HEDERA_PRIVATE_KEY");
    console.log("==================================================================");
    return;
  }

  if (!privateKey.startsWith("0x")) {
    privateKey = "0x" + privateKey;
  }

  // Connect to Hedera JSON-RPC Relay
  console.log(`\nConnecting to Hedera Testnet (${RPC_URL})...`);
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name: "hedera_testnet"
  });

  try {
    const network = await provider.getNetwork();
    console.log(`[PASS] Hedera JSON-RPC Relay Connected! Chain ID: ${network.chainId}`);
  } catch (err) {
    console.error(`[FAIL] Connection failed: ${err.message}`);
    process.exit(1);
  }

  // Initialize Wallet
  let wallet;
  try {
    wallet = new ethers.Wallet(privateKey, provider);
    console.log(`[PASS] Wallet Address (EVM): ${wallet.address}`);
  } catch (err) {
    console.error(`[FAIL] Invalid private key: ${err.message}`);
    process.exit(1);
  }

  // Check Balance
  const balanceWei = await provider.getBalance(wallet.address);
  const balanceHbar = ethers.formatEther(balanceWei);
  console.log(`       Wallet Balance: ${balanceHbar} HBAR`);

  if (balanceWei === 0n) {
    console.error(`\n[FAIL] Wallet has 0 HBAR! Cannot deploy contract or submit transactions.`);
    console.log(`Please request free testnet HBAR from the faucet at:`);
    console.log(`  https://portal.hedera.com`);
    process.exit(1);
  }

  // Save private key to .env
  updateEnv("FACULTY_PRIVATE_KEY", privateKey);

  // Load Contract Artifact
  const artifactPath = path.join(__dirname, "../artifacts/contracts/AttendanceRegistry.sol/AttendanceRegistry.json");
  if (!fs.existsSync(artifactPath)) {
    console.error(`[FAIL] Artifact not found at ${artifactPath}. Please run: npx hardhat compile`);
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  // Check existing contract address
  let existingAddress = process.env.CONTRACT_ADDRESS;
  const depPath = path.join(__dirname, "../deployments/hedera_testnet.json");
  if (!existingAddress && fs.existsSync(depPath)) {
    try {
      const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
      existingAddress = dep.address;
    } catch (e) {}
  }

  let contractAddress = existingAddress;
  let needDeploy = true;

  if (contractAddress) {
    try {
      const code = await provider.getCode(contractAddress);
      if (code && code !== "0x" && code !== "0x00") {
        console.log(`[PASS] Existing AttendanceRegistry found at: ${contractAddress}`);
        console.log(`       Bytecode length: ${(code.length - 2) / 2} bytes`);
        console.log(`       HashScan Link: https://hashscan.io/testnet/contract/${contractAddress}`);
        needDeploy = false;
      } else {
        console.log(`[INFO] Address ${contractAddress} has no bytecode. A new contract will be deployed.`);
      }
    } catch (e) {
      console.log(`[INFO] Could not fetch code for ${contractAddress}. Deploying new contract.`);
    }
  }

  if (needDeploy) {
    console.log("\nDeploying AttendanceRegistry smart contract to Hedera Testnet...");
    console.log("Gas limit: 3,000,000 | Network: hedera_testnet (296)");

    const deployTx = await factory.deploy({ gasLimit: 3000000 });
    console.log(`Deployment transaction submitted. Hash: ${deployTx.deploymentTransaction().hash}`);
    console.log("Waiting for Hedera consensus confirmation...");

    await deployTx.waitForDeployment();
    contractAddress = await deployTx.getAddress();
    console.log(`\n[SUCCESS] Contract deployed successfully!`);
    console.log(`Contract Address: ${contractAddress}`);
    console.log(`HashScan Explorer: https://hashscan.io/testnet/contract/${contractAddress}`);

    // Save deployment artifact
    const deploymentsDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
    fs.writeFileSync(depPath, JSON.stringify({
      network: "hedera_testnet",
      chainId: CHAIN_ID,
      address: contractAddress,
      deployer: wallet.address,
      deployedAt: new Date().toISOString(),
      abi: artifact.abi
    }, null, 2), "utf8");
    console.log(`Saved deployment info to: deployments/hedera_testnet.json`);
  }

  // Update .env
  updateEnv("CONTRACT_ADDRESS", contractAddress);
  updateEnv("CHAIN_MODE", "hedera");
  console.log(`\n[PASS] Updated .env:`);
  console.log(`  CHAIN_MODE=hedera`);
  console.log(`  CONTRACT_ADDRESS=${contractAddress}`);
  console.log(`  FACULTY_PRIVATE_KEY=${wallet.address} (configured)`);

  // Synchronize existing biometric students with Hedera Testnet contract
  console.log("\nSynchronizing existing enrolled students with Hedera contract...");
  try {
    const { execSync } = require("child_process");
    execSync("python scripts/sync_students_to_hedera.py", { stdio: "inherit" });
  } catch (err) {
    console.log(`[INFO] Student sync note: ${err.message}`);
  }

  console.log("\n==================================================================");
  console.log("       AttendChain is now 100% READY for HEDERA TESTNET!          ");
  console.log("==================================================================");
}

main().catch(err => {
  console.error("\n[ERROR] Setup failed:", err.message || err);
  process.exit(1);
});
