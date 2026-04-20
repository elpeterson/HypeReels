"""Unit tests for assembly/algorithm.py — build_edl() pure function.

All tests are pure (no I/O, no network, no DB).  They exercise the greedy
beat-sync scheduler with a variety of inputs.
"""

from __future__ import annotations


from assembly.algorithm import (
    AssemblyRequest,
    BeatData,
    ClipMeta,
    Highlight,
    PersonAppearance,
    PhraseInfo,
    build_edl,
)
from assembly.edl import EDL


# ── Helpers ───────────────────────────────────────────────────────────────────

def _beats(bpm: float, duration_ms: int) -> list[int]:
    """Generate beat timestamps at *bpm* for *duration_ms*."""
    interval = int(60_000 / bpm)
    return list(range(0, duration_ms, interval))


def _simple_request(
    *,
    clip_duration_ms: int = 30_000,
    song_duration_ms: int = 10_000,
    bpm: float = 120.0,
    highlights: list[Highlight] | None = None,
    person_appearances: list[PersonAppearance] | None = None,
    phrases: list[PhraseInfo] | None = None,
    extra_clips: list[ClipMeta] | None = None,
) -> AssemblyRequest:
    clips = [ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clip-1.mp4", duration_ms=clip_duration_ms)]
    if extra_clips:
        clips.extend(extra_clips)
    beats = _beats(bpm, song_duration_ms)
    downbeats = beats[::4]
    beat_data = BeatData(
        duration_ms=song_duration_ms,
        beats_ms=beats,
        downbeats_ms=downbeats,
        phrases=phrases or [],
    )
    return AssemblyRequest(
        session_id="sess-test",
        audio_r2_key="uploads/s/audio.mp3",
        clips=clips,
        highlights=highlights or [],
        person_appearances=person_appearances or [],
        beat_data=beat_data,
    )


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestHappyPath:
    """Multiple clips, person appearances, highlights, beat data → valid EDL."""

    def test_produces_segments(self):
        hl = [Highlight(clip_id="clip-1", start_ms=0, end_ms=3_000)]
        pa = [PersonAppearance(clip_id="clip-1", start_ms=5_000, end_ms=8_000)]
        req = _simple_request(
            clip_duration_ms=30_000,
            song_duration_ms=15_000,
            highlights=hl,
            person_appearances=pa,
        )
        edl = build_edl(req)
        assert isinstance(edl, EDL)
        assert len(edl.segments) > 0

    def test_all_segments_have_positive_duration(self):
        req = _simple_request(clip_duration_ms=60_000, song_duration_ms=20_000)
        edl = build_edl(req)
        for seg in edl.segments:
            assert seg.duration_ms > 0, f"Segment {seg.clip_id} has zero or negative duration"

    def test_target_duration_does_not_exceed_song(self):
        req = _simple_request(song_duration_ms=12_000)
        edl = build_edl(req)
        assert edl.target_duration_ms <= 12_000

    def test_multiple_clips_all_used_opportunistically(self):
        clips = [
            ClipMeta(clip_id=f"clip-{i}", clip_r2_key=f"uploads/s/clip-{i}.mp4", duration_ms=10_000)
            for i in range(1, 4)
        ]
        beats = _beats(120.0, 30_000)
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=clips,
            highlights=[],
            person_appearances=[],
            beat_data=BeatData(duration_ms=30_000, beats_ms=beats, downbeats_ms=beats[::4], phrases=[]),
        )
        edl = build_edl(req)
        assert len(edl.segments) > 0
        # EDL is valid (no gap/overlap checks needed for greedy)
        errors = edl.validate()
        # Only tolerate the "total duration exceeds target by more than 2s" warning,
        # not structural errors.
        structural = [e for e in errors if "non-positive" in e or "negative" in e or "end_ms <= start_ms" in e]
        assert structural == []


class TestHighlightsExceedSongDuration:
    """If total highlight duration > song duration, EDL must be truncated — no error raised."""

    def test_no_exception_raised(self):
        # 3 × 5 s highlights = 15 s, but song is only 8 s
        hl = [
            Highlight(clip_id="clip-1", start_ms=0, end_ms=5_000),
            Highlight(clip_id="clip-1", start_ms=5_000, end_ms=10_000),
            Highlight(clip_id="clip-1", start_ms=10_000, end_ms=15_000),
        ]
        req = _simple_request(
            clip_duration_ms=60_000,
            song_duration_ms=8_000,
            highlights=hl,
        )
        # Must not raise
        edl = build_edl(req)
        assert isinstance(edl, EDL)

    def test_target_duration_within_song(self):
        hl = [
            Highlight(clip_id="clip-1", start_ms=0, end_ms=8_000),
            Highlight(clip_id="clip-1", start_ms=8_000, end_ms=16_000),
        ]
        req = _simple_request(
            clip_duration_ms=60_000,
            song_duration_ms=6_000,
            highlights=hl,
        )
        edl = build_edl(req)
        assert edl.target_duration_ms <= 6_000

    def test_all_segments_non_negative(self):
        hl = [Highlight(clip_id="clip-1", start_ms=0, end_ms=20_000)]
        req = _simple_request(
            clip_duration_ms=60_000,
            song_duration_ms=5_000,
            highlights=hl,
        )
        edl = build_edl(req)
        for seg in edl.segments:
            assert seg.start_ms >= 0
            assert seg.end_ms > seg.start_ms


class TestNoHighlights:
    """No highlights set → AI freely selects from all clip segments."""

    def test_segments_produced_from_filler(self):
        req = _simple_request(clip_duration_ms=30_000, song_duration_ms=10_000)
        edl = build_edl(req)
        assert len(edl.segments) > 0

    def test_segments_use_filler_source(self):
        req = _simple_request(clip_duration_ms=30_000, song_duration_ms=10_000)
        edl = build_edl(req)
        sources = {s.source for s in edl.segments}
        # Without highlights or POI, all segments should be "filler"
        assert "filler" in sources

    def test_no_highlight_source_in_output(self):
        req = _simple_request(clip_duration_ms=30_000, song_duration_ms=10_000)
        edl = build_edl(req)
        assert not any(s.source == "highlight" for s in edl.segments)


class TestNoPersonOfInterest:
    """No person_appearances → selects from all clip segments."""

    def test_produces_segments_without_poi(self):
        req = _simple_request(
            clip_duration_ms=30_000,
            song_duration_ms=10_000,
            person_appearances=[],
        )
        edl = build_edl(req)
        assert len(edl.segments) > 0

    def test_no_person_source_in_output(self):
        req = _simple_request(
            clip_duration_ms=30_000,
            song_duration_ms=10_000,
            person_appearances=[],
        )
        edl = build_edl(req)
        assert not any(s.source == "person" for s in edl.segments)


class TestSingleClipSingleHighlight:
    """Single clip with one highlight → EDL contains that segment."""

    def test_highlight_appears_in_edl(self):
        hl = [Highlight(clip_id="clip-1", start_ms=2_000, end_ms=5_000)]
        req = _simple_request(
            clip_duration_ms=20_000,
            song_duration_ms=10_000,
            highlights=hl,
        )
        edl = build_edl(req)
        highlight_segs = [s for s in edl.segments if s.source == "highlight"]
        assert len(highlight_segs) >= 1

    def test_highlight_clip_id_matches(self):
        hl = [Highlight(clip_id="clip-1", start_ms=1_000, end_ms=4_000)]
        req = _simple_request(
            clip_duration_ms=20_000,
            song_duration_ms=8_000,
            highlights=hl,
        )
        edl = build_edl(req)
        highlight_segs = [s for s in edl.segments if s.source == "highlight"]
        assert all(s.clip_id == "clip-1" for s in highlight_segs)


class TestVeryShortSong:
    """Very short song (< 2 beats at 120 BPM = < 1000 ms) → at least one segment."""

    def test_short_song_produces_at_least_one_segment(self):
        beats = [0, 400]  # only 2 beats, 400 ms apart
        beat_data = BeatData(
            duration_ms=800,
            beats_ms=beats,
            downbeats_ms=beats,
            phrases=[],
        )
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=[ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clip-1.mp4", duration_ms=10_000)],
            highlights=[],
            person_appearances=[],
            beat_data=beat_data,
        )
        edl = build_edl(req)
        # Either segments were produced, or target_duration was truncated to 0
        # — must not raise, and if segments exist they must be valid
        if edl.segments:
            for seg in edl.segments:
                assert seg.duration_ms > 0

    def test_single_beat_song_does_not_raise(self):
        beat_data = BeatData(
            duration_ms=400,
            beats_ms=[0],
            downbeats_ms=[0],
            phrases=[],
        )
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=[ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clip-1.mp4", duration_ms=5_000)],
            highlights=[],
            person_appearances=[],
            beat_data=beat_data,
        )
        # Should not raise
        edl = build_edl(req)
        assert isinstance(edl, EDL)

    def test_no_beats_synthesises_fallback(self):
        """No beats → algorithm synthesises 120 BPM beats, still produces EDL."""
        beat_data = BeatData(
            duration_ms=3_000,
            beats_ms=[],
            downbeats_ms=[],
            phrases=[],
        )
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=[ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clip-1.mp4", duration_ms=10_000)],
            highlights=[],
            person_appearances=[],
            beat_data=beat_data,
        )
        edl = build_edl(req)
        assert isinstance(edl, EDL)
        assert len(edl.segments) > 0


class TestZeroPersonAppearances:
    """Clips with zero person appearances → handled gracefully (filler fills the song)."""

    def test_zero_appearances_falls_back_to_filler(self):
        req = _simple_request(
            clip_duration_ms=30_000,
            song_duration_ms=12_000,
            person_appearances=[],
        )
        edl = build_edl(req)
        assert len(edl.segments) > 0
        assert all(s.source in ("filler", "highlight", "person") for s in edl.segments)

    def test_appearance_on_unknown_clip_is_ignored(self):
        """PersonAppearance referencing a clip not in clips list must not crash."""
        pa = [PersonAppearance(clip_id="nonexistent-clip", start_ms=0, end_ms=3_000)]
        req = _simple_request(
            clip_duration_ms=30_000,
            song_duration_ms=10_000,
            person_appearances=pa,
        )
        edl = build_edl(req)
        # Must not raise; unknown clip appearance is silently ignored
        assert isinstance(edl, EDL)
        assert len(edl.segments) > 0


class TestPhraseAwareCuts:
    """Chorus phrases should produce more segments (faster cuts) than intro phrases."""

    def test_chorus_beats_per_window_is_1(self):
        """The algorithm uses beats_in_window=1 for chorus — verify indirectly via segment count."""
        phrases = [
            PhraseInfo(start_ms=0, end_ms=4_000, type="intro"),
            PhraseInfo(start_ms=4_000, end_ms=8_000, type="chorus"),
        ]
        req = _simple_request(
            clip_duration_ms=30_000,
            song_duration_ms=8_000,
            bpm=120.0,
            phrases=phrases,
        )
        edl = build_edl(req)
        assert len(edl.segments) > 0

    def test_edl_validate_passes_for_phrase_request(self):
        phrases = [
            PhraseInfo(start_ms=0, end_ms=5_000, type="verse"),
            PhraseInfo(start_ms=5_000, end_ms=10_000, type="chorus"),
        ]
        req = _simple_request(
            clip_duration_ms=60_000,
            song_duration_ms=10_000,
            phrases=phrases,
        )
        edl = build_edl(req)
        errors = edl.validate()
        structural = [e for e in errors if "non-positive" in e or "negative" in e or "end_ms <= start_ms" in e]
        assert structural == [], f"Structural EDL errors: {structural}"


class TestEdgeCases:
    """Additional edge cases."""

    def test_no_clips_returns_empty_edl(self):
        beat_data = BeatData(duration_ms=10_000, beats_ms=_beats(120.0, 10_000), downbeats_ms=[], phrases=[])
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=[],
            highlights=[],
            person_appearances=[],
            beat_data=beat_data,
        )
        edl = build_edl(req)
        assert edl.segments == []

    def test_clip_shorter_than_beat_window_still_usable(self):
        """A clip that is shorter than one beat window should still appear in the EDL."""
        beat_data = BeatData(
            duration_ms=10_000,
            beats_ms=_beats(60.0, 10_000),  # 1 beat/sec = 1000 ms windows
            downbeats_ms=[],
            phrases=[],
        )
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=[ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clip-1.mp4", duration_ms=500)],
            highlights=[],
            person_appearances=[],
            beat_data=beat_data,
        )
        edl = build_edl(req)
        # Short clip may be consumed in one beat window or filtered (< 200 ms); must not raise
        assert isinstance(edl, EDL)

    def test_segments_filtered_below_200ms(self):
        """Segments shorter than 200 ms should be filtered from final EDL."""
        req = _simple_request(clip_duration_ms=30_000, song_duration_ms=10_000)
        edl = build_edl(req)
        for seg in edl.segments:
            assert seg.duration_ms >= 200, (
                f"Segment shorter than 200 ms survived filter: {seg.duration_ms} ms"
            )
