"""
Unit tests for AttendChain Database & Chain Adapter (Mock & Local EVM).
"""

import os
import tempfile
import numpy as np
import pytest
from backend.database.db import (
    Database,
    compute_student_id,
    compute_face_commitment,
    compute_canonical_evidence
)
from backend.chain.mock_chain import MockChainAdapter

@pytest.fixture
def temp_db():
    import gc
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = Database(path)
    yield db
    del db
    gc.collect()
    try:
        if os.path.exists(path):
            os.remove(path)
    except PermissionError:
        pass

def test_database_student_and_commitment(temp_db):
    # Create synthetic 128-d embedding
    rng = np.random.default_rng(123)
    emb = rng.standard_normal(128).astype(np.float32)
    emb /= np.linalg.norm(emb)

    roll = "CS2026_01"
    name = "John Doe"
    registered_at = 1700000000

    student = temp_db.insert_student(roll, name, emb, registered_at)
    assert student["roll_no"] == "CS2026_01"
    assert student["name"] == "John Doe"
    assert student["student_id"].startswith("0x")
    assert len(student["student_id"]) == 66
    assert student["face_commitment"].startswith("0x")
    assert len(student["face_commitment"]) == 66

    # Verify lookups
    by_id = temp_db.get_student_by_id(student["student_id"])
    assert by_id is not None
    assert by_id["roll_no"] == "CS2026_01"

    by_roll = temp_db.get_student_by_roll("cs2026_01")
    assert by_roll is not None
    assert by_roll["name"] == "John Doe"

    all_embs = temp_db.get_all_embeddings()
    assert len(all_embs) == 1
    s_id, r_no, n_str, stored_emb = all_embs[0]
    assert s_id == student["student_id"]
    np.testing.assert_allclose(stored_emb, emb, atol=1e-6)

def test_canonical_evidence_hashing():
    ev_hash1, json1 = compute_canonical_evidence(
        session_id=1,
        student_id="0x1234",
        roll_no="cs101",
        match_score=0.85234,
        blink_count=2,
        frames_analyzed=30,
        timestamp=1700000100
    )

    # Identical inputs must yield identical hash and json
    ev_hash2, json2 = compute_canonical_evidence(
        session_id=1,
        student_id="0x1234",
        roll_no="CS101", # Uppercased inside
        match_score=0.8523,
        blink_count=2,
        frames_analyzed=30,
        timestamp=1700000100
    )

    assert ev_hash1 == ev_hash2
    assert json1 == json2
    assert ev_hash1.startswith("0x")
    assert len(ev_hash1) == 66
    # Verify canonical formatting (no space after colon or comma)
    assert '":' in json1
    assert '": ' not in json1

def test_mock_chain_adapter_complete_flow():
    chain = MockChainAdapter()
    health = chain.get_health()
    assert health["mode"] == "mock"
    assert health["node_reachable"] is True
    assert health["contract_deployed"] is True

    student_id = compute_student_id("ROLL100")
    commitment = "0x" + "ab" * 32

    # Register student
    tx1 = chain.register_student(student_id, commitment)
    assert tx1.startswith("0x")

    st = chain.get_student(student_id)
    assert st["registered"] is True
    assert st["face_commitment"] == commitment.lower()

    # Reject duplicate registration
    with pytest.raises(ValueError, match="AlreadyRegistered"):
        chain.register_student(student_id, commitment)

    # Session validation
    with pytest.raises(ValueError, match="InvalidSubject"):
        chain.open_session("", 3600)

    with pytest.raises(ValueError, match="InvalidDuration"):
        chain.open_session("CS101", 50)

    # Open valid session
    sess_id, sess_tx = chain.open_session("CS101", 1800)
    assert sess_id == 1
    assert sess_tx.startswith("0x")
    assert chain.is_session_active(sess_id) is True

    # Mark attendance
    ev_hash = "0x" + "cd" * 32
    att_tx = chain.mark_attendance(sess_id, student_id, ev_hash)
    assert att_tx.startswith("0x")
    assert chain.has_attended(sess_id, student_id) is True
    assert chain.get_evidence(sess_id, student_id) == ev_hash.lower()

    # Prevent double mark
    with pytest.raises(ValueError, match="AlreadyMarked"):
        chain.mark_attendance(sess_id, student_id, ev_hash)

    # Prevent unregistered student mark
    unreg_id = compute_student_id("UNREGISTERED")
    with pytest.raises(ValueError, match="NotRegistered"):
        chain.mark_attendance(sess_id, unreg_id, ev_hash)

    # Summary check
    summary = chain.get_student_summary(student_id, "CS101")
    assert summary["total_sessions"] == 1
    assert summary["present_sessions"] == 1
    assert summary["attendance_percent"] == 100

    # Time expiration
    chain.advance_time(1801)
    assert chain.is_session_active(sess_id) is False
    with pytest.raises(ValueError, match="SessionNotActive"):
        chain.mark_attendance(sess_id, student_id, ev_hash)
