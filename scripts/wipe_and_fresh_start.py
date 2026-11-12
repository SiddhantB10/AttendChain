#!/usr/bin/env python3
"""
AttendChain - Full System Wipe & Fresh Slate
1. Clears all demo students, sessions, attendance, evidence, and face resets from MongoDB Atlas and SQLite.
2. Ensures faculty and course groups remain ready for new classes.
3. Deploys a brand-new AttendanceRegistry smart contract on Hedera Testnet for a 100% clean ledger state.
"""

import os
import sys
import sqlite3
import subprocess
from pathlib import Path

# Add project root to sys.path
root_dir = str(Path(__file__).resolve().parent.parent)
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

import logging
from dotenv import load_dotenv

# Load .env file
load_dotenv(Path(root_dir) / ".env")

from backend.database.mongo_db import MongoDatabase
from backend.database.db import DEFAULT_DB_PATH

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("fresh_start")

def wipe_mongodb():
    mongo_uri = os.getenv("MONGODB_URI")
    db_name = os.getenv("MONGODB_DB_NAME", "Attendchain")
    if not mongo_uri:
        logger.info("No MONGODB_URI set, skipping MongoDB wipe.")
        return

    logger.info(f"Connecting to MongoDB Atlas database '{db_name}'...")
    from pymongo import MongoClient
    client = MongoClient(mongo_uri)
    db = client[db_name]

    # Wipe collections
    s_res = db.students.delete_many({})
    logger.info(f"Wiped {s_res.deleted_count} students from MongoDB.")

    ge_res = db.group_enrollments.delete_many({})
    logger.info(f"Wiped {ge_res.deleted_count} group enrollments from MongoDB.")

    sess_res = db.sessions.delete_many({})
    logger.info(f"Wiped {sess_res.deleted_count} sessions from MongoDB.")

    att_res = db.attendance.delete_many({})
    logger.info(f"Wiped {att_res.deleted_count} attendance records from MongoDB.")

    ev_res = db.evidence.delete_many({})
    logger.info(f"Wiped {ev_res.deleted_count} evidence records from MongoDB.")

    fr_res = db.face_resets.delete_many({})
    logger.info(f"Wiped {fr_res.deleted_count} face reset requests from MongoDB.")

    logger.info(f"MongoDB Atlas is now 100% FRESH and CLEAN (Students count: {db.students.count_documents({})}).")

def wipe_sqlite():
    db_path = Path(root_dir) / os.getenv("DATABASE_PATH", DEFAULT_DB_PATH)
    if not db_path.exists():
        logger.info(f"SQLite DB file {db_path} does not exist, skipping.")
        return

    logger.info(f"Wiping SQLite database at {db_path}...")
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    for tbl in ("students", "group_enrollments", "sessions", "attendance_records", "evidence_store", "face_resets"):
        try:
            cursor.execute(f"DELETE FROM {tbl}")
        except Exception:
            pass
    conn.commit()
    conn.close()
    logger.info("SQLite database is now 100% FRESH and CLEAN.")

def deploy_fresh_hedera_contract():
    logger.info("Deploying fresh AttendanceRegistry smart contract to Hedera Testnet...")
    cmd = ["npx", "hardhat", "run", "scripts/deploy.js", "--network", "hedera_testnet"]
    res = subprocess.run(cmd, cwd=root_dir, capture_output=True, text=True)
    if res.returncode != 0:
        logger.error(f"Failed to deploy fresh contract on Hedera: {res.stderr}\n{res.stdout}")
        sys.exit(1)
    logger.info(f"Fresh contract deployment output:\n{res.stdout}")

if __name__ == "__main__":
    print("=" * 70)
    print("       AttendChain - Full System Wipe & Fresh Slate Initiation        ")
    print("=" * 70)

    # 1. Wipe MongoDB
    wipe_mongodb()

    # 2. Wipe SQLite
    wipe_sqlite()

    # 3. Deploy fresh Hedera Contract
    deploy_fresh_hedera_contract()

    print("=" * 70)
    print("       SYSTEM IS NOW 100% FRESH, VIRGIN, AND READY!                   ")
    print("=" * 70)
