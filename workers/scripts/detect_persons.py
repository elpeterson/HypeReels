#!/usr/bin/env python3
"""
detect_persons.py — InsightFace person detection for HypeReels.

CLI:
    python detect_persons.py <video_file_path> <session_id> <clip_id> <output_dir>

Outputs JSON to stdout:
    [{"person_id":"uuid","bbox":[x,y,w,h],"thumbnail":"persons/{person_id}.jpg",
      "confidence":0.0-1.0,"appearances":[{"clip_id":"uuid","timestamp_ms":0}]}]

Exit 0 on success, non-zero on failure. Errors go to stderr.
"""

import json
import os
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

import cv2
import numpy as np


# ──────────────────────────────────────────────────────────────────────────────
# stdout guard — InsightFace / ONNX Runtime print to fd 1 (stdout) at the C
# level during model load, which poisons the JSON output Node.js parses.
# Python-level sys.stdout reassignment does NOT capture C-level writes; we
# must redirect the raw file descriptor with os.dup2.
# ──────────────────────────────────────────────────────────────────────────────

@contextmanager
def suppress_stdout_fd():
    """Temporarily redirect fd 1 → /dev/null to silence C-level stdout."""
    flushed = False
    old_fd = os.dup(1)
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.close(devnull)
        flushed = True
        yield
    finally:
        os.dup2(old_fd, 1)
        os.close(old_fd)


# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

SAMPLE_INTERVAL_MS = 500          # Sample every ~500 ms
LOW_CONFIDENCE_THRESHOLD = 0.70   # STORY-003: flag but still include below this
FACE_SIMILARITY_THRESHOLD = 0.55  # cosine distance to consider two embeddings the same person
MIN_FACE_SIZE_PX = 20             # Ignore tiny detections (noise)
THUMBNAIL_PADDING_FACTOR = 2.5    # STORY-028: expand crop to 2.5× bbox to show head/shoulders


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    """Write a log line to stderr (never stdout — stdout is reserved for JSON)."""
    print(f"[detect_persons] {msg}", file=sys.stderr)


def build_providers() -> list[str]:
    """
    Return the ONNX execution provider list based on environment.

    GPU policy (from CLAUDE.md / STORY-008 / STORY-009):
      - INSIGHTFACE_PROVIDERS=CUDAExecutionProvider → use CUDA
      - Anything else (or unset) → CPUExecutionProvider
      - No ROCm, no Metal/ANE
    """
    env_val = os.environ.get("INSIGHTFACE_PROVIDERS", "CPUExecutionProvider")
    if env_val == "CUDAExecutionProvider":
        log("Provider: CUDAExecutionProvider (NVIDIA GPU path)")
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    log("Provider: CPUExecutionProvider (CPU-only path)")
    return ["CPUExecutionProvider"]


def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Return cosine distance in [0, 2].  0 = identical, 2 = opposite."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 1.0
    return float(1.0 - np.dot(a, b) / (norm_a * norm_b))


def bbox_to_list(bbox) -> list[int]:
    """Convert InsightFace bbox (x1,y1,x2,y2) to [x, y, w, h]."""
    x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
    return [x1, y1, x2 - x1, y2 - y1]


# ──────────────────────────────────────────────────────────────────────────────
# Frame sampling
# ──────────────────────────────────────────────────────────────────────────────

def sample_frames(video_path: str) -> list[tuple[int, np.ndarray]]:
    """
    Open video and yield (timestamp_ms, frame) tuples at ~SAMPLE_INTERVAL_MS intervals.
    Returns list of (timestamp_ms, bgr_frame).
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_interval = max(1, int(round(fps * SAMPLE_INTERVAL_MS / 1000.0)))

    frames: list[tuple[int, np.ndarray]] = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_interval == 0:
            timestamp_ms = int(frame_idx / fps * 1000)
            frames.append((timestamp_ms, frame.copy()))
        frame_idx += 1

    cap.release()
    log(f"Sampled {len(frames)} frames from {frame_idx} total (every {frame_interval} frames)")
    return frames


# ──────────────────────────────────────────────────────────────────────────────
# Detection and clustering
# ──────────────────────────────────────────────────────────────────────────────

def load_model(providers: list[str]):
    """Load InsightFace FaceAnalysis model."""
    import insightface
    from insightface.app import FaceAnalysis

    model = FaceAnalysis(
        name="buffalo_sc",          # lightweight, good CPU perf
        providers=providers,
    )
    model.prepare(ctx_id=0, det_size=(640, 640))
    return model


def detect_faces_in_frames(
    model,
    frames: list[tuple[int, np.ndarray]],
    clip_id: str,
) -> list[dict]:
    """
    Run InsightFace on each sampled frame.
    Returns list of raw detection dicts with keys:
      bbox, confidence, embedding, timestamp_ms, frame (BGR crop)
    """
    detections = []
    for timestamp_ms, bgr_frame in frames:
        rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        try:
            faces = model.get(rgb_frame)
        except Exception as exc:
            log(f"  Frame at {timestamp_ms}ms detection error: {exc}")
            continue

        for face in faces:
            bbox = face.bbox.tolist() if hasattr(face.bbox, "tolist") else list(face.bbox)
            det_score = float(face.det_score) if hasattr(face, "det_score") else 0.0

            x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
            w = x2 - x1
            h = y2 - y1

            # Skip faces that are too small — typically noise
            if w < MIN_FACE_SIZE_PX or h < MIN_FACE_SIZE_PX:
                continue

            # STORY-028: expand crop by THUMBNAIL_PADDING_FACTOR so the
            # thumbnail shows head + shoulders instead of just the face.
            # Expand symmetrically from the face center, then clamp to frame.
            fh, fw = bgr_frame.shape[:2]
            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            half_w = (w * THUMBNAIL_PADDING_FACTOR) / 2.0
            half_h = (h * THUMBNAIL_PADDING_FACTOR) / 2.0
            x1c = max(0, int(cx - half_w))
            y1c = max(0, int(cy - half_h))
            x2c = min(fw, int(cx + half_w))
            y2c = min(fh, int(cy + half_h))
            crop = bgr_frame[y1c:y2c, x1c:x2c]

            embedding = face.embedding if hasattr(face, "embedding") and face.embedding is not None else None

            detections.append({
                "bbox": bbox,
                "confidence": det_score,
                "embedding": embedding,
                "timestamp_ms": timestamp_ms,
                "crop": crop,
                "clip_id": clip_id,
            })

    log(f"Raw detections across all frames: {len(detections)}")
    return detections


def cluster_detections(detections: list[dict]) -> list[dict]:
    """
    Group raw detections into unique persons by comparing face embeddings.
    Uses greedy nearest-neighbour clustering (no scipy/sklearn dependency).

    Returns list of person clusters, each with:
      embeddings, appearances, best_confidence, best_crop, bbox_at_best
    """
    clusters: list[dict] = []

    for det in detections:
        emb = det.get("embedding")
        matched_cluster = None

        if emb is not None:
            for cluster in clusters:
                # Compare against cluster representative embedding
                rep_emb = cluster["representative_embedding"]
                if rep_emb is not None:
                    dist = cosine_distance(emb, rep_emb)
                    if dist < FACE_SIMILARITY_THRESHOLD:
                        matched_cluster = cluster
                        break

        if matched_cluster is None:
            # New person
            matched_cluster = {
                "representative_embedding": emb,
                "appearances": [],
                "best_confidence": -1.0,
                "best_crop": None,
                "best_bbox": None,
            }
            clusters.append(matched_cluster)

        matched_cluster["appearances"].append({
            "clip_id": det["clip_id"],
            "timestamp_ms": det["timestamp_ms"],
        })

        if det["confidence"] > matched_cluster["best_confidence"]:
            matched_cluster["best_confidence"] = det["confidence"]
            matched_cluster["best_crop"] = det["crop"]
            matched_cluster["best_bbox"] = det["bbox"]

    log(f"Clustered into {len(clusters)} unique person(s)")
    return clusters


def save_thumbnail(crop: np.ndarray, person_id: str, output_dir: Path) -> str:
    """Save face crop JPEG. Returns relative path persons/{person_id}.jpg."""
    persons_dir = output_dir / "persons"
    persons_dir.mkdir(parents=True, exist_ok=True)
    rel_path = f"persons/{person_id}.jpg"
    abs_path = output_dir / rel_path
    cv2.imwrite(str(abs_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return rel_path


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) != 5:
        print(
            "Usage: detect_persons.py <video_file_path> <session_id> <clip_id> <output_dir>",
            file=sys.stderr,
        )
        sys.exit(1)

    video_path = sys.argv[1]
    _session_id = sys.argv[2]   # available for logging; not used in output
    clip_id = sys.argv[3]
    output_dir = Path(sys.argv[4])

    if not os.path.isfile(video_path):
        print(f"Error: video file not found: {video_path}", file=sys.stderr)
        sys.exit(2)

    output_dir.mkdir(parents=True, exist_ok=True)

    providers = build_providers()

    # ── Load model ──────────────────────────────────────────────────────────
    # InsightFace / ONNX Runtime emit C-level stdout during model init.
    # Suppress fd 1 so those messages don't corrupt our JSON output.
    log("Loading InsightFace model…")
    try:
        with suppress_stdout_fd():
            model = load_model(providers)
    except Exception as exc:
        print(f"Error loading InsightFace model: {exc}", file=sys.stderr)
        sys.exit(3)

    # ── Sample frames ────────────────────────────────────────────────────────
    log(f"Sampling frames from: {video_path}")
    try:
        frames = sample_frames(video_path)
    except Exception as exc:
        print(f"Error sampling frames: {exc}", file=sys.stderr)
        sys.exit(4)

    if not frames:
        log("No frames extracted — outputting empty person list")
        print(json.dumps([]))
        sys.exit(0)

    # ── Detect ───────────────────────────────────────────────────────────────
    log("Running face detection…")
    detections = detect_faces_in_frames(model, frames, clip_id)

    if not detections:
        log("No faces detected — outputting empty person list")
        print(json.dumps([]))
        sys.exit(0)

    # ── Cluster ──────────────────────────────────────────────────────────────
    clusters = cluster_detections(detections)

    # ── Build output ─────────────────────────────────────────────────────────
    results = []
    low_confidence_warnings: list[str] = []

    for cluster in clusters:
        person_id = str(uuid.uuid4())

        confidence = float(cluster["best_confidence"])
        bbox = bbox_to_list(cluster["best_bbox"]) if cluster["best_bbox"] else [0, 0, 0, 0]

        # Save thumbnail
        thumbnail_rel = "persons/placeholder.jpg"
        if cluster["best_crop"] is not None and cluster["best_crop"].size > 0:
            try:
                thumbnail_rel = save_thumbnail(cluster["best_crop"], person_id, output_dir)
            except Exception as exc:
                log(f"  Warning: could not save thumbnail for {person_id}: {exc}")

        # STORY-003: flag low-confidence persons but still include them
        if confidence < LOW_CONFIDENCE_THRESHOLD:
            low_confidence_warnings.append(
                f"person {person_id} confidence {confidence:.2f} is below threshold "
                f"{LOW_CONFIDENCE_THRESHOLD} — may be inaccurate"
            )

        # STORY-026: include the representative embedding so the Node.js worker
        # can run cross-clip deduplication after all clips are processed.
        rep_emb = cluster.get("representative_embedding")
        embedding_list = rep_emb.tolist() if rep_emb is not None else None

        results.append({
            "person_id": person_id,
            "bbox": bbox,
            "thumbnail": thumbnail_rel,
            "confidence": round(confidence, 4),
            "appearances": cluster["appearances"],
            "embedding": embedding_list,
        })

    for warn in low_confidence_warnings:
        log(f"LOW_CONFIDENCE: {warn}")

    log(f"Detection complete. {len(results)} person(s) found.")
    print(json.dumps(results))
    sys.exit(0)


if __name__ == "__main__":
    main()
