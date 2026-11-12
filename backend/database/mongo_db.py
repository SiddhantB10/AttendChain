"""
MongoDB Database Adapter for AttendChain.
Supports MongoDB Atlas (mongodb+srv://) and standalone MongoDB instances.
Compatible with SQLite Database interface in backend/database/db.py.
Stores face embeddings as binary blobs (AES-256 encrypted at rest in Atlas)
and ensures full zero-knowledge on-chain compliance.
"""

import os
import time
import re
import logging
from typing import Dict, Any, List, Optional, Tuple
import numpy as np
import bson

try:
    import pymongo
    from pymongo import MongoClient, ASCENDING, DESCENDING
    PYMONGO_AVAILABLE = True
except ImportError:
    PYMONGO_AVAILABLE = False

from .db import (
    compute_canonical_evidence,
    compute_face_commitment,
    compute_student_id,
    generate_invite_code
)

logger = logging.getLogger("attendchain.mongo")


class MongoDatabase:
    """
    MongoDB Atlas adapter implementing identical interface to SQLite Database.
    """

    def __init__(self, uri: Optional[str] = None, db_name: Optional[str] = None, client: Any = None):
        if not PYMONGO_AVAILABLE:
            raise ImportError("pymongo is required for MongoDB support. Run 'pip install pymongo dnspython'.")

        self.uri = uri or os.getenv("MONGODB_URI", "")
        self.db_name = db_name or os.getenv("MONGODB_DB_NAME", "attendchain")

        if client is not None:
            self.client = client
        else:
            if not self.uri:
                raise ValueError("MONGODB_URI must be provided or set in environment variables.")
            # Set 5-second server selection timeout for responsive connectivity check
            self.client = MongoClient(self.uri, serverSelectionTimeoutMS=5000)

        self.db = self.client[self.db_name]
        self._init_indexes()
        self._seed_defaults()

    def _init_indexes(self):
        """Create necessary indexes for high-speed queries and uniqueness."""
        try:
            self.db.students.create_index("student_id", unique=True)
            self.db.students.create_index("roll_no", unique=True)
            self.db.students.create_index("email")

            self.db.faculty.create_index("email", unique=True)
            self.db.faculty.create_index("id", unique=True)

            self.db.course_groups.create_index("id", unique=True)
            self.db.course_groups.create_index("invite_code", unique=True)
            self.db.course_groups.create_index("faculty_email")

            self.db.group_enrollments.create_index([("group_id", ASCENDING), ("student_id", ASCENDING)], unique=True)
            self.db.group_enrollments.create_index("student_id")

            self.db.sessions.create_index("session_id", unique=True)
            self.db.sessions.create_index("group_id")

            self.db.attendance_records.create_index([("session_id", ASCENDING), ("student_id", ASCENDING)], unique=True)
            self.db.attendance_records.create_index("evidence_hash")

            self.db.evidence_store.create_index("evidence_hash", unique=True)
        except Exception as e:
            logger.warning(f"Mongo index creation notice: {e}")

    def _seed_defaults(self):
        """Seed default faculty and groups if database is fresh."""
        try:
            if self.db.faculty.count_documents({}) == 0:
                now_ts = 1700000000
                self.db.faculty.insert_many([
                    {
                        "id": 1,
                        "name": "Dr. Alan Turing",
                        "email": "faculty@college.edu",
                        "password_hash": "faculty123",
                        "department": "Computer Science & Engineering",
                        "created_at": now_ts
                    },
                    {
                        "id": 2,
                        "name": "Prof. Margaret Hamilton",
                        "email": "hamilton@college.edu",
                        "password_hash": "faculty123",
                        "department": "Software Engineering",
                        "created_at": now_ts
                    }
                ])

            if self.db.course_groups.count_documents({}) == 0:
                now_ts = 1700000000
                self.db.course_groups.insert_many([
                    {
                        "id": 1,
                        "name": "Distributed Systems & Blockchain",
                        "subject_code": "CS301",
                        "faculty_email": "faculty@college.edu",
                        "invite_code": "CS301-X7K",
                        "department": "Computer Science & Engineering",
                        "created_at": now_ts
                    },
                    {
                        "id": 2,
                        "name": "Artificial Intelligence & Neural Systems",
                        "subject_code": "CS402",
                        "faculty_email": "faculty@college.edu",
                        "invite_code": "CS402-V9M",
                        "department": "Computer Science & Engineering",
                        "created_at": now_ts
                    },
                    {
                        "id": 3,
                        "name": "Software Architecture & Cloud Native Systems",
                        "subject_code": "SE205",
                        "faculty_email": "hamilton@college.edu",
                        "invite_code": "SE205-Q4L",
                        "department": "Software Engineering",
                        "created_at": now_ts
                    }
                ])
        except Exception as e:
            logger.warning(f"Mongo default seed notice: {e}")

    # =========================================================================
    # Auto-Increment Helpers
    # =========================================================================

    def _get_next_sequence(self, collection_name: str, field_name: str = "id") -> int:
        col = self.db[collection_name]
        doc = col.find_one({}, sort=[(field_name, DESCENDING)])
        if doc and field_name in doc and isinstance(doc[field_name], int):
            return doc[field_name] + 1
        return 1

    def generate_next_student_roll(self) -> str:
        """Parses all existing student roll numbers and produces next sequentially (e.g. AC001, AC002, AC003)."""
        max_num = 0
        for doc in self.db.students.find({}, {"roll_no": 1}):
            roll = str(doc.get("roll_no", "")).strip().upper()
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

    # =========================================================================
    # Students API
    # =========================================================================

    def create_student(self, name: str, email: str, password_hash: str) -> Dict[str, Any]:
        """Creates a new registered student with auto-allotted roll number."""
        roll_no = self.generate_next_student_roll()
        student_id = compute_student_id(roll_no)
        registered_at = int(time.time())

        doc = {
            "student_id": student_id,
            "roll_no": roll_no,
            "name": name.strip(),
            "email": email.strip().lower(),
            "password_hash": password_hash,
            "face_commitment": "",
            "embedding": b"",
            "registered_at": registered_at,
            "face_enrolled": 0,
            "face_reset_status": "NONE",
            "face_reset_reason": ""
        }
        self.db.students.insert_one(doc)

        # Auto-enroll new student into Core Group 1 (CS301)
        self.enroll_student_in_group(1, student_id, roll_no)

        return {
            "student_id": student_id,
            "roll_no": roll_no,
            "name": name.strip(),
            "email": email.strip().lower(),
            "face_commitment": "",
            "face_enrolled": 0,
            "face_reset_status": "NONE",
            "face_reset_reason": "",
            "registered_at": registered_at
        }

    def get_student_by_identifier(self, identifier: str) -> Optional[Dict[str, Any]]:
        ident = identifier.strip().lower()
        ident_upper = identifier.strip().upper()

        doc = self.db.students.find_one({
            "$or": [
                {"roll_no": {"$regex": f"^{re.escape(ident_upper)}$", "$options": "i"}},
                {"email": {"$regex": f"^{re.escape(ident)}$", "$options": "i"}},
                {"student_id": {"$regex": f"^{re.escape(ident)}$", "$options": "i"}}
            ]
        })
        if not doc:
            return None
        doc.pop("_id", None)
        return doc

    def get_student_by_id(self, student_id: str) -> Optional[Dict[str, Any]]:
        doc = self.db.students.find_one({
            "student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}
        })
        if not doc:
            return None
        doc.pop("_id", None)
        return doc

    def get_student_by_roll(self, roll_no: str) -> Optional[Dict[str, Any]]:
        doc = self.db.students.find_one({
            "roll_no": {"$regex": f"^{re.escape(roll_no.strip())}$", "$options": "i"}
        })
        if not doc:
            return None
        doc.pop("_id", None)
        return doc

    def get_all_students(self) -> List[Dict[str, Any]]:
        cursor = self.db.students.find({}, {"_id": 0, "embedding": 0}).sort("registered_at", DESCENDING)
        return list(cursor)

    def get_all_embeddings(self) -> List[Tuple[str, str, str, np.ndarray]]:
        """Returns list of (student_id, roll_no, name, embedding_array)."""
        cursor = self.db.students.find({
            "$or": [
                {"face_enrolled": 1},
                {"embedding": {"$exists": True, "$ne": b""}}
            ],
            "face_reset_status": {"$ne": "APPROVED"}
        })

        result = []
        for r in cursor:
            raw_emb = r.get("embedding")
            if raw_emb:
                if isinstance(raw_emb, (bytes, bytearray)):
                    emb = np.frombuffer(raw_emb, dtype=np.float32)
                elif isinstance(raw_emb, bson.Binary):
                    emb = np.frombuffer(bytes(raw_emb), dtype=np.float32)
                else:
                    emb = np.array(raw_emb, dtype=np.float32)
                result.append((r["student_id"], r["roll_no"], r["name"], emb))
        return result

    def insert_student(self, roll_no: str, name: str, embedding: np.ndarray, registered_at: int) -> Dict[str, Any]:
        student_id = compute_student_id(roll_no)
        commitment = compute_face_commitment(embedding)
        emb_bytes = embedding.astype(np.float32).tobytes()

        doc = {
            "student_id": student_id,
            "roll_no": roll_no.strip().upper(),
            "name": name.strip(),
            "face_commitment": commitment,
            "embedding": emb_bytes,
            "registered_at": registered_at,
            "face_enrolled": 1,
            "face_reset_status": "NONE",
            "face_reset_reason": "",
            "email": f"{roll_no.strip().lower()}@student.college.edu",
            "password_hash": "student123"
        }
        self.db.students.update_one(
            {"student_id": student_id},
            {"$set": doc},
            upsert=True
        )

        return {
            "student_id": student_id,
            "roll_no": roll_no.strip().upper(),
            "name": name.strip(),
            "face_commitment": commitment,
            "registered_at": registered_at
        }

    def update_student_face(self, student_id: str, face_commitment: str, embedding: np.ndarray) -> bool:
        emb_bytes = embedding.astype(np.float32).tobytes()
        res = self.db.students.update_one(
            {"student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}},
            {
                "$set": {
                    "face_commitment": face_commitment,
                    "embedding": emb_bytes,
                    "face_enrolled": 1,
                    "face_reset_status": "NONE",
                    "face_reset_reason": ""
                }
            }
        )
        return res.matched_count > 0

    def update_student_password(self, roll_no: str, new_password_hash: str) -> bool:
        res = self.db.students.update_one(
            {"roll_no": {"$regex": f"^{re.escape(roll_no.strip())}$", "$options": "i"}},
            {"$set": {"password_hash": new_password_hash}}
        )
        return res.matched_count > 0

    def request_face_reset(self, roll_no: str, reason: str = "") -> bool:
        res = self.db.students.update_one(
            {"roll_no": {"$regex": f"^{re.escape(roll_no.strip())}$", "$options": "i"}},
            {"$set": {"face_reset_status": "PENDING", "face_reset_reason": reason.strip()}}
        )
        return res.matched_count > 0

    def get_pending_face_resets(self) -> List[Dict[str, Any]]:
        cursor = self.db.students.find(
            {"face_reset_status": "PENDING"},
            {"_id": 0, "embedding": 0}
        )
        return list(cursor)

    def approve_face_reset(self, roll_no: str) -> bool:
        res = self.db.students.update_one(
            {"roll_no": {"$regex": f"^{re.escape(roll_no.strip())}$", "$options": "i"}},
            {
                "$set": {
                    "face_reset_status": "APPROVED",
                    "face_enrolled": 0,
                    "face_commitment": "",
                    "embedding": b""
                }
            }
        )
        return res.matched_count > 0

    def reject_face_reset(self, roll_no: str) -> bool:
        res = self.db.students.update_one(
            {"roll_no": {"$regex": f"^{re.escape(roll_no.strip())}$", "$options": "i"}},
            {"$set": {"face_reset_status": "REJECTED"}}
        )
        return res.matched_count > 0

    # =========================================================================
    # Sessions API
    # =========================================================================

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
        doc = {
            "session_id": session_id,
            "subject": subject,
            "duration_seconds": duration_seconds,
            "faculty_address": faculty_address,
            "start_time": start_time,
            "end_time": end_time,
            "tx_hash": tx_hash,
            "closed": 0,
            "group_id": group_id,
            "created_at": int(time.time())
        }
        self.db.sessions.update_one(
            {"session_id": session_id},
            {"$set": doc},
            upsert=True
        )

    def close_session(self, session_id: int):
        self.db.sessions.update_one(
            {"session_id": session_id},
            {"$set": {"closed": 1}}
        )

    def get_sessions(self, active_only: bool = False, current_timestamp: Optional[int] = None) -> List[Dict[str, Any]]:
        now_ts = current_timestamp if current_timestamp is not None else int(time.time())
        query = {}
        if active_only:
            query = {"closed": 0, "end_time": {"$gt": now_ts}}
        cursor = self.db.sessions.find(query, {"_id": 0}).sort("session_id", DESCENDING)
        return list(cursor)

    def get_session(self, session_id: int) -> Optional[Dict[str, Any]]:
        doc = self.db.sessions.find_one({"session_id": session_id}, {"_id": 0})
        return doc

    # =========================================================================
    # Attendance Records API
    # =========================================================================

    def record_attendance(
        self,
        session_id: int,
        student_id: str,
        roll_no: str,
        evidence_hash: str,
        tx_hash: str,
        timestamp: int,
        match_score: float,
        blink_count: int,
        frames_analyzed: int,
        canonical_json: Optional[str] = None
    ) -> Dict[str, Any]:
        doc = {
            "session_id": session_id,
            "student_id": student_id,
            "roll_no": roll_no,
            "evidence_hash": evidence_hash,
            "tx_hash": tx_hash,
            "timestamp": timestamp,
            "match_score": match_score,
            "blink_count": blink_count,
            "frames_analyzed": frames_analyzed
        }
        self.db.attendance_records.update_one(
            {"session_id": session_id, "student_id": student_id},
            {"$set": doc},
            upsert=True
        )

        if canonical_json:
            self.db.evidence_store.update_one(
                {"evidence_hash": evidence_hash},
                {"$set": {"evidence_hash": evidence_hash, "canonical_json": canonical_json, "created_at": int(time.time())}},
                upsert=True
            )

        return doc

    def get_attendance_for_session(self, session_id: int) -> List[Dict[str, Any]]:
        cursor = self.db.attendance_records.find({"session_id": session_id}, {"_id": 0}).sort("timestamp", DESCENDING)
        return list(cursor)

    def has_recorded_attendance(self, session_id: int, student_id: str) -> bool:
        count = self.db.attendance_records.count_documents({
            "session_id": session_id,
            "student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}
        })
        return count > 0

    def get_evidence_json(self, evidence_hash: str) -> Optional[str]:
        doc = self.db.evidence_store.find_one({"evidence_hash": evidence_hash})
        return doc.get("canonical_json") if doc else None

    def get_all_attendance_records(self) -> List[Dict[str, Any]]:
        cursor = self.db.attendance_records.find({}, {"_id": 0}).sort("timestamp", DESCENDING)
        return list(cursor)

    def get_attendance_records_for_student(self, student_id: str) -> List[Dict[str, Any]]:
        cursor = self.db.attendance_records.find(
            {"student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}},
            {"_id": 0}
        ).sort("timestamp", DESCENDING)
        records = list(cursor)
        for r in records:
            sess = self.db.sessions.find_one({"session_id": r.get("session_id")})
            if sess:
                grp = self.db.course_groups.find_one({"id": sess.get("group_id")})
                if grp:
                    r["subject_code"] = grp.get("subject_code", "")
                    r["group_name"] = grp.get("name", "")
                    r["faculty_name"] = grp.get("faculty_name", "")
        return records

    # =========================================================================
    # Faculty API
    # =========================================================================

    def add_faculty(self, name: str, email: str, password_hash: str, department: str = "") -> Dict[str, Any]:
        next_id = self._get_next_sequence("faculty", "id")
        created_at = int(time.time())
        doc = {
            "id": next_id,
            "name": name.strip(),
            "email": email.strip().lower(),
            "password_hash": password_hash,
            "department": department.strip(),
            "created_at": created_at
        }
        self.db.faculty.insert_one(doc)
        doc.pop("_id", None)
        return doc

    def get_faculty_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        doc = self.db.faculty.find_one({
            "email": {"$regex": f"^{re.escape(email.strip())}$", "$options": "i"}
        }, {"_id": 0})
        return doc

    def get_all_faculty(self) -> List[Dict[str, Any]]:
        cursor = self.db.faculty.find({}, {"_id": 0}).sort("id", ASCENDING)
        result = []
        for r in cursor:
            # Augment with course count
            c_count = self.db.course_groups.count_documents({
                "faculty_email": {"$regex": f"^{re.escape(r['email'])}$", "$options": "i"}
            })
            r["course_count"] = c_count
            result.append(r)
        return result

    # =========================================================================
    # Course Groups API
    # =========================================================================

    def create_group(
        self,
        name: str,
        subject_code: str,
        faculty_email: str,
        invite_code: Optional[str] = None,
        department: str = ""
    ) -> Dict[str, Any]:
        if not invite_code:
            invite_code = generate_invite_code(subject_code)

        next_id = self._get_next_sequence("course_groups", "id")
        created_at = int(time.time())

        doc = {
            "id": next_id,
            "name": name.strip(),
            "subject_code": subject_code.strip().upper(),
            "faculty_email": faculty_email.strip().lower(),
            "invite_code": invite_code.strip().upper(),
            "department": department.strip(),
            "created_at": created_at
        }
        self.db.course_groups.insert_one(doc)
        doc.pop("_id", None)
        return doc

    def get_group_by_id(self, group_id: int) -> Optional[Dict[str, Any]]:
        doc = self.db.course_groups.find_one({"id": group_id}, {"_id": 0})
        return doc

    def get_group_by_invite_code(self, invite_code: str) -> Optional[Dict[str, Any]]:
        doc = self.db.course_groups.find_one({
            "invite_code": {"$regex": f"^{re.escape(invite_code.strip())}$", "$options": "i"}
        }, {"_id": 0})
        return doc

    def get_groups_by_faculty(self, faculty_email: str) -> List[Dict[str, Any]]:
        now_ts = int(time.time())
        cursor = self.db.course_groups.find({
            "faculty_email": {"$regex": f"^{re.escape(faculty_email.strip())}$", "$options": "i"}
        }, {"_id": 0}).sort("id", ASCENDING)

        result = []
        for g in cursor:
            g_id = g["id"]
            enrolled_count = self.db.group_enrollments.count_documents({"group_id": g_id})
            total_sessions = self.db.sessions.count_documents({"group_id": g_id})

            # Check active session
            active_s = self.db.sessions.find_one({
                "group_id": g_id,
                "closed": 0,
                "end_time": {"$gt": now_ts}
            }, {"_id": 0})

            g["enrolled_students_count"] = enrolled_count
            g["total_sessions"] = total_sessions
            g["active_session"] = active_s
            result.append(g)
        return result

    def get_all_groups(self) -> List[Dict[str, Any]]:
        cursor = self.db.course_groups.find({}, {"_id": 0}).sort("id", ASCENDING)
        result = []
        for g in cursor:
            enrolled = self.db.group_enrollments.count_documents({"group_id": g["id"]})
            g["enrolled_count"] = enrolled
            fac = self.get_faculty_by_email(g.get("faculty_email", ""))
            g["faculty_name"] = fac.get("name", "Prof. Instructor") if fac else "Prof. Instructor"
            result.append(g)
        return result

    def enroll_student_in_group(self, group_id: int, student_id: str, roll_no: str) -> bool:
        try:
            self.db.group_enrollments.update_one(
                {"group_id": group_id, "student_id": student_id},
                {
                    "$set": {
                        "group_id": group_id,
                        "student_id": student_id,
                        "roll_no": roll_no.strip().upper(),
                        "enrolled_at": int(time.time())
                    }
                },
                upsert=True
            )
            return True
        except Exception as e:
            logger.warning(f"Mongo enroll student notice: {e}")
            return False

    def is_student_in_group(self, group_id: int, student_id: str) -> bool:
        count = self.db.group_enrollments.count_documents({
            "group_id": group_id,
            "student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}
        })
        return count > 0

    def get_students_in_group(self, group_id: int) -> List[Dict[str, Any]]:
        enrollments = list(self.db.group_enrollments.find({"group_id": group_id}, {"_id": 0}))
        total_sessions = self.db.sessions.count_documents({"group_id": group_id})

        result = []
        for en in enrollments:
            stu = self.get_student_by_id(en["student_id"])
            if not stu:
                continue

            # Attended sessions in this group
            sessions_in_group = [s["session_id"] for s in self.db.sessions.find({"group_id": group_id}, {"session_id": 1})]
            attended_count = self.db.attendance_records.count_documents({
                "session_id": {"$in": sessions_in_group},
                "student_id": {"$regex": f"^{re.escape(en['student_id'])}$", "$options": "i"}
            })

            pct = (attended_count * 100 // total_sessions) if total_sessions > 0 else 100
            result.append({
                "student_id": stu["student_id"],
                "roll_no": stu["roll_no"],
                "name": stu["name"],
                "face_commitment": stu.get("face_commitment", ""),
                "enrolled_at": en.get("enrolled_at", 0),
                "attended_sessions": attended_count,
                "total_sessions": total_sessions,
                "attendance_percent": pct,
                "is_defaulter": pct < 75
            })
        return result

    def get_groups_for_student(self, student_id: str) -> List[Dict[str, Any]]:
        now_ts = int(time.time())
        enrollments = list(self.db.group_enrollments.find({
            "student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}
        }, {"_id": 0}))

        result = []
        for en in enrollments:
            g = self.get_group_by_id(en["group_id"])
            if not g:
                continue

            g_id = g["id"]
            fac = self.get_faculty_by_email(g.get("faculty_email", ""))
            g["faculty_name"] = fac.get("name", "Course Instructor") if fac else "Course Instructor"
            g["enrolled_at"] = en.get("enrolled_at", 0)

            total_sessions = self.db.sessions.count_documents({"group_id": g_id})
            sessions_in_group = [s["session_id"] for s in self.db.sessions.find({"group_id": g_id}, {"session_id": 1})]
            attended_sessions = self.db.attendance_records.count_documents({
                "session_id": {"$in": sessions_in_group},
                "student_id": {"$regex": f"^{re.escape(student_id.strip())}$", "$options": "i"}
            })

            pct = (attended_sessions * 100 // total_sessions) if total_sessions > 0 else 100
            g["total_sessions"] = total_sessions
            g["attended_sessions"] = attended_sessions
            g["attendance_percent"] = pct
            g["is_defaulter"] = pct < 75

            # Active session check
            active_s = self.db.sessions.find_one({
                "group_id": g_id,
                "closed": 0,
                "end_time": {"$gt": now_ts}
            }, {"_id": 0})

            if active_s:
                already_marked = self.has_recorded_attendance(active_s["session_id"], student_id)
                g["active_session"] = {
                    "session_id": active_s["session_id"],
                    "subject": g["subject_code"],
                    "start_time": active_s["start_time"],
                    "end_time": active_s["end_time"],
                    "remaining_seconds": max(0, active_s["end_time"] - now_ts),
                    "already_marked": already_marked
                }
            else:
                g["active_session"] = None

            # Last session status check
            last_s = self.db.sessions.find_one(
                {"group_id": g_id},
                sort=[("session_id", DESCENDING)]
            )
            if last_s:
                g["last_session_id"] = last_s["session_id"]
                g["last_session_marked"] = self.has_recorded_attendance(last_s["session_id"], student_id)
            else:
                g["last_session_id"] = None
                g["last_session_marked"] = None

            result.append(g)

        result.sort(key=lambda x: x["id"])
        return result

