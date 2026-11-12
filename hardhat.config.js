require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("dotenv").config();

const HEDERA_TESTNET_RPC = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";
const HEDERA_MAINNET_RPC = "https://mainnet.hashio.io/api"; // NOT USED - placeholder per spec
const PRIVATE_KEY = process.env.FACULTY_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    hedera_testnet: {
      url: HEDERA_TESTNET_RPC,
      chainId: 296,
      accounts: [PRIVATE_KEY],
      timeout: 60000,
    },
    hedera_mainnet: {
      // PLACEHOLDER PER SPEC - NOT USED IN THIS PROJECT
      url: HEDERA_MAINNET_RPC,
      chainId: 295,
      accounts: [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  mocha: {
    timeout: 40000,
  },
};

