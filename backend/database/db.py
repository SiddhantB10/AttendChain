"""
SQLite Database Layer for AttendChain.
Stores off-chain private biometric templates, canonical JSON evidence, and student details.
Ensures zero PII is written to the blockchain.
"""

import os
import sqlite3
import json
import hashlib
import secrets
import string
import time
import re
from typing import Optional, List, Dict, Any, Tuple
import numpy as np

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "../data/attendchain.db")

def get_db_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    path = db_path or os.getenv("DATABASE_PATH", DEFAULT_DB_PATH)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def init_db(db_path: Optional[str] = None):
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # Students table (off-chain storage of PII and private biometric embedding)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS students (
        student_id TEXT PRIMARY KEY,
        roll_no TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        face_commitment TEXT NOT NULL,
        embedding BLOB NOT NULL,
        registered_at INTEGER NOT NULL
    )
    """)

    # Sessions table (cached local metadata)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        session_id INTEGER PRIMARY KEY,
        subject TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        faculty_address TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        tx_hash TEXT,
        closed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
    )
    """)

    # Attendance records table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        student_id TEXT NOT NULL,
        roll_no TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        tx_hash TEXT,
        timestamp INTEGER NOT NULL,
        match_score REAL NOT NULL,
        blink_count INTEGER NOT NULL,
        frames_analyzed INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions (session_id),
        FOREIGN KEY (student_id) REFERENCES students (student_id),
        UNIQUE(session_id, student_id)
    )
    """)

    # Canonical evidence store (stores raw canonical JSON matching the SHA-256 evidenceHash)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS evidence_store (
        evidence_hash TEXT PRIMARY KEY,
        canonical_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )
    """)

    # Faculty table (organization faculty/teachers)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS faculty (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        department TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )
    """)

    # Course Groups table (subject groups created by faculty with invite codes)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS course_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        subject_code TEXT NOT NULL,
        faculty_email TEXT NOT NULL,
        invite_code TEXT UNIQUE NOT NULL,
        department TEXT DEFAULT '',
        created_at INTEGER NOT NULL
    )
    """)

    # Group Enrollments table (students joined to groups via invite code)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS group_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        student_id TEXT NOT NULL,
        roll_no TEXT NOT NULL,
        enrolled_at INTEGER NOT NULL,
        FOREIGN KEY (group_id) REFERENCES course_groups (id),
        FOREIGN KEY (student_id) REFERENCES students (student_id),
        UNIQUE(group_id, student_id)
    )
    """)

    # Ensure group_id column exists in sessions table
    cursor.execute("PRAGMA table_info(sessions)")
    columns = [col[1] for col in cursor.fetchall()]
    if "group_id" not in columns:
        cursor.execute("ALTER TABLE sessions ADD COLUMN group_id INTEGER DEFAULT 0")

    # Ensure students table has auth and face lifecycle columns
    cursor.execute("PRAGMA table_info(students)")
    stu_cols = [col[1] for col in cursor.fetchall()]
    if "email" not in stu_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN email TEXT")
    if "password_hash" not in stu_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN password_hash TEXT")
    if "face_enrolled" not in stu_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN face_enrolled INTEGER DEFAULT 0")
    if "face_reset_status" not in stu_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN face_reset_status TEXT DEFAULT 'NONE'")
    if "face_reset_reason" not in stu_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN face_reset_reason TEXT DEFAULT ''")

    # Migrate existing students with demo credentials & status
    cursor.execute("""
        UPDATE students
        SET face_enrolled = 1
        WHERE embedding IS NOT NULL AND length(embedding) > 0 AND (face_enrolled = 0 OR face_enrolled IS NULL)
    """)
    cursor.execute("""
        UPDATE students
        SET email = LOWER(roll_no) || '@student.college.edu'
        WHERE email IS NULL OR email = ''
    """)
    cursor.execute("""
        UPDATE students
        SET password_hash = 'student123'
        WHERE password_hash IS NULL OR password_hash = ''
    """)
    cursor.execute("""
        UPDATE students
        SET face_reset_status = 'NONE'
        WHERE face_reset_status IS NULL OR face_reset_status = ''
    """)

    # Seed default faculty and initial course groups if empty
    cursor.execute("SELECT COUNT(*) FROM faculty")
    if cursor.fetchone()[0] == 0:
        now_ts = 1700000000
        cursor.execute(
            "INSERT INTO faculty (name, email, password_hash, department, created_at) VALUES (?, ?, ?, ?, ?)",
            ("Dr. Alan Turing", "faculty@college.edu", "faculty123", "Computer Science & Engineering", now_ts)
        )
        cursor.execute(
            "INSERT INTO faculty (name, email, password_hash, department, created_at) VALUES (?, ?, ?, ?, ?)",
            ("Prof. Margaret Hamilton", "hamilton@college.edu", "faculty123", "Software Engineering", now_ts)
        )

        # Faculty defaults initialized (no initial groups seeded so faculty can create fresh classes)
        pass

    # Link existing students into group 1 (CS301) and session 1 if needed
    try:
        cursor.execute("SELECT student_id, roll_no FROM students")
        existing_students = cursor.fetchall()
        for s in existing_students:
            cursor.execute(
                "INSERT OR IGNORE INTO group_enrollments (group_id, student_id, roll_no, enrolled_at) VALUES (1, ?, ?, ?)",
                (s[0], s[1], 1700000000)
            )
        cursor.execute("UPDATE sessions SET group_id = 1 WHERE (group_id = 0 OR group_id IS NULL) AND subject LIKE 'CS301%'")
    except Exception:
        pass

    conn.commit()
    conn.close()

def generate_invite_code(subject_code: str) -> str:
    """Generates a clean uppercase invite code, e.g. CS301-A9F2."""
    clean_prefix = "".join(c for c in subject_code.upper() if c.isalnum())[:5]
    suffix = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    return f"{clean_prefix}-{suffix}" if clean_prefix else f"GRP-{suffix}"

def compute_canonical_evidence(
    session_id: int,
    student_id: str,
    roll_no: str,
    match_score: float,
    blink_count: int,
    frames_analyzed: int,
    timestamp: int
) -> Tuple[str, str]:
    """
    Produces canonical JSON with sorted keys and no whitespace,
    and returns (0x-prefixed SHA-256 hex, canonical_json_str).
    """
    evidence_payload = {
        "blink_count": int(blink_count),
        "frames_analyzed": int(frames_analyzed),
        "match_score": round(float(match_score), 4),
        "roll_no": str(roll_no).strip().upper(),
        "session_id": int(session_id),
        "student_id": str(student_id).lower(),
        "timestamp": int(timestamp)
    }
    canonical_json = json.dumps(evidence_payload, sort_keys=True, separators=(',', ':'))
    evidence_hash_raw = hashlib.sha256(canonical_json.encode('utf-8')).hexdigest()
    evidence_hash = f"0x{evidence_hash_raw}"
    return evidence_hash, canonical_json

def compute_face_commitment(embedding: np.ndarray) -> str:
    """Computes SHA-256 commitment of the L2-normalized float32 embedding bytes."""
    norm_emb = embedding.astype(np.float32).tobytes()
    return f"0x{hashlib.sha256(norm_emb).hexdigest()}"

def compute_student_id(roll_no: str) -> str:
    """Computes keccak256(rollNo.strip().upper()) returned as 0x-prefixed hex string."""
    from eth_utils import keccak
    roll_bytes = roll_no.strip().upper().encode('utf-8')
    return f"0x{keccak(roll_bytes).hex()}"

def generate_next_student_roll(conn: sqlite3.Connection) -> str:
    cursor = conn.cursor()
    cursor.execute("SELECT roll_no FROM students")
    rows = cursor.fetchall()
    max_num = 0
    for r in rows:
        roll = str(r[0] if isinstance(r, (tuple, list)) else r["roll_no"]).strip().upper()
        m = re.search(r"AC(\d+)", roll, re.IGNORECASE)
        if not m:
            m = re.search(r"(\d+)", roll)
        if m:
            try:
                num = int(m.group(1))
                if num > max_num:
                    max_num = num
            except ValueError:
                pass
    next_num = max_num + 1
    return f"AC{next_num:03d}"

class Database:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or os.getenv("DATABASE_PATH", DEFAULT_DB_PATH)
        init_db(self.db_path)

    def _conn(self) -> sqlite3.Connection:
        return get_db_connection(self.db_path)

    def generate_next_student_roll(self) -> str:
        with self._conn() as conn:
            return generate_next_student_roll(conn)

    def create_student(self, name: str, email: str, password_hash: str) -> Dict[str, Any]:
        with self._conn() as conn:
            roll_no = generate_next_student_roll(conn)
            student_id = compute_student_id(roll_no)
            now_ts = int(time.time())
            conn.execute(
                """
                INSERT INTO students (student_id, roll_no, name, email, password_hash, face_commitment, embedding, registered_at, face_enrolled, face_reset_status, face_reset_reason)
                VALUES (?, ?, ?, ?, ?, '', X'', ?, 0, 'NONE', '')
                """,
                (student_id, roll_no, name.strip(), email.strip().lower(), password_hash, now_ts)
            )
            # Auto-enroll in Core Group 1 (CS301)
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO group_enrollments (group_id, student_id, roll_no, enrolled_at) VALUES (1, ?, ?, ?)",
                    (student_id, roll_no, now_ts)
                )
            except Exception:
                pass
            conn.commit()

            return {
                "student_id": student_id,
                "roll_no": roll_no,
                "name": name.strip(),
                "email": email.strip().lower(),
                "registered_at": now_ts,
                "face_enrolled": 0,
                "face_reset_status": "NONE"
            }

    def get_student_by_identifier(self, identifier: str) -> Optional[Dict[str, Any]]:
        clean_id = str(identifier).strip()
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT * FROM students 
                WHERE UPPER(roll_no) = UPPER(?) 
                   OR LOWER(email) = LOWER(?)
                   OR LOWER(student_id) = LOWER(?)
                """,
                (clean_id, clean_id, clean_id)
            ).fetchone()
            return dict(row) if row else None

    def update_student_password(self, roll_no: str, new_password_hash: str) -> bool:
        with self._conn() as conn:
            conn.execute(
                "UPDATE students SET password_hash = ? WHERE UPPER(roll_no) = UPPER(?)",
                (new_password_hash, roll_no.strip())
            )
            conn.commit()
            return True

    def update_student_face(self, student_id: str, face_commitment: str, embedding: np.ndarray) -> bool:
        emb_bytes = embedding.astype(np.float32).tobytes()
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE students 
                SET face_commitment = ?, embedding = ?, face_enrolled = 1, face_reset_status = 'NONE', face_reset_reason = ''
                WHERE LOWER(student_id) = LOWER(?)
                """,
                (face_commitment, emb_bytes, student_id.lower())
            )
            conn.commit()
            return True

    def request_face_reset(self, roll_no: str, reason: str = "") -> bool:
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE students
                SET face_reset_status = 'PENDING', face_reset_reason = ?
                WHERE UPPER(roll_no) = UPPER(?)
                """,
                (reason.strip(), roll_no.strip())
            )
            conn.commit()
            return True

    def get_pending_face_resets(self) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT student_id, roll_no, name, email, face_reset_reason, registered_at
                FROM students
                WHERE face_reset_status = 'PENDING'
                ORDER BY registered_at DESC
                """
            ).fetchall()
            return [dict(r) for r in rows]

    def approve_face_reset(self, roll_no: str) -> bool:
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE students
                SET face_reset_status = 'APPROVED', face_enrolled = 0, face_commitment = '', embedding = X''
                WHERE UPPER(roll_no) = UPPER(?)
                """,
                (roll_no.strip(),)
            )
            conn.commit()
            return True

    def reject_face_reset(self, roll_no: str) -> bool:
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE students
                SET face_reset_status = 'REJECTED'
                WHERE UPPER(roll_no) = UPPER(?)
                """,
                (roll_no.strip(),)
            )
            conn.commit()
            return True

    def insert_student(self, roll_no: str, name: str, embedding: np.ndarray, registered_at: int) -> Dict[str, Any]:
        student_id = compute_student_id(roll_no)
        commitment = compute_face_commitment(embedding)
        emb_bytes = embedding.astype(np.float32).tobytes()

        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO students (student_id, roll_no, name, face_commitment, embedding, registered_at, face_enrolled, face_reset_status)
                VALUES (?, ?, ?, ?, ?, ?, 1, 'NONE')
                """,
                (student_id, roll_no.strip().upper(), name.strip(), commitment, emb_bytes, registered_at)
            )
            conn.commit()

        return {
            "student_id": student_id,
            "roll_no": roll_no.strip().upper(),
            "name": name.strip(),
            "face_commitment": commitment,
            "registered_at": registered_at
        }

    def get_all_students(self) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT student_id, roll_no, name, face_commitment, registered_at FROM students ORDER BY registered_at DESC").fetchall()
            return [dict(r) for r in rows]

    def get_student_by_id(self, student_id: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT student_id, roll_no, name, face_commitment, registered_at FROM students WHERE LOWER(student_id) = LOWER(?)",
                (student_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_student_by_roll(self, roll_no: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM students WHERE UPPER(roll_no) = UPPER(?)",
                (roll_no.strip(),)
            ).fetchone()
            return dict(row) if row else None

    def get_all_embeddings(self) -> List[Tuple[str, str, str, np.ndarray]]:
        """Returns list of (student_id, roll_no, name, embedding_array). Only enrolled faces."""
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT student_id, roll_no, name, embedding 
                FROM students 
                WHERE (face_enrolled = 1 OR (embedding IS NOT NULL AND length(embedding) > 0))
                  AND (face_reset_status IS NULL OR face_reset_status != 'APPROVED')
                """
            ).fetchall()
            result = []
            for r in rows:
                if r["embedding"]:
                    emb = np.frombuffer(r["embedding"], dtype=np.float32)
                    result.append((r["student_id"], r["roll_no"], r["name"], emb))
            return result

    def insert_session(
        self,
        session_id: int,
        subject: str,
        duration_seconds: int,
        faculty_address: str,
        start_time: int,
        end_time: int,
        tx_hash: str,
        group_id: int = 0
    ):
        with self._conn() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sessions (session_id, subject, duration_seconds, faculty_address, start_time, end_time, tx_hash, closed, created_at, group_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (session_id, subject.strip().upper(), duration_seconds, faculty_address, start_time, end_time, tx_hash, start_time, group_id)
            )
            conn.commit()

    def close_session(self, session_id: int):
        with self._conn() as conn:
            conn.execute("UPDATE sessions SET closed = 1 WHERE session_id = ?", (session_id,))
            conn.commit()

    def get_sessions(self, active_only: bool = False, current_timestamp: Optional[int] = None) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            if active_only:
                now_ts = current_timestamp or 0
                rows = conn.execute(
                    "SELECT * FROM sessions WHERE closed = 0 AND end_time > ? ORDER BY session_id DESC",
                    (now_ts,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM sessions ORDER BY session_id DESC").fetchall()
            return [dict(r) for r in rows]

    def get_session(self, session_id: int) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
            return dict(row) if row else None

    def record_attendance(
        self,
        session_id: int,
        student_id: str,
        roll_no: str,
        evidence_hash: str,
        canonical_json: str,
        tx_hash: str,
        timestamp: int,
        match_score: float,
        blink_count: int,
        frames_analyzed: int
    ):
        with self._conn() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO evidence_store (evidence_hash, canonical_json, created_at)
                VALUES (?, ?, ?)
                """,
                (evidence_hash.lower(), canonical_json, timestamp)
            )
            conn.execute(
                """
                INSERT INTO attendance_records (
                    session_id, student_id, roll_no, evidence_hash, tx_hash,
                    timestamp, match_score, blink_count, frames_analyzed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    student_id.lower(),
                    roll_no.strip().upper(),
                    evidence_hash.lower(),
                    tx_hash,
                    timestamp,
                    match_score,
                    blink_count,
                    frames_analyzed
                )
            )
            conn.commit()

    def get_attendance_for_session(self, session_id: int) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT a.*, s.name
                FROM attendance_records a
                JOIN students s ON LOWER(a.student_id) = LOWER(s.student_id)
                WHERE a.session_id = ?
                ORDER BY a.timestamp ASC
                """,
                (session_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def has_recorded_attendance(self, session_id: int, student_id: str) -> bool:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM attendance_records WHERE session_id = ? AND LOWER(student_id) = LOWER(?)",
                (session_id, student_id)
            ).fetchone()
            return row is not None

    def get_evidence_json(self, evidence_hash: str) -> Optional[str]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT canonical_json FROM evidence_store WHERE LOWER(evidence_hash) = LOWER(?)",
                (evidence_hash,)
            ).fetchone()
            return row["canonical_json"] if row else None

    def get_all_attendance_records(self) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM attendance_records ORDER BY id ASC").fetchall()
            return [dict(r) for r in rows]

    def get_attendance_records_for_student(self, student_id: str) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("""
                SELECT ar.*, s.group_id, cg.name as group_name, cg.subject_code, cg.faculty_name
                FROM attendance_records ar
                LEFT JOIN sessions s ON ar.session_id = s.session_id
                LEFT JOIN course_groups cg ON s.group_id = cg.id
                WHERE LOWER(ar.student_id) = LOWER(?)
                ORDER BY ar.timestamp DESC
            """, (student_id.strip(),)).fetchall()
            return [dict(r) for r in rows]

    # --- Organization Faculty Methods ---

    def add_faculty(self, name: str, email: str, password_hash: str, department: str = "") -> Dict[str, Any]:
        now_ts = int(time.time())
        with self._conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO faculty (name, email, password_hash, department, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (name.strip(), email.strip().lower(), password_hash, department.strip(), now_ts)
            )
            conn.commit()
            faculty_id = cursor.lastrowid
        return {
            "id": faculty_id,
            "name": name.strip(),
            "email": email.strip().lower(),
            "department": department.strip(),
            "created_at": now_ts
        }

    def get_faculty_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT id, name, email, password_hash, department, created_at FROM faculty WHERE LOWER(email) = LOWER(?)",
                (email.strip(),)
            ).fetchone()
            return dict(row) if row else None

    def get_all_faculty(self) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT f.id, f.name, f.email, f.department, f.created_at,
                       COUNT(DISTINCT g.id) AS total_groups
                FROM faculty f
                LEFT JOIN course_groups g ON LOWER(f.email) = LOWER(g.faculty_email)
                GROUP BY f.id
                ORDER BY f.id ASC
                """
            ).fetchall()
            return [dict(r) for r in rows]

    # --- Course Groups & Invite Code Methods ---

    def create_group(
        self,
        name: str,
        subject_code: str,
        faculty_email: str,
        department: str = "",
        invite_code: Optional[str] = None
    ) -> Dict[str, Any]:
        now_ts = int(time.time())
        code = invite_code or generate_invite_code(subject_code)

        with self._conn() as conn:
            # Ensure unique invite code
            for _ in range(5):
                existing = conn.execute("SELECT 1 FROM course_groups WHERE invite_code = ?", (code,)).fetchone()
                if not existing:
                    break
                code = generate_invite_code(subject_code)

            cursor = conn.execute(
                """
                INSERT INTO course_groups (name, subject_code, faculty_email, invite_code, department, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (name.strip(), subject_code.strip().upper(), faculty_email.strip().lower(), code, department.strip(), now_ts)
            )
            conn.commit()
            group_id = cursor.lastrowid

        return {
            "id": group_id,
            "name": name.strip(),
            "subject_code": subject_code.strip().upper(),
            "faculty_email": faculty_email.strip().lower(),
            "invite_code": code,
            "department": department.strip(),
            "created_at": now_ts
        }

    def get_group_by_id(self, group_id: int) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT g.*, f.name as faculty_name
                FROM course_groups g
                LEFT JOIN faculty f ON LOWER(g.faculty_email) = LOWER(f.email)
                WHERE g.id = ?
                """,
                (group_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_group_by_invite_code(self, invite_code: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT g.*, f.name as faculty_name
                FROM course_groups g
                LEFT JOIN faculty f ON LOWER(g.faculty_email) = LOWER(f.email)
                WHERE UPPER(g.invite_code) = UPPER(?)
                """,
                (invite_code.strip(),)
            ).fetchone()
            return dict(row) if row else None

    def get_groups_by_faculty(self, faculty_email: str) -> List[Dict[str, Any]]:
        now_ts = int(time.time())
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT g.*,
                       (SELECT COUNT(*) FROM group_enrollments WHERE group_id = g.id) AS enrolled_count,
                       (SELECT COUNT(*) FROM sessions WHERE group_id = g.id) AS total_sessions,
                       s.session_id AS active_session_id,
                       s.end_time AS active_end_time,
                       s.start_time AS active_start_time
                FROM course_groups g
                LEFT JOIN sessions s ON s.group_id = g.id AND s.closed = 0 AND s.end_time > ?
                WHERE LOWER(g.faculty_email) = LOWER(?)
                ORDER BY g.id ASC
                """,
                (now_ts, faculty_email.strip())
            ).fetchall()

            result = []
            for r in rows:
                d = dict(r)
                if d.get("active_session_id"):
                    d["active_session"] = {
                        "session_id": d["active_session_id"],
                        "start_time": d["active_start_time"],
                        "end_time": d["active_end_time"],
                        "remaining_seconds": max(0, d["active_end_time"] - now_ts)
                    }
                else:
                    d["active_session"] = None

                result.append(d)
            return result

    def get_all_groups(self) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT g.*, f.name AS faculty_name,
                       (SELECT COUNT(*) FROM group_enrollments WHERE group_id = g.id) AS enrolled_count,
                       (SELECT COUNT(*) FROM sessions WHERE group_id = g.id) AS total_sessions
                FROM course_groups g
                LEFT JOIN faculty f ON LOWER(g.faculty_email) = LOWER(f.email)
                ORDER BY g.id ASC
                """
            ).fetchall()
            return [dict(r) for r in rows]

    # --- Group Enrollment Methods ---

    def enroll_student_in_group(self, group_id: int, student_id: str, roll_no: str) -> bool:
        now_ts = int(time.time())
        with self._conn() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO group_enrollments (group_id, student_id, roll_no, enrolled_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (group_id, student_id.lower(), roll_no.strip().upper(), now_ts)
                )
                conn.commit()
                return True
            except sqlite3.IntegrityError:
                return False

    def is_student_in_group(self, group_id: int, student_id: str) -> bool:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM group_enrollments WHERE group_id = ? AND LOWER(student_id) = LOWER(?)",
                (group_id, student_id.strip())
            ).fetchone()
            return row is not None

    def get_students_in_group(self, group_id: int) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT ge.enrolled_at, s.student_id, s.roll_no, s.name, s.face_commitment,
                       (SELECT COUNT(DISTINCT a.session_id)
                        FROM attendance_records a
                        JOIN sessions sess ON a.session_id = sess.session_id
                        WHERE sess.group_id = ge.group_id AND LOWER(a.student_id) = LOWER(s.student_id)
                       ) AS attended_sessions,
                       (SELECT COUNT(*) FROM sessions WHERE group_id = ge.group_id) AS total_sessions
                FROM group_enrollments ge
                JOIN students s ON LOWER(ge.student_id) = LOWER(s.student_id)
                WHERE ge.group_id = ?
                ORDER BY s.roll_no ASC
                """,
                (group_id,)
            ).fetchall()

            result = []
            for r in rows:
                d = dict(r)
                total = d["total_sessions"]
                attended = d["attended_sessions"]
                pct = (attended * 100 // total) if total > 0 else 100
                d["attendance_percent"] = pct
                d["is_defaulter"] = pct < 75

                result.append(d)
            return result

    def get_groups_for_student(self, student_id: str) -> List[Dict[str, Any]]:
        now_ts = int(time.time())
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT g.*, f.name AS faculty_name, ge.enrolled_at,
                       (SELECT COUNT(*) FROM sessions WHERE group_id = g.id) AS total_sessions,
                       (SELECT COUNT(DISTINCT a.session_id)
                        FROM attendance_records a
                        JOIN sessions sess ON a.session_id = sess.session_id
                        WHERE sess.group_id = g.id AND LOWER(a.student_id) = LOWER(?)
                       ) AS attended_sessions,
                       s.session_id AS active_session_id,
                       s.end_time AS active_end_time,
                       s.start_time AS active_start_time
                FROM group_enrollments ge
                JOIN course_groups g ON ge.group_id = g.id
                LEFT JOIN faculty f ON LOWER(g.faculty_email) = LOWER(f.email)
                LEFT JOIN sessions s ON s.group_id = g.id AND s.closed = 0 AND s.end_time > ?
                WHERE LOWER(ge.student_id) = LOWER(?)
                ORDER BY g.id ASC
                """,
                (student_id.lower(), now_ts, student_id.lower())
            ).fetchall()

            result = []
            for r in rows:
                d = dict(r)
                total = d["total_sessions"]
                attended = d["attended_sessions"]
                pct = (attended * 100 // total) if total > 0 else 100
                d["attendance_percent"] = pct
                d["is_defaulter"] = pct < 75

                if d.get("active_session_id"):
                    # Check if student already marked attendance for this active session
                    already_marked = self.has_recorded_attendance(d["active_session_id"], student_id)
                    d["active_session"] = {
                        "session_id": d["active_session_id"],
                        "subject": d["subject_code"],
                        "start_time": d["active_start_time"],
                        "end_time": d["active_end_time"],
                        "remaining_seconds": max(0, d["active_end_time"] - now_ts),
                        "already_marked": already_marked
                    }
                else:
                    d["active_session"] = None

                # Query most recent session for this group to check last lecture status
                last_sess = conn.execute(
                    "SELECT session_id, closed, end_time FROM sessions WHERE group_id = ? ORDER BY session_id DESC LIMIT 1",
                    (d["id"],)
                ).fetchone()
                if last_sess:
                    d["last_session_id"] = last_sess["session_id"]
                    d["last_session_marked"] = self.has_recorded_attendance(last_sess["session_id"], student_id)
                else:
                    d["last_session_id"] = None
                    d["last_session_marked"] = None

                result.append(d)
            return result

