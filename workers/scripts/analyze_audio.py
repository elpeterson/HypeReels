#!/usr/bin/env python3
"""
analyze_audio.py — librosa audio analysis for HypeReels.

CLI:
    python analyze_audio.py <audio_file_path>

Outputs JSON to stdout:
    {"bpm":120.0,"beats":[0,500,1000],"onsets":[0,250,500],"phrases":[{"start_ms":0,"end_ms":8000}]}

All timestamps are integers in milliseconds.

Edge case: ambient audio with no clear beat → fixed 500ms intervals, bpm=120.0,
and "beat_sync_unavailable":true flag added to output.

Exit 0 on success, non-zero on failure. Errors go to stderr.
"""

import json
import os
import sys

import librosa
import numpy as np


# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

MIN_BEATS_FOR_VALID_TRACKING = 4     # fewer beats → fallback path
FALLBACK_BPM = 120.0                 # beats per minute for fallback
FALLBACK_INTERVAL_MS = 500           # 500 ms = 120 BPM interval
BARS_PER_PHRASE = 8                  # musical phrase length in bars
BEATS_PER_BAR = 4                    # 4/4 time assumed


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    """Write a log line to stderr (stdout is reserved for JSON)."""
    print(f"[analyze_audio] {msg}", file=sys.stderr)


def frames_to_ms(frames: np.ndarray, sr: int, hop_length: int) -> list[int]:
    """Convert librosa frame indices → millisecond integer timestamps."""
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop_length)
    return [int(round(t * 1000)) for t in times]


def samples_to_ms(samples: np.ndarray, sr: int) -> list[int]:
    """Convert sample indices → millisecond integer timestamps."""
    return [int(round(float(s) / sr * 1000)) for s in samples]


# ──────────────────────────────────────────────────────────────────────────────
# Audio loading
# ──────────────────────────────────────────────────────────────────────────────

def load_audio(audio_path: str) -> tuple[np.ndarray, int]:
    """
    Load audio with librosa. Returns (y, sr).
    Raises RuntimeError if loading fails.
    """
    try:
        y, sr = librosa.load(audio_path, sr=None, mono=True)
    except Exception as exc:
        raise RuntimeError(f"librosa.load failed: {exc}") from exc

    if y is None or len(y) == 0:
        raise RuntimeError("Audio loaded but contains no samples")

    log(f"Loaded: {len(y)} samples @ {sr} Hz ({len(y)/sr:.1f}s)")
    return y, sr


# ──────────────────────────────────────────────────────────────────────────────
# Beat tracking
# ──────────────────────────────────────────────────────────────────────────────

def track_beats(y: np.ndarray, sr: int) -> tuple[float, np.ndarray, int]:
    """
    Run librosa beat tracking.

    Returns:
        bpm        — estimated tempo (float)
        beat_times — np.ndarray of beat times in seconds
        hop_length — hop length used by the tracker
    """
    hop_length = 512
    tempo, beat_frames = librosa.beat.beat_track(
        y=y,
        sr=sr,
        hop_length=hop_length,
        trim=False,
        units="frames",
    )
    # librosa >= 0.10 returns tempo as a 1-element array; extract scalar
    if hasattr(tempo, "__len__"):
        tempo = float(tempo[0])
    else:
        tempo = float(tempo)

    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
    return tempo, beat_times, hop_length


# ──────────────────────────────────────────────────────────────────────────────
# Onset detection
# ──────────────────────────────────────────────────────────────────────────────

def detect_onsets(y: np.ndarray, sr: int) -> list[int]:
    """Return onset timestamps in milliseconds."""
    hop_length = 512
    onset_frames = librosa.onset.onset_detect(
        y=y,
        sr=sr,
        hop_length=hop_length,
        backtrack=True,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length)
    return sorted({int(round(t * 1000)) for t in onset_times})


# ──────────────────────────────────────────────────────────────────────────────
# Phrase segmentation
# ──────────────────────────────────────────────────────────────────────────────

def segment_phrases(
    bpm: float,
    duration_ms: int,
    beat_times_ms: list[int],
) -> list[dict]:
    """
    Divide audio into phrases.

    Strategy:
    1. If we have valid beats, group beats into BARS_PER_PHRASE-bar phrases and
       snap boundaries to the nearest actual beat timestamp.
    2. Otherwise, fall back to equal-length segments based on BPM arithmetic.

    Returns list of {"start_ms": int, "end_ms": int}.
    """
    if not beat_times_ms:
        # Pure arithmetic fallback — no beat data
        beats_per_phrase = BARS_PER_PHRASE * BEATS_PER_BAR
        phrase_ms = int(round(beats_per_phrase * 60_000 / bpm))
        return _split_equal(duration_ms, phrase_ms)

    beats_per_phrase = BARS_PER_PHRASE * BEATS_PER_BAR
    phrases = []
    start_idx = 0

    while start_idx < len(beat_times_ms):
        end_idx = min(start_idx + beats_per_phrase, len(beat_times_ms))
        start_ms = beat_times_ms[start_idx]
        # Phrase ends at the next phrase's first beat, or audio end
        if end_idx < len(beat_times_ms):
            end_ms = beat_times_ms[end_idx]
        else:
            end_ms = duration_ms
        if end_ms > start_ms:
            phrases.append({"start_ms": start_ms, "end_ms": end_ms})
        start_idx = end_idx

    if not phrases:
        return [{"start_ms": 0, "end_ms": duration_ms}]

    # Ensure coverage starts at 0 and ends at duration_ms
    phrases[0]["start_ms"] = 0
    phrases[-1]["end_ms"] = duration_ms

    return phrases


def _split_equal(duration_ms: int, phrase_ms: int) -> list[dict]:
    """Split duration_ms into equal phrase_ms slices."""
    if phrase_ms <= 0 or duration_ms <= 0:
        return [{"start_ms": 0, "end_ms": duration_ms}]
    phrases = []
    start = 0
    while start < duration_ms:
        end = min(start + phrase_ms, duration_ms)
        phrases.append({"start_ms": start, "end_ms": end})
        start = end
    return phrases


# ──────────────────────────────────────────────────────────────────────────────
# Fallback: fixed-interval beats
# ──────────────────────────────────────────────────────────────────────────────

def generate_fixed_interval_beats(duration_ms: int, interval_ms: int = FALLBACK_INTERVAL_MS) -> list[int]:
    """Generate evenly-spaced beat timestamps for ambient/arrhythmic audio."""
    beats = list(range(0, duration_ms, interval_ms))
    return beats


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: analyze_audio.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    if not os.path.isfile(audio_path):
        print(f"Error: audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(2)

    # ── Load ─────────────────────────────────────────────────────────────────
    log(f"Loading audio: {audio_path}")
    try:
        y, sr = load_audio(audio_path)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(3)

    duration_s = len(y) / sr
    duration_ms = int(round(duration_s * 1000))
    log(f"Duration: {duration_ms} ms")

    # ── Beat tracking ────────────────────────────────────────────────────────
    log("Running beat tracking…")
    beat_sync_unavailable = False
    try:
        bpm, beat_times_sec, _hop = track_beats(y, sr)
        beat_times_ms = sorted({int(round(t * 1000)) for t in beat_times_sec})
    except Exception as exc:
        log(f"Beat tracking raised an exception: {exc} — using fallback")
        bpm = FALLBACK_BPM
        beat_times_ms = []

    # Edge case: fewer than MIN_BEATS_FOR_VALID_TRACKING beats detected
    if len(beat_times_ms) < MIN_BEATS_FOR_VALID_TRACKING:
        log(
            f"Only {len(beat_times_ms)} beat(s) detected (threshold={MIN_BEATS_FOR_VALID_TRACKING}) "
            "— beat tracking unreliable, using fixed intervals"
        )
        beat_sync_unavailable = True
        bpm = FALLBACK_BPM
        beat_times_ms = generate_fixed_interval_beats(duration_ms, FALLBACK_INTERVAL_MS)

    log(f"BPM: {bpm:.2f}  |  Beats: {len(beat_times_ms)}  |  Fallback: {beat_sync_unavailable}")

    # ── Onset detection ──────────────────────────────────────────────────────
    log("Running onset detection…")
    try:
        onset_times_ms = detect_onsets(y, sr)
    except Exception as exc:
        log(f"Onset detection failed: {exc} — using empty list")
        onset_times_ms = []

    log(f"Onsets: {len(onset_times_ms)}")

    # ── Phrase segmentation ──────────────────────────────────────────────────
    log("Segmenting phrases…")
    phrases = segment_phrases(bpm, duration_ms, beat_times_ms if not beat_sync_unavailable else [])
    log(f"Phrases: {len(phrases)}")

    # ── Output ───────────────────────────────────────────────────────────────
    output: dict = {
        "bpm": round(float(bpm), 2),
        "beats": beat_times_ms,
        "onsets": onset_times_ms,
        "phrases": phrases,
    }

    if beat_sync_unavailable:
        output["beat_sync_unavailable"] = True

    log("Analysis complete.")
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
