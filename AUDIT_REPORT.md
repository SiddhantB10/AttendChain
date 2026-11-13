# AttendChain Codebase Audit & System Integrity Report

**Auditor:** Principal Software Engineer  
**Date:** November 13, 2026  
**Active Working Branch:** `audit/cleanup-20261113`  
**Base Commit:** `a1d37ac` (`main`)  
**Hedera Smart Contract:** `0x10337f8b29CE1F072bac09Ff62F88b7b3CF9f77a` (Chain ID 296, Testnet)  
**Database Backend:** MongoDB Atlas (`cluster0.uoq3app.mongodb.net`) with local SQLite fallback  

---

## 1. Project Map

- **Architecture:** Hybrid EVM-Blockchain + Cloud/Local Database + AI Biometrics.
  - **Smart Contract Layer (`contracts/AttendanceRegistry.sol`):** Solidity smart contract deployed on Hedera Smart Contract Service (EVM JSON-RPC Relay). Stores immutable student commitments, session states, attendance evidence hashes, and attendance counters.
  - **Backend API Layer (`backend/app.py`):** Flask REST API with CORS serving unified SSO authentication, course management, face scanning, and on-chain synchronization.
  - **Database Abstraction Layer (`backend/database/`):**
    - `mongo_db.py`: MongoDB Atlas client with collections: `students`, `faculties`, `course_groups`, `group_enrollments`, `sessions`, `attendance_records`, `face_resets`, `audit_logs`.
    - `db.py`: Local SQLite fallback with identical relational schema.
    - Factory selector (`backend/database/__init__.py`) based on `DATABASE_BACKEND` env var.
  - **Biometrics & AI Engine (`backend/ai/`):**
    - `face_engine.py`: OpenCV DNN (YuNet face detector + SFace recognizer, ONNX format) with MediaPipe facial landmark fallback.
    - `liveness.py`: Real-time EAR (Eye Aspect Ratio) active blink liveness detection state machine.
  - **Frontend SPA Layer (`backend/static/`):**
    - `index.html`: Responsive, academic portal interface with role-isolated dashboards (SSO Gateway, Student Portal, Faculty & Course Console, Central Admin Console).
    - `app.js`: Camera streaming, canvas HUD tracking, landmark alignment, REST API client, and cross-tab `BroadcastChannel` live sync.
    - `styles.css`: Pure modern CSS styling, theme variables, glassmorphic HUD overlays, modal dialogs.
  - **Testing & Scripts (`test/`, `backend/tests/`, `scripts/`):**
    - Hardhat test suite for Solidity smart contract logic (`test/AttendanceRegistry.test.js`).
    - Pytest test suite for backend API, database adapters, face engine, and liveness (`backend/tests/`).
    - Administrative automation and operational scripts (`scripts/`).

---

## 2. Baseline vs Final Results

| Test / Verification Area | Phase 0 Baseline | Phase 5 Final Verification | Status |
|---|---|---|---|
| **Hardhat Contract Tests** (`npx hardhat test`) | 24 passed / 24 total | 24 passed / 24 total | **PASS (100%)** |
| **Python Backend Tests** (`pytest backend/tests`) | 20 passed / 23 total (3 failures) | **23 passed / 23 total (0 failures)** | **PASS (100%)** |
| **Contract Compilation** (`npx hardhat compile`) | Clean | Clean | **PASS** |
| **Python AST / Syntax** | Clean | Clean | **PASS** |
| **JavaScript Syntax** (`node -c`) | Clean | Clean | **PASS** |
| **Live Server Health & Connectivity** | Healthy (`status: 200`) | Healthy (`status: 200`) | **PASS** |
| **Core Flows (E2E Verified via Script)** | 3 edge cases failed | **All 8 flows passed cleanly** | **PASS** |

---

## 3. Bugs Found and Fixed

### Bug 1: SQLite Fallback Query Crash (`no such column: cg.faculty_name`)
- **File:** `backend/database/db.py:580`
- **Root Cause:** In `get_attendance_records_for_student`, SQL query selected `cg.faculty_name`, but the `course_groups` schema stores `faculty_email`. Whenever a student loaded their dashboard on an installation using SQLite, SQLite raised `sqlite3.OperationalError: no such column: cg.faculty_name`, producing an unhandled 500 error.
- **Fix:** Joined `faculty f ON LOWER(cg.faculty_email) = LOWER(f.email)` and selected `f.name as faculty_name`.
- **Commit:** `8d31323`

### Bug 2: Session Active Check Bypass on Inactive/Expired Chain Sessions
- **File:** `backend/app.py:1222-1236`
- **Root Cause:** When `/api/attendance/mark` was called, if `sess` existed in the local DB, the code skipped `app.chain.is_session_active(session_id)`. If a session was expired on-chain or mock chain time was advanced, it bypassed the chain status check and proceeded directly to facial analysis, returning HTTP 422 ("poor_frames") instead of HTTP 400 ("session_inactive").
- **Fix:** Ensured both DB active state and chain smart-contract state are verified before proceeding to biometric analysis.
- **Commit:** `d657130`

### Bug 3: Outdated Roll Number Prefix Assertion in Mongo Student Lifecycle Test
- **File:** `backend/tests/test_mongo_db.py:16`
- **Root Cause:** The test asserted `stu["roll_no"].startswith("STU-")`, which reflected a legacy format before AttendChain adopted the standard `AC001`, `AC002` roll number sequence.
- **Fix:** Updated the assertion to `assert stu["roll_no"].startswith("AC")`.
- **Commit:** `1dedbe4`

### Bug 4: Login Response Shape Discrepancy & Hardcoded Defaulter Thresholds
- **Files:** `backend/app.py`, `backend/static/app.js`, `backend/database/db.py`, `backend/database/mongo_db.py`
- **Root Cause:** 
  1. `/api/auth/login` returned `"user": { ... }` for faculty and admin, while `app.js` expected `data.faculty` and `data.admin`. This caused `currentFacultyData` to be undefined on login, falling back to static placeholder names.
  2. Multiple queries hardcoded `pct < 75` rather than honoring the environment variable `MIN_ATTENDANCE_PERCENT` (default: 75), and students with 0 sessions were prone to false defaulter flags.
- **Fix:** 
  1. Standardized backend login responses to return both `"user"` and role-specific keys (`"faculty"`, `"admin"`), and updated `app.js` to accept `data.faculty || data.user` and `data.admin || data.user`.
  2. Replaced hardcoded `75` with `int(os.getenv("MIN_ATTENDANCE_PERCENT", "75"))` across backend controllers and database adapters, ensuring students with zero sessions default to `is_defaulter: False`.
  3. Added `"ok": True` to `/api/admin/overview` response payload.
- **Commit:** `a946b3b`

---

## 4. Connections Verified

- **Frontend to API Endpoints (Pass):**
  - All 28 frontend API calls in `backend/static/app.js` have been cross-referenced against registered Flask routes. All endpoints (`/api/auth/*`, `/api/student/*`, `/api/faculty/*`, `/api/admin/*`, `/api/sessions/*`, `/api/face/*`) matched in URL, HTTP method, payload structure, and response format.
- **Backend to Database Schema (Pass):**
  - Both MongoDB Atlas collections and SQLite relational tables mirror identical data models.
  - Group ID normalization (`int` vs `str`) operates smoothly across Atlas documents.
- **Auth & Protected Endpoints (Pass):**
  - Central Admin endpoints (`/api/admin/*`, `/api/audit`, etc.) require valid `X-Admin-Token` verified using constant-time string comparison (`hmac.compare_digest`).
  - Strict UI and tab navigation role guards prevent students from viewing admin/faculty controls, and prevent faculty/admin from viewing student profiles.
- **Environment Configuration (Pass):**
  - All environment variables referenced in code (`CHAIN_MODE`, `HEDERA_RPC_URL`, `HEDERA_CHAIN_ID`, `FACULTY_PRIVATE_KEY`, `CONTRACT_ADDRESS`, `ADMIN_TOKEN`, `HOST`, `PORT`, `MIN_ATTENDANCE_PERCENT`, `FACE_SIMILARITY_THRESHOLD`, `DATABASE_BACKEND`, `MONGODB_URI`, `MONGODB_DB_NAME`) exist in `.env.example` and `.env`.
- **Mathematical & Biometric Integrity (Pass):**
  - Canonical evidence generation (`compute_canonical_evidence`) produces deterministic SHA-256 hashes (`0x...`, 66 chars).
  - Attendance percentages use integer arithmetic (`(attended * 100 // total) if total > 0 else 100`) to eliminate floating point rounding inconsistencies.

---

## 5. Cleaned / Removed Items

In compliance with the **PRIME DIRECTIVE** ("Breaking working functionality is far worse than leaving clutter behind"):
- **Legacy Tabs Removed (Completed in previous session and confirmed clean):**
  - `#tab-kiosk` ("Classroom Biometric Terminal") and `#tab-register` ("Biometric Enrollment") navbar items and DOM sections were cleanly removed from `index.html`.
- **Zero Destructive Deletions:** No production files or dependencies were removed that could jeopardize Hedera testnet interactions, MediaPipe models, or ONNX runtimes.

---

## 6. Items Listed for Review (UNSURE)

1. **`@hashgraph/sdk` in `package.json`:**
   - **Finding:** Hardhat and `scripts/*.js` interact with Hedera via JSON-RPC Relay using `hre.ethers` rather than the native `@hashgraph/sdk`.
   - **Recommendation:** Keep `@hashgraph/sdk` installed unless you plan to remove all Hedera Consensus Service / native SDK extensions. It introduces zero runtime overhead to the Flask backend.
2. **Stray Key `n` in `.env`:**
   - **Finding:** A stray single-character key `n` was detected in `.env`.
   - **Recommendation:** Can be safely removed from `.env` during your next manual configuration review.

---

## 7. Risks & Known Issues

1. **Hedera Testnet Rate Limits:**
   - Public Hashio RPC endpoints (`https://testnet.hashio.io/api`) occasionally throttle concurrent JSON-RPC requests. The backend’s asynchronous background thread pattern for non-critical blockchain updates (`_bg_close_old`, `_bg_close_active`) successfully mitigates UI latency, keeping frontend operations under 20ms.
2. **Camera Permissions:**
   - Web browsers strictly require HTTPS (or `localhost` / `127.0.0.1`) to grant webcam access via `navigator.mediaDevices.getUserMedia`.

---

## 8. How to Undo Everything (Revert Instructions)

All audit work and bug fixes have been executed strictly on the isolated branch **`audit/cleanup-20261113`**. Your `main` branch remains untouched and at commit `a1d37ac`.

- **To inspect the changes on this branch:**
  ```bash
  git log -n 4 --stat
  git diff main..audit/cleanup-20261113
  ```

- **To merge these verified bug fixes into `main`:**
  ```bash
  git checkout main
  git merge audit/cleanup-20261113
  ```

- **To undo and switch back to `main` without merging:**
  ```bash
  git checkout main
  git branch -D audit/cleanup-20261113
  ```
