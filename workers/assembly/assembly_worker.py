"""HypeReel Assembly Worker.

Consumes jobs from the BullMQ 'generation' queue.

For each generation job:
  1. Load session context from PostgreSQL: clips, highlights, selected person
     appearances, audio analysis JSON.
  2. Run the build_edl() algorithm to produce an Edit Decision List.
  3. Download all required clips and the audio track from R2 to /tmp.
  4. Execute FFmpeg pipeline:
       a. Trim each EDL segment to /tmp/seg_{n}.mp4
       b. Write an FFmpeg concat list file
       c. Concatenate all segments → /tmp/concat.mp4
       d. Mix audio track: replace clip audio with uploaded song
       e. Final encode: H.264 CRF 20, AAC 192 kbps, yuv420p, faststart,
          max 1080p (scale down if source is larger, never upscale)
  5. Upload final MP4 to generated/{session_id}/ in R2.
  6. Generate a 2-hour signed download URL.
  7. Update generation_jobs (status='complete', output_url, edl_json).
  8. Publish completion event to Redis.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from assembly.algorithm import (
    AssemblyRequest,
    BeatData,
    ClipMeta,
    Highlight,
    PersonAppearance,
    PhraseInfo,
    build_edl,
)
from assembly.edl import EDL, EDLSegment
from common.db import execute, fetchall, fetchone
from common.logger import get_logger
from common.r2_client import (
    download_to_tmp,
    generate_presigned_url,
    upload_file,
)
from common.redis_client import fetch_next_job, job_context, publish_event

load_dotenv()
log = get_logger(__name__)

QUEUE = "generation"
TMP_DIR = Path("/tmp/hypereels")
FFMPEG_CRF = 20
FFMPEG_AUDIO_BITRATE = "192k"
MAX_HEIGHT = 1080


# ── Session data loading ──────────────────────────────────────────────────────

def _load_assembly_request(session_id: str, job_id: str) -> AssemblyRequest:
    """Fetch all required data from PostgreSQL and build an AssemblyRequest."""

    # Clips
    clip_rows = fetchall(
        """
        SELECT id, r2_key, duration_ms
        FROM clips
        WHERE session_id = %s AND status = 'valid'
        ORDER BY created_at
        """,
        (session_id,),
    )
    clips = [
        ClipMeta(
            clip_id=r["id"],
            clip_r2_key=r["r2_key"],
            duration_ms=r["duration_ms"] or 0,
        )
        for r in clip_rows
    ]

    # Audio track + analysis
    audio_row = fetchone(
        """
        SELECT id, r2_key, analysis_json, duration_ms
        FROM audio_tracks
        WHERE session_id = %s AND analysis_status = 'complete'
        LIMIT 1
        """,
        (session_id,),
    )
    if not audio_row:
        raise RuntimeError(f"No complete audio analysis for session {session_id}")

    analysis = audio_row["analysis_json"]
    if isinstance(analysis, str):
        analysis = json.loads(analysis)

    audio_duration_ms = audio_row["duration_ms"] or analysis.get("duration_ms", 0)

    phrases = [
        PhraseInfo(
            start_ms=p["start_ms"],
            end_ms=p["end_ms"],
            type=p["type"],
        )
        for p in analysis.get("phrases", [])
    ]

    beat_data = BeatData(
        duration_ms=audio_duration_ms,
        beats_ms=analysis.get("beats_ms", []),
        downbeats_ms=analysis.get("downbeats_ms", []),
        phrases=phrases,
    )

    # Highlights
    hl_rows = fetchall(
        """
        SELECT clip_id, start_ms, end_ms
        FROM highlights
        WHERE session_id = %s
        ORDER BY clip_id, start_ms
        """,
        (session_id,),
    )
    highlights = [
        Highlight(clip_id=r["clip_id"], start_ms=r["start_ms"], end_ms=r["end_ms"])
        for r in hl_rows
    ]

    # Person of interest appearances
    session_row = fetchone(
        "SELECT person_of_interest_id FROM sessions WHERE id = %s",
        (session_id,),
    )
    person_appearances: list[PersonAppearance] = []
    poi_id = session_row["person_of_interest_id"] if session_row else None

    if poi_id:
        poi_row = fetchone(
            "SELECT person_ref_id FROM person_detections WHERE id = %s",
            (poi_id,),
        )
        if poi_row:
            person_ref_id = poi_row["person_ref_id"]
            app_rows = fetchall(
                """
                SELECT clip_id, appearances
                FROM person_detections
                WHERE session_id = %s AND person_ref_id = %s
                """,
                (session_id, person_ref_id),
            )
            for row in app_rows:
                apps = row["appearances"]
                if isinstance(apps, str):
                    apps = json.loads(apps)
                for app in apps:
                    person_appearances.append(PersonAppearance(
                        clip_id=row["clip_id"],
                        start_ms=app["start_ms"],
                        end_ms=app["end_ms"],
                    ))

    return AssemblyRequest(
        session_id=session_id,
        audio_r2_key=audio_row["r2_key"],
        clips=clips,
        highlights=highlights,
        person_appearances=person_appearances,
        beat_data=beat_data,
    )


# ── FFmpeg pipeline ───────────────────────────────────────────────────────────

def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run an FFmpeg command; raise on non-zero exit."""
    log.debug("ffmpeg_cmd", cmd=" ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(
            f"FFmpeg failed (exit {result.returncode}):\n{result.stderr[-2000:]}"
        )
    return result


def _ms_to_ffmpeg(ms: int) -> str:
    """Convert milliseconds to HH:MM:SS.mmm format for FFmpeg -ss / -to."""
    total_sec = ms / 1000.0
    hours = int(total_sec // 3600)
    minutes = int((total_sec % 3600) // 60)
    seconds = total_sec % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def trim_segment(
    input_path: Path,
    start_ms: int,
    end_ms: int,
    output_path: Path,
) -> None:
    """Trim one clip segment with stream-copy (fast, no re-encode)."""
    _run([
        "ffmpeg", "-y",
        "-ss", _ms_to_ffmpeg(start_ms),
        "-to", _ms_to_ffmpeg(end_ms),
        "-i", str(input_path),
        "-c", "copy",
        "-avoid_negative_ts", "1",
        str(output_path),
    ])


def write_concat_list(segment_paths: list[Path], list_path: Path) -> None:
    """Write an FFmpeg concat demuxer file listing all segment paths."""
    lines = []
    for p in segment_paths:
        # Escape single quotes in paths
        safe = str(p).replace("'", "'\\''")
        lines.append(f"file '{safe}'")
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def concatenate_segments(list_path: Path, output_path: Path) -> None:
    """Concatenate trimmed segments via the concat demuxer (stream-copy)."""
    _run([
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_path),
        "-c", "copy",
        str(output_path),
    ])


def mix_audio_and_encode(
    video_path: Path,
    audio_path: Path,
    output_path: Path,
    target_duration_ms: int,
) -> None:
    """Replace clip audio with the uploaded song track and final-encode.

    Encoding settings:
      - libx264 CRF 20 (high quality)
      - aac 192 kbps
      - yuv420p (maximum compatibility)
      - -movflags faststart (streaming-friendly)
      - -vf scale: downscale to max 1080p if needed, never upscale
      - Trim to target_duration_ms
    """
    # Scale filter: ensure height <= MAX_HEIGHT, width divisible by 2,
    # never upscale.
    scale_filter = (
        f"scale='if(gt(ih,{MAX_HEIGHT}),-2,iw)':'if(gt(ih,{MAX_HEIGHT}),{MAX_HEIGHT},-1)',"
        "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    )

    _run([
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(audio_path),
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-crf", str(FFMPEG_CRF),
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", FFMPEG_AUDIO_BITRATE,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-vf", scale_filter,
        "-t", _ms_to_ffmpeg(target_duration_ms),
        "-shortest",
        str(output_path),
    ])


def probe_duration_ms(path: Path) -> int:
    """Use ffprobe to get video duration in ms."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json",
            str(path),
        ],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        data = json.loads(result.stdout)
        dur = float(data.get("format", {}).get("duration", 0))
        return int(dur * 1000)
    return 0


def probe_size_bytes(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


# ── Main job handler ──────────────────────────────────────────────────────────

def process_generation_job(job_data: dict[str, Any]) -> None:
    job_id: str = job_data["job_id"]
    session_id: str = job_data["session_id"]

    log.info("assembly_job_start", job_id=job_id, session_id=session_id)

    execute(
        "UPDATE generation_jobs SET status = 'processing', started_at = NOW() WHERE id = %s",
        (job_id,),
    )

    # Create job-specific tmp directory
    job_tmp = TMP_DIR / job_id
    job_tmp.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Load session data
        request = _load_assembly_request(session_id, job_id)

        if not request.clips:
            raise RuntimeError("No valid clips found for assembly")

        # 2. Build EDL
        edl = build_edl(request)

        if not edl.segments:
            raise RuntimeError("Assembly algorithm produced an empty EDL")

        errors = edl.validate()
        if errors:
            log.warning("edl_validation_warnings", errors=errors)

        log.info(
            "edl_built",
            job_id=job_id,
            segments=edl.segment_count,
            duration_ms=edl.total_duration_ms,
        )

        # 3. Download all unique clips needed
        clip_local_paths: dict[str, Path] = {}
        needed_clip_ids = {s.clip_id for s in edl.segments}
        for seg in edl.segments:
            if seg.clip_id not in clip_local_paths:
                local = download_to_tmp(seg.clip_r2_key, suffix=".mp4")
                clip_local_paths[seg.clip_id] = local

        # Download audio
        audio_local = download_to_tmp(request.audio_r2_key, suffix=".audio")

        # 4. Trim segments
        execute(
            "UPDATE generation_jobs SET status = 'rendering' WHERE id = %s",
            (job_id,),
        )
        segment_paths: list[Path] = []
        for i, seg in enumerate(edl.segments):
            input_path = clip_local_paths[seg.clip_id]
            seg_out = job_tmp / f"seg_{i:04d}.mp4"
            trim_segment(input_path, seg.start_ms, seg.end_ms, seg_out)
            segment_paths.append(seg_out)

        # 5. Concat
        concat_list = job_tmp / "concat.txt"
        write_concat_list(segment_paths, concat_list)
        concat_out = job_tmp / "concat.mp4"
        concatenate_segments(concat_list, concat_out)

        # 6. Mix audio + final encode
        short_id = uuid.uuid4().hex[:8]
        final_filename = f"hypereel_{short_id}.mp4"
        final_path = job_tmp / final_filename
        mix_audio_and_encode(concat_out, audio_local, final_path, edl.target_duration_ms)

        # 7. Upload to R2
        output_r2_key = f"generated/{session_id}/{final_filename}"
        upload_file(final_path, output_r2_key, content_type="video/mp4")

        # 8. Generate signed URL (2-hour TTL)
        download_url = generate_presigned_url(output_r2_key, expires_in=7200)

        # 9. Measure output
        output_duration_ms = probe_duration_ms(final_path)
        output_size_bytes = probe_size_bytes(final_path)

        # 10. Persist results
        execute(
            """
            UPDATE generation_jobs
            SET status            = 'complete',
                edl_json          = %s,
                output_r2_key     = %s,
                output_url        = %s,
                output_duration_ms = %s,
                output_size_bytes  = %s,
                completed_at      = NOW()
            WHERE id = %s
            """,
            (
                json.dumps(edl.to_dict()),
                output_r2_key,
                download_url,
                output_duration_ms,
                output_size_bytes,
                job_id,
            ),
        )
        execute(
            "UPDATE sessions SET status = 'complete' WHERE id = %s",
            (session_id,),
        )

        # 11. Publish event
        publish_event(session_id, {
            "type": "generation-complete",
            "job_id": job_id,
            "download_url": download_url,
            "duration_ms": output_duration_ms,
            "size_bytes": output_size_bytes,
        })
        log.info(
            "assembly_job_complete",
            job_id=job_id,
            output_r2_key=output_r2_key,
            duration_ms=output_duration_ms,
        )

    except Exception as exc:
        execute(
            """
            UPDATE generation_jobs
            SET status = 'failed', error_message = %s
            WHERE id = %s
            """,
            (str(exc), job_id),
        )
        publish_event(session_id, {
            "type": "generation-failed",
            "job_id": job_id,
            "error": str(exc),
        })
        raise

    finally:
        # Clean up /tmp
        shutil.rmtree(job_tmp, ignore_errors=True)
        for p in clip_local_paths.values():
            p.unlink(missing_ok=True)
        if "audio_local" in dir():
            audio_local.unlink(missing_ok=True)  # type: ignore[possibly-undefined]


# ── Public importable function (used by FastAPI main.py) ─────────────────────

def assemble_reel(request: AssemblyRequest) -> dict[str, Any]:
    """Run the full assembly pipeline for an AssemblyRequest and return result dict.

    This is the importable entry point for the FastAPI HTTP layer.
    It builds the EDL, downloads clips, runs FFmpeg, uploads to R2, and returns
    a dict compatible with AssembleReelResponse in main.py.

    Note: R2 credentials must already be configured in the environment before
    calling this function.  The FastAPI layer (main.py) handles credential
    injection from the Node request payload.

    Returns:
        {
          "output_r2_key": str,
          "output_size_bytes": int,
          "output_duration_ms": int,
          "edl_json": dict,
        }
    """
    if not request.clips:
        raise ValueError("No clips in assembly request")

    edl = build_edl(request)
    if not edl.segments:
        raise RuntimeError("Assembly algorithm produced an empty EDL")

    errors = edl.validate()
    if errors:
        log.warning("edl_validation_warnings", errors=errors)

    job_id = str(uuid.uuid4())
    job_tmp = TMP_DIR / job_id
    job_tmp.mkdir(parents=True, exist_ok=True)

    try:
        clip_local_paths: dict[str, Path] = {}
        for seg in edl.segments:
            if seg.clip_id not in clip_local_paths:
                local = download_to_tmp(seg.clip_r2_key, suffix=".mp4")
                clip_local_paths[seg.clip_id] = local

        audio_local = download_to_tmp(request.audio_r2_key, suffix=".audio")

        segment_paths: list[Path] = []
        for i, seg in enumerate(edl.segments):
            input_path = clip_local_paths[seg.clip_id]
            seg_out = job_tmp / f"seg_{i:04d}.mp4"
            trim_segment(input_path, seg.start_ms, seg.end_ms, seg_out)
            segment_paths.append(seg_out)

        concat_list = job_tmp / "concat.txt"
        write_concat_list(segment_paths, concat_list)
        concat_out = job_tmp / "concat.mp4"
        concatenate_segments(concat_list, concat_out)

        short_id = uuid.uuid4().hex[:8]
        final_filename = f"hypereel_{short_id}.mp4"
        final_path = job_tmp / final_filename
        mix_audio_and_encode(concat_out, audio_local, final_path, edl.target_duration_ms)

        output_r2_key = f"generated/{request.session_id}/{final_filename}"
        upload_file(final_path, output_r2_key, content_type="video/mp4")

        output_duration_ms = probe_duration_ms(final_path)
        output_size_bytes = probe_size_bytes(final_path)

        return {
            "output_r2_key": output_r2_key,
            "output_size_bytes": output_size_bytes,
            "output_duration_ms": output_duration_ms,
            "edl_json": edl.to_dict(),
        }

    finally:
        shutil.rmtree(job_tmp, ignore_errors=True)
        for p in clip_local_paths.values():
            p.unlink(missing_ok=True)
        try:
            audio_local.unlink(missing_ok=True)  # type: ignore[possibly-undefined]
        except Exception:
            pass


# ── Worker loop ───────────────────────────────────────────────────────────────

def main() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    log.info("assembly_worker_started", queue=QUEUE)
    while True:
        job = fetch_next_job(QUEUE, block_seconds=5)
        if job is None:
            continue
        try:
            with job_context(QUEUE, job):
                process_generation_job(job["data"])
        except Exception as exc:
            log.error(
                "assembly_job_error",
                job_id=job.get("id"),
                error=str(exc),
                exc_info=True,
            )


if __name__ == "__main__":
    main()
