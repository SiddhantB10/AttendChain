"""
Unit Tests for Blink Liveness State Machine
Testing scenarios:
- No blink (static photo / staring)
- One normal blink
- Two distinct blinks
- Eyes kept closed too long (> 8 frames / sleeping / fake picture)
- Jitter around threshold
- Lost face in middle of sequence
- Stream starting closed
"""

import pytest
from backend.ai.liveness import BlinkStateMachine

def test_no_blink():
    """Eyes constantly open (e.g. photo or staring)."""
    sm = BlinkStateMachine()
    closures = [0.1, 0.15, 0.2, 0.12, 0.18, 0.1, 0.15, 0.2]
    count = sm.process_sequence(closures)
    assert count == 0

def test_one_blink():
    """Normal single blink: OPEN -> CLOSED (<= 8 frames) -> OPEN."""
    sm = BlinkStateMachine()
    closures = [
        0.1, 0.15,      # Open
        0.55, 0.60, 0.52, # Closed for 3 frames
        0.2, 0.15       # Re-opened
    ]
    count = sm.process_sequence(closures)
    assert count == 1

def test_two_blinks():
    """Two distinct blinks separated by open eyes."""
    sm = BlinkStateMachine()
    closures = [
        0.1, 0.1,       # Open
        0.6, 0.7,       # Blink 1 closed (2 frames)
        0.2, 0.1, 0.15, # Open
        0.65, 0.75,     # Blink 2 closed (2 frames)
        0.25, 0.2       # Open
    ]
    count = sm.process_sequence(closures)
    assert count == 2

def test_eyes_kept_closed_too_long():
    """Eyes closed for more than 8 frames (e.g. photo with closed eyes or sleeping)."""
    sm = BlinkStateMachine()
    closures = (
        [0.1, 0.15] +          # Open
        [0.7] * 12 +           # Closed for 12 frames (> 8)
        [0.15, 0.1]            # Reopened
    )
    count = sm.process_sequence(closures)
    assert count == 0 # Rejected as a blink because duration exceeded 8 frames

def test_jitter_around_threshold():
    """Closure values fluctuating between 0.36 and 0.49 (hysteresis boundary)."""
    sm = BlinkStateMachine()
    # Stays in hysteresis band: neither >= 0.50 (to trigger closed) nor <= 0.35 (to trigger open)
    closures = [0.2, 0.4, 0.45, 0.38, 0.42, 0.48, 0.37, 0.2]
    count = sm.process_sequence(closures)
    assert count == 0

def test_lost_face_resets_state():
    """Face is lost (closure is None) while eyes were closing."""
    sm = BlinkStateMachine()
    closures = [
        0.1,
        0.6, 0.65, # Started closing
        None,      # Lost face!
        0.2, 0.1   # Opened (face returned)
    ]
    count = sm.process_sequence(closures)
    assert count == 0 # Reset when face was lost, so no blink registered

def test_stream_starting_closed():
    """Camera starts with person's eyes already closed."""
    sm = BlinkStateMachine()
    closures = [
        0.8, 0.75, # Started already closed
        0.2, 0.15, # Opens eyes (NOT a blink)
        0.1,
        0.7, 0.65, # Real blink closed
        0.2, 0.15  # Real blink open
    ]
    count = sm.process_sequence(closures)
    assert count == 1 # Only the second event is counted as a genuine blink

