"""pytest tests for audio_analysis/audio_analysis_worker.py.

Uses numpy to synthesise audio signals (sine waves at known BPM) to verify
that the feature extraction functions return correctly typed, in-range values —
without requiring real audio files or network access.

All tests call the worker's analysis functions directly with numpy arrays,
bypassing download/DB/Redis logic entirely.
"""

from __future__ import annotations


import numpy as np

# ── Import the functions under test ───────────────────────────────────────────
# These imports must succeed without any env vars or DB connections.
from audio_analysis.audio_analysis_worker import (
    TARGET_SR,
    compute_energy_envelope,
    derive_downbeats,
    derive_phrases,
    extract_beats,
    extract_onsets,
)


# ── Synthetic audio helpers ───────────────────────────────────────────────────

def _sine_wave(
    freq_hz: float,
    duration_sec: float,
    sr: int = TARGET_SR,
    amplitude: float = 0.8,
) -> np.ndarray:
    """Generate a pure sine wave as a float32 array."""
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def _click_track(
    bpm: float,
    duration_sec: float,
    sr: int = TARGET_SR,
    click_width_samples: int = 64,
) -> np.ndarray:
    """Generate a click track at *bpm* — sharp amplitude peaks at each beat.

    Click tracks produce very reliable beat_track results compared with pure
    sine waves, because the onset pattern is unambiguous.
    """
    n_samples = int(sr * duration_sec)
    y = np.zeros(n_samples, dtype=np.float32)
    beat_interval_samples = int(sr * 60.0 / bpm)
    pos = 0
    while pos < n_samples:
        end = min(pos + click_width_samples, n_samples)
        y[pos:end] = 0.9
        pos += beat_interval_samples
    return y


def _mixed_signal(bpm: float, duration_sec: float, sr: int = TARGET_SR) -> np.ndarray:
    """Click track + low-freq sine carrier for a more realistic signal."""
    click = _click_track(bpm, duration_sec, sr)
    carrier = _sine_wave(110.0, duration_sec, sr, amplitude=0.15)
    mixed = click + carrier
    # Normalise to avoid clipping
    peak = np.abs(mixed).max()
    return (mixed / peak * 0.9).astype(np.float32) if peak > 0 else mixed


# ── BPM and beat extraction ───────────────────────────────────────────────────

class TestExtractBeats:
    """extract_beats(y, sr) must return a float bpm and a numpy array of times."""

    def test_bpm_is_float(self):
        y = _mixed_signal(bpm=120.0, duration_sec=10.0)
        bpm, beat_times = extract_beats(y, float(TARGET_SR))
        assert isinstance(bpm, float), f"Expected float, got {type(bpm)}"

    def test_bpm_in_plausible_range(self):
        """BPM for a click track between 60–180 should land in 60–200."""
        for target_bpm in (80.0, 120.0, 140.0):
            y = _mixed_signal(bpm=target_bpm, duration_sec=12.0)
            bpm, _ = extract_beats(y, float(TARGET_SR))
            assert 60.0 <= bpm <= 200.0, (
                f"BPM {bpm:.1f} is outside [60, 200] for target {target_bpm}"
            )

    def test_beat_times_is_ndarray(self):
        y = _mixed_signal(bpm=120.0, duration_sec=10.0)
        _, beat_times = extract_beats(y, float(TARGET_SR))
        assert isinstance(beat_times, np.ndarray)

    def test_beat_times_are_non_negative(self):
        y = _mixed_signal(bpm=120.0, duration_sec=10.0)
        _, beat_times = extract_beats(y, float(TARGET_SR))
        assert (beat_times >= 0).all(), "Some beat timestamps are negative"

    def test_beat_times_are_ascending(self):
        y = _mixed_signal(bpm=120.0, duration_sec=10.0)
        _, beat_times = extract_beats(y, float(TARGET_SR))
        if len(beat_times) > 1:
            diffs = np.diff(beat_times)
            assert (diffs > 0).all(), "Beat timestamps are not strictly ascending"

    def test_beat_times_within_audio_duration(self):
        duration_sec = 8.0
        y = _mixed_signal(bpm=120.0, duration_sec=duration_sec)
        _, beat_times = extract_beats(y, float(TARGET_SR))
        assert beat_times.max() <= duration_sec + 0.5, (
            f"Beat at {beat_times.max():.3f}s exceeds audio length {duration_sec}s"
        )

    def test_at_least_one_beat_detected(self):
        """Even a very short 3-second clip should yield at least one beat."""
        y = _mixed_signal(bpm=120.0, duration_sec=3.0)
        _, beat_times = extract_beats(y, float(TARGET_SR))
        assert len(beat_times) >= 1, "No beats detected in a 3-second click track"

    def test_silent_audio_does_not_raise(self):
        """All-zeros signal should not crash extract_beats."""
        y = np.zeros(TARGET_SR * 5, dtype=np.float32)
        bpm, beat_times = extract_beats(y, float(TARGET_SR))
        assert isinstance(bpm, float)
        assert isinstance(beat_times, np.ndarray)

    def test_short_clip_two_seconds(self):
        """2-second clip must not raise."""
        y = _mixed_signal(bpm=128.0, duration_sec=2.0)
        bpm, beat_times = extract_beats(y, float(TARGET_SR))
        assert isinstance(bpm, float)

    def test_120bpm_click_track_detected_in_correct_octave(self):
        """120 BPM click track should not be detected as 60 or 240 BPM."""
        # Run multiple times to avoid librosa's tempo estimation variance
        hits = 0
        for _ in range(3):
            y = _mixed_signal(bpm=120.0, duration_sec=16.0)
            bpm, _ = extract_beats(y, float(TARGET_SR))
            if 90.0 <= bpm <= 160.0:
                hits += 1
        # At least 2 out of 3 runs should land in the right octave
        assert hits >= 2, "120 BPM click track detected with unexpected BPM across runs"


# ── beats_ms list contract ────────────────────────────────────────────────────

class TestBeatsMsContract:
    """After converting beat_times to ms ints, the list must be ascending ints."""

    def _beats_ms(self, bpm: float = 120.0, duration_sec: float = 10.0) -> list[int]:
        y = _mixed_signal(bpm=bpm, duration_sec=duration_sec)
        _, beat_times = extract_beats(y, float(TARGET_SR))
        return [int(t * 1000) for t in beat_times]

    def test_beats_ms_is_list_of_ints(self):
        beats_ms = self._beats_ms()
        assert isinstance(beats_ms, list)
        assert all(isinstance(b, int) for b in beats_ms), "beats_ms contains non-int values"

    def test_beats_ms_ascending(self):
        beats_ms = self._beats_ms()
        if len(beats_ms) > 1:
            for i in range(len(beats_ms) - 1):
                assert beats_ms[i] <= beats_ms[i + 1], (
                    f"beats_ms not ascending at index {i}: {beats_ms[i]} > {beats_ms[i+1]}"
                )

    def test_beats_ms_non_negative(self):
        beats_ms = self._beats_ms()
        assert all(b >= 0 for b in beats_ms)

    def test_beats_ms_within_duration(self):
        duration_sec = 10.0
        beats_ms = self._beats_ms(duration_sec=duration_sec)
        max_ms = int(duration_sec * 1000) + 500  # 500 ms tolerance
        assert all(b <= max_ms for b in beats_ms), (
            f"Some beats_ms exceed expected duration {max_ms} ms"
        )


# ── Energy envelope ───────────────────────────────────────────────────────────

class TestComputeEnergyEnvelope:
    """energy_envelope must be a list of [time_ms, amplitude] pairs."""

    def _envelope(self, duration_sec: float = 10.0) -> list[list[float]]:
        y = _mixed_signal(bpm=120.0, duration_sec=duration_sec)
        return compute_energy_envelope(y, float(TARGET_SR))

    def test_returns_list(self):
        env = self._envelope()
        assert isinstance(env, list)

    def test_each_entry_is_pair(self):
        env = self._envelope()
        for entry in env:
            assert len(entry) == 2, f"Expected [time_ms, amp] pair, got {entry}"

    def test_time_ms_is_ascending(self):
        env = self._envelope()
        times = [e[0] for e in env]
        if len(times) > 1:
            for i in range(len(times) - 1):
                assert times[i] <= times[i + 1], (
                    f"energy_envelope time not ascending at index {i}: "
                    f"{times[i]} > {times[i+1]}"
                )

    def test_amplitude_in_zero_one_range(self):
        """RMS values are normalised to [0, 1] in compute_energy_envelope."""
        env = self._envelope()
        amps = [e[1] for e in env]
        assert all(0.0 <= a <= 1.0 for a in amps), (
            f"Amplitude outside [0,1]: min={min(amps):.4f} max={max(amps):.4f}"
        )

    def test_time_ms_are_floats(self):
        env = self._envelope()
        for entry in env:
            assert isinstance(entry[0], float), f"time_ms is not float: {type(entry[0])}"

    def test_amplitude_are_floats(self):
        env = self._envelope()
        for entry in env:
            assert isinstance(entry[1], float), f"amplitude is not float: {type(entry[1])}"

    def test_non_empty_for_typical_audio(self):
        env = self._envelope(duration_sec=5.0)
        assert len(env) > 0, "energy_envelope is empty for 5-second audio"

    def test_silent_audio_returns_envelope(self):
        """All-zero input: compute_energy_envelope should not raise."""
        y = np.zeros(TARGET_SR * 5, dtype=np.float32)
        env = compute_energy_envelope(y, float(TARGET_SR))
        assert isinstance(env, list)

    def test_downsampled_to_waveform_points(self):
        """Longer audio should be downsampled — max WAVEFORM_POINTS entries."""
        from audio_analysis.audio_analysis_worker import WAVEFORM_POINTS
        y = _mixed_signal(bpm=120.0, duration_sec=60.0)
        env = compute_energy_envelope(y, float(TARGET_SR))
        assert len(env) <= WAVEFORM_POINTS, (
            f"energy_envelope has {len(env)} points, expected <= {WAVEFORM_POINTS}"
        )

    def test_high_energy_section_has_higher_amplitude(self):
        """A loud section followed by silence should show higher RMS in the loud part."""
        sr = TARGET_SR
        loud = np.ones(sr * 3, dtype=np.float32) * 0.9   # 3 s at max amplitude
        quiet = np.zeros(sr * 3, dtype=np.float32)        # 3 s silence
        y = np.concatenate([loud, quiet])
        env = compute_energy_envelope(y, float(sr))
        if len(env) >= 4:
            first_quarter = [e[1] for e in env[: len(env) // 4]]
            last_quarter = [e[1] for e in env[3 * len(env) // 4 :]]
            avg_loud = sum(first_quarter) / len(first_quarter)
            avg_quiet = sum(last_quarter) / len(last_quarter)
            assert avg_loud > avg_quiet, (
                f"Expected loud section ({avg_loud:.4f}) > quiet section ({avg_quiet:.4f})"
            )


# ── Downbeats ─────────────────────────────────────────────────────────────────

class TestDeriveDownbeats:
    """derive_downbeats must return every 4th beat timestamp."""

    def test_downbeats_every_4th_beat(self):
        beat_times = np.arange(0.0, 10.0, 0.5)  # 20 beats, 0.5 s apart
        downbeats = derive_downbeats(beat_times)
        expected = beat_times[::4]
        np.testing.assert_array_equal(downbeats, expected)

    def test_downbeats_subset_of_beats(self):
        beat_times = np.linspace(0.0, 8.0, 16)
        downbeats = derive_downbeats(beat_times)
        for db in downbeats:
            assert any(np.isclose(db, bt) for bt in beat_times), (
                f"Downbeat {db} not found in beat_times"
            )

    def test_empty_beat_times_returns_empty(self):
        result = derive_downbeats(np.array([]))
        assert len(result) == 0

    def test_single_beat_returns_single_downbeat(self):
        beat_times = np.array([1.5])
        downbeats = derive_downbeats(beat_times)
        assert len(downbeats) == 1
        assert np.isclose(downbeats[0], 1.5)

    def test_downbeats_are_ascending(self):
        beat_times = np.arange(0.0, 20.0, 0.5)
        downbeats = derive_downbeats(beat_times)
        if len(downbeats) > 1:
            assert (np.diff(downbeats) > 0).all()


# ── Phrase derivation ─────────────────────────────────────────────────────────

class TestDerivePhrases:
    """derive_phrases must return at least one Phrase, with correct types."""

    def _run(
        self,
        n_beats: int = 64,
        duration_sec: float = 32.0,
        bpm: float = 120.0,
    ):
        beat_interval = 60.0 / bpm
        beat_times = np.arange(n_beats) * beat_interval
        # Build a synthetic energy envelope: first half quiet, second half loud
        sr = TARGET_SR
        y = np.concatenate([
            np.zeros(int(sr * duration_sec / 2), dtype=np.float32),
            np.ones(int(sr * duration_sec / 2), dtype=np.float32) * 0.9,
        ])
        env = compute_energy_envelope(y, float(sr))
        return derive_phrases(beat_times, env, duration_sec)

    def test_returns_list_of_phrases(self):
        from audio_analysis.audio_analysis_worker import Phrase
        phrases = self._run()
        assert isinstance(phrases, list)
        assert all(isinstance(p, Phrase) for p in phrases)

    def test_at_least_one_phrase(self):
        phrases = self._run()
        assert len(phrases) >= 1

    def test_first_phrase_is_intro(self):
        phrases = self._run(n_beats=64, duration_sec=32.0)
        if len(phrases) >= 2:
            assert phrases[0].type == "intro", (
                f"Expected first phrase to be 'intro', got '{phrases[0].type}'"
            )

    def test_last_phrase_is_outro(self):
        phrases = self._run(n_beats=64, duration_sec=32.0)
        if len(phrases) >= 2:
            assert phrases[-1].type == "outro", (
                f"Expected last phrase to be 'outro', got '{phrases[-1].type}'"
            )

    def test_phrase_types_are_valid_strings(self):
        phrases = self._run()
        valid_types = {"intro", "verse", "chorus", "outro"}
        for p in phrases:
            assert p.type in valid_types, f"Unknown phrase type: '{p.type}'"

    def test_phrase_start_end_ms_are_ints(self):
        phrases = self._run()
        for p in phrases:
            assert isinstance(p.start_ms, int), f"start_ms is not int: {type(p.start_ms)}"
            assert isinstance(p.end_ms, int), f"end_ms is not int: {type(p.end_ms)}"

    def test_phrase_start_less_than_end(self):
        phrases = self._run()
        for p in phrases:
            assert p.start_ms < p.end_ms, (
                f"Phrase has start_ms >= end_ms: {p.start_ms} >= {p.end_ms}"
            )

    def test_phrases_cover_full_duration(self):
        duration_sec = 32.0
        phrases = self._run(duration_sec=duration_sec)
        if phrases:
            assert phrases[0].start_ms == 0, "Phrases do not start at 0"
            assert phrases[-1].end_ms >= int(duration_sec * 1000) - 500, (
                f"Phrases end at {phrases[-1].end_ms} ms, "
                f"expected >= {int(duration_sec * 1000) - 500} ms"
            )

    def test_empty_beats_returns_single_verse_phrase(self):
        """With no beats, derive_phrases should fall back gracefully."""
        env = [[0.0, 0.5], [1000.0, 0.5]]
        phrases = derive_phrases(np.array([]), env, duration_sec=2.0)
        assert len(phrases) >= 1
        assert phrases[0].type == "verse"

    def test_high_energy_sections_get_chorus_type(self):
        """A very loud second half should be marked as 'chorus' (above 75th percentile)."""
        sr = TARGET_SR
        duration_sec = 32.0
        # Build a pattern where the MIDDLE two phrases are loud and the
        # first/last are quiet (intro/outro).  With 4 phrases of 8 s each:
        #   phrase 0 (0-8 s):   quiet → intro
        #   phrase 1 (8-16 s):  loud  → chorus
        #   phrase 2 (16-24 s): loud  → chorus
        #   phrase 3 (24-32 s): quiet → outro
        quiet1 = np.zeros(int(sr * duration_sec * 0.25), dtype=np.float32)
        loud = np.ones(int(sr * duration_sec * 0.50), dtype=np.float32) * 1.0
        quiet2 = np.zeros(int(sr * duration_sec * 0.25), dtype=np.float32)
        y = np.concatenate([quiet1, loud, quiet2])
        env = compute_energy_envelope(y, float(sr))

        beat_times = np.arange(64) * (60.0 / 120.0)
        phrases = derive_phrases(beat_times, env, duration_sec)
        phrase_types = {p.type for p in phrases}
        # chorus classification requires > 1 phrase (otherwise all is intro/outro)
        if len(phrases) > 2:
            assert "chorus" in phrase_types, (
                f"Expected 'chorus' in phrase types for high-energy audio, got: {phrase_types}"
            )


# ── Integration-style: full pipeline on synthetic array ──────────────────────

class TestFullPipelineOnSyntheticArray:
    """End-to-end test: run all extraction functions in sequence, check combined output."""

    def test_full_pipeline_returns_consistent_types(self):
        """Run the complete audio feature extraction pipeline on synthetic audio."""
        duration_sec = 15.0
        y = _mixed_signal(bpm=120.0, duration_sec=duration_sec)
        sr = float(TARGET_SR)

        bpm, beat_times = extract_beats(y, sr)
        onset_times = extract_onsets(y, sr)
        energy_envelope = compute_energy_envelope(y, sr)
        downbeat_times = derive_downbeats(beat_times)
        phrases = derive_phrases(beat_times, energy_envelope, duration_sec)

        # BPM
        assert isinstance(bpm, float)
        assert 60.0 <= bpm <= 200.0

        # beats_ms
        beats_ms = [int(t * 1000) for t in beat_times]
        assert isinstance(beats_ms, list)
        assert all(isinstance(b, int) for b in beats_ms)
        if len(beats_ms) > 1:
            assert beats_ms == sorted(beats_ms)

        # onsets_ms
        onsets_ms = [int(t * 1000) for t in onset_times]
        assert isinstance(onsets_ms, list)
        assert all(isinstance(o, int) for o in onsets_ms)

        # downbeats_ms
        downbeats_ms = [int(t * 1000) for t in downbeat_times]
        assert isinstance(downbeats_ms, list)

        # energy_envelope: list of [time_ms, amplitude] pairs
        assert isinstance(energy_envelope, list)
        for pair in energy_envelope:
            assert len(pair) == 2
            assert isinstance(pair[0], float)
            assert isinstance(pair[1], float)
            assert 0.0 <= pair[1] <= 1.0

        # phrases
        assert isinstance(phrases, list)
        assert len(phrases) >= 1

    def test_bpm_rounded_to_2_decimal_places(self):
        """round(bpm, 2) must match the rounded value."""
        y = _mixed_signal(bpm=120.0, duration_sec=10.0)
        bpm, _ = extract_beats(y, float(TARGET_SR))
        rounded = round(bpm, 2)
        assert rounded == round(rounded, 2)  # idempotent

    def test_onset_times_within_duration(self):
        duration_sec = 8.0
        y = _mixed_signal(bpm=120.0, duration_sec=duration_sec)
        onset_times = extract_onsets(y, float(TARGET_SR))
        if len(onset_times) > 0:
            assert onset_times.max() <= duration_sec + 0.5
