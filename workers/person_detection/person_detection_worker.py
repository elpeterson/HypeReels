"""Person Detection Worker.

Consumes jobs from the BullMQ 'person-detection' queue.

For each clip job:
  1. Download the clip from MinIO to /tmp.
  2. Sample one frame every 500 ms (2 fps) using OpenCV.
  3. Run InsightFace buffalo_l on each sampled frame (CPU-only).
  4. Cluster face detections within the clip by IoU overlap across
     consecutive frames into per-person appearance windows.
  5. Cross-clip identity matching: compare ArcFace embeddings via cosine
     similarity (threshold 0.45) against a session-scoped in-memory
     embedding store; assign existing person_ref_id on match, new UUID
     otherwise.
  6. Crop a representative thumbnail per unique person, upload to MinIO.
  7. Persist detection results to PostgreSQL (person_detections table).
  8. Publish completion event to Redis for SSE delivery.

Why InsightFace CPU-only (not GPU)?
  ADR-013: Three services compete for the single NVIDIA GTX 1080 Ti on
  Quorra:
    1. Frigate NVR — home security camera detection, runs continuously,
       critical service (missed detections = missed security events).
    2. FileFlows — media transcoding, uses NVENC, runs when encoding jobs
       are active.
    3. HypeReels InsightFace — batch face detection, async background job.
  Giving any of these exclusive GPU access risks degrading the others.
  CPU-only InsightFace yields ~30-60 seconds per clip-minute, which is
  fully acceptable for an async job — the user sees SSE progress updates
  while detection runs. The GTX 1080 Ti remains dedicated to Frigate and
  FileFlows. See ADR-013 in docs/architecture.md.

InsightFace initialisation (CPU-only):
  app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
  app.prepare(ctx_id=-1, det_size=(640, 640))  # ctx_id=-1 = CPU
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from dotenv import load_dotenv
from insightface.app import FaceAnalysis

from common.db import execute
from common.logger import get_logger
from common.minio_client import download_to_tmp, generate_presigned_url, upload_bytes
from common.redis_client import fetch_next_job, job_context, publish_event

load_dotenv()
log = get_logger(__name__)

QUEUE = "person-detection"
# Sample one frame every 500 ms (2 fps) — enough coverage for face detection
# without saturating Quorra's CPU alongside other running services.
FRAME_SAMPLE_INTERVAL_SEC = 0.5
# ArcFace cosine similarity threshold for same-person cross-clip matching.
# Faces from the same person typically score 0.4-0.7; 0.45 minimises false
# merges while tolerating lighting/angle variation.
FACE_COSINE_THRESHOLD = 0.45
# IoU threshold: boxes with IoU >= this are considered the same track.
MIN_IOU_FOR_SAME_TRACK = 0.4
# Minimum InsightFace detection confidence (0.0-1.0) to accept a face.
MIN_FACE_CONFIDENCE = 0.5

# ── InsightFace model initialisation ─────────────────────────────────────────
#
# IMPORTANT: CPU-only mode.
#   providers=['CPUExecutionProvider'] — do NOT add 'CUDAExecutionProvider'.
#   ctx_id=-1 — negative value selects CPU; ctx_id=0 would select GPU 0.
#
# Rationale: Three-way GPU contention on Quorra's GTX 1080 Ti between
#   Frigate (security NVR), FileFlows (media transcoding), and HypeReels
#   InsightFace. Frigate and FileFlows are critical services. CPU-only is
#   the safe default per ADR-013.
_insight_app: FaceAnalysis | None = None


def _get_insight_app() -> FaceAnalysis:
    """Lazily initialise InsightFace in CPU-only mode (singleton per process)."""
    global _insight_app
    if _insight_app is None:
        log.info("insightface_init_start", model="buffalo_l", provider="CPUExecutionProvider")
        # CPU-only — do NOT use CUDAExecutionProvider (GPU contention, ADR-013)
        _insight_app = FaceAnalysis(
            name="buffalo_l",
            providers=["CPUExecutionProvider"],
        )
        # ctx_id=-1 means CPU; ctx_id=0 would mean GPU 0 — must stay -1
        _insight_app.prepare(ctx_id=-1, det_size=(640, 640))
        log.info("insightface_init_complete", model="buffalo_l")
    return _insight_app


# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class BoundingBox:
    left: float
    top: float
    width: float
    height: float

    def to_dict(self) -> dict:
        return {"left": self.left, "top": self.top, "width": self.width, "height": self.height}

    def iou(self, other: "BoundingBox") -> float:
        """Intersection-over-Union with another BoundingBox."""
        x1 = max(self.left, other.left)
        y1 = max(self.top, other.top)
        x2 = min(self.left + self.width, other.left + other.width)
        y2 = min(self.top + self.height, other.top + other.height)
        intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        area_a = self.width * self.height
        area_b = other.width * other.height
        union = area_a + area_b - intersection
        return intersection / union if union > 0 else 0.0


@dataclass
class FaceDetection:
    frame_ms: int
    bounding_box: BoundingBox
    confidence: float
    embedding: np.ndarray        # 512-dim ArcFace embedding
    person_ref_id: str = ""      # set after cross-clip clustering


@dataclass
class PersonTrack:
    """A single person's appearances within one clip."""
    person_ref_id: str
    clip_id: str
    detections: list[FaceDetection] = field(default_factory=list)
    thumbnail_minio_key: str = ""
    thumbnail_url: str = ""
    confidence: float = 0.0

    @property
    def appearances(self) -> list[dict]:
        """Merge consecutive detections into contiguous time windows."""
        if not self.detections:
            return []
        sorted_dets = sorted(self.detections, key=lambda d: d.frame_ms)
        windows = []
        start = sorted_dets[0].frame_ms
        end = sorted_dets[0].frame_ms + int(FRAME_SAMPLE_INTERVAL_SEC * 1000)
        for det in sorted_dets[1:]:
            gap = det.frame_ms - end
            if gap <= int(FRAME_SAMPLE_INTERVAL_SEC * 1500):  # 1.5× tolerance
                end = det.frame_ms + int(FRAME_SAMPLE_INTERVAL_SEC * 1000)
            else:
                windows.append({
                    "start_ms": start,
                    "end_ms": end,
                    "bounding_box": sorted_dets[0].bounding_box.to_dict(),
                })
                start = det.frame_ms
                end = det.frame_ms + int(FRAME_SAMPLE_INTERVAL_SEC * 1000)
        windows.append({
            "start_ms": start,
            "end_ms": end,
            "bounding_box": sorted_dets[0].bounding_box.to_dict(),
        })
        return windows


# ── Frame sampling ────────────────────────────────────────────────────────────

def sample_frames(
    video_path: Path,
    interval_sec: float = FRAME_SAMPLE_INTERVAL_SEC,
) -> list[tuple[int, np.ndarray]]:
    """Return [(timestamp_ms, bgr_frame), ...] sampled at *interval_sec*.

    Sampling at 2 fps (every 500 ms) gives ~120 frames per minute of
    source video — sufficient for face detection coverage while keeping
    CPU utilisation manageable on Quorra.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, int(fps * interval_sec))
    frames = []

    frame_idx = 0
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            break
        timestamp_ms = int((frame_idx / fps) * 1000)
        frames.append((timestamp_ms, frame))
        frame_idx += step
        if frame_idx >= total_frames:
            break

    cap.release()
    log.info("frames_sampled", path=str(video_path), count=len(frames))
    return frames


# ── InsightFace detection ─────────────────────────────────────────────────────

def detect_faces_in_frame(frame_bgr: np.ndarray) -> list[Any]:
    """Run InsightFace buffalo_l on a single BGR frame; return face objects.

    Each returned face object has:
      .det_score   — detection confidence (0.0-1.0)
      .bbox        — [x1, y1, x2, y2] in pixel coords
      .embedding   — 512-dim ArcFace embedding (np.ndarray), or None if
                     recognition model is unavailable for this face
    """
    app = _get_insight_app()
    # InsightFace expects BGR (same as OpenCV), returns a list of Face objects
    faces = app.get(frame_bgr)
    return [f for f in faces if f.det_score >= MIN_FACE_CONFIDENCE]


def _bbox_to_normalised(bbox: np.ndarray, frame_h: int, frame_w: int) -> BoundingBox:
    """Convert InsightFace pixel [x1,y1,x2,y2] bbox to normalised BoundingBox."""
    x1, y1, x2, y2 = bbox
    x1, y1 = max(0.0, x1 / frame_w), max(0.0, y1 / frame_h)
    x2, y2 = min(1.0, x2 / frame_w), min(1.0, y2 / frame_h)
    return BoundingBox(left=x1, top=y1, width=max(0.0, x2 - x1), height=max(0.0, y2 - y1))


# ── Within-clip clustering ────────────────────────────────────────────────────

def cluster_detections_within_clip(
    frame_detections: list[tuple[int, list[Any]]],
    frame_dims: dict[int, tuple[int, int]],
) -> dict[str, list[FaceDetection]]:
    """Group per-frame InsightFace detections into per-track dicts.

    Greedy IoU clustering: a detection is assigned to an existing track
    if its normalised bounding box overlaps (IoU >= MIN_IOU_FOR_SAME_TRACK)
    with the track's most recent detection. Otherwise a new track is created.

    Returns: dict mapping provisional_track_id -> list[FaceDetection].
    """
    tracks: dict[str, tuple[BoundingBox, list[FaceDetection]]] = {}

    for timestamp_ms, face_list in frame_detections:
        frame_h, frame_w = frame_dims.get(timestamp_ms, (720, 1280))
        for face in face_list:
            bb = _bbox_to_normalised(face.bbox, frame_h, frame_w)
            embedding = face.embedding if face.embedding is not None else np.zeros(512, dtype=np.float32)
            det = FaceDetection(
                frame_ms=timestamp_ms,
                bounding_box=bb,
                confidence=float(face.det_score),
                embedding=embedding,
            )
            # Find best matching existing track by IoU
            best_track_id = None
            best_iou = MIN_IOU_FOR_SAME_TRACK
            for track_id, (last_bb, _) in tracks.items():
                iou = bb.iou(last_bb)
                if iou >= best_iou:
                    best_iou = iou
                    best_track_id = track_id

            if best_track_id:
                tracks[best_track_id] = (bb, tracks[best_track_id][1] + [det])
            else:
                new_id = str(uuid.uuid4())
                tracks[new_id] = (bb, [det])

    return {tid: dets for tid, (_, dets) in tracks.items()}


# ── Cross-clip identity matching ──────────────────────────────────────────────

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two embedding vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def match_or_create_person(
    embedding: np.ndarray,
    session_embeddings: list[dict],
) -> str:
    """Return existing person_ref_id if embedding matches (cosine >= 0.45),
    otherwise generate a new UUID and append to session_embeddings.

    ArcFace cosine similarity for same-person pairs typically falls in
    0.4-0.7; threshold 0.45 balances false-merge vs false-split errors.
    """
    best_score = 0.0
    best_ref_id = None
    for entry in session_embeddings:
        score = cosine_similarity(embedding, entry["embedding"])
        if score > best_score:
            best_score = score
            best_ref_id = entry["person_ref_id"]

    if best_score >= FACE_COSINE_THRESHOLD and best_ref_id:
        return best_ref_id

    # New person — assign a stable UUID and index the embedding
    new_ref_id = str(uuid.uuid4())
    session_embeddings.append({"person_ref_id": new_ref_id, "embedding": embedding})
    return new_ref_id


# ── Thumbnail crop ────────────────────────────────────────────────────────────

def crop_face_thumbnail(frame_bgr: np.ndarray, bb: BoundingBox, pad: float = 0.3) -> np.ndarray:
    """Crop a face with *pad* padding and resize to 224×224."""
    h, w = frame_bgr.shape[:2]
    x1 = max(0, int((bb.left - pad * bb.width) * w))
    y1 = max(0, int((bb.top - pad * bb.height) * h))
    x2 = min(w, int((bb.left + bb.width + pad * bb.width) * w))
    y2 = min(h, int((bb.top + bb.height + pad * bb.height) * h))
    crop = frame_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return cv2.resize(frame_bgr, (224, 224))
    return cv2.resize(crop, (224, 224))


# ── Main job handler ──────────────────────────────────────────────────────────

def process_detection_job(
    job_data: dict[str, Any],
    session_embeddings: list[dict],
) -> None:
    """Process a single person-detection job.

    session_embeddings is a mutable list shared across all clips in a
    session within this worker process. It accumulates ArcFace embeddings
    so that cross-clip person identity is preserved. The list is held in
    process memory only and discarded when the worker process handles the
    next session's jobs (or when the worker restarts).
    """
    clip_id: str = job_data["clip_id"]
    session_id: str = job_data["session_id"]
    minio_key: str = job_data["minio_key"]

    log.info("detection_job_start", clip_id=clip_id, session_id=session_id)

    # 1. Download clip
    tmp_path = download_to_tmp(minio_key, suffix=".mp4")
    try:
        # 2. Sample frames at 2 fps
        frames = sample_frames(tmp_path)
        if not frames:
            log.warning("no_frames_sampled", clip_id=clip_id)
            _persist_empty_detection(clip_id, session_id)
            return

        # Build a frame lookup for thumbnail cropping and dimension info
        frame_dict = {ts: frm for ts, frm in frames}
        frame_dims = {ts: (frm.shape[0], frm.shape[1]) for ts, frm in frames}

        # 3. Detect faces per frame using InsightFace (CPU-only)
        frame_detections: list[tuple[int, list[Any]]] = []
        for ts_ms, frame in frames:
            faces = detect_faces_in_frame(frame)
            if faces:
                frame_detections.append((ts_ms, faces))

        if not frame_detections:
            log.info("no_faces_detected", clip_id=clip_id)
            _persist_empty_detection(clip_id, session_id)
            return

        # 4. Within-clip clustering by IoU
        track_map = cluster_detections_within_clip(frame_detections, frame_dims)

        # 5. Cross-clip identity matching via cosine similarity on ArcFace embeddings
        person_tracks: list[PersonTrack] = []

        for provisional_id, detections in track_map.items():
            # Use the highest-confidence detection for identity matching
            best_det = max(detections, key=lambda d: d.confidence)

            if np.linalg.norm(best_det.embedding) == 0.0:
                # No embedding — assign a new unique ID (cannot match cross-clip)
                person_ref_id = str(uuid.uuid4())
            else:
                person_ref_id = match_or_create_person(best_det.embedding, session_embeddings)

            # Tag all detections in this track with the resolved person_ref_id
            for det in detections:
                det.person_ref_id = person_ref_id

            # 6. Crop and upload thumbnail
            best_frame = frame_dict.get(best_det.frame_ms)
            if best_frame is None:
                continue

            thumbnail_crop = crop_face_thumbnail(best_frame, best_det.bounding_box)
            _, jpg_buf = cv2.imencode(".jpg", thumbnail_crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            thumb_key = f"thumbnails/{session_id}/persons/{person_ref_id}.jpg"
            upload_bytes(jpg_buf.tobytes(), thumb_key, content_type="image/jpeg")
            thumb_url = generate_presigned_url(thumb_key, expires_in=86400 * 7)  # 7 days

            track = PersonTrack(
                person_ref_id=person_ref_id,
                clip_id=clip_id,
                detections=detections,
                thumbnail_minio_key=thumb_key,
                thumbnail_url=thumb_url,
                confidence=best_det.confidence,
            )
            person_tracks.append(track)

        # 7. Persist to DB
        _persist_detections(session_id, clip_id, person_tracks)

        # 8. Publish completion event
        persons_payload = [
            {
                "person_ref_id": t.person_ref_id,
                "thumbnail_url": t.thumbnail_url,
                "confidence": t.confidence,
                "appearances": t.appearances,
            }
            for t in person_tracks
        ]
        publish_event(session_id, {
            "type": "detection-complete",
            "clip_id": clip_id,
            "persons": persons_payload,
        })
        log.info("detection_job_complete", clip_id=clip_id, person_count=len(person_tracks))

    finally:
        tmp_path.unlink(missing_ok=True)


def _persist_empty_detection(clip_id: str, session_id: str) -> None:
    execute(
        "UPDATE clips SET detection_status = 'complete' WHERE id = %s",
        (clip_id,),
    )
    publish_event(session_id, {
        "type": "detection-complete",
        "clip_id": clip_id,
        "persons": [],
    })


def _persist_detections(session_id: str, clip_id: str, tracks: list[PersonTrack]) -> None:
    for track in tracks:
        appearances_json = json.dumps(track.appearances)
        execute(
            """
            INSERT INTO person_detections
                (id, session_id, clip_id, person_ref_id, thumbnail_url, confidence, appearances)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (session_id, clip_id, person_ref_id) DO UPDATE
                SET thumbnail_url = EXCLUDED.thumbnail_url,
                    confidence = EXCLUDED.confidence,
                    appearances = EXCLUDED.appearances
            """,
            (
                str(uuid.uuid4()),
                session_id,
                clip_id,
                track.person_ref_id,
                track.thumbnail_url,
                track.confidence,
                appearances_json,
            ),
        )
    execute(
        "UPDATE clips SET detection_status = 'complete' WHERE id = %s",
        (clip_id,),
    )


# ── Public importable function (used by FastAPI main.py) ─────────────────────

def detect_persons(
    clip_id: str,
    clip_url: str,
    session_id: str,
    session_embeddings: list[dict] | None = None,
) -> dict[str, Any]:
    """Download clip from *clip_url* and run the full person detection pipeline.

    This is the importable entry point for the FastAPI HTTP layer.
    Downloads the clip via presigned URL (or local path), samples frames,
    runs InsightFace (CPU-only), clusters identities, crops thumbnails, and
    returns structured results.

    Args:
        clip_id: UUID of the clip being processed.
        clip_url: Presigned MinIO URL, local file path, or file:// URI.
        session_id: UUID of the current session (used for thumbnail paths).
        session_embeddings: Mutable list for cross-clip embedding state.
            Pass the same list for all clips in a session. Pass None (or
            an empty list) for single-clip calls or tests.

    Returns:
        {
          "clip_id": str,
          "persons": [
            {
              "person_ref_id": str,
              "thumbnail_url": str,
              "confidence": float,
              "appearances": [{"start_ms": int, "end_ms": int, ...}, ...],
            },
            ...
          ],
        }
    """
    import tempfile
    import httpx

    if session_embeddings is None:
        session_embeddings = []

    # Download clip
    if clip_url.startswith("file://"):
        tmp_path = Path(clip_url[7:])
        _own_tmp = False
    elif clip_url.startswith("/"):
        tmp_path = Path(clip_url)
        _own_tmp = False
    else:
        fd, tmp = tempfile.mkstemp(suffix=".mp4", dir="/tmp/hypereels")
        os.close(fd)
        tmp_path = Path(tmp)
        _own_tmp = True
        with httpx.Client(timeout=600.0, follow_redirects=True) as client:
            with client.stream("GET", clip_url) as response:
                response.raise_for_status()
                with open(tmp_path, "wb") as f:
                    for chunk in response.iter_bytes(chunk_size=65536):
                        f.write(chunk)

    try:
        frames = sample_frames(tmp_path)
        if not frames:
            return {"clip_id": clip_id, "persons": []}

        frame_dict = {ts: frm for ts, frm in frames}
        frame_dims = {ts: (frm.shape[0], frm.shape[1]) for ts, frm in frames}

        frame_detections: list[tuple[int, list[Any]]] = []
        for ts_ms, frame in frames:
            faces = detect_faces_in_frame(frame)
            if faces:
                frame_detections.append((ts_ms, faces))

        if not frame_detections:
            return {"clip_id": clip_id, "persons": []}

        track_map = cluster_detections_within_clip(frame_detections, frame_dims)
        person_tracks: list[PersonTrack] = []

        for provisional_id, detections in track_map.items():
            best_det = max(detections, key=lambda d: d.confidence)

            if np.linalg.norm(best_det.embedding) == 0.0:
                person_ref_id = str(uuid.uuid4())
            else:
                person_ref_id = match_or_create_person(best_det.embedding, session_embeddings)

            for det in detections:
                det.person_ref_id = person_ref_id

            best_frame = frame_dict.get(best_det.frame_ms)
            if best_frame is None:
                continue

            thumbnail_crop = crop_face_thumbnail(best_frame, best_det.bounding_box)
            _, jpg_buf = cv2.imencode(".jpg", thumbnail_crop, [cv2.IMWRITE_JPEG_QUALITY, 90])

            from common.minio_client import generate_presigned_url, upload_bytes
            thumb_key = f"thumbnails/{session_id}/persons/{person_ref_id}.jpg"
            upload_bytes(jpg_buf.tobytes(), thumb_key, content_type="image/jpeg")
            thumb_url = generate_presigned_url(thumb_key, expires_in=86400 * 7)

            track = PersonTrack(
                person_ref_id=person_ref_id,
                clip_id=clip_id,
                detections=detections,
                thumbnail_minio_key=thumb_key,
                thumbnail_url=thumb_url,
                confidence=best_det.confidence,
            )
            person_tracks.append(track)

        return {
            "clip_id": clip_id,
            "persons": [
                {
                    "person_ref_id": t.person_ref_id,
                    "thumbnail_url": t.thumbnail_url,
                    "confidence": t.confidence,
                    "appearances": t.appearances,
                }
                for t in person_tracks
            ],
        }

    finally:
        if _own_tmp:
            tmp_path.unlink(missing_ok=True)


# ── Worker loop ───────────────────────────────────────────────────────────────

def main() -> None:
    log.info("person_detection_worker_started", queue=QUEUE)
    # Session-scoped in-memory embedding store. Held in process memory only;
    # discarded when the worker process restarts or handles a new session.
    # No face embeddings are persisted to disk or transmitted off-host.
    session_embeddings: list[dict] = []
    current_session_id: str = ""

    while True:
        job = fetch_next_job(QUEUE, block_seconds=5)
        if job is None:
            continue
        try:
            with job_context(QUEUE, job):
                job_session_id = job["data"].get("session_id", "")
                # Reset embedding store when a new session begins
                if job_session_id != current_session_id:
                    session_embeddings = []
                    current_session_id = job_session_id
                    log.info("session_embeddings_reset", session_id=current_session_id)
                process_detection_job(job["data"], session_embeddings)
        except Exception as exc:
            log.error(
                "detection_job_error",
                job_id=job["id"],
                error=str(exc),
                exc_info=True,
            )
            session_id = job["data"].get("session_id", "")
            clip_id = job["data"].get("clip_id", "")
            if session_id:
                publish_event(session_id, {
                    "type": "detection-failed",
                    "clip_id": clip_id,
                    "error": str(exc),
                })


if __name__ == "__main__":
    main()
