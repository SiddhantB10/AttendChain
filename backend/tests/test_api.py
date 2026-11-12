"""
End-to-End API Test Suite for AttendChain
Tests all Flask endpoints using MockChainAdapter and MockFaceEngine:
- Admin token authentication
- Student enrollment & duplicate identity prevention
- Session lifecycle & validation
- Attendance marking: happy path, double marking, no blink, unknown face, multiple faces, poor frames, inactive session
- Student attendance summary & defaulter calculations
- Tamper Audit Engine: deliberate tampering with DB and template swapping
"""

import os
import tempfile
import json
import gc
import pytest
import numpy as np

from backend.app import create_app
from backend.database.db import Database
from backend.chain.mock_chain import MockChainAdapter
from backend.ai.face_engine import MockFaceEngine

ADMIN_TOKEN = "test-secret-token"
AUTH_HEADERS = {"X-Admin-Token": ADMIN_TOKEN}

@pytest.fixture
def test_client():
    os.environ["ADMIN_TOKEN"] = ADMIN_TOKEN
    os.environ["MIN_ATTENDANCE_PERCENT"] = "75"

    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    db = Database(db_path)
    chain = MockChainAdapter()
    face_engine = MockFaceEngine()

    app = create_app(chain_adapter=chain, face_engine=face_engine, db=db, auto_init_session=False)
    app.config["TESTING"] = True

    with app.test_client() as client:
        yield client, app, chain, db, face_engine

    del app
    del db
    gc.collect()
    try:
        if os.path.exists(db_path):
            os.remove(db_path)
    except PermissionError:
        pass

def test_health_endpoint(test_client):
    client, _, _, _, _ = test_client
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["status"] == "healthy"
    assert data["chain_mode"] == "mock"
    assert data["node_reachable"] is True
    assert data["contract_deployed"] is True

def test_admin_auth_protection(test_client):
    client, _, _, _, _ = test_client

    # Without token -> 401
    resp = client.get("/api/students")
    assert resp.status_code == 401
    assert "Unauthorized" in resp.get_json()["error"]

    # With invalid token -> 401
    resp = client.get("/api/students", headers={"X-Admin-Token": "wrong-token"})
    assert resp.status_code == 401

    # With valid token -> 200
    resp = client.get("/api/students", headers=AUTH_HEADERS)
    assert resp.status_code == 200

def test_enroll_student_flow_and_validation(test_client):
    client, _, chain, db, face_engine = test_client

    # Missing fields
    resp = client.post("/api/students", headers=AUTH_HEADERS, json={"roll_no": ""})
    assert resp.status_code == 400

    # Successful enrollment
    resp = client.post("/api/students", headers=AUTH_HEADERS, json={
        "roll_no": "CS101",
        "name": "Alice Johnson",
        "frames": ["dummy_frame_base64"] * 10
    })
    assert resp.status_code == 201
    data = resp.get_json()
    assert data["student"]["roll_no"] == "CS101"
    assert data["student"]["name"] == "Alice Johnson"
    assert "0x" in data["student"]["student_id"]
    assert "0x" in data["student"]["face_commitment"]

    # Verify registered on chain
    st_chain = chain.get_student(data["student"]["student_id"])
    assert st_chain["registered"] is True

    # Duplicate roll number rejection
    resp2 = client.post("/api/students", headers=AUTH_HEADERS, json={
        "roll_no": "cs101",
        "name": "Alice Duplicate",
        "frames": ["dummy_frame_base64"] * 10
    })
    assert resp2.status_code == 409

    # Duplicate face rejection ("one person, one identity")
    face_engine.set_mock_behavior(verdict="already_enrolled")
    resp3 = client.post("/api/students", headers=AUTH_HEADERS, json={
        "roll_no": "CS102",
        "name": "Bob Impostor",
        "frames": ["dummy_frame_base64"] * 10
    })
    assert resp3.status_code == 409
    assert resp3.get_json()["verdict"] == "already_enrolled"

def test_session_lifecycle(test_client):
    client, _, chain, _, _ = test_client

    # Invalid duration (< 60s)
    resp = client.post("/api/sessions", headers=AUTH_HEADERS, json={
        "subject": "CS301",
        "duration_seconds": 30
    })
    assert resp.status_code == 400

    # Successful open session
    resp = client.post("/api/sessions", headers=AUTH_HEADERS, json={
        "subject": "CS301",
        "duration_seconds": 1800
    })
    assert resp.status_code == 201
    sess_id = resp.get_json()["session"]["session_id"]
    assert sess_id == 1

    # Check active filter
    resp = client.get("/api/sessions?active=1")
    assert resp.status_code == 200
    sessions = resp.get_json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["is_active"] is True

    # Close session
    resp = client.post(f"/api/sessions/{sess_id}/close", headers=AUTH_HEADERS)
    assert resp.status_code == 200

    # Now active sessions should be 0
    resp = client.get("/api/sessions?active=1")
    assert len(resp.get_json()["sessions"]) == 0

def test_attendance_verdicts(test_client):
    client, _, chain, db, face_engine = test_client

    # Enroll student Alice
    face_engine.set_mock_behavior(verdict=None)
    client.post("/api/students", headers=AUTH_HEADERS, json={
        "roll_no": "ROLL_ALICE",
        "name": "Alice",
        "frames": ["dummy"]
    })

    # Open session 1
    client.post("/api/sessions", headers=AUTH_HEADERS, json={
        "subject": "MATH201",
        "duration_seconds": 3600
    })

    # Scenario 1: Happy Path
    resp = client.post("/api/attendance/mark", json={"session_id": 1, "frames": ["frame1"]})
    assert resp.status_code == 200
    assert resp.get_json()["verdict"] == "ok"
    record = resp.get_json()["record"]
    assert record["roll_no"] == "ROLL_ALICE"
    assert record["blink_count"] >= 1
    assert "0x" in record["evidence_hash"]

    # Scenario 2: Double marking (Already marked)
    resp = client.post("/api/attendance/mark", json={"session_id": 1, "frames": ["frame1"]})
    assert resp.status_code == 409
    assert resp.get_json()["verdict"] == "already_marked"

    # Open session 2 for edge case testing
    client.post("/api/sessions", headers=AUTH_HEADERS, json={
        "subject": "MATH201",
        "duration_seconds": 3600
    })

    # Scenario 3: No blink (photo presentation attack)
    face_engine.set_mock_behavior(verdict="no_blink")
    resp = client.post("/api/attendance/mark", json={"session_id": 2, "frames": ["frame1"]})
    assert resp.status_code == 422
    assert resp.get_json()["verdict"] == "no_blink"

    # Scenario 4: Unknown face
    face_engine.set_mock_behavior(verdict="unknown_face")
    resp = client.post("/api/attendance/mark", json={"session_id": 2, "frames": ["frame1"]})
    assert resp.status_code == 401
    assert resp.get_json()["verdict"] == "unknown_face"

    # Scenario 5: Multiple faces
    face_engine.set_mock_behavior(verdict="multiple_faces")
    resp = client.post("/api/attendance/mark", json={"session_id": 2, "frames": ["frame1"]})
    assert resp.status_code == 422
    assert resp.get_json()["verdict"] == "multiple_faces"

    # Scenario 6: Poor frames
    face_engine.set_mock_behavior(verdict="poor_frames")
    resp = client.post("/api/attendance/mark", json={"session_id": 2, "frames": ["frame1"]})
    assert resp.status_code == 422
    assert resp.get_json()["verdict"] == "poor_frames"

    # Scenario 7: Session inactive / expired
    chain.advance_time(4000) # Expire session 2
    resp = client.post("/api/attendance/mark", json={"session_id": 2, "frames": ["frame1"]})
    assert resp.status_code == 400
    assert resp.get_json()["verdict"] == "session_inactive"

def test_summary_and_defaulter_math(test_client):
    client, _, chain, _, face_engine = test_client

    face_engine.set_mock_behavior(verdict=None)
    client.post("/api/students", headers=AUTH_HEADERS, json={
        "roll_no": "STUDENT_MATH",
        "name": "Charlie",
        "frames": ["dummy"]
    })

    # Open 4 sessions for PHYSICS
    for _ in range(4):
        client.post("/api/sessions", headers=AUTH_HEADERS, json={
            "subject": "PHYSICS",
            "duration_seconds": 3600
        })

    # Charlie marks in Session 1 only (1 out of 4 = 25% -> Defaulter < 75%)
    client.post("/api/attendance/mark", json={"session_id": 1, "frames": ["frame1"]})

    resp = client.get("/api/students/STUDENT_MATH/summary")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["is_defaulter_overall"] is True
    sub_stat = data["subjects"][0]
    assert sub_stat["subject"] == "PHYSICS"
    assert sub_stat["total_sessions"] == 4
    assert sub_stat["present_sessions"] == 1
    assert sub_stat["attendance_percent"] == 25
    assert sub_stat["defaulter"] is True

    # Charlie marks in Session 2 and Session 3 (3 out of 4 = 75% -> Not defaulter)
    client.post("/api/attendance/mark", json={"session_id": 2, "frames": ["frame1"]})
    client.post("/api/attendance/mark", json={"session_id": 3, "frames": ["frame1"]})

    resp = client.get("/api/students/STUDENT_MATH/summary")
    data = resp.get_json()
    assert data["is_defaulter_overall"] is False
    assert data["subjects"][0]["attendance_percent"] == 75
    assert data["subjects"][0]["defaulter"] is False

def test_tamper_audit_engine(test_client):
    client, _, chain, db, face_engine = test_client

    face_engine.set_mock_behavior(verdict=None)
    # Enroll Dave
    client.post("/api/students", headers=AUTH_HEADERS, json={
        "roll_no": "DAVE01",
        "name": "Dave",
        "frames": ["dummy"]
    })

    # Open session and mark Dave
    client.post("/api/sessions", headers=AUTH_HEADERS, json={"subject": "BIO", "duration_seconds": 3600})
    client.post("/api/attendance/mark", json={"session_id": 1, "frames": ["dummy"]})

    # Check 1: Initial audit MUST be clean
    audit_resp = client.get("/api/audit", headers=AUTH_HEADERS)
    assert audit_resp.status_code == 200
    assert audit_resp.get_json()["status"] == "CLEAN"
    assert audit_resp.get_json()["discrepancy_count"] == 0

    # Tamper 1: Tamper face template embedding directly in SQLite (simulating biometric swap)
    with db._conn() as conn:
        tampered_embedding = np.ones(128, dtype=np.float32).tobytes()
        conn.execute("UPDATE students SET embedding = ? WHERE roll_no = 'DAVE01'", (tampered_embedding,))
        conn.commit()

    audit_resp2 = client.get("/api/audit", headers=AUTH_HEADERS)
    assert audit_resp2.get_json()["status"] == "TAMPERING_DETECTED"
    types = [d["type"] for d in audit_resp2.get_json()["discrepancies"]]
    assert "TEMPLATE_SWAP_DETECTED" in types

    # Tamper 2: Insert fraudulent local attendance record without on-chain transaction
    with db._conn() as conn:
        conn.execute(
            """
            INSERT INTO attendance_records (
                session_id, student_id, roll_no, evidence_hash, tx_hash,
                timestamp, match_score, blink_count, frames_analyzed
            ) VALUES (1, '0xfake_student', 'FAKEROLL', '0x11112222', '0xfaketx', 1700000000, 0.99, 2, 30)
            """
        )
        conn.commit()

    audit_resp3 = client.get("/api/audit", headers=AUTH_HEADERS)
    types3 = [d["type"] for d in audit_resp3.get_json()["discrepancies"]]
    assert "ATTENDANCE_NOT_ON_CHAIN" in types3 or "SESSION_COUNT_MISMATCH" in types3

def test_role_based_logins(test_client):
    client, _, _, db, _ = test_client

    # 1. Faculty login - Invalid credentials
    f_bad = client.post("/api/auth/faculty/login", json={"username": "wrong", "password": "wrong"})
    assert f_bad.status_code == 401
    assert f_bad.get_json()["ok"] is False

    # 2. Faculty login - Valid credentials
    f_ok = client.post("/api/auth/faculty/login", json={"username": "faculty", "password": "faculty123"})
    assert f_ok.status_code == 200
    f_data = f_ok.get_json()
    assert f_data["ok"] is True
    assert f_data["role"] == "faculty"
    assert "token" in f_data

    # 3. Student login - Nonexistent student
    s_bad = client.post("/api/auth/student/login", json={"roll_no": "NONEXISTENT"})
    assert s_bad.status_code == 404
    assert s_bad.get_json()["ok"] is False

    # 4. Enroll student and login as student
    db.insert_student(
        roll_no="STU-777",
        name="Elena Rostova",
        embedding=np.zeros(128, dtype=np.float32),
        registered_at=1700000000
    )
    s_ok = client.post("/api/auth/student/login", json={"roll_no": "STU-777"})
    assert s_ok.status_code == 200
    s_data = s_ok.get_json()
    assert s_data["ok"] is True
    assert s_data["role"] == "student"
    assert s_data["student"]["name"] == "Elena Rostova"
    assert s_data["student"]["roll_no"] == "STU-777"

def test_admin_faculty_group_invite_and_attendance_workflow(test_client):
    client, _, chain, db, face_engine = test_client

    # 1. Admin login & overview
    admin_auth = client.post("/api/auth/admin/login", json={"username": "admin@college.edu", "password": "admin123"})
    assert admin_auth.status_code == 200
    admin_token = admin_auth.get_json()["token"]

    admin_overview = client.get("/api/admin/overview", headers={"X-Admin-Token": admin_token})
    assert admin_overview.status_code == 200
    assert admin_overview.get_json()["total_faculties"] >= 2

    # 2. Admin creates a new faculty member
    new_fac = client.post("/api/admin/faculties", headers={"X-Admin-Token": admin_token}, json={
        "name": "Prof. Claude Shannon",
        "email": "shannon@college.edu",
        "password": "faculty123",
        "department": "Information Theory"
    })
    assert new_fac.status_code == 201

    # 3. Faculty logs in
    fac_login = client.post("/api/auth/faculty/login", json={
        "username": "shannon@college.edu",
        "password": "faculty123"
    })
    assert fac_login.status_code == 200
    assert fac_login.get_json()["user"]["name"] == "Prof. Claude Shannon"

    # 4. Faculty creates a course group
    grp_resp = client.post("/api/faculty/groups", json={
        "name": "Information & Entropy Theory",
        "subject_code": "IT401",
        "department": "Information Theory",
        "faculty_email": "shannon@college.edu"
    })
    assert grp_resp.status_code == 201
    grp = grp_resp.get_json()["group"]
    group_id = grp["id"]
    invite_code = grp["invite_code"]
    assert "IT401" in invite_code

    # 5. Enroll two students
    s1 = db.insert_student("STU-101", "Student One", np.zeros(128, dtype=np.float32), 1700000000)
    s2 = db.insert_student("STU-102", "Student Two", np.ones(128, dtype=np.float32), 1700000000)
    chain.register_student(s1["student_id"], s1["face_commitment"])
    chain.register_student(s2["student_id"], s2["face_commitment"])

    # 6. Student 1 joins group using invite code
    join_resp = client.post("/api/student/join-group", json={
        "roll_no": "STU-101",
        "invite_code": invite_code
    })
    assert join_resp.status_code == 200
    assert join_resp.get_json()["ok"] is True

    # 6b. Duplicate join rejected
    dup_join = client.post("/api/student/join-group", json={
        "roll_no": "STU-101",
        "invite_code": invite_code
    })
    assert dup_join.status_code == 409

    # 6c. Invalid invite code rejected
    bad_code = client.post("/api/student/join-group", json={
        "roll_no": "STU-102",
        "invite_code": "INVALID-CODE-999"
    })
    assert bad_code.status_code == 404

    # 7. Check Student 1 dashboard
    s1_dash = client.get("/api/student/STU-101/dashboard")
    assert s1_dash.status_code == 200
    joined = s1_dash.get_json()["joined_groups"]
    assert any(g["id"] == group_id for g in joined)
    assert len(s1_dash.get_json()["active_attendance_sessions"]) == 0

    # 8. Faculty triggers "Take Attendance" for this group
    take_att = client.post(f"/api/faculty/groups/{group_id}/take-attendance", json={"duration_minutes": 20})
    assert take_att.status_code == 201
    sess_info = take_att.get_json()["session"]
    session_id = sess_info["session_id"]
    assert sess_info["remaining_seconds"] == 1200

    # 9. Now Student 1 sees active attendance session
    s1_dash_active = client.get("/api/student/STU-101/dashboard")
    active_list = s1_dash_active.get_json()["active_attendance_sessions"]
    assert len(active_list) == 1
    assert active_list[0]["group_id"] == group_id
    assert active_list[0]["session_id"] == session_id
    assert active_list[0]["already_marked"] is False

    # 10. Student 2 (NOT enrolled in group) tries to mark attendance -> Rejected (403)
    face_engine.set_mock_behavior(
        verdict=None,
        matched_student={
            "student_id": db.get_student_by_roll("STU-102")["student_id"],
            "roll_no": "STU-102",
            "name": "Student Two"
        }
    )
    s2_mark = client.post("/api/attendance/mark", json={
        "session_id": session_id,
        "frames": ["dummy_frame"] * 10
    })
    assert s2_mark.status_code == 403
    assert s2_mark.get_json()["verdict"] == "not_enrolled_in_group"

    # 11. Student 1 (Enrolled in group) marks attendance -> OK (200)
    face_engine.set_mock_behavior(
        verdict=None,
        matched_student={
            "student_id": db.get_student_by_roll("STU-101")["student_id"],
            "roll_no": "STU-101",
            "name": "Student One"
        }
    )
    s1_mark = client.post("/api/attendance/mark", json={
        "session_id": session_id,
        "frames": ["dummy_frame"] * 10
    })
    assert s1_mark.status_code == 200
    assert s1_mark.get_json()["verdict"] == "ok"
    assert s1_mark.get_json()["record"]["roll_no"] == "STU-101"

    # 12. Faculty checks live attendance feed
    live_feed = client.get(f"/api/faculty/groups/{group_id}/live-attendance")
    assert live_feed.status_code == 200
    feed_data = live_feed.get_json()
    assert feed_data["is_active"] is True
    assert feed_data["count"] == 1
    assert feed_data["records"][0]["roll_no"] == "STU-101"

    # 13. Faculty closes attendance
    close_resp = client.post(f"/api/faculty/groups/{group_id}/close-attendance")
    assert close_resp.status_code == 200
    assert close_resp.get_json()["ok"] is True

    # 14. Live attendance is now inactive
    live_feed_after = client.get(f"/api/faculty/groups/{group_id}/live-attendance")
    assert live_feed_after.get_json()["is_active"] is False

