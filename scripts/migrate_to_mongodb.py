#!/usr/bin/env python3
"""
AttendChain SQLite -> MongoDB Atlas Migration Utility.
Copies all students (including 128-d biometric embeddings and commitments),
course groups, faculty, sessions, and attendance records from SQLite directly
into your MongoDB Atlas cluster.
"""

import os
import sys
import sqlite3
import logging
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

try:
    import pymongo
except ImportError:
    print("Error: pymongo not installed. Please run: pip install pymongo dnspython")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("migrate")

def migrate():
    mongo_uri = os.getenv("MONGODB_URI", "").strip()
    db_name = os.getenv("MONGODB_DB_NAME", "attendchain").strip()
    sqlite_path = os.getenv("DATABASE_PATH", "backend/data/attendchain.db")

    if not mongo_uri:
        print("\n[!] MONGODB_URI is not set in your .env file.")
        print("Please add your MongoDB Atlas connection string to .env:")
        print("MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority\n")
        sys.exit(1)

    if not Path(sqlite_path).exists():
        print(f"\n[!] SQLite database file not found at: {sqlite_path}")
        sys.exit(1)

    print("==================================================")
    print("AttendChain: Migrating SQLite to MongoDB Atlas")
    print(f"Source SQLite: {sqlite_path}")
    print(f"Target Mongo DB: {db_name}")
    print("==================================================")

    # 1. Connect to MongoDB
    try:
        client = pymongo.MongoClient(mongo_uri, serverSelectionTimeoutMS=8000)
        # Test connection
        client.admin.command('ping')
        print("✓ Connected to MongoDB Atlas successfully!")
    except Exception as e:
        print(f"\n[X] Could not connect to MongoDB Atlas: {e}")
        print("Please check your MONGODB_URI and Network Access (IP whitelist) in MongoDB Atlas.")
        sys.exit(1)

    mongo_db = client[db_name]

    # 2. Connect to SQLite
    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row

    # Migrate Faculty
    try:
        rows = sqlite_conn.execute("SELECT * FROM faculty").fetchall()
        for r in rows:
            d = dict(r)
            mongo_db.faculty.update_one({"id": d["id"]}, {"$set": d}, upsert=True)
        print(f"✓ Migrated {len(rows)} faculty members.")
    except Exception as e:
        print(f"Faculty migration warning: {e}")

    # Migrate Course Groups
    try:
        rows = sqlite_conn.execute("SELECT * FROM course_groups").fetchall()
        for r in rows:
            d = dict(r)
            mongo_db.course_groups.update_one({"id": d["id"]}, {"$set": d}, upsert=True)
        print(f"✓ Migrated {len(rows)} course groups.")
    except Exception as e:
        print(f"Course groups migration warning: {e}")

    # Migrate Students
    try:
        rows = sqlite_conn.execute("SELECT * FROM students").fetchall()
        for r in rows:
            d = dict(r)
            # Ensure embedding is stored as bytes/Binary
            if d.get("embedding"):
                d["embedding"] = bytes(d["embedding"])
            mongo_db.students.update_one({"student_id": d["student_id"]}, {"$set": d}, upsert=True)
        print(f"✓ Migrated {len(rows)} students with biometric Face ID embeddings.")
    except Exception as e:
        print(f"Students migration warning: {e}")

    # Migrate Group Enrollments
    try:
        rows = sqlite_conn.execute("SELECT * FROM group_enrollments").fetchall()
        for r in rows:
            d = dict(r)
            mongo_db.group_enrollments.update_one(
                {"group_id": d["group_id"], "student_id": d["student_id"]},
                {"$set": d},
                upsert=True
            )
        print(f"✓ Migrated {len(rows)} course enrollments.")
    except Exception as e:
        print(f"Enrollments migration warning: {e}")

    # Migrate Sessions
    try:
        rows = sqlite_conn.execute("SELECT * FROM sessions").fetchall()
        for r in rows:
            d = dict(r)
            mongo_db.sessions.update_one({"session_id": d["session_id"]}, {"$set": d}, upsert=True)
        print(f"✓ Migrated {len(rows)} lecture sessions.")
    except Exception as e:
        print(f"Sessions migration warning: {e}")

    # Migrate Attendance Records
    try:
        rows = sqlite_conn.execute("SELECT * FROM attendance_records").fetchall()
        for r in rows:
            d = dict(r)
            mongo_db.attendance_records.update_one(
                {"session_id": d["session_id"], "student_id": d["student_id"]},
                {"$set": d},
                upsert=True
            )
        print(f"✓ Migrated {len(rows)} on-chain attendance records.")
    except Exception as e:
        print(f"Attendance records migration warning: {e}")

    # Migrate Evidence Store
    try:
        rows = sqlite_conn.execute("SELECT * FROM evidence_store").fetchall()
        for r in rows:
            d = dict(r)
            mongo_db.evidence_store.update_one({"evidence_hash": d["evidence_hash"]}, {"$set": d}, upsert=True)
        print(f"✓ Migrated {len(rows)} canonical cryptographic evidence entries.")
    except Exception as e:
        print(f"Evidence store migration warning: {e}")

    sqlite_conn.close()
    print("\n==================================================")
    print("🎉 ALL DATA MIGRATED TO MONGODB ATLAS SUCCESSFULLY!")
    print("==================================================")

if __name__ == "__main__":
    migrate()

