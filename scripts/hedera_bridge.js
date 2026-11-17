#!/usr/bin/env node
/**
 * AttendChain Hedera Testnet Bridge for Node.js / Ethers.js
 * Provides secure, AppLocker-compliant EVM transactions and calls on Hedera Testnet.
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const RPC_URL = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = parseInt(process.env.HEDERA_CHAIN_ID || "296", 10);
const PRIVATE_KEY = process.env.FACULTY_PRIVATE_KEY || "";
let CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";

// If CONTRACT_ADDRESS is empty, check deployments/hedera_testnet.json
if (!CONTRACT_ADDRESS) {
  const depPath = path.join(__dirname, "../deployments/hedera_testnet.json");
  if (fs.existsSync(depPath)) {
    try {
      const depData = JSON.parse(fs.readFileSync(depPath, "utf8"));
      CONTRACT_ADDRESS = depData.address || "";
    } catch (e) {}
  }
}

// Load ABI: compiled Hardhat artifact first, then the ABI saved alongside the deployment
// (artifacts/ is git-ignored, so a fresh clone only has deployments/hedera_testnet.json).
function loadAbi() {
  const candidates = [
    path.join(__dirname, "../artifacts/contracts/AttendanceRegistry.sol/AttendanceRegistry.json"),
    path.join(__dirname, "../deployments/hedera_testnet.json")
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const abi = JSON.parse(fs.readFileSync(file, "utf8")).abi;
      if (Array.isArray(abi) && abi.length) return abi;
    } catch (e) {}
  }
  return [];
}

const ABI = loadAbi();

function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name: "hedera_testnet"
  });
}

function getWallet(provider) {
  if (!PRIVATE_KEY || PRIVATE_KEY.startsWith("0x0000000000000000000000000000000000000000000000000000000000000001")) {
    return null;
  }
  return new ethers.Wallet(PRIVATE_KEY, provider);
}

function getContract(signerOrProvider) {
  if (!CONTRACT_ADDRESS || !ABI.length) return null;
  return new ethers.Contract(CONTRACT_ADDRESS, ABI, signerOrProvider);
}

// Helper: ensure 32-byte hex for bytes32
function toBytes32(hexStr) {
  let clean = (hexStr || "").trim();
  if (clean.startsWith("0x")) clean = clean.slice(2);
  clean = clean.padStart(64, "0").slice(0, 64);
  return "0x" + clean;
}

// Must stay byte-for-byte identical to Web3ChainAdapter._text_to_bytes32 (trim, upper-case, 32 bytes)
function subjectToBytes32(subj) {
  const text = String(subj || "CS301").trim().toUpperCase();
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return "0x" + text.slice(2).toLowerCase();
  const hex = Buffer.from(text, "utf8").subarray(0, 32).toString("hex");
  return "0x" + hex.padEnd(64, "0");
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0] || "get_health";
  const rawPayload = args[1] || "{}";

  let payload = {};
  try {
    payload = JSON.parse(rawPayload);
  } catch (e) {
    payload = {};
  }

  const provider = getProvider();
  const wallet = getWallet(provider);

  try {
    if (action === "get_health") {
      let nodeReachable = false;
      let walletBalanceHbar = 0.0;
      let walletAddress = wallet ? wallet.address : "0x0000000000000000000000000000000000000000";
      let contractDeployed = false;

      try {
        const network = await provider.getNetwork();
        nodeReachable = network.chainId === BigInt(CHAIN_ID);
      } catch (e) {
        nodeReachable = false;
      }

      if (wallet) {
        try {
          const bal = await provider.getBalance(wallet.address);
          walletBalanceHbar = parseFloat(ethers.formatEther(bal));
        } catch (e) {}
      }

      if (CONTRACT_ADDRESS) {
        try {
          const code = await provider.getCode(CONTRACT_ADDRESS);
          contractDeployed = code && code.length > 2 && code !== "0x00";
        } catch (e) {
          contractDeployed = false;
        }
      }

      console.log(JSON.stringify({
        ok: true,
        mode: "hedera",
        network: `Hedera Testnet (${CHAIN_ID})`,
        chain_id: CHAIN_ID,
        contract_address: CONTRACT_ADDRESS,
        wallet_address: walletAddress,
        wallet_balance_hbar: walletBalanceHbar,
        node_reachable: nodeReachable,
        contract_deployed: contractDeployed
      }));
      return;
    }

    // Actions below require contract
    const contract = getContract(wallet || provider);
    if (!contract) {
      console.log(JSON.stringify({ ok: false, error: "Contract or ABI not configured on Hedera Testnet." }));
      return;
    }

    if (action === "register_student") {
      if (!wallet) throw new Error("FACULTY_PRIVATE_KEY is required to sign Hedera transactions.");
      const studentId = toBytes32(payload.student_id);
      const commitment = toBytes32(payload.face_commitment);

      const tx = await contract.registerStudent(studentId, commitment, { gasLimit: 500000 });
      const receipt = await tx.wait();
      console.log(JSON.stringify({ ok: true, tx_hash: receipt.hash }));
      return;
    }

    if (action === "open_session") {
      if (!wallet) throw new Error("FACULTY_PRIVATE_KEY is required to sign Hedera transactions.");
      const subj = subjectToBytes32(payload.subject || "CS301");
      const duration = parseInt(payload.duration_seconds || 3600, 10);

      const tx = await contract.openSession(subj, duration, { gasLimit: 500000 });
      const receipt = await tx.wait();

      // Parse SessionOpened event
      let sessionId = 1;
      for (const log of receipt.logs || []) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed && parsed.name === "SessionOpened") {
            sessionId = Number(parsed.args[0]);
            break;
          }
        } catch (e) {}
      }

      console.log(JSON.stringify({ ok: true, session_id: sessionId, tx_hash: receipt.hash }));
      return;
    }

    if (action === "close_session") {
      if (!wallet) throw new Error("FACULTY_PRIVATE_KEY is required to sign Hedera transactions.");
      const sessionId = parseInt(payload.session_id, 10);
      const tx = await contract.closeSession(sessionId, { gasLimit: 300000 });
      const receipt = await tx.wait();
      console.log(JSON.stringify({ ok: true, tx_hash: receipt.hash }));
      return;
    }

    if (action === "record_attendance") {
      if (!wallet) throw new Error("FACULTY_PRIVATE_KEY is required to sign Hedera transactions.");
      const sessionId = parseInt(payload.session_id, 10);
      const studentId = toBytes32(payload.student_id);
      const evidenceHash = toBytes32(payload.evidence_hash);

      // The contract function is markAttendance (there is no recordAttendance in AttendanceRegistry.sol)
      const tx = await contract.markAttendance(sessionId, studentId, evidenceHash, { gasLimit: 500000 });
      const receipt = await tx.wait();
      console.log(JSON.stringify({ ok: true, tx_hash: receipt.hash }));
      return;
    }

    if (action === "get_student") {
      const studentId = toBytes32(payload.student_id);
      const res = await contract.getStudent(studentId);
      console.log(JSON.stringify({
        ok: true,
        registered: res[0],
        registered_at: Number(res[1]),
        face_commitment: res[2]
      }));
      return;
    }

    if (action === "is_session_active") {
      const sessionId = parseInt(payload.session_id, 10);
      const active = await contract.isSessionActive(sessionId);
      console.log(JSON.stringify({ ok: true, active: Boolean(active) }));
      return;
    }

    if (action === "get_session") {
      const sessionId = parseInt(payload.session_id, 10);
      const res = await contract.getSession(sessionId);
      console.log(JSON.stringify({
        ok: true,
        session_id: sessionId,
        subject: res[0],
        faculty: res[1],
        start_time: Number(res[2]),
        end_time: Number(res[3]),
        closed: Boolean(res[4]),
        present_count: Number(res[5])
      }));
      return;
    }

    if (action === "get_attendance") {
      const sessionId = parseInt(payload.session_id, 10);
      const studentId = toBytes32(payload.student_id);
      // AttendanceRegistry exposes hasAttended + getEvidence (there is no getAttendance view)
      const present = await contract.hasAttended(sessionId, studentId);
      const evidence = await contract.getEvidence(sessionId, studentId);
      console.log(JSON.stringify({
        ok: true,
        present: Boolean(present),
        evidence_hash: evidence
      }));
      return;
    }

    if (action === "get_session_count") {
      const count = await contract.sessionCount();
      console.log(JSON.stringify({ ok: true, session_count: Number(count) }));
      return;
    }

    if (action === "get_student_summary") {
      const studentId = toBytes32(payload.student_id);
      const subj = subjectToBytes32(payload.subject);
      const total = await contract.totalSessions(subj);
      const present = await contract.presentSessions(subj, studentId);
      const pct = await contract.attendancePercent(subj, studentId);
      console.log(JSON.stringify({
        ok: true,
        total_sessions: Number(total),
        present_sessions: Number(present),
        attendance_percent: Number(pct)
      }));
      return;
    }

    console.log(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message || String(err) }));
});

