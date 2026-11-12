"""
Blink Liveness Detection for AttendChain.
Uses MediaPipe Face Landmarker blendshapes (eyeBlinkLeft and eyeBlinkRight)
with a hysteresis state machine.
"""

from typing import List, Optional, Tuple, Dict, Any

class BlinkStateMachine:
    """
    Hysteresis State Machine for Blink Detection:
    - Eye closure threshold: closed >= 0.5, open <= 0.35
    - Valid blink: Eyes transition from OPEN -> CLOSED -> OPEN
    - Max closed duration: 8 frames (longer closure = sleeping/eyes shut, not a blink)
    - Losing face resets the state machine
    - Stream starting closed is discarded (not counted as a blink upon opening)
    """

    STATE_OPEN = "OPEN"
    STATE_CLOSED = "CLOSED"
    STATE_EXCEEDED = "EXCEEDED"

    def __init__(self, closed_thresh: float = 0.50, open_thresh: float = 0.35, max_closed_frames: int = 8):
        self.closed_thresh = closed_thresh
        self.open_thresh = open_thresh
        self.max_closed_frames = max_closed_frames

        self.state = self.STATE_OPEN
        self.closed_frames = 0
        self.blink_count = 0
        self.first_frame = True

    def reset(self):
        self.state = self.STATE_OPEN
        self.closed_frames = 0
        self.first_frame = True

    def process_frame(self, closure: Optional[float], has_face: bool = True) -> int:
        """
        Processes a single frame's eye closure value.
        closure: mean of eyeBlinkLeft and eyeBlinkRight (0.0 to 1.0), or None if no face.
        Returns the total cumulative blink count.
        """
        if not has_face or closure is None:
            # Losing face resets the state
            self.state = self.STATE_OPEN
            self.closed_frames = 0
            return self.blink_count

        # If stream starts already closed, mark as EXCEEDED so reopening is not counted as a blink
        if self.first_frame:
            self.first_frame = False
            if closure >= self.closed_thresh:
                self.state = self.STATE_EXCEEDED
                self.closed_frames = 1
                return self.blink_count

        if self.state == self.STATE_OPEN:
            if closure >= self.closed_thresh:
                self.state = self.STATE_CLOSED
                self.closed_frames = 1

        elif self.state == self.STATE_CLOSED:
            if closure <= self.open_thresh:
                # Valid blink completed!
                if 1 <= self.closed_frames <= self.max_closed_frames:
                    self.blink_count += 1
                self.state = self.STATE_OPEN
                self.closed_frames = 0
            else:
                self.closed_frames += 1
                if self.closed_frames > self.max_closed_frames:
                    # Eyes held closed too long
                    self.state = self.STATE_EXCEEDED

        elif self.state == self.STATE_EXCEEDED:
            if closure <= self.open_thresh:
                # Reopened after prolonged closure; reset to open without incrementing
                self.state = self.STATE_OPEN
                self.closed_frames = 0
            else:
                self.closed_frames += 1

        return self.blink_count

    def process_sequence(self, closures: List[Optional[float]]) -> int:
        """Helper to process a list of closure values sequentially."""
        for c in closures:
            self.process_frame(c, has_face=(c is not None))
        return self.blink_count


class MediaPipeLivenessDetector:
    """
    Extracts eyeBlinkLeft and eyeBlinkRight from frames using MediaPipe FaceLandmarker.
    """
    def __init__(self, model_path: Optional[str] = None):
        self.model_path = model_path
        self._landmarker = None

    def initialize(self):
        if self._landmarker is not None:
            return

        import os
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        default_path = os.path.join(os.path.dirname(__file__), "../models/face_landmarker.task")
        path = self.model_path or default_path

        if not os.path.exists(path):
            raise FileNotFoundError(f"MediaPipe Face Landmarker model not found at {path}. Run scripts/download_models.py.")

        base_options = python.BaseOptions(model_asset_path=path)
        options = vision.FaceLandmarkerOptions(
            base_options=base_options,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=False,
            num_faces=1
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(options)

    def extract_eye_closure(self, image_rgb_numpy) -> Optional[float]:
        """
        Runs face landmarker on RGB numpy array (H, W, 3).
        Returns mean(eyeBlinkLeft, eyeBlinkRight) or None if no face detected.
        """
        import mediapipe as mp
        self.initialize()

        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb_numpy)
        result = self._landmarker.detect(mp_image)

        if not result.face_blendshapes or len(result.face_blendshapes) == 0:
            return None

        blendshapes = result.face_blendshapes[0]
        blink_left = 0.0
        blink_right = 0.0
        found_left = False
        found_right = False

        for category in blendshapes:
            if category.category_name == "eyeBlinkLeft":
                blink_left = category.score
                found_left = True
            elif category.category_name == "eyeBlinkRight":
                blink_right = category.score
                found_right = True

        if found_left and found_right:
            return (blink_left + blink_right) / 2.0
        return None

