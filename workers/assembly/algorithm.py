"""HypeReel Assembly Algorithm — pure function, no I/O.

Entry point:
    build_edl(request: AssemblyRequest) -> EDL

The algorithm is a greedy beat-sync scheduler:

  1.  SCORE all available candidate segments:
        - highlight segments:       score 1.5
        - person-of-interest segs:  score 1.0
        - filler (any clip):        score 0.5

  2.  MAP each beat to a song phrase (intro/verse/chorus/outro) and derive
      a target segment duration budget per phrase.

  3.  LOCK highlights: guarantee every highlight appears in the reel.
      If the total highlight duration already exceeds the song duration,
      trim highlights from the end, preserving each highlight's start.

  4.  GREEDY fill: for each beat window (from the first beat to the last
      beat that fits within the song), pick the highest-scored candidate
      that:
        (a) hasn't been fully consumed yet
        (b) has enough remaining clip footage to fill the current beat window
      Snap each segment's start/end to the nearest beat timestamp.

  5.  CHORUS PRIORITISATION: during chorus beat windows, restrict candidates
      to score >= 1.0 (highlights + POI) if any are available; only fall
      back to filler if no high-score candidates remain.

  6.  GAP FILL: if all high-priority candidates are exhausted before the
      song ends, fill remaining beats with filler segments from any clip,
      cycling through available footage.

  7.  TRUNCATE: if even filler is exhausted, truncate the target_duration_ms
      to the last filled beat boundary (as per spec).

The output is an EDL dataclass (see edl.py).
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass

from assembly.edl import EDL, EDLSegment, SegmentSource


# ── Input types ───────────────────────────────────────────────────────────────

@dataclass
class ClipMeta:
    """Metadata for one uploaded clip."""
    clip_id: str
    clip_r2_key: str
    duration_ms: int


@dataclass
class Highlight:
    """A user-defined highlight segment (locked in, score 1.5)."""
    clip_id: str
    start_ms: int
    end_ms: int


@dataclass
class PersonAppearance:
    """A single appearance window of the selected person in a clip."""
    clip_id: str
    start_ms: int
    end_ms: int


@dataclass
class PhraseInfo:
    """A musical phrase from audio analysis."""
    start_ms: int
    end_ms: int
    type: str   # intro | verse | chorus | outro


@dataclass
class BeatData:
    """Beat/downbeat/phrase data from audio analysis."""
    duration_ms: int            # total song duration
    beats_ms: list[int]         # all beat timestamps in ms
    downbeats_ms: list[int]     # every 4th beat
    phrases: list[PhraseInfo]   # phrase boundaries with type


@dataclass
class AssemblyRequest:
    """All inputs needed for the assembly algorithm (no I/O)."""
    session_id: str
    audio_r2_key: str
    clips: list[ClipMeta]
    highlights: list[Highlight]
    person_appearances: list[PersonAppearance]   # empty list = no POI selected
    beat_data: BeatData


# ── Internal candidate type ───────────────────────────────────────────────────

@dataclass
class _Candidate:
    clip_id: str
    clip_r2_key: str
    clip_duration_ms: int   # total duration of source clip
    seg_start_ms: int       # current consumption pointer within the clip
    seg_end_ms: int         # max end of this candidate's footage window
    score: float
    source: SegmentSource
    is_locked: bool = False  # locked = highlight (must include)

    @property
    def remaining_ms(self) -> int:
        return self.seg_end_ms - self.seg_start_ms


# ── Beat utilities ────────────────────────────────────────────────────────────

def _snap_to_nearest_beat(timestamp_ms: int, beats_ms: list[int]) -> int:
    """Return the beat timestamp in *beats_ms* closest to *timestamp_ms*."""
    if not beats_ms:
        return timestamp_ms
    idx = bisect.bisect_left(beats_ms, timestamp_ms)
    candidates = []
    if idx > 0:
        candidates.append(beats_ms[idx - 1])
    if idx < len(beats_ms):
        candidates.append(beats_ms[idx])
    return min(candidates, key=lambda b: abs(b - timestamp_ms))


def _snap_to_nearest_downbeat(timestamp_ms: int, downbeats_ms: list[int], beats_ms: list[int]) -> int:
    """Snap to downbeat if within 2 beats, otherwise snap to nearest beat."""
    if not downbeats_ms:
        return _snap_to_nearest_beat(timestamp_ms, beats_ms)
    idx = bisect.bisect_left(downbeats_ms, timestamp_ms)
    candidates = []
    if idx > 0:
        candidates.append(downbeats_ms[idx - 1])
    if idx < len(downbeats_ms):
        candidates.append(downbeats_ms[idx])
    closest_downbeat = min(candidates, key=lambda b: abs(b - timestamp_ms))
    # Estimate 2-beat window using average beat interval
    if len(beats_ms) >= 2:
        avg_beat_ms = (beats_ms[-1] - beats_ms[0]) / max(len(beats_ms) - 1, 1)
        two_beat_ms = avg_beat_ms * 2
    else:
        two_beat_ms = 1000
    if abs(closest_downbeat - timestamp_ms) <= two_beat_ms:
        return closest_downbeat
    return _snap_to_nearest_beat(timestamp_ms, beats_ms)


def _phrase_at_ms(phrases: list[PhraseInfo], time_ms: int) -> PhraseInfo | None:
    """Return the phrase active at *time_ms*, or None."""
    for phrase in phrases:
        if phrase.start_ms <= time_ms < phrase.end_ms:
            return phrase
    return None


def _avg_beat_interval_ms(beats_ms: list[int]) -> int:
    """Return average ms between consecutive beats (floor)."""
    if len(beats_ms) < 2:
        return 500  # fallback: 120 BPM
    return max(100, int((beats_ms[-1] - beats_ms[0]) / (len(beats_ms) - 1)))


# ── Candidate construction ────────────────────────────────────────────────────

def _build_candidates(request: AssemblyRequest) -> list[_Candidate]:
    """Build a flat list of all candidates from highlights, POI, and filler."""
    clip_lookup: dict[str, ClipMeta] = {c.clip_id: c for c in request.clips}
    candidates: list[_Candidate] = []

    # Highlights (locked, score 1.5) — one candidate per highlight range
    for hl in request.highlights:
        clip = clip_lookup.get(hl.clip_id)
        if clip is None:
            continue
        candidates.append(_Candidate(
            clip_id=hl.clip_id,
            clip_r2_key=clip.clip_r2_key,
            clip_duration_ms=clip.duration_ms,
            seg_start_ms=hl.start_ms,
            seg_end_ms=hl.end_ms,
            score=1.5,
            source="highlight",
            is_locked=True,
        ))

    # Highlight clip_id+range set for deduplication
    highlight_ranges: set[tuple[str, int, int]] = {
        (hl.clip_id, hl.start_ms, hl.end_ms) for hl in request.highlights
    }

    # Person-of-interest appearances (score 1.0)
    for app in request.person_appearances:
        clip = clip_lookup.get(app.clip_id)
        if clip is None:
            continue
        # Skip if this range is already covered by a highlight
        if (app.clip_id, app.start_ms, app.end_ms) in highlight_ranges:
            continue
        candidates.append(_Candidate(
            clip_id=app.clip_id,
            clip_r2_key=clip.clip_r2_key,
            clip_duration_ms=clip.duration_ms,
            seg_start_ms=app.start_ms,
            seg_end_ms=app.end_ms,
            score=1.0,
            source="person",
        ))

    # Filler: entire clip footage not covered by higher-priority candidates
    covered: dict[str, list[tuple[int, int]]] = {}
    for cand in candidates:
        covered.setdefault(cand.clip_id, []).append((cand.seg_start_ms, cand.seg_end_ms))

    for clip in request.clips:
        clip_covered = sorted(covered.get(clip.clip_id, []))
        # Find uncovered intervals within [0, clip.duration_ms]
        cursor = 0
        for start, end in clip_covered:
            if cursor < start:
                candidates.append(_Candidate(
                    clip_id=clip.clip_id,
                    clip_r2_key=clip.clip_r2_key,
                    clip_duration_ms=clip.duration_ms,
                    seg_start_ms=cursor,
                    seg_end_ms=start,
                    score=0.5,
                    source="filler",
                ))
            cursor = max(cursor, end)
        if cursor < clip.duration_ms:
            candidates.append(_Candidate(
                clip_id=clip.clip_id,
                clip_r2_key=clip.clip_r2_key,
                clip_duration_ms=clip.duration_ms,
                seg_start_ms=cursor,
                seg_end_ms=clip.duration_ms,
                score=0.5,
                source="filler",
            ))

    return candidates


# ── Highlight overflow trimming ───────────────────────────────────────────────

def _trim_highlights_to_fit(
    highlights: list[Highlight],
    song_duration_ms: int,
) -> list[Highlight]:
    """If total highlight duration exceeds song_duration_ms, trim from the end.

    Trims each highlight proportionally, preserving start timestamps.
    """
    total = sum(h.end_ms - h.start_ms for h in highlights)
    if total <= song_duration_ms:
        return highlights

    # Scale factor
    scale = song_duration_ms / total
    trimmed = []
    for hl in highlights:
        orig_dur = hl.end_ms - hl.start_ms
        new_dur = max(500, int(orig_dur * scale))  # minimum 500 ms per highlight
        trimmed.append(Highlight(
            clip_id=hl.clip_id,
            start_ms=hl.start_ms,
            end_ms=hl.start_ms + new_dur,
        ))
    return trimmed


# ── Core greedy scheduler ─────────────────────────────────────────────────────

def build_edl(request: AssemblyRequest) -> EDL:
    """Build a beat-synced EDL from the assembly request.

    This is a pure function: takes data structures in, returns an EDL.
    No filesystem access, no network calls, no database queries.
    """
    bd = request.beat_data
    beats = bd.beats_ms
    song_duration_ms = bd.duration_ms

    # Handle degenerate case: no clips
    if not request.clips:
        return EDL(
            session_id=request.session_id,
            audio_r2_key=request.audio_r2_key,
            target_duration_ms=song_duration_ms,
            segments=[],
        )

    # Handle degenerate case: no beats
    if not beats:
        # Synthesise beats at 120 BPM
        interval = 500  # ms
        beats = list(range(0, song_duration_ms, interval))

    avg_beat_ms = _avg_beat_interval_ms(beats)

    # Trim highlights if they exceed song duration
    effective_highlights = _trim_highlights_to_fit(request.highlights, song_duration_ms)

    # Build effective request with trimmed highlights
    effective_request = AssemblyRequest(
        session_id=request.session_id,
        audio_r2_key=request.audio_r2_key,
        clips=request.clips,
        highlights=effective_highlights,
        person_appearances=request.person_appearances,
        beat_data=request.beat_data,
    )

    candidates = _build_candidates(effective_request)
    if not candidates:
        return EDL(
            session_id=request.session_id,
            audio_r2_key=request.audio_r2_key,
            target_duration_ms=song_duration_ms,
            segments=[],
        )

    # Sort candidates: locked (highlights) first, then by score descending
    candidates.sort(key=lambda c: (not c.is_locked, -c.score))

    # ── Phase 1: Lock in highlights ───────────────────────────────────────────
    # Place all locked candidates first; they define fixed time windows in the
    # reel.  We assign them to beat-snapped windows in song-time order based
    # on their clip score priority.

    locked_candidates = [c for c in candidates if c.is_locked]
    free_candidates = [c for c in candidates if not c.is_locked]

    segments: list[EDLSegment] = []
    song_cursor_ms = 0   # current position in song timeline (ms)

    def _pick_best_free(
        window_ms: int,
        min_score: float = 0.0,
        prefer_chorus: bool = False,
    ) -> _Candidate | None:
        """Pick the best free candidate that has >= window_ms of remaining footage."""
        pool = [
            c for c in free_candidates
            if c.remaining_ms >= window_ms and c.score >= min_score
        ]
        if prefer_chorus:
            high_pool = [c for c in pool if c.score >= 1.0]
            if high_pool:
                pool = high_pool
        if not pool:
            return None
        # Highest score wins; break ties by remaining footage (more is better)
        return max(pool, key=lambda c: (c.score, c.remaining_ms))

    def _consume(candidate: _Candidate, consume_ms: int) -> tuple[int, int]:
        """Advance candidate's consumption pointer; return (used_start, used_end)."""
        used_start = candidate.seg_start_ms
        used_end = candidate.seg_start_ms + consume_ms
        candidate.seg_start_ms = used_end
        return used_start, used_end

    def _snap_end(song_end_ms: int) -> int:
        snapped = _snap_to_nearest_beat(song_end_ms, beats)
        # Never exceed song duration
        return min(snapped, song_duration_ms)

    # ── Iterate over beat windows ─────────────────────────────────────────────
    # We step through the song beat-by-beat, assigning a clip segment per beat
    # window (or multi-beat window depending on energy/phrase).

    beat_idx = 0
    locked_queue = list(locked_candidates)  # consume locked segments in order
    locked_queue_idx = 0

    while song_cursor_ms < song_duration_ms and beat_idx < len(beats):
        beat_start = beats[beat_idx]
        if beat_start < song_cursor_ms:
            beat_idx += 1
            continue

        # Determine window end: snap to next beat (or 2 beats in slow phrases)
        phrase = _phrase_at_ms(request.beat_data.phrases, beat_start)
        phrase_type = phrase.type if phrase else "verse"

        # Number of beats to assign per window
        # intro/outro → 2 beats (slower cuts), verse → 1–2 beats, chorus → 1 beat
        if phrase_type in ("intro", "outro"):
            beats_in_window = 2
        elif phrase_type == "chorus":
            beats_in_window = 1
        else:
            beats_in_window = 1

        next_beat_idx = beat_idx + beats_in_window
        if next_beat_idx < len(beats):
            beat_end = beats[next_beat_idx]
        else:
            beat_end = song_duration_ms

        beat_end = min(beat_end, song_duration_ms)
        window_ms = beat_end - beat_start

        if window_ms <= 0:
            beat_idx += 1
            continue

        # ── Try locked candidate next ─────────────────────────────────────────
        if locked_queue_idx < len(locked_queue):
            locked_cand = locked_queue[locked_queue_idx]
            avail = locked_cand.remaining_ms
            consume_ms = min(avail, window_ms)
            if consume_ms > 0:
                used_start, used_end = _consume(locked_cand, consume_ms)
                # Snap the song-time segment end to the nearest beat
                seg_song_end = _snap_end(beat_start + consume_ms)
                segments.append(EDLSegment(
                    clip_id=locked_cand.clip_id,
                    clip_r2_key=locked_cand.clip_r2_key,
                    start_ms=used_start,
                    end_ms=used_end,
                    beat_aligned=True,
                    source=locked_cand.source,
                    transition="cut",
                ))
                song_cursor_ms = seg_song_end
                if locked_cand.remaining_ms == 0:
                    locked_queue_idx += 1
                beat_idx = bisect.bisect_left(beats, song_cursor_ms)
                continue

        # ── Pick best free candidate ──────────────────────────────────────────
        is_chorus = phrase_type == "chorus"
        best = _pick_best_free(
            window_ms=min(window_ms, avg_beat_ms),  # need at least one beat worth
            min_score=0.0,
            prefer_chorus=is_chorus,
        )

        if best is None:
            # No candidate with enough footage — use whatever is left
            best = next(
                (c for c in free_candidates if c.remaining_ms > 0),
                None,
            )

        if best is None:
            # Truly exhausted — truncate
            break

        consume_ms = min(best.remaining_ms, window_ms)
        used_start, used_end = _consume(best, consume_ms)

        seg_song_end = _snap_end(beat_start + consume_ms)
        segments.append(EDLSegment(
            clip_id=best.clip_id,
            clip_r2_key=best.clip_r2_key,
            start_ms=used_start,
            end_ms=used_end,
            beat_aligned=True,
            source=best.source,
            transition="cut",
        ))
        song_cursor_ms = seg_song_end
        beat_idx = bisect.bisect_left(beats, song_cursor_ms)

        # Remove exhausted candidates from free pool
        free_candidates = [c for c in free_candidates if c.remaining_ms > 0]

    # ── Post-process: merge tiny trailing segments, remove zero-duration ──────
    segments = [s for s in segments if s.duration_ms >= 200]

    # Actual reel duration = last song-cursor position
    actual_duration_ms = song_cursor_ms if song_cursor_ms > 0 else (
        sum(s.duration_ms for s in segments)
    )

    return EDL(
        session_id=request.session_id,
        audio_r2_key=request.audio_r2_key,
        target_duration_ms=min(actual_duration_ms, song_duration_ms),
        segments=segments,
    )
