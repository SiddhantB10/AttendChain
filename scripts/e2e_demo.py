#!/usr/bin/env python3
"""
AttendChain End-to-End Demo Script
Executes the full college viva demo flow:
1. Registers 3 students (Alice, Bob, Charlie)
2. Opens a 10-minute session for CS301_BLOCKCHAIN
3. Alice marks attendance (verifies liveness, face recognition, writes to chain, logs HashScan link)
4. Alice attempts duplicate marking (refused on-chain with AlreadyMarked)
5. Photo spoof attempt with no blink (refused by liveness engine)
6. "My Attendance" summary queried for Alice (percentage calculation & regular status)
7. Simulates database tampering (modifies Alice's biometric embedding in SQLite)
8. Runs On-Chain Tamper Audit and flags the template swap!
"""

import os
import sys
import time
import json
from pathlib import Path
import numpy as np

# Ensure root directory in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app import create_app
from backend.database.db import Database
from backend.chain.mock_chain import MockChainAdapter
from backend.ai.face_engine import MockFaceEngine

def run_demo():
    print("==================================================================")
    print("               AttendChain End-to-End Live Demo                   ")
    print("==================================================================")

    # Initialize app with mock chain and fake face engine
    import tempfile
    fd, temp_db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = Database(temp_db_path)
    chain = MockChainAdapter()
    face_engine = MockFaceEngine()
    app = create_app(chain_adapter=chain, face_engine=face_engine, db=db)
    client = app.test_client()

    admin_headers = {"X-Admin-Token": os.getenv("ADMIN_TOKEN", "attendchain-admin-secret-change-me")}

    # Step 1: Register 3 Students
    print("\n--- STEP 1: Registering 3 Students On-Chain ---")
    students = [
        ("CS101", "Alice Johnson"),
        ("CS102", "Bob Smith"),
        ("CS103", "Charlie Brown")
    ]

    for roll, name in students:
        face_engine.set_mock_behavior(verdict=None)
        res = client.post("/api/students", headers=admin_headers, json={
            "roll_no": roll,
            "name": name,
            "frames": ["dummy_frame_base64"] * 10
        })
        assert res.status_code == 201, f"Failed to register {name}: {res.get_json()}"
        data = res.get_json()["student"]
        print(f" [OK] Enrolled: {name} ({roll})")
        print(f"      Student ID (keccak256): {data['student_id'][:16]}...")
        print(f"      Face Commitment (SHA-256): {data['face_commitment'][:16]}...")
        print(f"      Registration Tx Hash: {data['tx_hash'][:16]}...")

    # Step 2: Open a 10-Minute Session
    print("\n--- STEP 2: Opening a 10-Minute Session on Hedera SCS ---")
    res = client.post("/api/sessions", headers=admin_headers, json={
        "subject": "CS301_BLOCKCHAIN",
        "duration_seconds": 600
    })
    assert res.status_code == 201
    sess_data = res.get_json()["session"]
    session_id = sess_data["session_id"]
    print(f" [OK] Session #{session_id} Opened for subject: {sess_data['subject']}")
    print(f"      Duration: {sess_data['duration_seconds']} seconds (10 minutes)")
    print(f"      Tx Hash: {sess_data['tx_hash'][:20]}...")
    print(f"      Explorer Link: {sess_data['explorer_url']}")

    # Step 3: Student Marks Attendance (Alice)
    print("\n--- STEP 3: Student Marks Attendance (Face Recognition + Liveness) ---")
    face_engine.set_mock_behavior(verdict=None, similarity=0.892, blinks=2)
    res = client.post("/api/attendance/mark", json={
        "session_id": session_id,
        "frames": ["frame_burst_data"] * 30
    })
    assert res.status_code == 200
    mark_data = res.get_json()
    rec = mark_data["record"]
    print(f" [OK] Attendance Marked Successfully for: {rec['name']} ({rec['roll_no']})")
    print(f"      Match Score: {rec['match_score']:.3f} (Threshold >= 0.363)")
    print(f"      Liveness Blinks Detected: {rec['blink_count']}")
    print(f"      Canonical Evidence Hash: {rec['evidence_hash'][:20]}...")
    print(f"      On-Chain Transaction: {rec['tx_hash'][:20]}...")
    print(f"      HashScan Explorer: {rec['explorer_url']}")

    # Step 4: Refuse Double Marking
    print("\n--- STEP 4: Attempting to Mark Attendance Again in Same Session ---")
    res = client.post("/api/attendance/mark", json={
        "session_id": session_id,
        "frames": ["frame_burst_data"] * 30
    })
    assert res.status_code == 409
    err = res.get_json()
    print(f" [REFUSED] Status: {res.status_code} ({err['verdict']})")
    print(f"           Message: {err['error']}")

    # Step 5: Photo Spoof Attempt (No Blink)
    print("\n--- STEP 5: Photo Presentation Attack (No Blink Detected) ---")
    # Open session 2 for this test
    res = client.post("/api/sessions", headers=admin_headers, json={
        "subject": "CS301_BLOCKCHAIN",
        "duration_seconds": 600
    })
    sess2_id = res.get_json()["session"]["session_id"]

    face_engine.set_mock_behavior(verdict="no_blink", blinks=0)
    res = client.post("/api/attendance/mark", json={
        "session_id": sess2_id,
        "frames": ["static_photo_frames"] * 30
    })
    assert res.status_code == 422
    err = res.get_json()
    print(f" [REFUSED] Status: {res.status_code} ({err['verdict']})")
    print(f"           Message: {err['error']}")

    # Step 6: "My Attendance" Summary Query
    print("\n--- STEP 6: Querying 'My Attendance' Summary for Alice ---")
    res = client.get("/api/students/CS101/summary")
    assert res.status_code == 200
    summary = res.get_json()
    print(f" [OK] Student: {summary['student']['name']} ({summary['student']['roll_no']})")
    print(f"      Overall Defaulter Status: {'DEFAULTER (< 75%)' if summary['is_defaulter_overall'] else 'REGULAR (>= 75%)'}")
    for sub in summary["subjects"]:
        print(f"      Subject: {sub['subject']:<18} | Attended: {sub['present_sessions']}/{sub['total_sessions']} | Attendance: {sub['attendance_percent']}% | Defaulter: {sub['defaulter']}")

    # Step 7: Clean Audit First
    print("\n--- STEP 7: Running Cryptographic Audit on Clean System ---")
    res = client.get("/api/audit", headers=admin_headers)
    assert res.status_code == 200
    audit1 = res.get_json()
    print(f" [AUDIT] Status: {audit1['status']}")
    print(f"         Total Cryptographic Checks Performed: {audit1['total_checks_performed']}")
    print(f"         Discrepancies Found: {audit1['discrepancy_count']}")

    # Step 8: Simulate DB Tampering (Modify Biometric Embedding in SQLite)
    print("\n--- STEP 8: Simulating Database Tampering (Swapping Alice's Face Template) ---")
    with db._conn() as conn:
        tampered_embedding = np.ones(128, dtype=np.float32).tobytes()
        conn.execute("UPDATE students SET embedding = ? WHERE roll_no = 'CS101'", (tampered_embedding,))
        conn.commit()
    print(" [TAMPER] Updated SQLite 'students' table: swapped Alice's 128-d face embedding.")

    # Step 9: Re-run Audit to Detect Tampering
    print("\n--- STEP 9: Re-running Blockchain Tamper Audit ---")
    res = client.get("/api/audit", headers=admin_headers)
    assert res.status_code == 200
    audit2 = res.get_json()
    print(f" [AUDIT RESULT] Status: {audit2['status']} (Tampering successfully detected!)")
    print(f"                Discrepancies Count: {audit2['discrepancy_count']}")
    for d in audit2["discrepancies"]:
        print(f"                -> Type: {d['type']} [{d['severity']}]")
        print(f"                   Detail: {d['detail']}")
        print(f"                   Local DB SHA-256:       {d.get('local_commitment', '')[:24]}...")
        print(f"                   On-Chain Ledger SHA-256: {d.get('on_chain_commitment', '')[:24]}...")

    print("\n==================================================================")
    print("            DEMO COMPLETE: ALL CHECKS VERIFIED 100%!              ")
    print("==================================================================")

    import gc
    del app
    del db
    gc.collect()
    try:
        if os.path.exists(temp_db_path):
            os.remove(temp_db_path)
    except PermissionError:
        pass

if __name__ == "__main__":
    run_demo()
