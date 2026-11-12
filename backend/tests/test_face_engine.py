"""
Unit and Smoke Tests for Face Engine (Mock and OpenCV YuNet/SFace/MediaPipe).
"""

import numpy as np
import pytest
from backend.ai.face_engine import FaceEngine, MockFaceEngine, OpenCVFaceEngine

def test_mock_face_engine_scenarios():
    mock_engine = MockFaceEngine()
    templates = [
        ("0xstudent1", "ROLL01", "Alice", np.zeros(128, dtype=np.float32))
    ]

    # Test OK match
    res = mock_engine.analyze_stream([], templates)
    assert res["verdict"] == "ok"
    assert res["matched_student"]["roll_no"] == "ROLL01"
    assert res["blink_count"] >= 1

    # Test preset no_blink
    mock_engine.set_mock_behavior(verdict="no_blink")
    res = mock_engine.analyze_stream([], templates)
    assert res["verdict"] == "no_blink"

    # Test preset multiple_faces
    mock_engine.set_mock_behavior(verdict="multiple_faces")
    res = mock_engine.analyze_stream([], templates)
    assert res["verdict"] == "multiple_faces"

    # Test preset unknown_face
    mock_engine.set_mock_behavior(verdict="unknown_face")
    res = mock_engine.analyze_stream([], templates)
    assert res["verdict"] == "unknown_face"

    # Test preset poor_frames
    mock_engine.set_mock_behavior(verdict="poor_frames")
    res = mock_engine.analyze_stream([], templates)
    assert res["verdict"] == "poor_frames"

    # Test enrollment
    mock_engine.set_mock_behavior(verdict=None)
    enroll_res = mock_engine.enroll_face([], [])
    assert enroll_res["success"] is True
    assert enroll_res["embedding"] is not None
    assert len(enroll_res["embedding"]) == 128
    np.testing.assert_allclose(np.linalg.norm(enroll_res["embedding"]), 1.0, atol=1e-5)

def test_opencv_face_engine_initialization():
    """Smoke test ensuring YuNet, SFace and MediaPipe landmarker load without errors."""
    engine = OpenCVFaceEngine()
    engine.initialize()
    assert engine._detector is not None
    assert engine._recognizer is not None
    assert engine._liveness_detector is not None

    # Test empty stream handling
    res = engine.analyze_stream([], [])
    assert res["verdict"] == "poor_frames"

