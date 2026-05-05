"""
Unit tests for detect_persons.py

Tests cover:
- Output contract shape: person_id, bbox, thumbnail, confidence, appearances (TC-047)
- No-persons case returns empty array (TC-048)
- Low-confidence detection included at correct value (TC-049)
- CPUExecutionProvider selected when CUDA unavailable (TC-050)
- Sub-second clip handled gracefully (TC-051)

All heavy dependencies (cv2.VideoCapture, insightface.app.FaceAnalysis,
cv2.imwrite) are mocked. Tests run without GPU, without video files,
and without real InsightFace models.
"""

import json
import os
import sys
import uuid
from pathlib import Path
from typing import List
from unittest.mock import MagicMock, patch, call
from io import StringIO

import numpy as np
import pytest


# ─── Script path setup ────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))


def _make_face(det_score: float = 0.92, bbox=None) -> MagicMock:
    """Create a mock InsightFace Face object."""
    face = MagicMock()
    face.bbox = np.array(bbox or [10.0, 20.0, 90.0, 120.0], dtype=float)
    face.det_score = det_score
    face.normed_embedding = np.zeros(512, dtype=np.float32)
    return face


def _run_detect_persons(
    video_path: str,
    session_id: str,
    clip_id: str,
    output_dir: str,
    *,
    faces_per_frame: List = None,
    total_frames: int = 150,
    fps: float = 30.0,
    providers: str = "CPUExecutionProvider",
) -> dict:
    """
    Run detect_persons with all external dependencies mocked.

    faces_per_frame: list of faces returned by FaceAnalysis.get() on each sampled frame.
                     If None, uses one high-confidence face.
    Returns parsed JSON output dict.
    """
    if faces_per_frame is None:
        faces_per_frame = [[_make_face(0.92)]]

    # Mock cv2
    mock_cv2 = MagicMock()
    blank_frame = np.zeros((100, 100, 3), dtype=np.uint8)

    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True
    mock_cap.get.side_effect = lambda prop: {
        0: float(total_frames),   # CAP_PROP_FRAME_COUNT
        5: fps,                    # CAP_PROP_FPS
    }.get(prop, 0.0)

    # Make read() return a frame for each sampled position
    read_call_count = [0]

    def _read():
        idx = read_call_count[0]
        read_call_count[0] += 1
        return (True, blank_frame)

    mock_cap.read.side_effect = lambda: _read()
    mock_cv2.VideoCapture.return_value = mock_cap
    mock_cv2.cvtColor.return_value = blank_frame
    mock_cv2.imwrite.return_value = True
    mock_cv2.CAP_PROP_FRAME_COUNT = 0
    mock_cv2.CAP_PROP_FPS = 5
    mock_cv2.COLOR_BGR2RGB = 4

    # Mock InsightFace
    mock_insightface = MagicMock()
    mock_app = MagicMock()

    # Cycle through faces_per_frame for each call to app.get()
    face_call_count = [0]

    def _get_faces(frame):
        idx = face_call_count[0] % len(faces_per_frame)
        face_call_count[0] += 1
        return faces_per_frame[idx]

    mock_app.get.side_effect = _get_faces
    mock_insightface.app.FaceAnalysis.return_value = mock_app

    # Mock os.environ for providers
    mock_env = {"INSIGHTFACE_PROVIDERS": providers}

    captured = StringIO()

    with patch.dict("sys.modules", {
        "cv2": mock_cv2,
        "insightface": mock_insightface,
        "insightface.app": mock_insightface.app,
    }):
        with patch.dict(os.environ, mock_env, clear=False):
            with patch("sys.argv", [
                "detect_persons.py", video_path, session_id, clip_id, output_dir
            ]):
                with patch("sys.stdout", captured):
                    if "detect_persons" in sys.modules:
                        del sys.modules["detect_persons"]
                    import detect_persons  # noqa: F401

    output = captured.getvalue().strip()
    return json.loads(output)


# ─── TC-047: Output contract shape ────────────────────────────────────────────

class TestDetectPersonsOutputContract:
    def test_output_is_array(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: Output JSON is an array."""
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir)
        assert isinstance(result, list), "Output must be a JSON array"

    def test_person_has_person_id_uuid(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: Each person has person_id as a UUID string."""
        faces = [[_make_face(0.92)]]
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir,
                                      faces_per_frame=faces)
        assert len(result) >= 1, "Expected at least one person"
        person = result[0]
        assert "person_id" in person, "person must have person_id"
        # Must be a valid UUID
        try:
            uuid.UUID(person["person_id"])
        except ValueError:
            pytest.fail(f"person_id '{person['person_id']}' is not a valid UUID")

    def test_person_has_bbox_4_elements(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: bbox is a 4-element array [x, y, w, h]."""
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir)
        for person in result:
            assert "bbox" in person, "person must have bbox"
            assert isinstance(person["bbox"], list), "bbox must be a list"
            assert len(person["bbox"]) == 4, \
                f"bbox must have 4 elements, got {len(person['bbox'])}"

    def test_person_has_thumbnail_string(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: thumbnail is a non-empty string (file path or object key)."""
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir)
        for person in result:
            assert "thumbnail" in person, "person must have thumbnail"
            assert isinstance(person["thumbnail"], str), "thumbnail must be a string"
            assert len(person["thumbnail"]) > 0, "thumbnail must be non-empty"

    def test_person_has_confidence_float(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: confidence is a float between 0.0 and 1.0."""
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir)
        for person in result:
            assert "confidence" in person, "person must have confidence"
            assert isinstance(person["confidence"], float), \
                f"confidence must be float, got {type(person['confidence'])}"
            assert 0.0 <= person["confidence"] <= 1.0, \
                f"confidence must be in [0,1], got {person['confidence']}"

    def test_person_has_appearances_array(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: appearances is an array of {clip_id, timestamp_ms} objects."""
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir)
        for person in result:
            assert "appearances" in person, "person must have appearances"
            assert isinstance(person["appearances"], list), "appearances must be a list"
            for appearance in person["appearances"]:
                assert "clip_id" in appearance, "appearance must have clip_id"
                assert "timestamp_ms" in appearance, "appearance must have timestamp_ms"
                assert isinstance(appearance["timestamp_ms"], int), \
                    "timestamp_ms must be an int"
                assert appearance["timestamp_ms"] >= 0, "timestamp_ms must be >= 0"

    def test_appearance_clip_id_matches_input(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-047: clip_id in each appearance matches the input clip_id."""
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir)
        for person in result:
            for appearance in person["appearances"]:
                assert appearance["clip_id"] == clip_id, \
                    f"appearance clip_id must equal input clip_id '{clip_id}'"

    def test_confidence_value_matches_face_det_score(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-047: confidence in output equals the face det_score from InsightFace."""
        face = _make_face(det_score=0.92)
        result = _run_detect_persons(mock_video_path, session_id, clip_id, mock_output_dir,
                                      faces_per_frame=[[face]])
        assert len(result) >= 1
        assert abs(result[0]["confidence"] - 0.92) < 0.01, \
            f"Expected confidence≈0.92, got {result[0]['confidence']}"


# ─── TC-048: No persons case ──────────────────────────────────────────────────

class TestNoPersonsCase:
    def test_no_faces_returns_empty_array(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-048: When InsightFace finds no faces, output is []."""
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[]]  # No faces on any frame
        )
        assert result == [], f"Expected [], got {result}"

    def test_no_faces_is_not_an_error(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-048: Empty array output is valid JSON (no exception = exit code 0)."""
        # If this raises, test fails — no exception means exit 0 path
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[]]
        )
        assert isinstance(result, list), "No-persons output must be a list"

    def test_no_faces_output_is_serializable(self, mock_video_path, session_id, clip_id, mock_output_dir):
        """TC-048: Empty array is valid JSON and serializable."""
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[]]
        )
        # Confirm it round-trips through JSON
        serialized = json.dumps(result)
        assert serialized == "[]", f"Expected '[]', got '{serialized}'"


# ─── TC-049: Low-confidence detection ─────────────────────────────────────────

class TestLowConfidenceDetection:
    def test_low_confidence_face_included_in_output(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-049: Faces with confidence < 0.70 are included (filtering is UI responsibility)."""
        low_conf_face = _make_face(det_score=0.55)
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[low_conf_face]]
        )
        assert len(result) >= 1, "Low confidence face must still appear in output"
        assert result[0]["confidence"] < 0.70, \
            f"Expected confidence < 0.70, got {result[0]['confidence']}"

    def test_low_confidence_value_preserved(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-049: Exact confidence value 0.55 is preserved in output."""
        low_conf_face = _make_face(det_score=0.55)
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[low_conf_face]]
        )
        assert len(result) >= 1
        assert abs(result[0]["confidence"] - 0.55) < 0.01, \
            f"Expected confidence≈0.55, got {result[0]['confidence']}"

    def test_high_confidence_face_included(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-049: High confidence face (0.92) also included correctly."""
        high_conf_face = _make_face(det_score=0.92)
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[high_conf_face]]
        )
        assert len(result) >= 1
        assert result[0]["confidence"] >= 0.70


# ─── TC-050: CPUExecutionProvider selection ───────────────────────────────────

class TestCPUProviderSelection:
    def test_cpu_provider_no_crash(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-050: Script runs without crash when INSIGHTFACE_PROVIDERS=CPUExecutionProvider."""
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            providers="CPUExecutionProvider"
        )
        assert isinstance(result, list), \
            "CPU-only path must produce valid JSON list output"

    def test_cpu_provider_output_is_valid(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-050: Output from CPU path passes full contract validation."""
        face = _make_face(0.85)
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[face]],
            providers="CPUExecutionProvider"
        )
        for person in result:
            assert "person_id" in person
            assert "bbox" in person
            assert "thumbnail" in person
            assert "confidence" in person
            assert "appearances" in person

    def test_no_cuda_error_in_cpu_mode(
        self, mock_video_path, session_id, clip_id, mock_output_dir, capsys
    ):
        """TC-050: CPU-only mode produces no CUDA-related errors in stderr."""
        _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            providers="CPUExecutionProvider"
        )
        captured = capsys.readouterr()
        # stderr must not contain CUDA failure messages
        assert "CUDA" not in captured.err.upper() or "fallback" in captured.err.lower(), \
            "CPU mode must not emit unhandled CUDA errors"


# ─── TC-051: Sub-second clip ──────────────────────────────────────────────────

class TestSubSecondClip:
    def test_short_clip_no_crash(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-051: Clip shorter than 1 second (20 frames at 30fps) exits with code 0."""
        # total_frames=20, fps=30 → ~0.67 seconds
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[]],  # No faces (not enough to sample)
            total_frames=20,
            fps=30.0
        )
        assert isinstance(result, list), \
            "Sub-second clip must produce valid JSON list (may be empty)"

    def test_short_clip_output_is_valid_json(
        self, mock_video_path, session_id, clip_id, mock_output_dir
    ):
        """TC-051: Output for sub-second clip is valid JSON."""
        result = _run_detect_persons(
            mock_video_path, session_id, clip_id, mock_output_dir,
            faces_per_frame=[[]],
            total_frames=20,
            fps=30.0
        )
        # Verify round-trip serialization
        json.dumps(result)  # Raises if not serializable
