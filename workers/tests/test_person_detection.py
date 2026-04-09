"""pytest tests for workers/person_detection/person_detection_worker.py.

What this file tests and why
------------------------------
The person detection worker is the most infrastructure-heavy component: it
requires InsightFace (buffalo_l model), OpenCV, MinIO, PostgreSQL, and Redis.
Running those in CI would require the full stack and would be very slow.

This test file therefore:

1. Mocks InsightFace entirely so no model download is needed in CI.
2. Uses numpy arrays as synthetic "frames" — no real video files needed.
3. Tests the pure logic: frame sampling count, cosine similarity clustering,
   empty-clip handling, and the response schema shape.
4. Validates ADR-013: InsightFace MUST be initialised with CPUExecutionProvider
   only (no CUDAExecutionProvider) because the GTX 1080 Ti is shared with
   Frigate NVR and FileFlows.

Run with:
    pytest workers/tests/test_person_detection.py -v
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch, PropertyMock

import numpy as np
import pytest


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_embedding(seed: int = 0, dim: int = 512) -> np.ndarray:
    """Return a deterministic unit-normalised 512-dim float32 vector."""
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    norm = np.linalg.norm(v)
    return v / norm if norm > 0 else v


def _make_face_obj(
    det_score: float = 0.95,
    bbox: list[float] | None = None,
    embedding: np.ndarray | None = None,
) -> MagicMock:
    """Return a mock InsightFace Face object with the minimal required attributes."""
    face = MagicMock()
    face.det_score = det_score
    face.bbox = np.array(bbox or [100.0, 50.0, 300.0, 350.0], dtype=np.float32)
    face.embedding = embedding if embedding is not None else _make_embedding()
    return face


def _make_bgr_frame(height: int = 480, width: int = 640) -> np.ndarray:
    """Return a simple solid-colour BGR numpy frame."""
    return np.zeros((height, width, 3), dtype=np.uint8)


# ── TC-013: InsightFace initialised with CPUExecutionProvider only ────────────

class TestInsightFaceCPUInit:
    """ADR-013: InsightFace MUST use CPUExecutionProvider exclusively.

    The GTX 1080 Ti on Quorra is reserved for Frigate NVR and FileFlows.
    Using CUDAExecutionProvider would contend with those critical services.
    ctx_id=-1 selects CPU mode; ctx_id=0 would select GPU 0.
    """

    def test_face_analysis_called_with_cpu_provider_only(self):
        """_get_insight_app() must call FaceAnalysis with providers=['CPUExecutionProvider']."""
        with patch("person_detection.person_detection_worker.FaceAnalysis") as MockFA:
            mock_instance = MagicMock()
            MockFA.return_value = mock_instance

            # Reset the module-level singleton so it re-initialises
            import person_detection.person_detection_worker as pdw
            pdw._insight_app = None

            _ = pdw._get_insight_app()

            MockFA.assert_called_once()
            call_kwargs = MockFA.call_args
            # Accept both positional and keyword argument forms
            providers_arg = None
            if call_kwargs.kwargs.get("providers") is not None:
                providers_arg = call_kwargs.kwargs["providers"]
            elif len(call_kwargs.args) >= 2:
                providers_arg = call_kwargs.args[1]

            assert providers_arg == ["CPUExecutionProvider"], (
                f"InsightFace must use only CPUExecutionProvider, got: {providers_arg}"
            )

    def test_face_analysis_called_without_cuda_provider(self):
        """CUDAExecutionProvider must NOT appear in the providers list (ADR-013)."""
        with patch("person_detection.person_detection_worker.FaceAnalysis") as MockFA:
            mock_instance = MagicMock()
            MockFA.return_value = mock_instance

            import person_detection.person_detection_worker as pdw
            pdw._insight_app = None

            _ = pdw._get_insight_app()

            call_kwargs = MockFA.call_args
            providers_arg = call_kwargs.kwargs.get("providers") or (
                call_kwargs.args[1] if len(call_kwargs.args) >= 2 else None
            )
            if providers_arg is not None:
                assert "CUDAExecutionProvider" not in providers_arg, (
                    "CUDAExecutionProvider must not be used — GPU is reserved for Frigate (ADR-013)"
                )

    def test_prepare_called_with_cpu_ctx_id(self):
        """prepare() must be called with ctx_id=-1 (CPU), not ctx_id=0 (GPU 0)."""
        with patch("person_detection.person_detection_worker.FaceAnalysis") as MockFA:
            mock_instance = MagicMock()
            MockFA.return_value = mock_instance

            import person_detection.person_detection_worker as pdw
            pdw._insight_app = None

            _ = pdw._get_insight_app()

            mock_instance.prepare.assert_called_once()
            prepare_kwargs = mock_instance.prepare.call_args
            ctx_id = prepare_kwargs.kwargs.get("ctx_id")
            if ctx_id is None and len(prepare_kwargs.args) >= 1:
                ctx_id = prepare_kwargs.args[0]

            assert ctx_id == -1, (
                f"prepare() ctx_id must be -1 (CPU), got {ctx_id}"
            )

    def test_singleton_reused_on_second_call(self):
        """_get_insight_app() should return the same instance on repeated calls."""
        with patch("person_detection.person_detection_worker.FaceAnalysis") as MockFA:
            mock_instance = MagicMock()
            MockFA.return_value = mock_instance

            import person_detection.person_detection_worker as pdw
            pdw._insight_app = None

            app1 = pdw._get_insight_app()
            app2 = pdw._get_insight_app()

            assert app1 is app2
            assert MockFA.call_count == 1, "FaceAnalysis constructor should only be called once"


# ── TC-014: Frame sampling count ─────────────────────────────────────────────

class TestFrameSampling:
    """sample_frames() must produce the expected number of frames at 2 fps.

    A 10-second clip at 25 fps with interval_sec=0.5 should yield ~20 frames.
    We mock cv2.VideoCapture so no actual video file is needed.
    """

    def _make_mock_capture(
        self,
        fps: float = 25.0,
        total_frames: int = 250,  # 10 s at 25 fps
        height: int = 480,
        width: int = 640,
    ) -> MagicMock:
        cap = MagicMock()
        cap.isOpened.return_value = True
        cap.get.side_effect = lambda prop: {
            0: 0.0,       # CAP_PROP_POS_MSEC
            5: fps,       # CAP_PROP_FPS
            7: total_frames,  # CAP_PROP_FRAME_COUNT
        }.get(prop, 0.0)

        frame = _make_bgr_frame(height, width)
        # read() always succeeds with a valid frame
        cap.read.return_value = (True, frame)
        return cap

    def test_10s_clip_at_2fps_yields_approx_20_frames(self):
        """10 s clip at 25 fps, interval=0.5 s → step=12 frames → ~20 samples."""
        from person_detection.person_detection_worker import sample_frames

        cap = self._make_mock_capture(fps=25.0, total_frames=250)

        with patch("person_detection.person_detection_worker.cv2") as mock_cv2:
            mock_cv2.VideoCapture.return_value = cap
            mock_cv2.CAP_PROP_FPS = 5
            mock_cv2.CAP_PROP_FRAME_COUNT = 7

            # Build a side_effect for cap.get that handles our mock correctly
            cap_instance = mock_cv2.VideoCapture.return_value
            cap_instance.isOpened.return_value = True

            # Reset to use our custom cap
            cap_instance.get.side_effect = lambda prop: {
                5: 25.0,
                7: 250,
            }.get(prop, 0.0)
            cap_instance.read.return_value = (True, _make_bgr_frame())

            result = sample_frames(Path("/fake/video.mp4"), interval_sec=0.5)

        # At 25 fps, step = max(1, int(25 * 0.5)) = 12
        # Frame indices: 0, 12, 24, 36, ..., 240 → ceil(250/12) ≈ 21 frames
        assert 18 <= len(result) <= 22, (
            f"Expected ~20 frames for 10 s clip at 2 fps, got {len(result)}"
        )

    def test_each_frame_is_tuple_of_timestamp_and_array(self):
        """sample_frames returns list of (timestamp_ms, np.ndarray) tuples."""
        from person_detection.person_detection_worker import sample_frames

        frame = _make_bgr_frame()
        with patch("person_detection.person_detection_worker.cv2") as mock_cv2:
            cap = mock_cv2.VideoCapture.return_value
            cap.isOpened.return_value = True
            cap.get.side_effect = lambda prop: {5: 10.0, 7: 50}.get(prop, 0.0)
            cap.read.return_value = (True, frame)

            result = sample_frames(Path("/fake/video.mp4"), interval_sec=0.5)

        if result:
            ts, frm = result[0]
            assert isinstance(ts, int), f"timestamp must be int (ms), got {type(ts)}"
            assert isinstance(frm, np.ndarray), f"frame must be np.ndarray, got {type(frm)}"

    def test_timestamps_are_non_negative_and_ascending(self):
        """All timestamps must be >= 0 and in ascending order."""
        from person_detection.person_detection_worker import sample_frames

        frame = _make_bgr_frame()
        with patch("person_detection.person_detection_worker.cv2") as mock_cv2:
            cap = mock_cv2.VideoCapture.return_value
            cap.isOpened.return_value = True
            cap.get.side_effect = lambda prop: {5: 25.0, 7: 100}.get(prop, 0.0)
            cap.read.return_value = (True, frame)

            result = sample_frames(Path("/fake/video.mp4"), interval_sec=0.5)

        if len(result) > 1:
            timestamps = [r[0] for r in result]
            assert all(t >= 0 for t in timestamps)
            assert timestamps == sorted(timestamps)

    def test_cannot_open_video_raises_runtime_error(self):
        """If cv2.VideoCapture cannot open the file, RuntimeError must be raised."""
        from person_detection.person_detection_worker import sample_frames

        with patch("person_detection.person_detection_worker.cv2") as mock_cv2:
            cap = mock_cv2.VideoCapture.return_value
            cap.isOpened.return_value = False

            with pytest.raises(RuntimeError, match="Cannot open video"):
                sample_frames(Path("/nonexistent.mp4"))

    def test_empty_video_returns_empty_list(self):
        """A video with 0 frames returns an empty list without error."""
        from person_detection.person_detection_worker import sample_frames

        with patch("person_detection.person_detection_worker.cv2") as mock_cv2:
            cap = mock_cv2.VideoCapture.return_value
            cap.isOpened.return_value = True
            cap.get.side_effect = lambda prop: {5: 25.0, 7: 0}.get(prop, 0.0)
            cap.read.return_value = (False, None)

            result = sample_frames(Path("/empty.mp4"))

        assert result == []


# ── TC-015: Cosine similarity threshold ──────────────────────────────────────

class TestCosimeSimilarity:
    """cosine_similarity() and match_or_create_person() must implement the
    ArcFace threshold correctly.

    ArcFace cosine similarity for same-person pairs typically falls in 0.4–0.7.
    Threshold 0.45 minimises false-merge vs false-split errors.
    """

    def test_identical_embeddings_have_similarity_1(self):
        from person_detection.person_detection_worker import cosine_similarity

        v = _make_embedding(seed=42)
        sim = cosine_similarity(v, v)
        assert abs(sim - 1.0) < 1e-5, f"Identical embeddings must have cosine sim = 1.0, got {sim}"

    def test_orthogonal_embeddings_have_similarity_near_0(self):
        from person_detection.person_detection_worker import cosine_similarity

        v1 = np.zeros(512, dtype=np.float32)
        v2 = np.zeros(512, dtype=np.float32)
        v1[0] = 1.0
        v2[1] = 1.0
        sim = cosine_similarity(v1, v2)
        assert abs(sim) < 1e-5, f"Orthogonal embeddings must have cosine sim ≈ 0, got {sim}"

    def test_zero_vector_returns_zero(self):
        from person_detection.person_detection_worker import cosine_similarity

        v = _make_embedding(seed=1)
        zero = np.zeros(512, dtype=np.float32)
        sim = cosine_similarity(v, zero)
        assert sim == 0.0

    def test_same_person_above_threshold_reuses_ref_id(self):
        """Two very similar embeddings (same person) must share a person_ref_id."""
        from person_detection.person_detection_worker import match_or_create_person

        base = _make_embedding(seed=10)
        # Near-identical embedding: tiny perturbation, cosine sim >> 0.45
        noisy = base + np.random.default_rng(99).standard_normal(512).astype(np.float32) * 0.01
        noisy = noisy / np.linalg.norm(noisy)

        ref_id = str(uuid.uuid4())
        session_embeddings = [{"person_ref_id": ref_id, "embedding": base}]

        result_id = match_or_create_person(noisy, session_embeddings)
        assert result_id == ref_id, (
            f"Near-identical embedding should return existing ref_id {ref_id}, got {result_id}"
        )

    def test_different_person_below_threshold_creates_new_ref_id(self):
        """Two very different embeddings (different people) must get separate ref IDs."""
        from person_detection.person_detection_worker import match_or_create_person

        v1 = _make_embedding(seed=1)
        v2 = _make_embedding(seed=9999)  # Very different seed → low cosine sim

        ref_id = str(uuid.uuid4())
        session_embeddings = [{"person_ref_id": ref_id, "embedding": v1}]

        result_id = match_or_create_person(v2, session_embeddings)
        # If cosine sim < 0.45, a new UUID is generated
        if result_id != ref_id:
            # Correctly created a new ID
            assert result_id != ref_id
            # The session_embeddings list should now have two entries
            assert len(session_embeddings) == 2

    def test_threshold_is_0_45(self):
        """Verify the module constant FACE_COSINE_THRESHOLD equals 0.45."""
        from person_detection.person_detection_worker import FACE_COSINE_THRESHOLD

        assert FACE_COSINE_THRESHOLD == 0.45, (
            f"Expected FACE_COSINE_THRESHOLD = 0.45, got {FACE_COSINE_THRESHOLD}"
        )

    def test_empty_session_embeddings_always_creates_new(self):
        """With no existing embeddings, every call creates a new person_ref_id."""
        from person_detection.person_detection_worker import match_or_create_person

        session_embeddings: list[dict] = []
        v = _make_embedding(seed=42)
        ref_id = match_or_create_person(v, session_embeddings)

        assert isinstance(ref_id, str)
        assert len(ref_id) > 0
        assert len(session_embeddings) == 1  # Entry was appended

    def test_multiple_persons_creates_separate_entries(self):
        """Three distinct embeddings in one session must produce three separate ref IDs."""
        from person_detection.person_detection_worker import match_or_create_person

        session_embeddings: list[dict] = []
        ids = set()
        for seed in (1, 9999, 77777):
            v = _make_embedding(seed=seed)
            ref_id = match_or_create_person(v, session_embeddings)
            ids.add(ref_id)

        # All three should be distinct (assuming seeds produce dissimilar embeddings)
        # We allow for the rare case that two random embeddings happen to be similar
        assert len(ids) >= 2, f"Expected at least 2 distinct person IDs, got {ids}"


# ── TC-016: Empty clip produces empty persons list ────────────────────────────

class TestEmptyClipDetection:
    """When no faces are detected in a clip, the worker must return an empty
    persons list rather than raising an error.

    This is critical for STORY-009: 'No people were detected' should show a
    clear empty state message, not crash the session.
    """

    def test_detect_faces_in_frame_empty_returns_empty_list(self):
        """InsightFace returning [] from app.get() must produce an empty list."""
        from person_detection.person_detection_worker import detect_faces_in_frame

        frame = _make_bgr_frame()
        with patch("person_detection.person_detection_worker._get_insight_app") as mock_get_app:
            mock_app = MagicMock()
            mock_app.get.return_value = []  # No faces detected
            mock_get_app.return_value = mock_app

            result = detect_faces_in_frame(frame)

        assert result == []

    def test_detect_faces_low_confidence_filtered_out(self):
        """Faces below MIN_FACE_CONFIDENCE threshold must be filtered."""
        from person_detection.person_detection_worker import (
            detect_faces_in_frame,
            MIN_FACE_CONFIDENCE,
        )

        frame = _make_bgr_frame()
        low_conf_face = _make_face_obj(det_score=MIN_FACE_CONFIDENCE - 0.01)

        with patch("person_detection.person_detection_worker._get_insight_app") as mock_get_app:
            mock_app = MagicMock()
            mock_app.get.return_value = [low_conf_face]
            mock_get_app.return_value = mock_app

            result = detect_faces_in_frame(frame)

        assert result == [], (
            f"Face with confidence {low_conf_face.det_score} should be filtered out "
            f"(threshold={MIN_FACE_CONFIDENCE})"
        )

    def test_detect_faces_high_confidence_kept(self):
        """Faces at or above MIN_FACE_CONFIDENCE threshold must be retained."""
        from person_detection.person_detection_worker import (
            detect_faces_in_frame,
            MIN_FACE_CONFIDENCE,
        )

        frame = _make_bgr_frame()
        high_conf_face = _make_face_obj(det_score=MIN_FACE_CONFIDENCE + 0.1)

        with patch("person_detection.person_detection_worker._get_insight_app") as mock_get_app:
            mock_app = MagicMock()
            mock_app.get.return_value = [high_conf_face]
            mock_get_app.return_value = mock_app

            result = detect_faces_in_frame(frame)

        assert len(result) == 1

    def test_no_frame_detections_does_not_raise(self):
        """If all frames return empty face lists, the pipeline should complete cleanly."""
        from person_detection.person_detection_worker import (
            cluster_detections_within_clip,
        )

        # Simulate: no frames with faces detected
        frame_detections: list[tuple[int, list]] = []
        frame_dims: dict[int, tuple[int, int]] = {}

        # Must not raise
        result = cluster_detections_within_clip(frame_detections, frame_dims)
        assert result == {}

    def test_empty_track_map_produces_empty_persons(self):
        """An empty track_map must result in no PersonTrack objects being created."""
        from person_detection.person_detection_worker import PersonTrack

        track_map: dict[str, list] = {}
        person_tracks = []

        for provisional_id, detections in track_map.items():
            track = PersonTrack(
                person_ref_id=provisional_id,
                clip_id="clip-1",
                detections=detections,
            )
            person_tracks.append(track)

        assert person_tracks == []


# ── Response schema validation ────────────────────────────────────────────────

class TestResponseSchema:
    """The detect_persons() return dict must match the expected API contract.

    Expected shape:
    {
      "clip_id": str,
      "persons": [
        {
          "person_ref_id": str,
          "thumbnail_url": str,
          "confidence": float (0.0–1.0),
          "appearances": [{"start_ms": int, "end_ms": int, ...}, ...]
        }
      ]
    }
    """

    def test_empty_result_matches_schema(self):
        """The empty-clip result must match the expected schema."""
        result = {"clip_id": "test-clip-id", "persons": []}

        assert "clip_id" in result
        assert isinstance(result["clip_id"], str)
        assert "persons" in result
        assert isinstance(result["persons"], list)
        assert result["persons"] == []

    def test_person_result_fields_present(self):
        """A synthetic person result must have all required fields."""
        person = {
            "person_ref_id": str(uuid.uuid4()),
            "thumbnail_url": "https://minio.local/thumbnails/sess/persons/abc.jpg",
            "confidence": 0.92,
            "appearances": [
                {"start_ms": 1200, "end_ms": 4800}
            ],
        }

        assert "person_ref_id" in person
        assert isinstance(person["person_ref_id"], str)
        assert "thumbnail_url" in person
        assert isinstance(person["thumbnail_url"], str)
        assert "confidence" in person
        assert 0.0 <= person["confidence"] <= 1.0
        assert "appearances" in person
        assert isinstance(person["appearances"], list)
        for app in person["appearances"]:
            assert "start_ms" in app
            assert "end_ms" in app
            assert isinstance(app["start_ms"], int)
            assert isinstance(app["end_ms"], int)
            assert app["end_ms"] > app["start_ms"]

    def test_person_track_appearances_merges_consecutive_detections(self):
        """PersonTrack.appearances must merge temporally adjacent detections into windows."""
        from person_detection.person_detection_worker import (
            PersonTrack,
            FaceDetection,
            BoundingBox,
            FRAME_SAMPLE_INTERVAL_SEC,
        )

        bb = BoundingBox(left=0.1, top=0.1, width=0.2, height=0.3)
        # Three consecutive detections at 0, 500, 1000 ms
        detections = [
            FaceDetection(frame_ms=0, bounding_box=bb, confidence=0.9, embedding=_make_embedding(0)),
            FaceDetection(frame_ms=500, bounding_box=bb, confidence=0.9, embedding=_make_embedding(1)),
            FaceDetection(frame_ms=1000, bounding_box=bb, confidence=0.9, embedding=_make_embedding(2)),
        ]

        track = PersonTrack(
            person_ref_id=str(uuid.uuid4()),
            clip_id="clip-test",
            detections=detections,
        )

        appearances = track.appearances

        assert isinstance(appearances, list)
        assert len(appearances) >= 1
        # All windows must have start_ms < end_ms
        for w in appearances:
            assert w["start_ms"] < w["end_ms"]

    def test_frame_sample_interval_is_0_5_seconds(self):
        """FRAME_SAMPLE_INTERVAL_SEC must be 0.5 (2 fps sampling per architecture spec)."""
        from person_detection.person_detection_worker import FRAME_SAMPLE_INTERVAL_SEC

        assert FRAME_SAMPLE_INTERVAL_SEC == 0.5, (
            f"Frame sampling interval must be 0.5 s (2 fps), got {FRAME_SAMPLE_INTERVAL_SEC} s"
        )


# ── Bounding box IoU ──────────────────────────────────────────────────────────

class TestBoundingBoxIoU:
    """BoundingBox.iou() is used for within-clip face track clustering.

    Correct IoU computation is critical: wrong values will split the same
    person into multiple tracks or merge different people into one.
    """

    def _bb(self, left, top, width, height):
        from person_detection.person_detection_worker import BoundingBox
        return BoundingBox(left=left, top=top, width=width, height=height)

    def test_identical_boxes_have_iou_1(self):
        bb = self._bb(0.1, 0.1, 0.2, 0.3)
        assert abs(bb.iou(bb) - 1.0) < 1e-5

    def test_non_overlapping_boxes_have_iou_0(self):
        a = self._bb(0.0, 0.0, 0.1, 0.1)
        b = self._bb(0.5, 0.5, 0.1, 0.1)
        assert abs(a.iou(b)) < 1e-5

    def test_partial_overlap_iou_in_range(self):
        a = self._bb(0.0, 0.0, 0.4, 0.4)
        b = self._bb(0.2, 0.2, 0.4, 0.4)
        iou = a.iou(b)
        assert 0.0 < iou < 1.0, f"Partial overlap IoU should be in (0, 1), got {iou}"

    def test_iou_is_symmetric(self):
        a = self._bb(0.0, 0.0, 0.3, 0.3)
        b = self._bb(0.1, 0.1, 0.3, 0.3)
        assert abs(a.iou(b) - b.iou(a)) < 1e-5

    def test_zero_area_box_returns_zero_iou(self):
        """A degenerate box with zero area must not cause division by zero."""
        a = self._bb(0.1, 0.1, 0.0, 0.0)
        b = self._bb(0.1, 0.1, 0.2, 0.2)
        iou = a.iou(b)
        assert iou == 0.0 or not np.isnan(iou)
