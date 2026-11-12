"""
Mock In-Memory Hash-Chained Blockchain Adapter for AttendChain.
Replicates full EVM AttendanceRegistry behavior for offline demos, CI tests, and fast UI development.
"""

import time
import hashlib
from typing import Dict, Any, Tuple, Optional, List
from .base import ChainAdapter

class MockChainAdapter(ChainAdapter):
    def __init__(self, owner_address: str = "0xMockDeployerOwner000000000000000000000001", chain_id: int = 296):
        self._mode = "mock"
        self._owner = owner_address
        self._faculty = {self._owner.lower(): True}
        self._contract_address = "0xMockAttendanceRegistryContract000000001"
        self._chain_id = chain_id
        self._block_height = 1000
        self._last_block_hash = "0x" + "00" * 32
        self._clock_offset = 0 # For time-travel in tests

        # State storage replicating contract mappings
        # studentId (0x-hex) => {'registered': bool, 'registered_at': int, 'face_commitment': str}
        self.students: Dict[str, Dict[str, Any]] = {}

        # sessionId (int) => Session dict
        self.sessions: Dict[int, Dict[str, Any]] = {}
        self.session_count_val = 0

        # subject_hex => list of session IDs
        self.subject_sessions: Dict[str, List[int]] = {}

        # (sessionId, studentId) => attended: bool
        self.attendance: Dict[Tuple[int, str], bool] = {}

        # (sessionId, studentId) => evidenceHash: str
        self.evidence_hashes: Dict[Tuple[int, str], str] = {}

        # (subject_hex, studentId) => attended_count: int
        self.student_subject_attendance: Dict[Tuple[str, str], int] = {}

    def sync_from_db(self, db):
        """Restores and synchronizes in-memory mock state from persistent SQLite database."""
        try:
            # 1. Sync Students
            for st in db.get_all_students():
                s_id = st["student_id"].lower()
                self.students[s_id] = {
                    "registered": True,
                    "registered_at": st["registered_at"],
                    "face_commitment": st["face_commitment"].lower()
                }

            # 2. Sync Sessions
            all_sessions = db.get_sessions()
            for s in all_sessions:
                s_id = s["session_id"]
                subj_hex = self._subject_to_hex(s["subject"])
                self.sessions[s_id] = {
                    "session_id": s_id,
                    "subject": subj_hex,
                    "subject_str": s["subject"],
                    "faculty": s.get("faculty_address") or self._owner,
                    "start_time": s["start_time"],
                    "end_time": s["end_time"],
                    "closed": bool(s.get("closed", False)),
                    "present_count": 0
                }
                if subj_hex not in self.subject_sessions:
                    self.subject_sessions[subj_hex] = []
                if s_id not in self.subject_sessions[subj_hex]:
                    self.subject_sessions[subj_hex].append(s_id)
                if s_id > self.session_count_val:
                    self.session_count_val = s_id

            # 3. Sync Attendance Records
            with db._conn() as conn:
                recs = conn.execute("SELECT session_id, student_id, evidence_hash FROM attendance_records").fetchall()
                for r in recs:
                    s_id = r["session_id"]
                    st_id = r["student_id"].lower()
                    pair_key = (s_id, st_id)
                    self.attendance[pair_key] = True
                    self.evidence_hashes[pair_key] = r["evidence_hash"].lower()
                    if s_id in self.sessions:
                        self.sessions[s_id]["present_count"] += 1
                    if s_id in self.sessions:
                        sub_hex = self.sessions[s_id]["subject"]
                        sub_key = (sub_hex, st_id)
                        self.student_subject_attendance[sub_key] = self.student_subject_attendance.get(sub_key, 0) + 1
        except Exception:
            pass

    @property
    def mode(self) -> str:
        return "mock"

    @property
    def contract_address(self) -> str:
        return self._contract_address

    def _now(self) -> int:
        return int(time.time()) + self._clock_offset

    def advance_time(self, seconds: int):
        """Simulates time travel for tests."""
        self._clock_offset += seconds

    def _generate_tx_hash(self, action: str, data: str) -> str:
        self._block_height += 1
        raw = f"{self._block_height}:{self._last_block_hash}:{action}:{data}:{self._now()}"
        tx_hash = "0x" + hashlib.sha256(raw.encode()).hexdigest()
        self._last_block_hash = tx_hash
        return tx_hash

    def _subject_to_hex(self, subject: str) -> str:
        """Converts text subject to 32-byte hex if not already formatted."""
        if subject.startswith("0x") and len(subject) == 66:
            return subject.lower()
        b = subject.encode('utf-8')
        if len(b) > 32:
            b = b[:32]
        return "0x" + b.hex().ljust(64, '0')

    def get_health(self) -> Dict[str, Any]:
        return {
            "mode": "mock",
            "network": "Hedera Testnet (Mock Engine)",
            "chain_id": self._chain_id,
            "contract_address": self._contract_address,
            "node_reachable": True,
            "contract_deployed": True,
            "wallet_address": self._owner,
            "wallet_balance_hbar": 500.0,
            "is_faculty": True,
            "block_height": self._block_height
        }

    def register_student(self, student_id_hex: str, face_commitment_hex: str) -> str:
        s_id = student_id_hex.lower()
        if s_id in self.students and self.students[s_id]["registered"]:
            raise ValueError("AlreadyRegistered: Student already registered on-chain")

        now_ts = self._now()
        self.students[s_id] = {
            "registered": True,
            "registered_at": now_ts,
            "face_commitment": face_commitment_hex.lower()
        }
        return self._generate_tx_hash("registerStudent", f"{s_id}:{face_commitment_hex}")

    def get_student(self, student_id_hex: str) -> Dict[str, Any]:
        s_id = student_id_hex.lower()
        if s_id in self.students:
            return self.students[s_id]
        return {
            "registered": False,
            "registered_at": 0,
            "face_commitment": "0x" + "00" * 32
        }

    def open_session(self, subject_str: str, duration_seconds: int) -> Tuple[int, str]:
        if not subject_str or subject_str.strip() == "":
            raise ValueError("InvalidSubject: subject cannot be empty")
        if duration_seconds < 60 or duration_seconds > 43200:
            raise ValueError("InvalidDuration: duration must be between 60s and 43200s")

        subject_hex = self._subject_to_hex(subject_str.strip().upper())
        self.session_count_val += 1
        s_id = self.session_count_val
        start = self._now()
        end = start + duration_seconds

        self.sessions[s_id] = {
            "subject": subject_hex,
            "subject_str": subject_str.strip().upper(),
            "faculty": self._owner,
            "start_time": start,
            "end_time": end,
            "closed": False,
            "present_count": 0
        }

        if subject_hex not in self.subject_sessions:
            self.subject_sessions[subject_hex] = []
        self.subject_sessions[subject_hex].append(s_id)

        tx = self._generate_tx_hash("openSession", f"{s_id}:{subject_hex}")
        return s_id, tx

    def close_session(self, session_id: int) -> str:
        if session_id <= 0 or session_id > self.session_count_val:
            raise ValueError("InvalidSession: session does not exist")
        sess = self.sessions[session_id]
        if sess["closed"]:
            raise ValueError("SessionNotActive: session already closed")

        sess["closed"] = True
        return self._generate_tx_hash("closeSession", str(session_id))

    def get_session(self, session_id: int) -> Dict[str, Any]:
        if session_id <= 0 or session_id > self.session_count_val:
            raise ValueError("InvalidSession: session does not exist")
        sess = self.sessions[session_id].copy()
        sess["is_active"] = self.is_session_active(session_id)
        return sess

    def is_session_active(self, session_id: int) -> bool:
        if session_id <= 0 or session_id > self.session_count_val:
            return False
        sess = self.sessions[session_id]
        if sess["closed"]:
            return False
        if self._now() > sess["end_time"]:
            return False
        return True

    def get_session_count(self) -> int:
        return self.session_count_val

    def mark_attendance(self, session_id: int, student_id_hex: str, evidence_hash_hex: str) -> str:
        if session_id <= 0 or session_id > self.session_count_val:
            raise ValueError("InvalidSession: session does not exist")
        sess = self.sessions[session_id]

        if not self.is_session_active(session_id):
            raise ValueError("SessionNotActive: session is closed or expired")

        s_id = student_id_hex.lower()
        if s_id not in self.students or not self.students[s_id]["registered"]:
            raise ValueError("NotRegistered: student is not registered on-chain")

        pair_key = (session_id, s_id)
        if self.attendance.get(pair_key, False):
            raise ValueError("AlreadyMarked: attendance already marked for this session")

        # Mark attendance
        self.attendance[pair_key] = True
        self.evidence_hashes[pair_key] = evidence_hash_hex.lower()
        sess["present_count"] += 1

        sub_key = (sess["subject"], s_id)
        self.student_subject_attendance[sub_key] = self.student_subject_attendance.get(sub_key, 0) + 1

        return self._generate_tx_hash("markAttendance", f"{session_id}:{s_id}:{evidence_hash_hex}")

    def has_attended(self, session_id: int, student_id_hex: str) -> bool:
        return self.attendance.get((session_id, student_id_hex.lower()), False)

    def get_evidence(self, session_id: int, student_id_hex: str) -> str:
        return self.evidence_hashes.get((session_id, student_id_hex.lower()), "0x" + "00" * 32)

    def get_student_summary(self, student_id_hex: str, subject_str: str) -> Dict[str, Any]:
        s_id = student_id_hex.lower()
        subject_hex = self._subject_to_hex(subject_str.strip().upper())

        total = len(self.subject_sessions.get(subject_hex, []))
        present = self.student_subject_attendance.get((subject_hex, s_id), 0)

        percent = 0 if total == 0 else (present * 100) // total
        return {
            "total_sessions": total,
            "present_sessions": present,
            "attendance_percent": percent
        }

    def get_explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://hashscan.io/testnet/transaction/{tx_hash}"

    def get_explorer_contract_url(self, contract_address: Optional[str] = None) -> str:
        addr = contract_address or self._contract_address
        return f"https://hashscan.io/testnet/contract/{addr}"

