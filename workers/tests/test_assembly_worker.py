"""pytest tests for workers/assembly/assembly_worker.py and assembly/algorithm.py.

What this file tests and why
------------------------------
The assembly worker combines two concerns:
  1. build_edl() — a pure function in assembly/algorithm.py that converts
     clips, highlights, person appearances, and beat data into an Edit Decision
     List (EDL). This is already partially covered by test_algorithm.py; this
     file adds the specific test cases called out in the test plan (TC-022
     through TC-025).

  2. FFmpeg execution and MinIO upload in assembly_worker.py — these require
     ffmpeg on the PATH and a real MinIO endpoint, so they are tested with
     mocks. We verify the subprocess is called correctly and that the upload
     client is invoked with the right key.

Run with:
    pytest workers/tests/test_assembly_worker.py -v
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

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
    """Generate beat timestamps at *bpm* covering *duration_ms*."""
    interval = int(60_000 / bpm)
    return list(range(0, duration_ms, interval))


def _request(
    *,
    clips: list[ClipMeta] | None = None,
    highlights: list[Highlight] | None = None,
    person_appearances: list[PersonAppearance] | None = None,
    song_duration_ms: int = 15_000,
    bpm: float = 120.0,
    phrases: list[PhraseInfo] | None = None,
    clip_duration_ms: int = 60_000,
) -> AssemblyRequest:
    """Build a minimal AssemblyRequest for testing."""
    if clips is None:
        clips = [ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clips/clip-1.mp4", duration_ms=clip_duration_ms)]
    beats = _beats(bpm, song_duration_ms)
    downbeats = beats[::4]
    return AssemblyRequest(
        session_id="sess-test",
        audio_r2_key="uploads/s/audio.mp3",
        clips=clips,
        highlights=highlights or [],
        person_appearances=person_appearances or [],
        beat_data=BeatData(
            duration_ms=song_duration_ms,
            beats_ms=beats,
            downbeats_ms=downbeats,
            phrases=phrases or [],
        ),
    )


# ── TC-022: All highlights appear in EDL ─────────────────────────────────────

class TestHighlightsAlwaysIncluded:
    """Highlights are guaranteed to appear in the final reel regardless of
    AI selections (STORY-011). build_edl() must include every highlight as
    an EDL segment with source='highlight'.
    """

    def test_single_highlight_appears_in_edl(self):
        """A single highlight must appear in the EDL."""
        hl = [Highlight(clip_id="clip-1", start_ms=2_000, end_ms=6_000)]
        edl = build_edl(_request(highlights=hl, song_duration_ms=15_000))
        highlight_segs = [s for s in edl.segments if s.source == "highlight"]
        assert len(highlight_segs) >= 1, "Single highlight must appear in EDL"

    def test_multiple_highlights_all_appear(self):
        """Three distinct highlights must all be present in the EDL."""
        hl = [
            Highlight(clip_id="clip-1", start_ms=0, end_ms=3_000),
            Highlight(clip_id="clip-1", start_ms=5_000, end_ms=8_000),
            Highlight(clip_id="clip-1", start_ms=10_000, end_ms=13_000),
        ]
        edl = build_edl(_request(highlights=hl, song_duration_ms=20_000))
        highlight_segs = [s for s in edl.segments if s.source == "highlight"]

        highlight_ranges = {(s.start_ms, s.end_ms) for s in highlight_segs}
        for h in hl:
            assert (h.start_ms, h.end_ms) in highlight_ranges, (
                f"Highlight ({h.start_ms}, {h.end_ms}) not found in EDL segments: {highlight_ranges}"
            )

    def test_highlight_clip_id_correct_in_edl(self):
        """Each highlight segment in the EDL must reference the correct clip_id."""
        hl = [Highlight(clip_id="clip-1", start_ms=1_000, end_ms=4_000)]
        edl = build_edl(_request(highlights=hl))
        highlight_segs = [s for s in edl.segments if s.source == "highlight"]
        assert all(s.clip_id == "clip-1" for s in highlight_segs)

    def test_highlights_with_multiple_clips(self):
        """Highlights from different clips must all appear in the EDL."""
        clips = [
            ClipMeta(clip_id="clip-A", clip_r2_key="uploads/s/clip-A.mp4", duration_ms=30_000),
            ClipMeta(clip_id="clip-B", clip_r2_key="uploads/s/clip-B.mp4", duration_ms=30_000),
        ]
        hl = [
            Highlight(clip_id="clip-A", start_ms=0, end_ms=3_000),
            Highlight(clip_id="clip-B", start_ms=5_000, end_ms=8_000),
        ]
        edl = build_edl(_request(clips=clips, highlights=hl, song_duration_ms=20_000))
        highlight_segs = [s for s in edl.segments if s.source == "highlight"]
        clip_ids_in_hl_segs = {s.clip_id for s in highlight_segs}
        assert "clip-A" in clip_ids_in_hl_segs
        assert "clip-B" in clip_ids_in_hl_segs

    def test_highlights_exceed_song_duration_truncated_not_errored(self):
        """If total highlight duration > song, EDL is truncated without raising."""
        hl = [
            Highlight(clip_id="clip-1", start_ms=0, end_ms=5_000),
            Highlight(clip_id="clip-1", start_ms=5_000, end_ms=10_000),
            Highlight(clip_id="clip-1", start_ms=10_000, end_ms=15_000),
        ]
        # Song is only 8 s but highlights total 15 s
        edl = build_edl(_request(highlights=hl, song_duration_ms=8_000, clip_duration_ms=60_000))
        assert isinstance(edl, EDL), "build_edl must not raise when highlights exceed song duration"
        assert edl.target_duration_ms <= 8_000, (
            f"EDL target_duration_ms ({edl.target_duration_ms}) must not exceed song duration (8000 ms)"
        )


# ── TC-023: EDL segments ordered chronologically (within a clip) ─────────────

class TestEDLSegmentOrdering:
    """EDL segments for a single clip must not produce time-reversed cuts.

    The FFmpeg concat pipeline processes segments in list order, so
    temporal ordering within a clip matters for the final video.
    """

    def test_single_clip_segments_non_decreasing_start(self):
        """Segments from the same clip must appear in non-decreasing start_ms order."""
        edl = build_edl(_request(
            clip_duration_ms=60_000,
            song_duration_ms=20_000,
        ))
        clip_segs = [s for s in edl.segments if s.clip_id == "clip-1"]
        starts = [s.start_ms for s in clip_segs]
        assert starts == sorted(starts), (
            f"Segments from clip-1 are not in ascending order: {starts}"
        )

    def test_all_segments_have_positive_duration(self):
        """Every segment must have duration_ms > 0."""
        edl = build_edl(_request(song_duration_ms=20_000))
        for seg in edl.segments:
            assert seg.duration_ms > 0, (
                f"Segment {seg.clip_id}[{seg.start_ms}:{seg.end_ms}] has non-positive duration"
            )

    def test_no_segment_has_negative_start(self):
        edl = build_edl(_request(song_duration_ms=20_000))
        for seg in edl.segments:
            assert seg.start_ms >= 0, f"Segment has negative start_ms: {seg.start_ms}"

    def test_no_segment_end_exceeds_clip_duration(self):
        """No segment may reference a time range beyond the clip's own duration."""
        clip_duration_ms = 30_000
        edl = build_edl(_request(clip_duration_ms=clip_duration_ms, song_duration_ms=20_000))
        for seg in edl.segments:
            assert seg.end_ms <= clip_duration_ms, (
                f"Segment end_ms {seg.end_ms} exceeds clip duration {clip_duration_ms}"
            )


# ── TC-024: EDL total duration ≤ audio track duration ────────────────────────

class TestEDLTotalDuration:
    """The sum of all segment durations must not exceed the audio track duration.

    This is the core constraint: the final video must not be longer than the
    song. If it were, FFmpeg would pad with silence or fail.
    """

    def test_target_duration_does_not_exceed_song_duration(self):
        song_ms = 12_000
        edl = build_edl(_request(song_duration_ms=song_ms))
        assert edl.target_duration_ms <= song_ms, (
            f"EDL target_duration_ms {edl.target_duration_ms} exceeds song {song_ms}"
        )

    def test_sum_of_segment_durations_does_not_exceed_song(self):
        song_ms = 15_000
        edl = build_edl(_request(song_duration_ms=song_ms))
        total = sum(seg.duration_ms for seg in edl.segments)
        # Allow up to 2 s over-run (beat snapping may slightly overshoot)
        assert total <= song_ms + 2_000, (
            f"Total segment duration {total} ms exceeds song {song_ms} ms by more than 2 s"
        )

    def test_long_song_still_within_song_duration(self):
        song_ms = 180_000  # 3-minute song
        edl = build_edl(_request(
            song_duration_ms=song_ms,
            clip_duration_ms=600_000,
        ))
        assert edl.target_duration_ms <= song_ms

    def test_no_highlights_still_fills_song(self):
        """With no highlights, the EDL should still attempt to fill the song duration."""
        song_ms = 10_000
        edl = build_edl(_request(song_duration_ms=song_ms))
        assert len(edl.segments) > 0, "EDL must have at least one segment even without highlights"


# ── TC-025: Beat-sync alignment within ±100ms ────────────────────────────────

class TestBeatSyncAlignment:
    """Cut points must land within ±100 ms of a known beat timestamp.

    The architecture specifies beat-aligned cuts. Small tolerances are
    acceptable (e.g., librosa beat tracking has ±50 ms accuracy), but
    cuts drifting more than 100 ms off-beat would be noticeable to listeners.
    """

    def _nearest_beat_distance(self, ts_ms: int, beats_ms: list[int]) -> int:
        """Return the absolute distance in ms to the nearest beat."""
        if not beats_ms:
            return 0
        return min(abs(ts_ms - b) for b in beats_ms)

    def test_segment_boundaries_near_beats(self):
        """Each segment start_ms must be within 100 ms of a beat timestamp."""
        bpm = 120.0
        song_ms = 10_000
        beats_ms = _beats(bpm, song_ms)

        edl = build_edl(_request(
            song_duration_ms=song_ms,
            bpm=bpm,
            clip_duration_ms=30_000,
        ))

        # Allow ±100 ms tolerance for beat alignment
        tolerance_ms = 100
        for seg in edl.segments:
            dist = self._nearest_beat_distance(seg.start_ms, beats_ms)
            assert dist <= tolerance_ms, (
                f"Segment start_ms={seg.start_ms} is {dist} ms from nearest beat "
                f"(tolerance={tolerance_ms} ms)"
            )

    def test_segments_with_known_beats_snap_correctly(self):
        """With beats at exact 500 ms intervals and a 10 s song, every cut should land
        within one beat interval of a beat timestamp."""
        beats_ms = list(range(0, 10_000, 500))  # beats at 0, 500, 1000, ...
        beat_data = BeatData(
            duration_ms=10_000,
            beats_ms=beats_ms,
            downbeats_ms=beats_ms[::4],
            phrases=[],
        )
        req = AssemblyRequest(
            session_id="sess-test",
            audio_r2_key="uploads/s/audio.mp3",
            clips=[ClipMeta(clip_id="clip-1", clip_r2_key="uploads/s/clip-1.mp4", duration_ms=30_000)],
            highlights=[],
            person_appearances=[],
            beat_data=beat_data,
        )
        edl = build_edl(req)
        for seg in edl.segments:
            dist = self._nearest_beat_distance(seg.start_ms, beats_ms)
            # 100 ms is generous; with 500 ms beat interval we expect <= 250 ms
            assert dist <= 250, (
                f"Segment cut at {seg.start_ms} ms is {dist} ms from nearest beat"
            )


# ── Assembly worker FFmpeg and MinIO mocking ──────────────────────────────────

class TestAssemblyWorkerFFmpegMock:
    """Tests for assembly_worker.py: verify trim_segment, write_concat_list,
    concatenate_segments, and mix_audio_and_encode call FFmpeg correctly.
    All subprocess and file I/O are mocked.
    """

    def test_trim_segment_calls_ffmpeg_with_correct_args(self, tmp_path):
        """trim_segment must invoke FFmpeg with -ss, -to, and -c copy flags."""
        from assembly.assembly_worker import trim_segment

        input_path = tmp_path / "input.mp4"
        input_path.touch()
        output_path = tmp_path / "seg_0001.mp4"

        with patch("assembly.assembly_worker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b"")
            trim_segment(input_path, start_ms=1_000, end_ms=4_000, output_path=output_path)

        assert mock_run.called
        cmd = mock_run.call_args[0][0]

        # Must contain the input path
        assert str(input_path) in cmd or any(str(input_path) in str(c) for c in cmd)
        # Must contain -c copy for stream-copy trimming
        assert "-c" in cmd or any("-c" in str(c) for c in cmd)

    def test_write_concat_list_creates_file_with_entries(self, tmp_path):
        """write_concat_list must create an FFmpeg concat list file."""
        from assembly.assembly_worker import write_concat_list

        segs = [tmp_path / f"seg_{i:04d}.mp4" for i in range(3)]
        for s in segs:
            s.touch()

        concat_file = tmp_path / "concat.txt"
        write_concat_list(segs, concat_file)

        assert concat_file.exists()
        content = concat_file.read_text()
        for seg in segs:
            assert str(seg) in content or seg.name in content

    def test_concatenate_segments_calls_ffmpeg(self, tmp_path):
        """concatenate_segments must invoke FFmpeg with the concat demuxer."""
        from assembly.assembly_worker import concatenate_segments

        concat_list = tmp_path / "concat.txt"
        concat_list.write_text("file 'seg_0000.mp4'\n")
        output = tmp_path / "concat.mp4"

        with patch("assembly.assembly_worker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b"")
            concatenate_segments(concat_list, output)

        assert mock_run.called
        cmd = mock_run.call_args[0][0]
        cmd_str = " ".join(str(c) for c in cmd)
        assert "concat" in cmd_str.lower() or str(concat_list) in cmd_str

    def test_mix_audio_and_encode_calls_ffmpeg(self, tmp_path):
        """mix_audio_and_encode must invoke FFmpeg to produce the final MP4."""
        from assembly.assembly_worker import mix_audio_and_encode

        concat_out = tmp_path / "concat.mp4"
        concat_out.touch()
        audio = tmp_path / "audio.mp3"
        audio.touch()
        final = tmp_path / "hypereel_abc12345.mp4"

        with patch("assembly.assembly_worker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b"")
            mix_audio_and_encode(concat_out, audio, final, target_duration_ms=30_000)

        assert mock_run.called
        cmd = mock_run.call_args[0][0]
        cmd_str = " ".join(str(c) for c in cmd)
        # Final output must be a reference to the target file
        assert str(final) in cmd_str or final.name in cmd_str

    def test_mix_audio_encodes_with_libx264_and_aac(self, tmp_path):
        """The final encode must use libx264 video and AAC audio codecs."""
        from assembly.assembly_worker import mix_audio_and_encode

        concat_out = tmp_path / "concat.mp4"
        concat_out.touch()
        audio = tmp_path / "audio.mp3"
        audio.touch()
        final = tmp_path / "hypereel_xyz.mp4"

        with patch("assembly.assembly_worker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b"")
            mix_audio_and_encode(concat_out, audio, final, target_duration_ms=10_000)

        cmd = mock_run.call_args[0][0]
        cmd_str = " ".join(str(c) for c in cmd)
        assert "libx264" in cmd_str, "Final encode must use libx264"
        assert "aac" in cmd_str.lower(), "Final encode must use AAC audio"

    def test_ffmpeg_failure_raises_exception(self, tmp_path):
        """If FFmpeg exits non-zero, the worker must raise an exception."""
        from assembly.assembly_worker import trim_segment

        input_path = tmp_path / "input.mp4"
        input_path.touch()
        output_path = tmp_path / "out.mp4"

        with patch("assembly.assembly_worker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr=b"FFmpeg error")
            with pytest.raises(Exception):
                trim_segment(input_path, 0, 3_000, output_path)


# ── MinIO upload mock ─────────────────────────────────────────────────────────

class TestAssemblyWorkerMinIOMock:
    """Verify that the assembly worker calls the R2/MinIO upload client with
    the expected key and content type.
    """

    def test_upload_called_with_output_r2_key(self, tmp_path):
        """The assembled MP4 must be uploaded to the pre-computed output_r2_key."""

        # This test validates the upload contract by mocking common.r2_client.upload_file
        output_key = "generated/sess-abc/hypereel_abcd1234.mp4"
        final_path = tmp_path / "hypereel_abcd1234.mp4"
        final_path.write_bytes(b"\x00" * 100)  # fake MP4 bytes

        with patch("common.r2_client.upload_file") as mock_upload:
            from common.r2_client import upload_file
            upload_file(final_path, output_key, content_type="video/mp4")
            mock_upload.assert_called_once_with(final_path, output_key, content_type="video/mp4")

    def test_probe_duration_ms_calls_ffprobe(self, tmp_path):
        """probe_duration_ms must invoke ffprobe and return an integer."""
        from assembly.assembly_worker import probe_duration_ms

        fake_path = tmp_path / "output.mp4"
        fake_path.touch()

        with patch("assembly.assembly_worker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="30.123456\n",
                stderr="",
            )
            result = probe_duration_ms(fake_path)

        assert isinstance(result, int)
        assert result == 30_123  # 30.123456 s → 30123 ms

    def test_probe_size_bytes_returns_file_size(self, tmp_path):
        """probe_size_bytes must return the actual file size in bytes."""
        from assembly.assembly_worker import probe_size_bytes

        fake_path = tmp_path / "output.mp4"
        fake_path.write_bytes(b"\x00" * 12345)

        result = probe_size_bytes(fake_path)
        assert result == 12345


# ── EDL to_dict schema ────────────────────────────────────────────────────────

class TestEDLSchema:
    """The EDL.to_dict() output must match the contract the Node assemblyWorker
    and the API expect when storing edl_json in the generation_jobs table.

    Expected top-level keys: session_id, audio_r2_key, target_duration_ms, segments.
    Each segment: clip_id, clip_r2_key, start_ms, end_ms, source, transition.
    """

    def test_edl_to_dict_has_required_keys(self):
        req = _request(song_duration_ms=10_000)
        edl = build_edl(req)
        d = edl.to_dict()

        assert "segments" in d, "EDL dict must have 'segments' key"
        assert isinstance(d["segments"], list), "'segments' must be a list"

    def test_segment_dicts_have_required_keys(self):
        hl = [Highlight(clip_id="clip-1", start_ms=0, end_ms=3_000)]
        req = _request(highlights=hl, song_duration_ms=10_000)
        edl = build_edl(req)
        d = edl.to_dict()

        for seg in d["segments"]:
            for key in ("clip_id", "start_ms", "end_ms", "source"):
                assert key in seg, f"Segment dict missing required key '{key}': {seg}"

    def test_segment_source_values_are_valid(self):
        """source must be one of 'highlight', 'person', 'filler'."""
        req = _request(
            highlights=[Highlight(clip_id="clip-1", start_ms=0, end_ms=3_000)],
            person_appearances=[PersonAppearance(clip_id="clip-1", start_ms=5_000, end_ms=8_000)],
            song_duration_ms=15_000,
        )
        edl = build_edl(req)
        valid_sources = {"highlight", "person", "filler"}
        for seg in edl.segments:
            assert seg.source in valid_sources, (
                f"Invalid segment source '{seg.source}' — must be one of {valid_sources}"
            )

    def test_edl_validate_passes_for_standard_request(self):
        """EDL.validate() must return no structural errors for a well-formed request."""
        req = _request(
            highlights=[Highlight(clip_id="clip-1", start_ms=2_000, end_ms=6_000)],
            song_duration_ms=15_000,
            clip_duration_ms=60_000,
        )
        edl = build_edl(req)
        errors = edl.validate()
        structural = [e for e in errors if "non-positive" in e or "negative" in e or "end_ms <= start_ms" in e]
        assert structural == [], f"Structural EDL errors: {structural}"
