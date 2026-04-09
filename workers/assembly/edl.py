"""Edit Decision List (EDL) data classes and validation.

The EDL is the contract between the Assembly Algorithm and the FFmpeg render
step.  It is also persisted to generation_jobs.edl_json in PostgreSQL.

Schema (mirrors architecture.md EDL JSON Schema):

{
  "session_id": "uuid",
  "audio_r2_key": "uploads/{session_id}/audio.mp3",
  "target_duration_ms": 214000,
  "segments": [
    {
      "clip_id": "uuid",
      "clip_r2_key": "uploads/{session_id}/{clip_id}.mp4",
      "start_ms": 12300,
      "end_ms": 16100,
      "beat_aligned": true,
      "source": "highlight | person | filler",
      "transition": "cut"
    }
  ]
}
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Literal


# ── Allowed literal types ─────────────────────────────────────────────────────

SegmentSource = Literal["highlight", "person", "filler"]
TransitionType = Literal["cut", "dissolve_200ms"]


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class EDLSegment:
    clip_id: str
    clip_r2_key: str
    start_ms: int
    end_ms: int
    beat_aligned: bool
    source: SegmentSource
    transition: TransitionType = "cut"

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class EDL:
    session_id: str
    audio_r2_key: str
    target_duration_ms: int
    segments: list[EDLSegment] = field(default_factory=list)

    # ── Derived properties ────────────────────────────────────────────────────

    @property
    def total_duration_ms(self) -> int:
        return sum(s.duration_ms for s in self.segments)

    @property
    def segment_count(self) -> int:
        return len(self.segments)

    # ── Serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "audio_r2_key": self.audio_r2_key,
            "target_duration_ms": self.target_duration_ms,
            "segments": [s.to_dict() for s in self.segments],
        }

    def to_json(self, indent: int | None = None) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: dict) -> "EDL":
        segments = [
            EDLSegment(
                clip_id=s["clip_id"],
                clip_r2_key=s["clip_r2_key"],
                start_ms=s["start_ms"],
                end_ms=s["end_ms"],
                beat_aligned=s.get("beat_aligned", False),
                source=s.get("source", "filler"),
                transition=s.get("transition", "cut"),
            )
            for s in data.get("segments", [])
        ]
        return cls(
            session_id=data["session_id"],
            audio_r2_key=data["audio_r2_key"],
            target_duration_ms=data["target_duration_ms"],
            segments=segments,
        )

    # ── Validation ────────────────────────────────────────────────────────────

    def validate(self) -> list[str]:
        """Return a list of validation error strings (empty = valid)."""
        errors: list[str] = []

        if not self.segments:
            errors.append("EDL has no segments")
            return errors

        for i, seg in enumerate(self.segments):
            if seg.duration_ms <= 0:
                errors.append(f"Segment {i} ({seg.clip_id}) has non-positive duration: {seg.duration_ms} ms")
            if seg.start_ms < 0:
                errors.append(f"Segment {i} ({seg.clip_id}) has negative start_ms: {seg.start_ms}")
            if seg.end_ms <= seg.start_ms:
                errors.append(f"Segment {i} ({seg.clip_id}) end_ms <= start_ms")
            if seg.source not in ("highlight", "person", "filler"):
                errors.append(f"Segment {i} has unknown source: {seg.source!r}")
            if seg.transition not in ("cut", "dissolve_200ms"):
                errors.append(f"Segment {i} has unknown transition: {seg.transition!r}")

        if self.total_duration_ms > self.target_duration_ms + 2000:  # 2 s tolerance
            errors.append(
                f"EDL total duration {self.total_duration_ms} ms exceeds target "
                f"{self.target_duration_ms} ms by more than 2 s"
            )

        return errors

    def is_valid(self) -> bool:
        return len(self.validate()) == 0
