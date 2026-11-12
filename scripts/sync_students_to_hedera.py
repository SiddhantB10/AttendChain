#!/usr/bin/env python3
"""
Sync enrolled students from MongoDB/SQLite to Hedera Smart Contract.
Ensures that all students with biometrics can mark attendance on Hedera.
"""

import os
import sys
from pathlib import Path

# Add project root to sys.path
root_dir = str(Path(__file__).resolve().parent.parent)
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

import logging
from backend.database import get_database
from backend.chain import get_chain_adapter

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sync_hedera")

def sync():
    db = get_database()
    chain = get_chain_adapter()

    health = chain.get_health()
    logger.info(f"Chain Mode: {health.get('mode')} | Contract: {health.get('contract_address')}")

    if not health.get("contract_deployed") and health.get("mode") == "hedera":
        logger.error("Hedera contract is not deployed! Run `node scripts/setup_hedera.js` first.")
        sys.exit(1)

    students = db.get_all_students()
    logger.info(f"Total students in database: {len(students)}")

    synced = 0
    already_reg = 0
    skipped_no_face = 0

    for s in students:
        roll = s.get("roll_no")
        s_id = s.get("student_id")
        commitment = s.get("face_commitment")

        if not commitment or commitment == "0x" + "0" * 64:
            skipped_no_face += 1
            continue

        try:
            on_chain = chain.get_student(s_id)
            if on_chain.get("registered"):
                logger.info(f"Student {roll} ({s_id[:10]}...) is ALREADY registered on-chain.")
                already_reg += 1
                continue

            logger.info(f"Registering student {roll} ({s_id[:10]}...) on Hedera...")
            tx_hash = chain.register_student(s_id, commitment)
            logger.info(f"-> SUCCESS: Registered {roll} | Tx: {tx_hash}")
            synced += 1
        except Exception as e:
            logger.error(f"Failed to register student {roll}: {e}")

    logger.info(f"Sync complete! Synced: {synced}, Already on-chain: {already_reg}, Skipped (no face): {skipped_no_face}")

if __name__ == "__main__":
    sync()
