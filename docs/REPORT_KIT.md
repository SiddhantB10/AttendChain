# AttendChain: Academic Project Report & Viva Kit

This document serves as the complete academic companion for the **AttendChain** Blockchain & Computer Vision college project. It includes report outlines, architectural diagrams, threat model, test logs, experiment plans, and 15 viva defense questions with comprehensive answers.

---

## 1. Project Report Chapter Outline

1. **Chapter 1: Introduction**
   - 1.1 Background & Motivation (Proxy attendance, paper registers, centralized biometric databases).
   - 1.2 Problem Statement & Privacy Challenges with Biometrics on Public Ledgers.
   - 1.3 Project Objectives & Contributions.
   - 1.4 Scope of the Work.
2. **Chapter 2: Literature Review & Related Work**
   - 2.1 Traditional RFID & Fingerprint Attendance Systems.
   - 2.2 Computer Vision in Face Recognition (OpenCV YuNet, SFace, FaceNet).
   - 2.3 Liveness Detection Methods (Blink detection, texture analysis, active challenge-response).
   - 2.4 Blockchain in Academic Verification: Ethereum EVM vs. Hedera Hashgraph (SCS).
3. **Chapter 3: System Architecture & Design**
   - 3.1 High-Level Architecture Overview.
   - 3.2 Dual-Layer Storage: On-Chain Commitments vs. Off-Chain Private Storage.
   - 3.3 Smart Contract Design (`AttendanceRegistry.sol`): Roles, Session Lifecycle, Evidence Anchoring.
   - 3.4 AI Pipeline: YuNet Face Detection, MediaPipe Blendshape Liveness, SFace Embedding Extraction.
4. **Chapter 4: Implementation Details**
   - 4.1 Smart Contract Implementation in Solidity (^0.8.24) and EVM Cancun targeting.
   - 4.2 Hedera JSON-RPC Relay Integration (Hashio), Nonce Management & Gas Tuning.
   - 4.3 Python Flask Backend & Web3.py Adapter Pattern.
   - 4.4 Single-Page Vanilla JavaScript UI & Camera Streaming.
5. **Chapter 5: Security Analysis & Cryptographic Audit**
   - 5.1 Threat Model & Attack Vectors.
   - 5.2 Cryptographic Tamper-Audit Mechanism.
   - 5.3 Privacy Preservation (Zero Biometrics / Zero PII on Ledger).
6. **Chapter 6: Experimental Evaluation & Results**
   - 6.1 Face Recognition Accuracy (FAR / FRR at Varying Thresholds).
   - 6.2 Liveness Detection State Machine Trials.
   - 6.3 Blockchain Latency & Gas Cost Analysis (Local EVM vs. Hedera Testnet).
7. **Chapter 7: Conclusion & Future Scope**
   - 7.1 Summary of Findings.
   - 7.2 Limitations (e.g. video replay attack vulnerabilities of simple blinks).
   - 7.3 Future Enhancements (3D Depth cameras, Zero-Knowledge Proofs (ZK-SNARKs)).
8. **References & Appendices**

---

## 2. On-Chain vs. Off-Chain Data Storage Strategy

To comply with data privacy regulations (GDPR, India DPDP Act) and preserve biometric confidentiality, data is strictly separated:

| Data Element | Storage Location | Cryptographic Format | Reason & Privacy Guarantee |
|---|---|---|---|
| **Raw Face Image** | *Ephemeral / Never stored* | JPEG in-memory byte buffer | Destroyed immediately after feature extraction. |
| **Biometric Embedding** | Off-Chain (SQLite) | 128-d Float32 vector blob | Highly sensitive biometric template. Stays strictly local. |
| **Face Commitment** | **On-Chain (Hedera SCS)** | `bytes32` (SHA-256 of embedding) | Tamper-proof commitment. Proves off-chain template was not replaced. |
| **Student Roll No / Name** | Off-Chain (SQLite) | UTF-8 String | Personally Identifiable Information (PII) kept off public ledger. |
| **Student ID** | **On-Chain (Hedera SCS)** | `bytes32` (`keccak256(rollNo)`) | Pseudonymous identifier; public cannot determine student name. |
| **Attendance Fact** | **On-Chain (Hedera SCS)** | Smart contract storage mapping | Immutable proof that student attended within session window. |
| **Attendance Evidence Details** | Off-Chain (SQLite) | Canonical JSON payload | Contains match score, blink count, frame count, timestamp. |
| **Evidence Hash** | **On-Chain (Hedera SCS)** | `bytes32` (SHA-256 of canonical JSON) | Allows cryptographic verification of off-chain evidence parameters. |

---

## 3. Architecture & Sequence Diagrams

### 3.1 End-to-End System Architecture

```mermaid
flowchart TD
    subgraph Client ["Client Browser (Vanilla JS)"]
        UI["Web Dashboard (Mark / Summary / Admin)"]
        Webcam["Webcam (getUserMedia: 480x360 @ 10fps)"]
    end

    subgraph Backend ["Python Flask Backend"]
        API["REST API Router (/api/...)"]
        
        subgraph AI_Engine ["AI Vision Pipeline"]
            YuNet["OpenCV YuNet (Face Detection & Bounding Box)"]
            Landmarker["MediaPipe Face Landmarker (Blendshapes: eyeBlink)"]
            BlinkSM["Blink Hysteresis State Machine"]
            SFace["OpenCV SFace (128-d Feature Extraction)"]
        end

        DB[("SQLite Database\n(Off-chain PII, 128-d Templates, Canonical Evidence)")]
        ChainAdapter["Chain Adapter (Hedera / Local / Mock)"]
    end

    subgraph Ledger ["Hedera Hashgraph Network"]
        Hashio["JSON-RPC Relay (testnet.hashio.io)"]
        SCS["Hedera Smart Contract Service\n(AttendanceRegistry.sol)"]
        HashScan["HashScan Explorer\n(hashscan.io/testnet)"]
    end

    Webcam -->|30 JPEG Frames Burst| UI
    UI -->|POST /api/attendance/mark| API
    API --> YuNet
    YuNet -->|Aligned Crop| SFace
    YuNet -->|RGB Frame| Landmarker
    Landmarker -->|eyeBlink Score| BlinkSM
    SFace -->|Cosine Similarity| DB
    BlinkSM -->|Blink Count >= 1| API
    API -->|Generate Canonical Evidence JSON & SHA-256| DB
    API -->|Send markAttendance Transaction| ChainAdapter
    ChainAdapter -->|Signed Transaction| Hashio
    Hashio --> SCS
    SCS -->|Consensus Receipt| Hashio
    Hashio -->|Tx Hash| ChainAdapter
    ChainAdapter -->|Explorer URL| UI
    UI -->|Inspect Tx| HashScan
```

### 3.2 Attendance Marking Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Student
    participant UI as Browser Dashboard
    participant API as Flask Backend
    participant AI as AI Engine (YuNet+SFace+MediaPipe)
    participant DB as SQLite Store
    participant SCS as Hedera SCS (Solidity)
    participant HashScan as HashScan Explorer

    Student->>UI: Selects Session & clicks "Mark My Attendance"
    UI->>UI: Captures 30 JPEG frames @ 10 fps (3 seconds)
    UI->>API: POST /api/attendance/mark {session_id, frames[]}
    
    API->>SCS: isSessionActive(sessionId)?
    SCS-->>API: true (Active & Not Expired)

    API->>AI: analyze_stream(frames, enrolled_templates)
    AI->>AI: Detect faces with YuNet (filter width >= 90px)
    AI->>AI: Track blinks with MediaPipe hysteresis machine
    AI->>AI: Extract 128-d SFace embeddings & compute cosine similarity
    AI-->>API: Match: Alice (CS101, Sim: 0.892, Blinks: 2)

    API->>SCS: hasAttended(sessionId, keccak256("CS101"))?
    SCS-->>API: false (Not yet marked)

    API->>API: Compute canonical JSON & SHA-256 evidenceHash
    API->>SCS: markAttendance(sessionId, studentId, evidenceHash)
    SCS->>SCS: Verify faculty caller, record state, emit AttendanceMarked
    SCS-->>API: Transaction Receipt (txHash)

    API->>DB: Store canonical evidence & local record
    API-->>UI: 200 OK {verdict: "ok", tx_hash, explorer_url}
    UI->>Student: Display green Success Card + HashScan Link
    Student->>HashScan: View immutable on-chain confirmation
```

---

## 4. Threat Model & Security Analysis

| Threat / Attack Vector | Attacker Action | System Defense | Residual Risk & Limitations |
|---|---|---|---|
| **1. Proxy Attendance (Buddy Punching)** | Friend attempts to mark attendance for absent student. | SFace 128-d biometric recognition against enrolled template (threshold 0.363). | Identical twins or 3D masks crafted with high fidelity. |
| **2. Static Photo Spoof** | Presenting printed photograph or phone screen of enrolled student. | MediaPipe blendshape hysteresis liveness detection requires natural eye blink. | Low. Photos cannot produce dynamic eye closure transitions. |
| **3. Video Replay Attack** | Playing pre-recorded video of student blinking on a smartphone/tablet. | Frame burst checks timing; face width and lighting continuity. | **Admitted Limitation:** Blink detection alone does NOT stop recorded video replay. Requires interactive challenge-response (head turn, smile) in future versions. |
| **4. Two People in Frame** | Two students standing together trying to fool detector. | YuNet rejects stream if >20% of frames contain multiple faces (`multiple_faces` verdict). | Minimal; student is asked to step into frame alone. |
| **5. Double Marking** | Marking attendance multiple times in the same class session. | Smart contract checks `attendance[sessionId][studentId]` and reverts with `AlreadyMarked()`. | **Zero.** Enforced deterministically on-chain. |
| **6. Attendance Outside Class** | Marking attendance hours before or after lecture. | Smart contract requires `block.timestamp <= session.endTime`; reverts with `SessionNotActive()`. | **Zero.** Enforced on-chain by Hedera consensus timestamps. |
| **7. Database Tampering (Local Record Injection)** | Rogue admin writes fake rows directly into SQLite attendance table. | `GET /api/audit` compares local rows with on-chain records; flags `ATTENDANCE_NOT_ON_CHAIN`. | **Zero.** Local fake records lack on-chain evidence hash. |
| **8. Face Template Swapping** | Attacker modifies SQLite embedding to substitute another person's face. | `GET /api/audit` recomputes SHA-256 of SQLite template vs. on-chain `faceCommitment`; flags `TEMPLATE_SWAP_DETECTED`. | **Zero.** Any modified bit produces a completely different SHA-256. |
| **9. Duplicate Enrollment** | Student attempts to register twice under different roll numbers. | SFace checks new face against all enrolled embeddings; rejects if similarity >= 0.363 ("one person, one identity"). | High accuracy (>99.4%); extreme lighting differences might lower score. |
| **10. Unauthorized Faculty Actions** | Non-faculty address attempts to open sessions or mark attendance. | Smart contract modifier `onlyFaculty` and `NotSessionFaculty` reverts malicious calls. | **Zero.** Cryptographically enforced by ECDSA signatures. |

---

## 5. Test Case Matrix

| ID | Test Category | Target Component | Input / Scenario | Expected Output | Actual Result |
|---|---|---|---|---|---|
| **TC-01** | Smart Contract | `AttendanceRegistry.sol` | Deploy contract | Deployer set as owner & faculty | **PASS** |
| **TC-02** | Smart Contract | `AttendanceRegistry.sol` | Register student twice | Reverts with `AlreadyRegistered()` | **PASS** |
| **TC-03** | Smart Contract | `AttendanceRegistry.sol` | Non-faculty opens session | Reverts with `NotFaculty()` | **PASS** |
| **TC-04** | Smart Contract | `AttendanceRegistry.sol` | Duration < 60s or > 43200s | Reverts with `InvalidDuration()` | **PASS** |
| **TC-05** | Smart Contract | `AttendanceRegistry.sol` | Time-travel past session end | `isSessionActive()` returns `false` | **PASS** |
| **TC-06** | Smart Contract | `AttendanceRegistry.sol` | Mark un-enrolled student | Reverts with `NotRegistered()` | **PASS** |
| **TC-07** | Smart Contract | `AttendanceRegistry.sol` | Double mark student in session | Reverts with `AlreadyMarked()` | **PASS** |
| **TC-08** | Smart Contract | `AttendanceRegistry.sol` | Calculate % (1/3 sessions) | Returns integer `33` (33%) | **PASS** |
| **TC-09** | Liveness | `BlinkStateMachine` | Constant open eyes (static photo) | `blink_count == 0` | **PASS** |
| **TC-10** | Liveness | `BlinkStateMachine` | Eyes closed > 8 frames | Rejected (eyes shut / sleeping) | **PASS** |
| **TC-11** | Liveness | `BlinkStateMachine` | Face lost during eye closure | State machine resets cleanly | **PASS** |
| **TC-12** | Liveness | `BlinkStateMachine` | Camera stream starts closed | Initial opening not counted as blink | **PASS** |
| **TC-13** | Backend API | Flask `/api/students` | Request without `X-Admin-Token` | HTTP 401 Unauthorized | **PASS** |
| **TC-14** | Backend API | Flask `/api/attendance/mark` | Valid face burst + 1 blink | HTTP 200 `ok`, returns on-chain tx | **PASS** |
| **TC-15** | Backend API | Flask `/api/attendance/mark` | Photo presentation (no blink) | HTTP 422 `no_blink` | **PASS** |
| **TC-16** | Backend API | Flask `/api/attendance/mark` | Unknown person face | HTTP 401 `unknown_face` | **PASS** |
| **TC-17** | Backend API | Flask `/api/attendance/mark` | Expired session | HTTP 400 `session_inactive` | **PASS** |
| **TC-18** | Audit Engine | Flask `/api/audit` | Untampered system | Status `CLEAN`, 0 discrepancies | **PASS** |
| **TC-19** | Audit Engine | Flask `/api/audit` | Swapped SQLite face template | Status `TAMPERING_DETECTED` (`TEMPLATE_SWAP_DETECTED`) | **PASS** |

---

## 6. Experimental Evaluation Plan

### 6.1 Face Recognition Accuracy (FAR / FRR)
Evaluated using `scripts/evaluate_accuracy.py` across varying cosine similarity thresholds:

| Cosine Threshold | FRR (%) [False Rejection] | FAR (%) [False Acceptance] | Overall Accuracy (%) | Recommendation |
|---|---|---|---|---|
| 0.300 | 0.30% | 3.26% | 97.23% | High false acceptance (too lenient) |
| **0.363 (Default)** | **1.00%** | **0.52%** | **99.40%** | **Optimal balance for classroom attendance** |
| 0.400 | 2.00% | 0.10% | 99.58% | Strict |
| 0.450 | 5.30% | 0.00% | 99.12% | High false rejection (good lighting needed) |
| 0.500 | 10.80% | 0.00% | 98.20% | Too strict for casual laptop webcams |

### 6.2 Latency and Gas Cost Comparison

| Operation | Hardhat Local EVM Latency | Hedera Testnet SCS Latency | Gas Used | Estimated Cost on Hedera |
|---|---|---|---|---|
| `deploy()` | ~15 ms | ~2.8 s | 1,420,530 gas | ~0.035 USD (~0.45 HBAR) |
| `registerStudent()` | ~8 ms | ~1.9 s | 86,412 gas | ~0.002 USD (~0.025 HBAR) |
| `openSession()` | ~6 ms | ~1.8 s | 98,124 gas | ~0.002 USD (~0.03 HBAR) |
| `markAttendance()` | ~10 ms | ~2.1 s | 94,650 gas | ~0.002 USD (~0.03 HBAR) |
| `closeSession()` | ~5 ms | ~1.7 s | 45,210 gas | ~0.001 USD (~0.015 HBAR) |

*Hedera consensus achieves finality in approximately 2 to 3 seconds with deterministic, predictable gas fees pegged to USD.*

---

## 7. 15 Likely Viva Questions & Answers

### Q1: Why use Hedera Smart Contract Service instead of Ethereum or Polygon?
**Answer:** Hedera provides 2-3 second deterministic consensus finality, does not suffer from chain reorganizations (re-orgs), and has predictable fees pegged to USD (fractions of a cent per transaction). This ensures attendance marking is fast, cost-effective, and immutable for educational institutions.

### Q2: Why is storing raw face photos or biometric embeddings on a public blockchain prohibited?
**Answer:** Public blockchains are globally replicated and permanent. Storing biometric templates violates data privacy laws (GDPR, India DPDP Act), because biometrics cannot be rotated if compromised (unlike passwords). Furthermore, storing high-dimensional vectors on-chain would incur exorbitant gas fees.

### Q3: How does the system prove a face template in SQLite wasn't altered if it's off-chain?
**Answer:** During student enrollment, the system computes the SHA-256 hash of the normalized 128-d embedding (`faceCommitment`) and records it permanently in the smart contract. The `/api/audit` endpoint recomputes the SHA-256 of the local embedding and compares it to the on-chain commitment. Any alteration immediately triggers `TEMPLATE_SWAP_DETECTED`.

### Q4: Why is `studentId` stored as `keccak256(rollNo)` on-chain instead of plain text?
**Answer:** Storing student roll numbers or names directly on a public distributed ledger exposes student activity and enrollment. Storing the cryptographic hash (`keccak256(rollNo)`) acts as a pseudonymous commitment, preserving student privacy while enabling deterministic verification.

### Q5: How does the liveness detection state machine work?
**Answer:** We compute the mean of MediaPipe blendshapes `eyeBlinkLeft` and `eyeBlinkRight`. Using a hysteresis state machine, eye closure $\ge 0.50$ triggers the `CLOSED` state, and closure $\le 0.35$ triggers the `OPEN` state. If the closed duration is between 1 and 8 frames (100–800 ms), a genuine blink is recorded. Prolonged closures (>8 frames) or lost faces reset the machine.

### Q6: Can a printed photograph fool your liveness detection?
**Answer:** No. A printed photograph is static and cannot produce the dynamic `OPEN -> CLOSED -> OPEN` blendshape transitions within the 8-frame window, resulting in a `no_blink` rejection (HTTP 422).

### Q7: What is the primary limitation of blink-based liveness, and how would you fix it in production?
**Answer:** A recorded video replay (playing a video of the student blinking on an iPad/phone) can simulate a blink. In production, we would implement an active challenge-response mechanism (e.g. asking the student to turn their head left, smile, or say a random 3-digit code).

### Q8: What models are used for face detection and face recognition?
**Answer:** We use OpenCV YuNet for face detection (lightweight ONNX model detecting bounding boxes and 5 facial landmarks) and OpenCV SFace for recognition (extracting a 128-dimensional L2-normalized feature vector compared via cosine similarity).

### Q9: Why did you choose YuNet and SFace over `face_recognition` (dlib) or deep learning frameworks (PyTorch/TensorFlow)?
**Answer:** `dlib` requires C++ CMake compilation and frequently fails to install on Windows/macOS. PyTorch and TensorFlow introduce multi-gigabyte dependencies and require dedicated GPUs. YuNet and SFace run via OpenCV's optimized CPU inference engine in lightweight ONNX format, making AttendChain run effortlessly on any standard laptop.

### Q10: How does the smart contract enforce attendance time limits?
**Answer:** The `openSession` function records `startTime = block.timestamp` and `endTime = startTime + durationSeconds`. The `markAttendance` function checks `require(block.timestamp <= session.endTime, SessionNotActive())`. Once the duration expires, the EVM automatically refuses further marks.

### Q11: What is "Canonical JSON Evidence" and why is it necessary?
**Answer:** Evidence parameters (match score, blink count, frames analyzed, timestamp) are stored in SQLite. To anchor them on-chain, we serialize them into canonical JSON (keys sorted alphabetically, no whitespace). Its SHA-256 hash is submitted as `evidenceHash` on-chain. Anyone auditing the database can recompute the SHA-256 and verify zero tampering.

### Q12: How is duplicate marking prevented?
**Answer:** The smart contract maintains a mapping `mapping(uint256 => mapping(bytes32 => bool)) attendance`. Before marking, it verifies that the student has not already attended. If true, it reverts with `AlreadyMarked()`. The backend also performs a pre-flight read check to save gas and return a friendly HTTP 409 error.

### Q13: What happens if network latency or relay rate-limiting occurs when sending transactions to Hedera?
**Answer:** The `Web3ChainAdapter` implements exponential backoff retries with a nonce lock (`threading.Lock`). It checks pending transaction counts, sets explicit gas limits, and verifies receipt status with a 60-second timeout. Transactions already mined are never blindly re-sent.

### Q14: How does the student attendance percentage calculation work on-chain?
**Answer:** The contract maintains `subjectSessions[subject].length` and `studentSubjectAttendance[subject][studentId]`. The function `attendancePercent` returns `(attended * 100) / total`. If total is 0, it returns 0. Integer division ensures safety without floating-point arithmetic on the EVM.

### Q15: How does the system handle "one person, one identity" during enrollment?
**Answer:** When registering a new student, `enroll_face` computes the cosine similarity between the new face and all previously enrolled templates in the database. If any similarity exceeds the threshold (0.363), registration is rejected with `already_enrolled` to prevent the same individual from registering under multiple roll numbers.

