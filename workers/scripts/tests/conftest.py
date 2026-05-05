"""
Shared pytest fixtures for HypeReels ML script tests.

All fixtures are deterministic and self-contained — no real video/audio files,
no real InsightFace models, no real librosa file I/O.
"""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest


# ─── Audio analysis fixtures ──────────────────────────────────────────────────

@pytest.fixture
def sample_rate():
    """Standard sample rate used across audio analysis tests."""
    return 44100


@pytest.fixture
def bpm_120_beat_frames(sample_rate):
    """
    Beat frames for 120 BPM audio.
    At 120 BPM, one beat every 0.5 seconds.
    Frames: 0, 22050, 44100, 66150, 88200 (every sr/2 frames).
    """
    return np.array([0, 22050, 44100, 66150, 88200], dtype=float)


@pytest.fixture
def bpm_120_beats_ms():
    """Expected beat timestamps in milliseconds for 120 BPM at 44100 Hz."""
    return [0, 500, 1000, 1500, 2000]


@pytest.fixture
def empty_beat_frames():
    """Empty beat frames — simulates ambient/no-rhythm audio."""
    return np.array([], dtype=float)


@pytest.fixture
def mock_audio_file(tmp_path):
    """
    Creates a temp file that appears to be a valid audio path.
    The actual file contents don't matter — librosa.load is mocked.
    """
    audio_file = tmp_path / "test_audio.mp3"
    audio_file.write_bytes(b"\xff\xfb" + b"\x00" * 100)  # Minimal MP3 header
    return str(audio_file)


@pytest.fixture
def mock_audio_array(sample_rate):
    """
    Synthetic audio signal: 5-second sine wave at 440 Hz.
    Deterministic, no random elements.
    """
    duration_s = 5.0
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    signal = 0.5 * np.sin(2 * np.pi * 440 * t).astype(np.float32)
    return signal, sample_rate


# ─── Person detection fixtures ─────────────────────────────────────────────────

@pytest.fixture
def mock_video_path(tmp_path):
    """
    Creates a temp file that appears to be a valid video path.
    OpenCV/cv2 is mocked so actual video content doesn't matter.
    """
    video_file = tmp_path / "test_clip.mp4"
    video_file.write_bytes(b"\x00" * 64)  # Placeholder bytes
    return str(video_file)


@pytest.fixture
def session_id():
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def clip_id():
    return "550e8400-e29b-41d4-a716-446655440001"


@pytest.fixture
def mock_output_dir(tmp_path):
    """Temp directory for person detection thumbnail output."""
    output = tmp_path / "persons"
    output.mkdir()
    return str(output)


@pytest.fixture
def mock_face_one():
    """
    Single mock InsightFace Face object with high confidence.
    Fields match what InsightFace's app.get() returns.
    """
    face = MagicMock()
    face.bbox = np.array([10.0, 20.0, 90.0, 120.0])  # x1, y1, x2, y2
    face.det_score = 0.92
    face.normed_embedding = np.zeros(512, dtype=np.float32)
    return face


@pytest.fixture
def mock_face_low_confidence():
    """InsightFace Face object with confidence below the 0.70 threshold."""
    face = MagicMock()
    face.bbox = np.array([5.0, 5.0, 50.0, 60.0])
    face.det_score = 0.55
    face.normed_embedding = np.zeros(512, dtype=np.float32)
    return face


@pytest.fixture
def mock_video_capture_5s(sample_rate=30):
    """
    Mock cv2.VideoCapture for a 5-second, 30fps video.
    Returns a blank 100x100 BGR frame on read().
    """
    cap = MagicMock()
    cap.isOpened.return_value = True
    cap.get.side_effect = lambda prop: {
        0: 150,   # CAP_PROP_FRAME_COUNT = 150 (5s × 30fps)
        5: 30.0,  # CAP_PROP_FPS = 30
    }.get(prop, 0)

    blank_frame = np.zeros((100, 100, 3), dtype=np.uint8)
    cap.read.return_value = (True, blank_frame)
    return cap


@pytest.fixture
def mock_video_capture_1s():
    """Mock cv2.VideoCapture for a sub-second clip (20 frames at 30fps = ~0.67s)."""
    cap = MagicMock()
    cap.isOpened.return_value = True
    cap.get.side_effect = lambda prop: {
        0: 20,    # CAP_PROP_FRAME_COUNT
        5: 30.0,  # CAP_PROP_FPS
    }.get(prop, 0)

    blank_frame = np.zeros((100, 100, 3), dtype=np.uint8)
    cap.read.return_value = (True, blank_frame)
    return cap


@pytest.fixture
def mock_video_capture_no_faces():
    """Mock cv2.VideoCapture that returns frames, but InsightFace finds no faces."""
    cap = MagicMock()
    cap.isOpened.return_value = True
    cap.get.side_effect = lambda prop: {
        0: 150,
        5: 30.0,
    }.get(prop, 0)
    blank_frame = np.zeros((100, 100, 3), dtype=np.uint8)
    cap.read.return_value = (True, blank_frame)
    return cap
