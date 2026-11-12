const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const networkName = hre.network.name;

  console.log("==================================================");
  console.log(`Deploying AttendanceRegistry to network: ${networkName}`);
  console.log(`Deployer address: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${hre.ethers.formatEther(balance)} native tokens (HBAR / ETH)`);
  console.log("==================================================");

  const AttendanceRegistry = await hre.ethers.getContractFactory("AttendanceRegistry");

  // On Hedera JSON-RPC relay, provide sufficient explicit gas limit
  let registry;
  if (networkName === "hedera_testnet") {
    console.log("Hedera Testnet detected: sending deployment transaction with 3,000,000 gas limit...");
    registry = await AttendanceRegistry.deploy({ gasLimit: 3000000 });
  } else {
    registry = await AttendanceRegistry.deploy();
  }

  await registry.waitForDeployment();
  const contractAddress = await registry.getAddress();
  console.log(`AttendanceRegistry deployed successfully at: ${contractAddress}`);

  // Prepare deployment artifact
  const artifactPath = path.join(__dirname, "../artifacts/contracts/AttendanceRegistry.sol/AttendanceRegistry.json");
  let abi = [];
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    abi = artifact.abi;
  }

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentData = {
    network: networkName,
    chainId: hre.network.config.chainId,
    address: contractAddress,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    abi: abi,
  };

  const outputFile = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(deploymentData, null, 2));
  console.log(`Saved deployment info to: ${outputFile}`);

  // Auto-update .env with deployed CONTRACT_ADDRESS
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf8");
    if (envContent.includes("CONTRACT_ADDRESS=")) {
      envContent = envContent.replace(/CONTRACT_ADDRESS=.*/, `CONTRACT_ADDRESS=${contractAddress}`);
    } else {
      envContent += `\nCONTRACT_ADDRESS=${contractAddress}`;
    }
    if (networkName === "hedera_testnet") {
      envContent = envContent.replace(/CHAIN_MODE=.*/, "CHAIN_MODE=hedera");
    }
    fs.writeFileSync(envPath, envContent);
    console.log(`Updated .env: CONTRACT_ADDRESS=${contractAddress} | CHAIN_MODE=${networkName === "hedera_testnet" ? "hedera" : "local"}`);
  }

  if (networkName === "hedera_testnet") {
    console.log(`HashScan Explorer: https://hashscan.io/testnet/contract/${contractAddress}`);
  }
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});

