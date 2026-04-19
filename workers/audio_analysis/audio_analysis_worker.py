"""Audio Analysis Worker.

Consumes jobs from the BullMQ 'audio-analysis' queue.

For each audio job:
  1. Download the audio file from R2 to /tmp.
  2. Decode to mono 22 050 Hz float32 array with librosa.
  3. Extract:
     - BPM via librosa.beat.beat_track (trim=False for full accuracy)
     - Beat timestamps array
     - Downbeat timestamps (every 4 beats by default)
     - Onset timestamps via librosa.onset.onset_detect
     - RMS energy envelope (50 ms frames, downsampled to ~200 points)
     - Phrase boundaries (4-bar groups, 16 beats per phrase at 4/4 time)
     - Phrase type classification (intro / verse / chorus / outro) based on
       energy percentile within each phrase
  4. Serialise results to JSON.
  5. Store JSON in audio_tracks.analysis_json via DB.
  6. Generate and upload a waveform SVG to R2 for frontend display.
  7. Publish completion event to Redis.
"""

from __future__ import annotations

import io
import json
import math
import os
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from dotenv import load_dotenv

from common.db import execute, fetchone
from common.logger import get_logger
from common.r2_client import download_to_tmp, generate_presigned_url, upload_bytes
from common.redis_client import fail_job, fetch_next_job, job_context, publish_event

load_dotenv()
log = get_logger(__name__)

QUEUE = "audio-analysis"
TARGET_SR = 22_050          # librosa default sample rate
HOP_LENGTH = 512            # frames: ~23 ms at 22 050 Hz
RMS_FRAME_MS = 50           # energy envelope granularity
WAVEFORM_POINTS = 200       # SVG waveform resolution
BEATS_PER_BAR = 4           # 4/4 time assumed
BARS_PER_PHRASE = 4         # 16 beats per phrase


# ── Output schema ─────────────────────────────────────────────────────────────

@dataclass
class Phrase:
    start_ms: int
    end_ms: int
    type: str   # intro | verse | chorus | outro


@dataclass
class AudioAnalysis:
    audio_id: str
    duration_ms: int
    bpm: float
    beats_ms: list[int]
    downbeats_ms: list[int]
    onsets_ms: list[int]
    energy_envelope: list[list[float]]   # [[time_ms, rms], ...]
    phrases: list[Phrase]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["phrases"] = [asdict(p) for p in self.phrases]
        return d


# ── Analysis functions ────────────────────────────────────────────────────────

def load_audio(path: Path) -> tuple[np.ndarray, float]:
    """Load audio file to mono float32 at TARGET_SR."""
    y, sr = librosa.load(str(path), sr=TARGET_SR, mono=True)
    log.info("audio_loaded", path=str(path), sr=sr, samples=len(y))
    return y, float(sr)


def extract_beats(y: np.ndarray, sr: float) -> tuple[float, np.ndarray]:
    """Return (bpm, beat_times_seconds).

    Fallback chain (NEVER raises):
      1. librosa.beat.beat_track(trim=False) — primary path.
      2. If < 4 beats returned, attempt madmom RNNBeatProcessor.
      3. If madmom unavailable or also returns < 4 beats, synthesise
         beats at the detected BPM using a fixed interval (60.0 / bpm).
    """
    duration_sec = float(len(y)) / sr

    tempo, beat_frames = librosa.beat.beat_track(
        y=y, sr=sr, hop_length=HOP_LENGTH, trim=False
    )
    bpm = float(tempo) if np.isscalar(tempo) else float(tempo[0])
    if bpm <= 0:
        bpm = 120.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)

    if len(beat_times) < 4:
        log.warning(
            "beat_track_low_count",
            librosa_beats=len(beat_times),
            bpm=bpm,
        )
        # Try madmom fallback
        try:
            from madmom.features.beats import RNNBeatProcessor, BeatTrackingProcessor
            import tempfile, soundfile as sf

            # madmom requires a file path; write a temp wav
            fd, tmp_wav = tempfile.mkstemp(suffix=".wav", dir="/tmp/hypereels")
            os.close(fd)
            try:
                sf.write(tmp_wav, y, int(sr))
                proc = RNNBeatProcessor()
                tracker = BeatTrackingProcessor(fps=100)
                beat_times_madmom = tracker(proc(tmp_wav))
                if len(beat_times_madmom) >= 4:
                    log.info("beat_track_madmom_success", beats=len(beat_times_madmom))
                    return bpm, np.array(beat_times_madmom, dtype=np.float64)
            finally:
                try:
                    os.unlink(tmp_wav)
                except OSError:
                    pass
        except Exception as exc:
            log.warning("madmom_fallback_failed", error=str(exc))

        # Fixed-interval fallback: synthesise beats at detected BPM
        interval_sec = 60.0 / bpm
        beat_times = np.arange(0.0, duration_sec, interval_sec)
        log.info(
            "beat_track_fixed_interval_fallback",
            bpm=bpm,
            synthesised_beats=len(beat_times),
        )

    return bpm, beat_times


def extract_onsets(y: np.ndarray, sr: float) -> np.ndarray:
    """Return onset times in seconds."""
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=HOP_LENGTH, backtrack=True
    )
    return librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP_LENGTH)


def compute_energy_envelope(y: np.ndarray, sr: float, frame_ms: int = RMS_FRAME_MS) -> list[list[float]]:
    """Compute RMS energy per *frame_ms* window, downsampled to WAVEFORM_POINTS."""
    frame_length = int(sr * frame_ms / 1000)
    hop = frame_length
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop)[0]
    times = librosa.frames_to_time(
        np.arange(len(rms)), sr=sr, hop_length=hop
    )

    # Downsample to WAVEFORM_POINTS for the frontend SVG
    if len(rms) > WAVEFORM_POINTS:
        indices = np.linspace(0, len(rms) - 1, WAVEFORM_POINTS, dtype=int)
        rms = rms[indices]
        times = times[indices]

    # Normalise to [0, 1]
    max_rms = float(rms.max()) if rms.max() > 0 else 1.0
    envelope = [
        [round(float(t) * 1000, 1), round(float(r) / max_rms, 4)]
        for t, r in zip(times, rms)
    ]
    return envelope


def derive_downbeats(beat_times: np.ndarray) -> np.ndarray:
    """Every 4th beat is a downbeat (assuming 4/4 time)."""
    return beat_times[::BEATS_PER_BAR]


def derive_phrases(
    beat_times: np.ndarray,
    energy_envelope: list[list[float]],
    duration_sec: float,
) -> list[Phrase]:
    """Segment the song into phrases of BARS_PER_PHRASE bars each.

    Phrase type classification:
      - First phrase → 'intro'
      - Last phrase → 'outro'
      - Remaining phrases with RMS > 75th percentile → 'chorus'
      - Remaining phrases → 'verse'
    """
    beats_per_phrase = BEATS_PER_BAR * BARS_PER_PHRASE  # 16 beats
    if len(beat_times) == 0:
        return [Phrase(start_ms=0, end_ms=int(duration_sec * 1000), type="verse")]

    phrase_start_indices = list(range(0, len(beat_times), beats_per_phrase))
    phrase_boundaries_sec = [beat_times[i] for i in phrase_start_indices]
    phrase_boundaries_sec.append(duration_sec)  # append song end

    # Build RMS lookup for classification
    env_arr = np.array(energy_envelope)  # shape (N, 2): [[time_ms, rms], ...]
    env_times_ms = env_arr[:, 0]
    env_rms = env_arr[:, 1]

    def _mean_rms_for_range(start_ms: int, end_ms: int) -> float:
        mask = (env_times_ms >= start_ms) & (env_times_ms < end_ms)
        vals = env_rms[mask]
        return float(vals.mean()) if len(vals) > 0 else 0.0

    phrases: list[Phrase] = []
    phrase_rms: list[float] = []

    for i in range(len(phrase_boundaries_sec) - 1):
        start_ms = int(phrase_boundaries_sec[i] * 1000)
        end_ms = int(phrase_boundaries_sec[i + 1] * 1000)
        phrase_rms.append(_mean_rms_for_range(start_ms, end_ms))
        phrases.append(Phrase(start_ms=start_ms, end_ms=end_ms, type="verse"))  # temp

    if not phrases:
        return [Phrase(start_ms=0, end_ms=int(duration_sec * 1000), type="verse")]

    rms_arr = np.array(phrase_rms)
    chorus_threshold = float(np.percentile(rms_arr, 75)) if len(rms_arr) > 1 else 0.0

    for i, phrase in enumerate(phrases):
        if i == 0:
            phrase.type = "intro"
        elif i == len(phrases) - 1:
            phrase.type = "outro"
        elif phrase_rms[i] >= chorus_threshold:
            phrase.type = "chorus"
        else:
            phrase.type = "verse"

    return phrases


# ── SVG waveform generation ───────────────────────────────────────────────────

def generate_waveform_svg(energy_envelope: list[list[float]], width: int = 800, height: int = 100) -> bytes:
    """Generate a minimal SVG polyline from the energy envelope."""
    if not energy_envelope:
        return b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 100"></svg>'

    total_duration_ms = energy_envelope[-1][0]
    if total_duration_ms <= 0:
        total_duration_ms = 1.0

    points = []
    for time_ms, rms in energy_envelope:
        x = round((time_ms / total_duration_ms) * width, 2)
        y = round(height - (rms * (height - 4)) - 2, 2)  # flip Y, 2px padding
        points.append(f"{x},{y}")

    polyline = " ".join(points)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'preserveAspectRatio="none">'
        f'<polyline points="{polyline}" fill="none" stroke="#6366f1" stroke-width="1.5"/>'
        f"</svg>"
    )
    return svg.encode("utf-8")


# ── Main job handler ──────────────────────────────────────────────────────────

def process_audio_job(job_data: dict[str, Any]) -> None:
    audio_id: str = job_data["audio_id"]
    session_id: str = job_data["session_id"]
    r2_key: str = job_data["r2_key"]

    log.info("audio_analysis_start", audio_id=audio_id, session_id=session_id)

    # Mark as processing
    execute(
        "UPDATE audio_tracks SET analysis_status = 'processing' WHERE id = %s",
        (audio_id,),
    )

    # 1. Download audio
    suffix = Path(r2_key).suffix or ".mp3"
    tmp_path = download_to_tmp(r2_key, suffix=suffix)
    try:
        # 2. Load + decode
        y, sr = load_audio(tmp_path)
        duration_sec = float(len(y)) / sr
        duration_ms = int(duration_sec * 1000)

        # 3. Feature extraction
        bpm, beat_times = extract_beats(y, sr)
        onset_times = extract_onsets(y, sr)
        energy_envelope = compute_energy_envelope(y, sr)
        downbeat_times = derive_downbeats(beat_times)
        phrases = derive_phrases(beat_times, energy_envelope, duration_sec)

        analysis = AudioAnalysis(
            audio_id=audio_id,
            duration_ms=duration_ms,
            bpm=round(bpm, 2),
            beats_ms=[int(t * 1000) for t in beat_times],
            downbeats_ms=[int(t * 1000) for t in downbeat_times],
            onsets_ms=[int(t * 1000) for t in onset_times],
            energy_envelope=energy_envelope,
            phrases=phrases,
        )

        log.info(
            "audio_features_extracted",
            audio_id=audio_id,
            bpm=analysis.bpm,
            beats=len(analysis.beats_ms),
            duration_ms=duration_ms,
        )

        # 4. Generate SVG waveform
        svg_bytes = generate_waveform_svg(energy_envelope)
        waveform_key = f"thumbnails/{session_id}/waveform.svg"
        upload_bytes(svg_bytes, waveform_key, content_type="image/svg+xml")
        waveform_url = generate_presigned_url(waveform_key, expires_in=86400 * 7)

        # 5. Persist to DB
        analysis_dict = analysis.to_dict()
        execute(
            """
            UPDATE audio_tracks
            SET analysis_status = 'complete',
                analysis_json   = %s,
                duration_ms     = %s,
                waveform_url    = %s
            WHERE id = %s
            """,
            (json.dumps(analysis_dict), duration_ms, waveform_url, audio_id),
        )

        # 6. Publish event
        publish_event(session_id, {
            "type": "audio-analysed",
            "audio_id": audio_id,
            "bpm": analysis.bpm,
            "duration_ms": duration_ms,
            "waveform_url": waveform_url,
        })
        log.info("audio_analysis_complete", audio_id=audio_id)

    except Exception:
        execute(
            "UPDATE audio_tracks SET analysis_status = 'failed' WHERE id = %s",
            (audio_id,),
        )
        raise
    finally:
        tmp_path.unlink(missing_ok=True)


# ── Public importable function (used by FastAPI main.py) ─────────────────────

def analyse_audio(audio_url: str, session_id: str, audio_track_id: str) -> AudioAnalysis:
    """Download audio from *audio_url* and return a fully-populated AudioAnalysis.

    This is the importable entry point called by the FastAPI HTTP layer.
    No database writes, no Redis events — pure analysis.

    Args:
        audio_url:      Presigned URL (or local file:// path) to the audio file.
        session_id:     Session UUID (used to build the audio_id placeholder).
        audio_track_id: audio_tracks.id from PostgreSQL.

    Returns:
        AudioAnalysis dataclass with all extracted features.
    """
    import tempfile
    import httpx
    from pathlib import Path

    # Determine whether audio_url is a local path or remote URL
    if audio_url.startswith("file://"):
        tmp_path = Path(audio_url[7:])
        _own_tmp = False
    elif audio_url.startswith("/"):
        tmp_path = Path(audio_url)
        _own_tmp = False
    else:
        # Download remote file
        suffix = Path(audio_url.split("?")[0]).suffix or ".mp3"
        fd, tmp = tempfile.mkstemp(suffix=suffix, dir="/tmp/hypereels")
        os.close(fd)
        tmp_path = Path(tmp)
        _own_tmp = True
        with httpx.Client(timeout=600.0, follow_redirects=True) as client:
            with client.stream("GET", audio_url) as response:
                response.raise_for_status()
                with open(tmp_path, "wb") as f:
                    for chunk in response.iter_bytes(chunk_size=65536):
                        f.write(chunk)

    try:
        y, sr = load_audio(tmp_path)
        duration_sec = float(len(y)) / sr
        duration_ms = int(duration_sec * 1000)

        bpm, beat_times = extract_beats(y, sr)
        onset_times = extract_onsets(y, sr)
        energy_envelope = compute_energy_envelope(y, sr)
        downbeat_times = derive_downbeats(beat_times)
        phrases = derive_phrases(beat_times, energy_envelope, duration_sec)

        return AudioAnalysis(
            audio_id=audio_track_id,
            duration_ms=duration_ms,
            bpm=round(bpm, 2),
            beats_ms=[int(t * 1000) for t in beat_times],
            downbeats_ms=[int(t * 1000) for t in downbeat_times],
            onsets_ms=[int(t * 1000) for t in onset_times],
            energy_envelope=energy_envelope,
            phrases=phrases,
        )
    finally:
        if _own_tmp:
            tmp_path.unlink(missing_ok=True)


# ── Worker loop ───────────────────────────────────────────────────────────────

def main() -> None:
    log.info("audio_analysis_worker_started", queue=QUEUE)
    while True:
        job = fetch_next_job(QUEUE, block_seconds=5)
        if job is None:
            continue
        try:
            with job_context(QUEUE, job):
                process_audio_job(job["data"])
        except Exception as exc:
            log.error(
                "audio_analysis_error",
                job_id=job["id"],
                error=str(exc),
                exc_info=True,
            )
            session_id = job["data"].get("session_id", "")
            if session_id:
                publish_event(session_id, {
                    "type": "audio-analysis-failed",
                    "audio_id": job["data"].get("audio_id", ""),
                    "error": str(exc),
                })


if __name__ == "__main__":
    main()
