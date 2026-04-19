"""HypeReels Python Worker — FastAPI HTTP entry point.

Exposes three synchronous endpoints that the Node.js backend calls:

  POST /analyse-audio   → audio analysis (librosa)
  POST /assemble-reel   → EDL build + FFmpeg render + MinIO upload
  POST /detect-persons  → frame sampling + InsightFace buffalo_l (CPU-only) + face clustering

Each endpoint runs the job synchronously (the Node worker already handles
async queuing) and returns structured JSON.  Errors are returned as HTTP 422
with a JSON detail body.

Start with:
    uvicorn workers.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from common.logger import get_logger

load_dotenv()

log = get_logger(__name__)

app = FastAPI(
    title="HypeReels Python Worker",
    version="1.0.0",
    description="Audio analysis, HypeReel assembly, and person detection HTTP endpoints.",
)

TMP_DIR = Path("/tmp/hypereels")
TMP_DIR.mkdir(parents=True, exist_ok=True)


# ── Error helper ──────────────────────────────────────────────────────────────

def _error_response(status: int, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail})


# ─────────────────────────────────────────────────────────────────────────────
# POST /analyse-audio
# ─────────────────────────────────────────────────────────────────────────────

class AnalyseAudioRequest(BaseModel):
    """Body sent by the Node audioAnalysisWorker."""
    audio_url: str = Field(..., description="Presigned R2 URL to the audio file")
    session_id: str
    audio_track_id: str


class PhraseResult(BaseModel):
    start_ms: int
    end_ms: int
    type: str


class AnalyseAudioResponse(BaseModel):
    bpm: float
    beats_ms: list[int]
    downbeats_ms: list[int]
    onsets_ms: list[int]
    energy_envelope: list[list[float]]
    phrases: list[PhraseResult]
    duration_ms: int


@app.post("/analyse-audio", response_model=AnalyseAudioResponse)
async def analyse_audio(body: AnalyseAudioRequest) -> AnalyseAudioResponse:
    """Download audio from a presigned URL, run librosa analysis, return results."""
    log.info(
        "http_analyse_audio",
        session_id=body.session_id,
        audio_track_id=body.audio_track_id,
    )
    try:
        result = _run_audio_analysis(body.audio_url, body.session_id, body.audio_track_id)
        return result
    except Exception as exc:
        log.error("analyse_audio_error", error=str(exc), exc_info=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _run_audio_analysis(
    audio_url: str,
    session_id: str,
    audio_track_id: str,
) -> AnalyseAudioResponse:
    """Download audio via presigned URL and run the full analysis pipeline."""
    from audio_analysis.audio_analysis_worker import (
        load_audio,
        extract_beats,
        extract_onsets,
        compute_energy_envelope,
        derive_downbeats,
        derive_phrases,
    )

    # Download audio to a temp file
    suffix = _url_suffix(audio_url) or ".mp3"
    tmp_path = _download_url(audio_url, suffix=suffix)

    try:
        y, sr = load_audio(tmp_path)
        duration_sec = float(len(y)) / sr
        duration_ms = int(duration_sec * 1000)

        bpm, beat_times = extract_beats(y, sr)
        onset_times = extract_onsets(y, sr)
        energy_envelope = compute_energy_envelope(y, sr)
        downbeat_times = derive_downbeats(beat_times)
        phrases = derive_phrases(beat_times, energy_envelope, duration_sec)

        return AnalyseAudioResponse(
            bpm=round(bpm, 2),
            beats_ms=[int(t * 1000) for t in beat_times],
            downbeats_ms=[int(t * 1000) for t in downbeat_times],
            onsets_ms=[int(t * 1000) for t in onset_times],
            energy_envelope=energy_envelope,
            phrases=[
                PhraseResult(start_ms=p.start_ms, end_ms=p.end_ms, type=p.type)
                for p in phrases
            ],
            duration_ms=duration_ms,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# POST /assemble-reel
# ─────────────────────────────────────────────────────────────────────────────

class HighlightItem(BaseModel):
    start_ms: int
    end_ms: int


class PersonAppearanceItem(BaseModel):
    start_ms: int
    end_ms: int
    confidence: float = 0.0
    person_ref_id: str = ""


class ClipItem(BaseModel):
    clip_id: str
    r2_key: str
    duration_ms: int | None = None
    highlights: list[HighlightItem] = Field(default_factory=list)
    person_appearances: list[PersonAppearanceItem] = Field(default_factory=list)


class AssembleReelRequest(BaseModel):
    """Body sent by the Node assemblyWorker."""
    session_id: str
    job_id: str
    audio_r2_key: str
    audio_analysis: dict[str, Any]
    clips: list[ClipItem]
    person_of_interest_id: str | None = None
    # R2 credentials passed by Node so Python can upload directly
    r2_endpoint: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None
    r2_bucket: str | None = None
    output_r2_key: str


class AssembleReelResponse(BaseModel):
    output_r2_key: str
    output_size_bytes: int
    output_duration_ms: int
    edl_json: dict[str, Any]


@app.post("/assemble-reel", response_model=AssembleReelResponse)
async def assemble_reel(body: AssembleReelRequest) -> AssembleReelResponse:
    """Build EDL, render with FFmpeg, upload to R2, return metadata."""
    log.info(
        "http_assemble_reel",
        session_id=body.session_id,
        job_id=body.job_id,
        clips=len(body.clips),
    )
    try:
        result = _run_assembly(body)
        return result
    except Exception as exc:
        log.error("assemble_reel_error", error=str(exc), exc_info=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _run_assembly(body: AssembleReelRequest) -> AssembleReelResponse:
    """Run the full assembly pipeline and return the result."""
    import json
    import shutil
    import uuid as _uuid
    from pathlib import Path as _Path

    from assembly.algorithm import (
        AssemblyRequest,
        BeatData,
        ClipMeta,
        Highlight,
        PersonAppearance,
        PhraseInfo,
        build_edl,
    )
    from assembly.assembly_worker import (
        TMP_DIR as ATMP,
        trim_segment,
        write_concat_list,
        concatenate_segments,
        mix_audio_and_encode,
        probe_duration_ms,
        probe_size_bytes,
    )

    # ── Override R2 credentials if passed by Node ─────────────────────────────
    _configure_r2_from_request(body)

    from common.r2_client import download_to_tmp, upload_file, generate_presigned_url

    analysis = body.audio_analysis
    audio_duration_ms = int(analysis.get("duration_ms", 0))

    phrases = [
        PhraseInfo(
            start_ms=p["start_ms"],
            end_ms=p["end_ms"],
            type=p.get("type", "verse"),
        )
        for p in analysis.get("phrases", [])
    ]

    beat_data = BeatData(
        duration_ms=audio_duration_ms,
        beats_ms=[int(b) for b in analysis.get("beats_ms", [])],
        downbeats_ms=[int(b) for b in analysis.get("downbeats_ms", [])],
        phrases=phrases,
    )

    clips = [
        ClipMeta(
            clip_id=c.clip_id,
            clip_r2_key=c.r2_key,
            duration_ms=c.duration_ms or 0,
        )
        for c in body.clips
    ]

    highlights = [
        Highlight(clip_id=c.clip_id, start_ms=h.start_ms, end_ms=h.end_ms)
        for c in body.clips
        for h in c.highlights
    ]

    # Only include person appearances that match the person_of_interest_id
    poi_id = body.person_of_interest_id
    person_appearances: list[PersonAppearance] = []
    for c in body.clips:
        for app in c.person_appearances:
            if poi_id is None or app.person_ref_id == poi_id or poi_id == "":
                person_appearances.append(
                    PersonAppearance(
                        clip_id=c.clip_id,
                        start_ms=app.start_ms,
                        end_ms=app.end_ms,
                    )
                )

    request = AssemblyRequest(
        session_id=body.session_id,
        audio_r2_key=body.audio_r2_key,
        clips=clips,
        highlights=highlights,
        person_appearances=person_appearances,
        beat_data=beat_data,
    )

    # Build EDL
    edl = build_edl(request)
    if not edl.segments:
        raise RuntimeError("Assembly algorithm produced an empty EDL")

    # Set up job tmp dir
    job_id = body.job_id
    job_tmp = ATMP / job_id
    job_tmp.mkdir(parents=True, exist_ok=True)

    try:
        # Download clips
        clip_local_paths: dict[str, _Path] = {}
        for seg in edl.segments:
            if seg.clip_id not in clip_local_paths:
                local = download_to_tmp(seg.clip_r2_key, suffix=".mp4")
                clip_local_paths[seg.clip_id] = local

        audio_local = download_to_tmp(body.audio_r2_key, suffix=".audio")

        # Trim segments
        segment_paths: list[_Path] = []
        for i, seg in enumerate(edl.segments):
            input_path = clip_local_paths[seg.clip_id]
            seg_out = job_tmp / f"seg_{i:04d}.mp4"
            trim_segment(input_path, seg.start_ms, seg.end_ms, seg_out)
            segment_paths.append(seg_out)

        # Concat
        concat_list = job_tmp / "concat.txt"
        write_concat_list(segment_paths, concat_list)
        concat_out = job_tmp / "concat.mp4"
        concatenate_segments(concat_list, concat_out)

        # Mix audio + final encode
        short_id = _uuid.uuid4().hex[:8]
        final_filename = f"hypereel_{short_id}.mp4"
        final_path = job_tmp / final_filename
        mix_audio_and_encode(concat_out, audio_local, final_path, edl.target_duration_ms)

        # Upload to R2 using the pre-computed output key from Node
        output_r2_key = body.output_r2_key
        upload_file(final_path, output_r2_key, content_type="video/mp4")

        output_duration_ms = probe_duration_ms(final_path)
        output_size_bytes = probe_size_bytes(final_path)

        return AssembleReelResponse(
            output_r2_key=output_r2_key,
            output_size_bytes=output_size_bytes,
            output_duration_ms=output_duration_ms,
            edl_json=edl.to_dict(),
        )

    finally:
        shutil.rmtree(job_tmp, ignore_errors=True)
        for p in clip_local_paths.values():
            p.unlink(missing_ok=True)
        try:
            audio_local.unlink(missing_ok=True)
        except Exception:
            pass


def _configure_r2_from_request(body: AssembleReelRequest) -> None:
    """Override R2 env vars with credentials passed by Node, if provided."""
    if body.r2_endpoint:
        os.environ["R2_ENDPOINT_URL"] = body.r2_endpoint
    if body.r2_access_key_id:
        os.environ["R2_ACCESS_KEY_ID"] = body.r2_access_key_id
    if body.r2_secret_access_key:
        os.environ["R2_SECRET_ACCESS_KEY"] = body.r2_secret_access_key
    if body.r2_bucket:
        os.environ["R2_BUCKET_NAME"] = body.r2_bucket
    # Reset the cached client so it picks up new credentials
    import common.r2_client as _r2
    _r2._s3_client = None


# ─────────────────────────────────────────────────────────────────────────────
# POST /detect-persons
# ─────────────────────────────────────────────────────────────────────────────

class DetectPersonsRequest(BaseModel):
    """Body sent by the Node personDetectionWorker (HTTP mode)."""
    clip_id: str
    clip_url: str = Field(..., description="Presigned MinIO URL to the clip file")
    session_id: str
    # collection_id is accepted for API compatibility but unused — InsightFace
    # uses session_id directly for in-process embedding clustering (not a remote collection)
    collection_id: str = ""


class AppearanceWindow(BaseModel):
    start_ms: int
    end_ms: int


class PersonResult(BaseModel):
    person_ref_id: str
    thumbnail_url: str
    confidence: float
    appearances: list[AppearanceWindow]


class DetectPersonsResponse(BaseModel):
    clip_id: str
    persons: list[PersonResult]


@app.post("/detect-persons", response_model=DetectPersonsResponse)
async def detect_persons_endpoint(body: DetectPersonsRequest) -> DetectPersonsResponse:
    """Download clip, sample frames, run InsightFace (CPU-only), return person detections."""
    log.info(
        "http_detect_persons",
        clip_id=body.clip_id,
        session_id=body.session_id,
    )
    try:
        result = _run_person_detection(body)
        return result
    except Exception as exc:
        log.error("detect_persons_error", error=str(exc), exc_info=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ── Per-session in-process embedding store (cross-clip identity matching) ──────
#
# The InsightFace `detect_persons()` function accepts a mutable session_embeddings
# list to enable cross-clip person identity matching within a session.  In the
# HTTP (FastAPI) context each request is independent, so we maintain a short-lived
# in-memory cache keyed by session_id.  This approximates the long-running worker
# loop's embedding persistence without requiring any external state.
#
# The cache is process-local only — ephemeral by design.  Session cleanup (TTL)
# resets are handled by the cleanup worker, not here.
import threading as _threading

_session_embeddings_lock = _threading.Lock()
_session_embeddings_cache: dict[str, list[dict]] = {}


def _get_session_embeddings(session_id: str) -> list[dict]:
    """Return (and create if absent) the in-memory embedding list for *session_id*."""
    with _session_embeddings_lock:
        if session_id not in _session_embeddings_cache:
            _session_embeddings_cache[session_id] = []
        return _session_embeddings_cache[session_id]


def _run_person_detection(body: DetectPersonsRequest) -> DetectPersonsResponse:
    """Run InsightFace buffalo_l (CPU-only) person detection on *body.clip_url*.

    Uses the public ``detect_persons()`` entry point from
    ``person_detection.person_detection_worker``, which handles frame sampling,
    IoU clustering, ArcFace embedding comparison, thumbnail upload to MinIO, and
    structured result assembly.

    Cross-clip embedding state is maintained in ``_session_embeddings_cache`` so
    that multiple clips belonging to the same session produce consistent
    ``person_ref_id`` assignments even when processed as separate HTTP calls.
    """
    from person_detection.person_detection_worker import detect_persons

    # Share embedding store across calls within the same session
    session_embeddings = _get_session_embeddings(body.session_id)

    raw = detect_persons(
        clip_id=body.clip_id,
        clip_url=body.clip_url,
        session_id=body.session_id,
        session_embeddings=session_embeddings,
    )

    return DetectPersonsResponse(
        clip_id=raw["clip_id"],
        persons=[
            PersonResult(
                person_ref_id=p["person_ref_id"],
                thumbnail_url=p["thumbnail_url"],
                confidence=p["confidence"],
                appearances=[
                    AppearanceWindow(start_ms=a["start_ms"], end_ms=a["end_ms"])
                    for a in p["appearances"]
                ],
            )
            for p in raw["persons"]
        ],
    )


# ─────────────────────────────────────────────────────────────────────────────
# Utility: download a presigned URL to a temp file
# ─────────────────────────────────────────────────────────────────────────────

def _url_suffix(url: str) -> str:
    """Extract file extension from URL path (before query string)."""
    from urllib.parse import urlparse
    path = urlparse(url).path
    suffix = Path(path).suffix
    return suffix if suffix else ""


def _download_url(url: str, suffix: str = "") -> Path:
    """Download *url* to a temp file and return its path."""
    fd, tmp = tempfile.mkstemp(suffix=suffix, dir=str(TMP_DIR))
    os.close(fd)
    path = Path(tmp)
    with httpx.Client(timeout=600.0, follow_redirects=True) as client:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            with open(path, "wb") as f:
                for chunk in response.iter_bytes(chunk_size=65536):
                    f.write(chunk)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Health check
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "hypereels-python-worker"}
