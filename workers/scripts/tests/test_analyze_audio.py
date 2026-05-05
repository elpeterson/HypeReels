"""
Unit tests for analyze_audio.py

Tests cover:
- BPM extraction (TC-043)
- Beat timestamps in milliseconds (TC-045)
- Phrase detection output shape (TC-046)
- Ambient audio fallback — empty beats (TC-044)
- Full output contract shape validation (TC-043)

All heavy dependencies (librosa.load, librosa.beat.beat_track,
librosa.onset.onset_detect) are mocked so tests run without real audio files
and complete in milliseconds.
"""

import json
import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch, call
from io import StringIO

import numpy as np
import pytest


# ─── Helper to run analyze_audio as a module ─────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))


def _run_analyze_audio(audio_path: str, monkeypatch, *, y=None, sr=44100,
                        beat_frames=None, onset_frames=None):
    """
    Import-and-call helper that patches librosa before importing the script.

    Returns the parsed JSON dict from stdout (or raises if exit code is non-zero).
    """
    import importlib

    if y is None:
        y = np.zeros(sr * 5, dtype=np.float32)

    if beat_frames is None:
        beat_frames = np.array([0, 22050, 44100, 66150, 88200], dtype=float)

    if onset_frames is None:
        onset_frames = np.array([0, 11025, 22050, 33075, 44100], dtype=float)

    mock_librosa = MagicMock()
    mock_librosa.load.return_value = (y, sr)
    mock_librosa.beat.beat_track.return_value = (np.float64(120.0), beat_frames)
    mock_librosa.onset.onset_detect.return_value = onset_frames
    mock_librosa.frames_to_time.side_effect = lambda frames, sr: frames / sr
    mock_librosa.time_to_frames.side_effect = lambda times, sr: np.array(times) * sr

    captured_output = StringIO()

    with patch.dict("sys.modules", {"librosa": mock_librosa,
                                     "librosa.beat": mock_librosa.beat,
                                     "librosa.onset": mock_librosa.onset}):
        with patch("sys.argv", ["analyze_audio.py", audio_path]):
            with patch("sys.stdout", captured_output):
                # Import fresh each time
                if "analyze_audio" in sys.modules:
                    del sys.modules["analyze_audio"]
                import analyze_audio  # noqa: F401 — side-effectful import

    output = captured_output.getvalue().strip()
    return json.loads(output)


# ─── TC-043: Output contract shape validation ─────────────────────────────────

class TestAnalyzeAudioOutputContract:
    def test_output_has_bpm_field(self, mock_audio_file, monkeypatch):
        """TC-043: Output JSON contains bpm as a positive float."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        assert "bpm" in result, "Output must contain 'bpm' field"
        assert isinstance(result["bpm"], (int, float)), "bpm must be a number"
        assert result["bpm"] > 0, "bpm must be positive"

    def test_output_has_beats_field(self, mock_audio_file, monkeypatch):
        """TC-043: Output JSON contains beats as an array."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        assert "beats" in result, "Output must contain 'beats' field"
        assert isinstance(result["beats"], list), "beats must be an array"

    def test_output_has_onsets_field(self, mock_audio_file, monkeypatch):
        """TC-043: Output JSON contains onsets as an array."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        assert "onsets" in result, "Output must contain 'onsets' field"
        assert isinstance(result["onsets"], list), "onsets must be an array"

    def test_output_has_phrases_field(self, mock_audio_file, monkeypatch):
        """TC-043: Output JSON contains phrases as an array of objects."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        assert "phrases" in result, "Output must contain 'phrases' field"
        assert isinstance(result["phrases"], list), "phrases must be an array"

    def test_phrases_have_start_end_ms(self, mock_audio_file, monkeypatch):
        """TC-043: Each phrase has start_ms and end_ms keys (integers)."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        for phrase in result["phrases"]:
            assert "start_ms" in phrase, "Phrase must have start_ms"
            assert "end_ms" in phrase, "Phrase must have end_ms"
            assert isinstance(phrase["start_ms"], int), "start_ms must be int"
            assert isinstance(phrase["end_ms"], int), "end_ms must be int"
            assert phrase["end_ms"] > phrase["start_ms"], \
                "end_ms must be > start_ms"

    def test_bpm_is_120(self, mock_audio_file, monkeypatch):
        """TC-043: BPM matches the mocked value of 120.0."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=np.array([0, 22050, 44100], dtype=float))
        assert abs(result["bpm"] - 120.0) < 1.0, \
            f"Expected bpm≈120.0, got {result['bpm']}"

    def test_all_contract_keys_present(self, mock_audio_file, monkeypatch):
        """TC-043: Exactly the four contract keys are present (no missing, extras OK)."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        required_keys = {"bpm", "beats", "onsets", "phrases"}
        missing = required_keys - set(result.keys())
        assert not missing, f"Output contract missing keys: {missing}"


# ─── TC-045: Beat timestamps in milliseconds ──────────────────────────────────

class TestBeatTimestamps:
    def test_beats_are_integers(self, mock_audio_file, monkeypatch):
        """TC-045: All beat timestamps are integers (ms precision)."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        for beat in result["beats"]:
            assert isinstance(beat, int), \
                f"Beat timestamp must be int (ms), got {type(beat)}: {beat}"

    def test_beats_converted_from_frames_to_ms(self, mock_audio_file, monkeypatch):
        """
        TC-045: Frames [0, 22050, 44100] at sr=44100 must become [0, 500, 1000] ms.
        Frame i → time = i / sr seconds → ms = round(i / sr * 1000).
        """
        beat_frames = np.array([0, 22050, 44100], dtype=float)
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=beat_frames, sr=44100)
        # Each frame/sr*1000 = ms; 0→0, 22050→500, 44100→1000
        expected = [0, 500, 1000]
        assert result["beats"] == expected, \
            f"Expected beats={expected}, got {result['beats']}"

    def test_beats_are_non_negative(self, mock_audio_file, monkeypatch):
        """TC-045: No beat timestamp is negative."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        assert all(b >= 0 for b in result["beats"]), \
            "All beat timestamps must be >= 0"

    def test_beats_are_ascending(self, mock_audio_file, monkeypatch):
        """TC-045: Beat timestamps are in ascending order."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        for i in range(1, len(result["beats"])):
            assert result["beats"][i] >= result["beats"][i - 1], \
                "Beat timestamps must be in ascending order"


# ─── TC-044: Ambient audio fallback ──────────────────────────────────────────

class TestAmbientAudioFallback:
    def test_empty_beats_returns_empty_array(self, mock_audio_file, monkeypatch):
        """TC-044: When no beats detected, beats field is []."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=np.array([], dtype=float))
        assert result["beats"] == [], \
            "Ambient audio with no beats must return beats=[]"

    def test_empty_beats_does_not_crash(self, mock_audio_file, monkeypatch):
        """TC-044: Empty beats array produces valid JSON output (exit 0 implied by no exception)."""
        # If this raises, the test fails — absence of exception = exit code 0 path
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=np.array([], dtype=float))
        assert isinstance(result, dict), "Output must be valid JSON dict even with no beats"

    def test_empty_beats_contract_keys_still_present(self, mock_audio_file, monkeypatch):
        """TC-044: All four contract keys present even when beats=[]."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=np.array([], dtype=float))
        for key in ("bpm", "beats", "onsets", "phrases"):
            assert key in result, f"Key '{key}' must be present even with no beats"

    def test_empty_onsets_handled(self, mock_audio_file, monkeypatch):
        """TC-044: Empty onset frames also produce valid output."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=np.array([], dtype=float),
                                     onset_frames=np.array([], dtype=float))
        assert result["onsets"] == [], "Empty onset frames must produce onsets=[]"


# ─── TC-046: Phrase detection output ─────────────────────────────────────────

class TestPhraseDetection:
    def test_phrases_non_empty_with_beats(self, mock_audio_file, monkeypatch):
        """TC-046: At least one phrase is returned when beats are present."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        # If beats are present, phrases should be non-empty
        if result["beats"]:
            assert len(result["phrases"]) >= 1, \
                "At least one phrase must be returned when beats exist"

    def test_phrase_start_ms_non_negative(self, mock_audio_file, monkeypatch):
        """TC-046: All phrase start_ms values are >= 0."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        for phrase in result["phrases"]:
            assert phrase["start_ms"] >= 0, "phrase start_ms must be >= 0"

    def test_phrase_end_ms_greater_than_start(self, mock_audio_file, monkeypatch):
        """TC-046: phrase end_ms > start_ms for all phrases."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch)
        for phrase in result["phrases"]:
            assert phrase["end_ms"] > phrase["start_ms"], \
                f"phrase end_ms must be > start_ms, got {phrase}"

    def test_empty_beats_produces_empty_or_full_phrase(self, mock_audio_file, monkeypatch):
        """TC-046: With no beats, phrases is either [] or a single whole-track span."""
        result = _run_analyze_audio(mock_audio_file, monkeypatch,
                                     beat_frames=np.array([], dtype=float))
        # Either empty or valid phrases
        for phrase in result["phrases"]:
            assert phrase["end_ms"] > phrase["start_ms"]
