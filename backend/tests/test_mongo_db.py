import pytest
import numpy as np
import mongomock
from backend.database.mongo_db import MongoDatabase

@pytest.fixture
def mongo_db():
    mock_client = mongomock.MongoClient()
    return MongoDatabase(db_name="test_attendchain", client=mock_client)

def test_mongo_student_lifecycle(mongo_db):
    # 1. Create student
    stu = mongo_db.create_student("John Doe", "john@college.edu", "pass123")
    assert stu["name"] == "John Doe"
    assert stu["email"] == "john@college.edu"
    assert stu["roll_no"].startswith("STU-")
    assert stu["face_enrolled"] == 0

    roll = stu["roll_no"]
    s_id = stu["student_id"]

    # 2. Get student by identifiers
    by_roll = mongo_db.get_student_by_roll(roll)
    assert by_roll is not None
    assert by_roll["name"] == "John Doe"

    by_email = mongo_db.get_student_by_identifier("john@college.edu")
    assert by_email is not None
    assert by_email["roll_no"] == roll

    by_id = mongo_db.get_student_by_id(s_id)
    assert by_id is not None
    assert by_id["email"] == "john@college.edu"

    # 3. Enroll Face ID
    emb = np.random.randn(128).astype(np.float32)
    face_commit = "0xfacecommitment123"
    success = mongo_db.update_student_face(s_id, face_commit, emb)
    assert success is True

    updated_stu = mongo_db.get_student_by_roll(roll)
    assert updated_stu["face_enrolled"] == 1
    assert updated_stu["face_commitment"] == face_commit

    # Verify embeddings list
    all_embs = mongo_db.get_all_embeddings()
    assert len(all_embs) >= 1
    assert any(item[1] == roll for item in all_embs)

    # 4. Request Face Reset
    req_success = mongo_db.request_face_reset(roll, "Webcam changed")
    assert req_success is True

    pending = mongo_db.get_pending_face_resets()
    assert len(pending) == 1
    assert pending[0]["roll_no"] == roll
    assert pending[0]["face_reset_reason"] == "Webcam changed"

    # 5. Approve Face Reset
    appr_success = mongo_db.approve_face_reset(roll)
    assert appr_success is True

    reset_stu = mongo_db.get_student_by_roll(roll)
    assert reset_stu["face_reset_status"] == "APPROVED"
    assert reset_stu["face_enrolled"] == 0

    # 6. Change password
    pass_success = mongo_db.update_student_password(roll, "new_secret_hash")
    assert pass_success is True
    assert mongo_db.get_student_by_roll(roll)["password_hash"] == "new_secret_hash"

def test_mongo_groups_and_sessions(mongo_db):
    # 1. Create course group
    grp = mongo_db.create_group("Computer Networks", "CS202", "faculty@college.edu", "CS202-ABC")
    assert grp["subject_code"] == "CS202"
    assert grp["invite_code"] == "CS202-ABC"

    by_code = mongo_db.get_group_by_invite_code("cs202-abc")
    assert by_code is not None
    assert by_code["name"] == "Computer Networks"

    # 2. Enroll student in group
    stu = mongo_db.create_student("Alice Smith", "alice@college.edu", "pass123")
    mongo_db.enroll_student_in_group(grp["id"], stu["student_id"], stu["roll_no"])
    assert mongo_db.is_student_in_group(grp["id"], stu["student_id"]) is True

    # 3. Create session & take attendance
    mongo_db.insert_session(
        session_id=101,
        subject="CS202",
        duration_seconds=3600,
        faculty_address="0xFaculty",
        start_time=1700000000,
        end_time=1700003600,
        tx_hash="0xTx101",
        group_id=grp["id"]
    )

    sess = mongo_db.get_session(101)
    assert sess is not None
    assert sess["subject"] == "CS202"

    # 4. Record attendance
    mongo_db.record_attendance(
        session_id=101,
        student_id=stu["student_id"],
        roll_no=stu["roll_no"],
        evidence_hash="0xEvidence101",
        tx_hash="0xAttTx101",
        timestamp=1700000500,
        match_score=0.88,
        blink_count=2,
        frames_analyzed=10,
        canonical_json='{"test": 123}'
    )

    assert mongo_db.has_recorded_attendance(101, stu["student_id"]) is True
    evidence = mongo_db.get_evidence_json("0xEvidence101")
    assert evidence == '{"test": 123}'

    # Check student dashboard group view
    student_groups = mongo_db.get_groups_for_student(stu["student_id"])
    assert len(student_groups) >= 1
    sg = next(g for g in student_groups if g["id"] == grp["id"])
    assert sg["attendance_percent"] == 100
    assert sg["is_defaulter"] is False
    assert sg["last_session_marked"] is True

