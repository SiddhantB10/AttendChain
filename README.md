# AttendChain: AI Face Attendance on Hedera Smart Contract Service

[![Solidity](https://img.shields.io/badge/Solidity-^0.8.24-363636.svg)](https://soliditylang.org/)
[![Hedera](https://img.shields.io/badge/Hedera-Smart_Contract_Service_(Testnet)-0084FF.svg)](https://docs.hedera.com/)
[![OpenCV](https://img.shields.io/badge/OpenCV-YuNet_%2B_SFace-5C3EE8.svg)](https://opencv.org/)
[![MediaPipe](https://img.shields.io/badge/MediaPipe-Blink_Liveness-0097A7.svg)](https://developers.google.com/mediapipe)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AttendChain** is a production-grade, privacy-preserving, and tamper-evident college attendance system that combines computer vision (face recognition & blink liveness detection) with the **Hedera Smart Contract Service (SCS)**.

Built specifically for a Blockchain engineering mini-project, AttendChain runs end-to-end on any standard laptop with a webcam (Windows, macOS, Linux) without requiring external paid APIs, Docker, or deep learning GPUs.

---

## 1. Key Architectural Principles

1. **Zero Biometrics On-Chain:** Face embeddings (128-d vectors), personal names, and roll numbers are stored strictly in private off-chain storage (SQLite).
2. **On-Chain Cryptographic Integrity:** 
   - Student identity is anchored as `keccak256(rollNo)`.
   - Biometric template integrity is anchored as a SHA-256 commitment (`faceCommitment`).
   - Attendance events anchor a canonical JSON evidence hash (`evidenceHash`).
3. **Multi-Stage AI Pipeline:** 
   - **YuNet:** Real-time face detection & 5-point landmark alignment.
   - **MediaPipe:** Eye closure blendshapes with a hysteresis state machine for genuine blink verification.
   - **SFace:** 128-dimensional L2-normalized face embeddings matched via cosine similarity (threshold: `0.363`).
4. **Three Execution Modes (`CHAIN_MODE`):**
   - `mock`: In-memory hash-chained ledger for offline demos and zero-dependency unit tests.
   - `local`: Local Hardhat EVM node (`http://127.0.0.1:8545`).
   - `hedera`: Live Hedera Testnet via Hashio JSON-RPC Relay.

---

## 2. System Architecture

```mermaid
flowchart TD
    subgraph Browser ["Web Browser (Vanilla HTML5 / CSS / JS)"]
        Cam["Webcam Video Stream\n(480x360 @ 10fps)"]
        UI["Attendance Dashboard\n(Mark / My Attendance / Faculty Admin)"]
    end

    subgraph Backend ["Python 3.10+ Flask Server"]
        API["REST API Router (/api/...)"]
        
        subgraph Vision ["Computer Vision & Liveness"]
            YuNet["YuNet Detector (Width >= 90px)"]
            MediaPipe["MediaPipe Blendshapes (eyeBlinkLeft/Right)"]
            LivenessSM["Blink Hysteresis State Machine"]
            SFace["SFace Recognizer (128-d Cosine Match)"]
        end

        DB[("SQLite Private Store\n(Biometric Embeddings, PII, Canonical JSON)")]
        ChainAdapter["Chain Adapter (Nonce Lock, Gas Limits, Exponential Retries)"]
    end

    subgraph Hedera ["Hedera Network (Testnet)"]
        Relay["Hashio JSON-RPC Relay\n(testnet.hashio.io)"]
        SCS["AttendanceRegistry.sol\n(Hedera Smart Contract Service)"]
        HashScan["HashScan Explorer\n(hashscan.io/testnet)"]
    end

    Cam -->|30 JPEG Frames Burst (~3s)| UI
    UI -->|POST /api/attendance/mark| API
    API --> Vision
    Vision -->|Verify 1+ Blink & Match >= 0.363| API
    API -->|Generate Canonical JSON & SHA-256| DB
    API -->|Send markAttendance Transaction| ChainAdapter
    ChainAdapter -->|Signed EVM Tx (Chain ID 296)| Relay
    Relay --> SCS
    SCS -->|Consensus Receipt| Relay
    Relay -->|Tx Hash| ChainAdapter
    ChainAdapter -->|HashScan Link| UI
    UI -->|View Immutable Record| HashScan
```

---

## 3. Official Hedera Facts & Setup Guide

### 3.1 Network Details
- **Network:** Hedera Testnet
- **Chain ID:** `296` (Hex: `0x128`)
- **JSON-RPC Relay URL:** `https://testnet.hashio.io/api`
- **Block Explorer:** [https://hashscan.io/testnet/](https://hashscan.io/testnet/)
- **Hedera Developer Portal:** [https://portal.hedera.com/](https://portal.hedera.com/)

### 3.2 Creating and Funding a Hedera Testnet Account
1. Visit [portal.hedera.com](https://portal.hedera.com/) and create a free developer account.
2. Under the **Testnet** tab, create an account with an **ECDSA (secp256k1)** key.
   > **IMPORTANT:** Ensure you choose **ECDSA** (not ED25519) so the account has a standard EVM-compatible private key (`0x...`).
3. Click the faucet button on the portal to fund your account with **100 testnet HBAR**.
4. Copy the **EVM Private Key** (64 hex characters) and paste it into `.env` as `FACULTY_PRIVATE_KEY`.

### 3.3 Hedera EVM Quirks & Considerations
- **Explicit Gas Limits:** The JSON-RPC relay requires explicit gas limits on transactions (e.g., 300,000 to 350,000 for attendance calls; 3,000,000 for contract deployment).
- **Consensus Timestamps:** `block.timestamp` in Hedera EVM reflects the nanosecond consensus timestamp truncated to seconds.
- **Gas Price:** Dynamic gas price fetched from node via `eth_gasPrice` (typically 2,000 to 4,000 gwei).

---

## 4. Quickstart Installation & Run Steps

### Prerequisites
- **Node.js** v18+ or v20+ (`node -v`, `npm -v`)
- **Python** 3.10+ (`python --version`)
- A working webcam

### 4.1 Clone and Install Dependencies

```bash
# 1. Clone repository & enter directory
cd Attend

# 2. Install Node.js Hardhat dependencies
npm install

# 3. Install Python dependencies
python -m pip install -r requirements.txt

# 4. Download AI ONNX & MediaPipe models
python scripts/download_models.py
```

### 4.2 Configure Environment (`.env`)

Copy `.env.example` to `.env`:
```bash
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

For immediate offline evaluation without external credentials, leave `CHAIN_MODE=mock`.  
To run on Hedera Testnet, set:
```ini
CHAIN_MODE=hedera
FACULTY_PRIVATE_KEY=0xYOUR_HEDERA_ECDSA_PRIVATE_KEY
CONTRACT_ADDRESS=0xYOUR_DEPLOYED_CONTRACT_ADDRESS
```

### 4.3 Verify Connectivity

Run the diagnostic tool to check RPC connectivity and wallet status:
```bash
python scripts/check_hedera.py
# or
node scripts/check_hedera.js
```

---

## 5. Running Tests

### 5.1 Smart Contract Hardhat Tests (Local EVM)
Executes 24 unit tests covering every revert, custom error, time-travel window, and math calculation:
```bash
npx hardhat test
```

### 5.2 Python Backend Tests
Executes 19 unit and API tests using the mock chain and fake face engine:
```bash
python -m pytest backend/tests/
```

### 5.3 Automated End-to-End Demo Script
Executes the full college viva demo flow in under 5 seconds:
```bash
python scripts/e2e_demo.py
```

---

## 6. Running the Web Application

Start the Flask server:
```bash
python -m backend.app
```

Open your browser at:  
👉 **`http://localhost:5000`**

---

## 7. College Viva Demonstration Guide

Follow this sequence for an impressive, flawless viva presentation:

1. **Open Dashboard:** Navigate to `http://localhost:5000`. Show the live **Status Pill** displaying Mode, Network, and AI model readiness.
2. **Tab 3 (Faculty & Admin):**
   - Click "Start Enrol Cam".
   - Enter Roll No `CS101` and Name `Alice Johnson`.
   - Click **Capture & Register Student**. Show the transaction hash and the face commitment.
   - Register a second student `CS102` (`Bob Smith`).
3. **Open Attendance Session:**
   - In Tab 3, enter Subject `CS301_BLOCKCHAIN` and select `10 Minutes (600 s)`.
   - Click **Open On-Chain Session**.
4. **Tab 1 (Mark Attendance):**
   - Select the active session from the dropdown.
   - Click "Start Camera", align face in the guide oval, and click **Mark My Attendance**.
   - Show the 3-second progress bar (capturing 30 frames at 10 fps).
   - Show the green **Result Card** with Name, Similarity %, Blinks verified, and the **HashScan link**.
5. **Demonstrate Duplicate Prevention:**
   - Immediately click "Mark My Attendance" again.
   - Show the red card rejecting with `already_marked` (enforced on-chain).
6. **Demonstrate Liveness Spoof Prevention:**
   - Open Session #2.
   - Present a static photo on a phone without blinking.
   - Show the red card rejecting with `no_blink` (liveness check failed).
7. **Tab 2 (My Attendance):**
   - Enter `CS101` and click "Check Attendance".
   - Show the attendance percentage progress bar and eligibility status.
8. **Demonstrate Cryptographic Tamper Audit:**
   - In Tab 3, click **Run Full Audit**. Show the green **CLEAN (0 Discrepancies)** report.
   - Switch to terminal and simulate database tampering:
     ```bash
     python -c "import sqlite3; c=sqlite3.connect('backend/data/attendchain.db'); c.execute('UPDATE students SET embedding = x\'00\' WHERE roll_no=\'CS101\''); c.commit()"
     ```
   - Return to browser and click **Run Full Audit** again.
   - **Show the red alert flagging `TEMPLATE_SWAP_DETECTED`!** Explain to the examiner how the on-chain SHA-256 commitment exposed the tampered database.

---

## 8. Parameter Tuning Guide

| Parameter | Location | Default | Description & Recommended Values |
|---|---|---|---|
| `FACE_SIMILARITY_THRESHOLD` | `.env` | `0.363` | SFace cosine threshold. `0.30` (lenient), `0.363` (balanced: FAR 0.52%), `0.45` (strict). |
| `MIN_ATTENDANCE_PERCENT` | `.env` | `75` | Minimum attendance percentage threshold before flagging student as a defaulter. |
| `Burst Frame Count` | `app.js` | `30` frames | Number of frames captured per attendance attempt (~3 seconds at 10 fps). |
| `Blink Closed Threshold` | `liveness.py` | `0.50` | MediaPipe blendshape mean closure score to consider eyes closed. |
| `Blink Open Threshold` | `liveness.py` | `0.35` | MediaPipe blendshape mean closure score to consider eyes open. |
| `Max Blink Duration` | `liveness.py` | `8` frames | Maximum frames eyes can remain closed for a valid blink (prevents sleeping/photo). |

---

## 9. Troubleshooting Guide

| Issue | Root Cause | Solution |
|---|---|---|
| **Camera Access Denied** | Browser blocked webcam permissions | Ensure you are accessing `http://localhost:5000` (browser grants webcam only on localhost or HTTPS). Click the lock icon in address bar and allow camera. |
| **YuNet / SFace Not Found** | Model files not downloaded | Run `python scripts/download_models.py`. If network is blocked, download URLs manually into `backend/models/`. |
| **Insufficient HBAR / Out of Gas** | Hedera testnet wallet has 0 balance | Visit [portal.hedera.com](https://portal.hedera.com/) and request testnet HBAR to your ECDSA account. |
| **Relay Rate Limit / HTTP 429** | Free Hashio public relay throttled | Wait 5 seconds; `Web3ChainAdapter` automatically retries with exponential backoff. |
| **Session Expired Error** | Wall-clock time exceeded duration | Open a new session from the Faculty & Admin tab with 10 or 30 minutes duration. |

---

## 10. Known Limitations & Future Work

- **Video Replay Attacks:** While blink liveness detection prevents static photo attacks, it does not prevent playback of a pre-recorded video of a student blinking. Future iterations can integrate random challenge-response prompts (e.g. "turn head left", "smile").
- **Extreme Lighting:** Very dim lighting may degrade YuNet face detection or SFace cosine similarity.
- **Zero-Knowledge Proofs (ZK-SNARKs):** Future work can prove face match score $\ge \tau$ inside a zk-SNARK circuit for absolute zero-knowledge verification.

---

## 11. Project Deliverables & Academic Kit

For academic Viva preparation, report outlines, threat model analysis, and 15 viva defense questions, refer to [docs/REPORT_KIT.md](file:///c:/Users/siddh/Desktop/Attend/docs/REPORT_KIT.md).

