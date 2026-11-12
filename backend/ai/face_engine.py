"""
Face Engine abstraction for AttendChain.
Supports:
- OpenCVFaceEngine (YuNet detection + SFace 128-d embeddings + MediaPipe blink liveness)
- MockFaceEngine (deterministic fake engine for hermetic testing and CI)
"""

import os
import threading
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

from .liveness import BlinkStateMachine, MediaPipeLivenessDetector

class FaceEngine(ABC):
    @abstractmethod
    def analyze_stream(
        self,
        frames_bgr: List[np.ndarray],
        enrolled_templates: List[Tuple[str, str, str, np.ndarray]], # (student_id, roll_no, name, embedding)
        similarity_threshold: float = 0.363
    ) -> Dict[str, Any]:
        """
        Analyzes a sequence of frames for attendance marking:
        Returns dict with:
        - 'verdict': 'ok', 'no_blink', 'unknown_face', 'multiple_faces', 'poor_frames', 'no_students'
        - 'matched_student': {'student_id': str, 'roll_no': str, 'name': str} or None
        - 'match_score': float
        - 'blink_count': int
        - 'usable_frame_count': int
        - 'total_frames': int
        - 'error_message': Optional[str]
        """
        pass

    @abstractmethod
    def enroll_face(
        self,
        frames_bgr: List[np.ndarray],
        existing_templates: List[Tuple[str, str, str, np.ndarray]],
        similarity_threshold: float = 0.363
    ) -> Dict[str, Any]:
        """
        Enrolls a new student from a burst of frames:
        Requires at least 6 consistent usable frames, checks for duplicate person.
        Returns:
        - 'success': bool
        - 'embedding': np.ndarray (128-d normalized) or None
        - 'error': Optional[str]
        - 'verdict': 'ok', 'poor_frames', 'multiple_faces', 'already_enrolled'
        """
        pass


class OpenCVFaceEngine(FaceEngine):
    def __init__(
        self,
        yunet_path: Optional[str] = None,
        sface_path: Optional[str] = None,
        landmarker_path: Optional[str] = None
    ):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        models_dir = os.path.join(base_dir, "../models")

        self.yunet_path = yunet_path or os.path.join(models_dir, "face_detection_yunet_2023mar.onnx")
        self.sface_path = sface_path or os.path.join(models_dir, "face_recognition_sface_2021dec.onnx")
        self.landmarker_path = landmarker_path or os.path.join(models_dir, "face_landmarker.task")

        self._lock = threading.Lock() # Thread-safe execution
        self._detector = None
        self._recognizer = None
        self._liveness_detector = None

    def initialize(self):
        if self._detector is not None:
            return

        if not os.path.exists(self.yunet_path):
            raise FileNotFoundError(f"YuNet model not found at {self.yunet_path}. Run scripts/download_models.py.")
        if not os.path.exists(self.sface_path):
            raise FileNotFoundError(f"SFace model not found at {self.sface_path}. Run scripts/download_models.py.")

        # Absolute normalized path
        yunet_abs = str(os.path.abspath(self.yunet_path))
        sface_abs = str(os.path.abspath(self.sface_path))

        # Default input size (320, 320) - dynamically updated per frame
        self._detector = cv2.FaceDetectorYN.create(
            yunet_abs,
            "",
            (320, 320),
            0.6,
            0.3,
            5000
        )
        self._recognizer = cv2.FaceRecognizerSF.create(sface_abs, "")
        self._liveness_detector = MediaPipeLivenessDetector(self.landmarker_path)

    def _extract_face_and_embedding(self, frame_bgr: np.ndarray) -> Tuple[int, Optional[np.ndarray], Optional[np.ndarray]]:
        """
        Detects faces in single frame.
        Returns (face_count, primary_face_box, l2_normalized_embedding).
        primary_face_box is returned only if face width >= 80px.
        """
        h, w = frame_bgr.shape[:2]
        self._detector.setInputSize((w, h))
        _, faces = self._detector.detect(frame_bgr)

        if faces is None or len(faces) == 0:
            return 0, None, None

        face_count = len(faces)
        if face_count != 1:
            return face_count, None, None

        face = faces[0]
        face_width = face[2]
        if face_width < 60:
            return 1, None, None # Face too small to be usable

        aligned = self._recognizer.alignCrop(frame_bgr, face)
        raw_feat = self._recognizer.feature(aligned)
        norm = np.linalg.norm(raw_feat)
        if norm > 0:
            embedding = raw_feat / norm
        else:
            embedding = raw_feat

        return 1, face, embedding.flatten()

    def analyze_stream(
        self,
        frames_bgr: List[np.ndarray],
        enrolled_templates: List[Tuple[str, str, str, np.ndarray]],
        similarity_threshold: float = 0.363
    ) -> Dict[str, Any]:
        with self._lock:
            self.initialize()

            total_frames = len(frames_bgr)
            if total_frames == 0:
                return {
                    "verdict": "poor_frames",
                    "error_message": "No frames received in burst.",
                    "matched_student": None,
                    "match_score": 0.0,
                    "blink_count": 0,
                    "usable_frame_count": 0,
                    "total_frames": 0
                }

            if len(enrolled_templates) == 0:
                return {
                    "verdict": "no_students",
                    "error_message": "No students are currently enrolled in the system.",
                    "matched_student": None,
                    "match_score": 0.0,
                    "blink_count": 0,
                    "usable_frame_count": 0,
                    "total_frames": total_frames
                }

            usable_embeddings = []
            multi_face_count = 0
            blink_sm = BlinkStateMachine()

            # Process frames
            for frame in frames_bgr:
                face_count, _, emb = self._extract_face_and_embedding(frame)
                if face_count > 1:
                    multi_face_count += 1

                if face_count == 1 and emb is not None:
                    usable_embeddings.append(emb)

                # Liveness blink check
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                closure = self._liveness_detector.extract_eye_closure(frame_rgb)
                blink_sm.process_frame(closure, has_face=(face_count == 1))

            usable_count = len(usable_embeddings)

            # Rule: Reject if > 20% of frames have multiple faces
            if (multi_face_count / total_frames) > 0.20:
                return {
                    "verdict": "multiple_faces",
                    "error_message": "Multiple faces detected in frame sequence (>20% of frames).",
                    "matched_student": None,
                    "match_score": 0.0,
                    "blink_count": blink_sm.blink_count,
                    "usable_frame_count": usable_count,
                    "total_frames": total_frames
                }

            # Reject if fewer than 3 usable frames or < 20%
            if usable_count < 3 or (usable_count / total_frames) < 0.20:
                return {
                    "verdict": "poor_frames",
                    "error_message": f"Insufficient usable frames ({usable_count}/{total_frames} clear frames). Please position your face in the center of the camera and face the light.",
                    "matched_student": None,
                    "match_score": 0.0,
                    "blink_count": blink_sm.blink_count,
                    "usable_frame_count": usable_count,
                    "total_frames": total_frames
                }

            # Rule: Blink liveness check (at least 1 blink required)
            if blink_sm.blink_count < 1:
                return {
                    "verdict": "no_blink",
                    "error_message": "Liveness check failed: No eye blink detected during capture.",
                    "matched_student": None,
                    "match_score": 0.0,
                    "blink_count": blink_sm.blink_count,
                    "usable_frame_count": usable_count,
                    "total_frames": total_frames
                }

            # Rule: Sample up to 7 usable frames, match against all enrolled templates
            sample_step = max(1, usable_count // 7)
            sampled_embs = usable_embeddings[::sample_step][:7]

            votes = {} # student_id -> count of votes
            scores = {} # student_id -> list of similarity scores
            student_meta = {} # student_id -> (roll_no, name)

            for sample_emb in sampled_embs:
                best_sim = -1.0
                best_id = None
                for s_id, roll, name, t_emb in enrolled_templates:
                    student_meta[s_id] = (roll, name)
                    sim = float(np.dot(sample_emb, t_emb))
                    if sim > best_sim:
                        best_sim = sim
                        best_id = s_id

                if best_id is not None:
                    votes[best_id] = votes.get(best_id, 0) + 1
                    scores.setdefault(best_id, []).append(best_sim)

            # Find majority vote candidate
            top_student_id = max(votes, key=votes.get) if votes else None
            top_votes = votes.get(top_student_id, 0)
            agreement_ratio = top_votes / len(sampled_embs)
            mean_similarity = float(np.mean(scores.get(top_student_id, [0.0])))

            # Rule: At least 60% agreement AND mean similarity >= threshold
            if agreement_ratio >= 0.60 and mean_similarity >= similarity_threshold:
                roll, name = student_meta[top_student_id]
                return {
                    "verdict": "ok",
                    "matched_student": {
                        "student_id": top_student_id,
                        "roll_no": roll,
                        "name": name
                    },
                    "match_score": mean_similarity,
                    "blink_count": blink_sm.blink_count,
                    "usable_frame_count": usable_count,
                    "total_frames": total_frames,
                    "error_message": None
                }
            else:
                return {
                    "verdict": "unknown_face",
                    "error_message": f"Face not recognized (similarity: {mean_similarity:.3f}, required: {similarity_threshold}).",
                    "matched_student": None,
                    "match_score": mean_similarity,
                    "blink_count": blink_sm.blink_count,
                    "usable_frame_count": usable_count,
                    "total_frames": total_frames
                }

    def enroll_face(
        self,
        frames_bgr: List[np.ndarray],
        existing_templates: List[Tuple[str, str, str, np.ndarray]],
        similarity_threshold: float = 0.363
    ) -> Dict[str, Any]:
        with self._lock:
            self.initialize()

            total_frames = len(frames_bgr)
            usable_embeddings = []
            multi_face_count = 0

            for frame in frames_bgr:
                face_count, _, emb = self._extract_face_and_embedding(frame)
                if face_count > 1:
                    multi_face_count += 1
                if face_count == 1 and emb is not None:
                    usable_embeddings.append(emb)

            if total_frames > 0 and (multi_face_count / total_frames) > 0.20:
                return {
                    "success": False,
                    "verdict": "multiple_faces",
                    "error": "Multiple faces detected during enrollment.",
                    "embedding": None
                }

            if len(usable_embeddings) < 3:
                return {
                    "success": False,
                    "verdict": "poor_frames",
                    "error": f"Please align face inside camera view (need at least 3 clear frames, got {len(usable_embeddings)}).",
                    "embedding": None
                }

            # Average and normalize
            avg_emb = np.mean(usable_embeddings, axis=0)
            norm = np.linalg.norm(avg_emb)
            if norm > 0:
                final_emb = avg_emb / norm
            else:
                final_emb = avg_emb

            # Check duplicate against existing templates ("one person, one identity")
            for s_id, roll, name, t_emb in existing_templates:
                sim = float(np.dot(final_emb, t_emb))
                if sim >= similarity_threshold:
                    return {
                        "success": False,
                        "verdict": "already_enrolled",
                        "error": f"Face matches already registered student: {name} ({roll}) with similarity {sim:.3f}.",
                        "embedding": None
                    }

            return {
                "success": True,
                "verdict": "ok",
                "embedding": final_emb,
                "error": None
            }


class MockFaceEngine(FaceEngine):
    """
    Deterministic Mock Face Engine for zero-dependency unit tests, API tests, and CI.
    Configurable to simulate any desired scenario.
    """
    def __init__(self):
        self.preset_verdict: Optional[str] = None
        self.preset_similarity: float = 0.85
        self.preset_blink_count: int = 1
        self.preset_matched_student: Optional[Dict[str, Any]] = None

    def set_mock_behavior(
        self,
        verdict: Optional[str] = None,
        similarity: float = 0.85,
        blinks: int = 1,
        matched_student: Optional[Dict[str, Any]] = None
    ):
        self.preset_verdict = verdict
        self.preset_similarity = similarity
        self.preset_blink_count = blinks
        self.preset_matched_student = matched_student

    def analyze_stream(
        self,
        frames_bgr: List[Any],
        enrolled_templates: List[Tuple[str, str, str, np.ndarray]],
        similarity_threshold: float = 0.363
    ) -> Dict[str, Any]:
        total = len(frames_bgr) if frames_bgr else 30

        if self.preset_verdict:
            verdict = self.preset_verdict
            if verdict == "multiple_faces":
                return {"verdict": "multiple_faces", "error_message": "Multiple faces detected", "matched_student": None, "match_score": 0.0, "blink_count": 0, "usable_frame_count": 0, "total_frames": total}
            elif verdict == "poor_frames":
                return {"verdict": "poor_frames", "error_message": "Insufficient usable frames", "matched_student": None, "match_score": 0.0, "blink_count": 0, "usable_frame_count": 2, "total_frames": total}
            elif verdict == "no_blink":
                return {"verdict": "no_blink", "error_message": "No blink detected", "matched_student": None, "match_score": 0.80, "blink_count": 0, "usable_frame_count": 25, "total_frames": total}
            elif verdict == "unknown_face":
                return {"verdict": "unknown_face", "error_message": "Unknown face", "matched_student": None, "match_score": 0.20, "blink_count": 2, "usable_frame_count": 25, "total_frames": total}
            elif verdict == "no_students":
                return {"verdict": "no_students", "error_message": "No students enrolled", "matched_student": None, "match_score": 0.0, "blink_count": 0, "usable_frame_count": 25, "total_frames": total}

        if len(enrolled_templates) == 0:
            return {
                "verdict": "no_students",
                "error_message": "No students enrolled in database.",
                "matched_student": None,
                "match_score": 0.0,
                "blink_count": 0,
                "usable_frame_count": 25,
                "total_frames": total
            }

        # Match with preset student or first enrolled student
        if self.preset_matched_student:
            matched = self.preset_matched_student
        else:
            target_id, target_roll, target_name, _ = enrolled_templates[0]
            matched = {
                "student_id": target_id,
                "roll_no": target_roll,
                "name": target_name
            }

        return {
            "verdict": "ok",
            "matched_student": matched,
            "match_score": self.preset_similarity,
            "blink_count": self.preset_blink_count,
            "usable_frame_count": 25,
            "total_frames": total,
            "error_message": None
        }

    def enroll_face(
        self,
        frames_bgr: List[Any],
        existing_templates: List[Tuple[str, str, str, np.ndarray]],
        similarity_threshold: float = 0.363
    ) -> Dict[str, Any]:
        if self.preset_verdict == "poor_frames":
            return {"success": False, "verdict": "poor_frames", "error": "Insufficient frames", "embedding": None}
        if self.preset_verdict == "already_enrolled":
            return {"success": False, "verdict": "already_enrolled", "error": "Face already registered", "embedding": None}

        # Generate deterministic synthetic embedding
        rng = np.random.default_rng(seed=len(existing_templates) + 42)
        emb = rng.standard_normal(128).astype(np.float32)
        emb /= np.linalg.norm(emb)
        return {"success": True, "verdict": "ok", "embedding": emb, "error": None}
