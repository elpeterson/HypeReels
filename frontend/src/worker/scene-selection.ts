/**
 * Scene selection algorithm for reel generation.
 *
 * Strategy:
 * 1. Prioritize highlight segments (guaranteed in output).
 * 2. Prioritize moments featuring the person of interest.
 * 3. Fill remaining beats with arbitrary clip content.
 *
 * Output: EDL (Edit Decision List)
 */

import type { Clip, Person } from "../types";
import type { AudioAnalysis, DetectedPerson } from "./python";
import type { EdlEntry } from "./ffmpeg";

export interface SceneSelectionInput {
  clips: Clip[];
  persons: DetectedPerson[];
  selectedPersonId: string | null;
  analysis: AudioAnalysis;
}

/**
 * Build an EDL from session clips, audio analysis, and person appearances.
 *
 * The EDL is a list of clip segments aligned to beat boundaries.
 * Each segment duration is approximately one phrase or 4-beat chunk.
 */
export function buildEdl(input: SceneSelectionInput): EdlEntry[] {
  const { clips, persons, selectedPersonId, analysis } = input;

  const readyClips = clips.filter((c) => c.status === "ready" && c.clip_id);
  if (readyClips.length === 0) {
    throw new Error("No ready clips available for reel generation");
  }

  const beats = analysis.beats;
  const phrases = analysis.phrases;

  if (beats.length === 0) {
    // No beats detected — use fixed 2-second intervals
    console.log("[scene-selection] No beats detected — using fixed 2s intervals");
    return buildFixedIntervalEdl(readyClips, analysis);
  }

  const edl: EdlEntry[] = [];

  // ── Step 1: Collect highlight segments ────────────────────────────────────
  const highlightSegments: Array<{ clip: Clip; start_ms: number; end_ms: number }> = [];
  for (const clip of readyClips) {
    for (const h of clip.highlights) {
      highlightSegments.push({ clip, start_ms: h.start_ms, end_ms: h.end_ms });
    }
  }

  // ── Step 2: Collect person-of-interest appearances ─────────────────────────
  const personAppearances: Array<{ clip_id: string; timestamp_ms: number }> = [];
  if (selectedPersonId) {
    const selectedPerson = persons.find((p) => p.person_id === selectedPersonId);
    if (selectedPerson) {
      personAppearances.push(...selectedPerson.appearances);
    }
  }

  // ── Step 3: Assign phrase slots ────────────────────────────────────────────
  // Each phrase maps to one or more EDL entries. We fill phrase slots in order:
  // highlights first, then person appearances, then fill from all clips.
  const phraseCount = phrases.length > 0 ? phrases.length : Math.ceil(beats.length / 4);
  const effectivePhrases =
    phrases.length > 0
      ? phrases
      : Array.from({ length: phraseCount }, (_, i) => ({
          start_ms: beats[i * 4] ?? 0,
          end_ms: beats[(i + 1) * 4] ?? beats[beats.length - 1] ?? 8000,
        }));

  let clipCursor = 0;

  for (let pi = 0; pi < effectivePhrases.length; pi++) {
    const phrase = effectivePhrases[pi];
    const phraseDurationMs = phrase.end_ms - phrase.start_ms;

    // Try to find a highlight segment to fill this phrase
    const highlight = highlightSegments.find((h) => {
      const dur = h.end_ms - h.start_ms;
      return dur >= phraseDurationMs * 0.5; // At least half the phrase duration
    });

    if (highlight) {
      const idx = highlightSegments.indexOf(highlight);
      highlightSegments.splice(idx, 1); // Consume it

      edl.push({
        clip_id: highlight.clip.clip_id,
        start_ms: highlight.start_ms,
        end_ms: Math.min(
          highlight.start_ms + phraseDurationMs,
          highlight.end_ms
        ),
        transition: "cut",
      });
      continue;
    }

    // Try person-of-interest appearance
    if (personAppearances.length > 0) {
      const appearance = personAppearances.shift()!;
      const clip = readyClips.find((c) => c.clip_id === appearance.clip_id);
      if (clip && clip.duration_ms > 0) {
        const start = Math.max(0, appearance.timestamp_ms - 500);
        const end = Math.min(clip.duration_ms, start + phraseDurationMs);
        if (end - start >= 500) {
          edl.push({
            clip_id: clip.clip_id,
            start_ms: start,
            end_ms: end,
            transition: "cut",
          });
          continue;
        }
      }
    }

    // Fall back: round-robin through ready clips
    const clip = readyClips[clipCursor % readyClips.length];
    clipCursor++;

    if (clip.duration_ms > 0) {
      // Pick a segment offset cycling through the clip
      const segOffset = Math.floor(
        ((clipCursor - 1) / readyClips.length) * clip.duration_ms
      );
      const startMs = segOffset % Math.max(1, clip.duration_ms - phraseDurationMs);
      const endMs = Math.min(clip.duration_ms, startMs + phraseDurationMs);

      edl.push({
        clip_id: clip.clip_id,
        start_ms: startMs,
        end_ms: endMs,
        transition: "cut",
      });
    } else {
      // Duration unknown — use clip start
      edl.push({
        clip_id: clip.clip_id,
        start_ms: 0,
        end_ms: phraseDurationMs,
        transition: "cut",
      });
    }
  }

  // Ensure minimum 4 beats / 4 EDL entries
  if (edl.length < 4 && readyClips.length > 0) {
    const clip = readyClips[0];
    while (edl.length < 4) {
      edl.push({
        clip_id: clip.clip_id,
        start_ms: 0,
        end_ms: Math.min(clip.duration_ms || 2000, 2000),
        transition: "cut",
      });
    }
  }

  return edl;
}

function buildFixedIntervalEdl(clips: Clip[], analysis: AudioAnalysis): EdlEntry[] {
  const intervalMs = 2000;
  const totalMs =
    analysis.beats.length > 0
      ? analysis.beats[analysis.beats.length - 1]
      : 30000; // 30 seconds default

  const edl: EdlEntry[] = [];
  let elapsed = 0;
  let clipIdx = 0;

  while (elapsed < totalMs) {
    const clip = clips[clipIdx % clips.length];
    const start = 0;
    const end = Math.min(clip.duration_ms || intervalMs, intervalMs);

    edl.push({
      clip_id: clip.clip_id,
      start_ms: start,
      end_ms: end,
      transition: "cut",
    });

    elapsed += end - start;
    clipIdx++;
  }

  return edl;
}
