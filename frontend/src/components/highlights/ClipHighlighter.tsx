"use client";

import { useState, useCallback } from "react";
import { HighlightRange, AddHighlightForm } from "./HighlightRange";
import { Banner } from "@/components/ui/Banner";
import { saveHighlights, deleteHighlight } from "@/lib/api";
import { formatDuration } from "@/lib/validation";
import type { Clip, Highlight } from "@/types";

interface ClipHighlighterProps {
  clip: Clip;
  sessionId: string;
  audioDurationMs: number | null;
  onHighlightsChanged: (clipId: string, highlights: Highlight[]) => void;
}

export function ClipHighlighter({
  clip,
  sessionId,
  audioDurationMs,
  onHighlightsChanged,
}: ClipHighlighterProps) {
  const [highlights, setHighlights] = useState<Highlight[]>(clip.highlights);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const isTooShort = clip.duration_ms < 1000;

  const totalHighlightMs = highlights.reduce(
    (sum, h) => sum + (h.end_ms - h.start_ms),
    0
  );
  const exceedsAudio =
    audioDurationMs != null && totalHighlightMs > audioDurationMs;

  const handleAddHighlight = useCallback(
    async (startMs: number, endMs: number) => {
      setSaving(true);
      setError(null);

      const newHighlights = [
        ...highlights,
        { start_ms: startMs, end_ms: endMs },
      ];

      try {
        const saved = await saveHighlights(
          sessionId,
          clip.clip_id,
          newHighlights
        );
        setHighlights(saved);
        onHighlightsChanged(clip.clip_id, saved);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to save highlight.";
        setError(msg);
      } finally {
        setSaving(false);
      }
    },
    [highlights, sessionId, clip.clip_id, onHighlightsChanged]
  );

  const handleRemoveHighlight = useCallback(
    async (highlightId: string) => {
      setSaving(true);
      setError(null);

      try {
        await deleteHighlight(sessionId, clip.clip_id, highlightId);
        const updated = highlights.filter((h) => h.highlight_id !== highlightId);
        setHighlights(updated);
        onHighlightsChanged(clip.clip_id, updated);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to remove highlight.";
        setError(msg);
      } finally {
        setSaving(false);
      }
    },
    [highlights, sessionId, clip.clip_id, onHighlightsChanged]
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 text-left focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-inset"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={`clip-${clip.clip_id}-highlights`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* Thumbnail */}
          <div
            className="w-14 h-9 bg-gray-800 rounded overflow-hidden shrink-0"
            aria-hidden="true"
          >
            {clip.thumbnail_url ? (
              <img
                src={clip.thumbnail_url}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600">
                🎬
              </div>
            )}
          </div>
          <div className="min-w-0">
            <p
              className="text-sm font-medium text-gray-200 truncate"
              title={clip.filename}
            >
              {clip.filename}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {formatDuration(clip.duration_ms)}
              {highlights.length > 0 && (
                <span className="ml-2 text-red-400">
                  {highlights.length} highlight{highlights.length !== 1 ? "s" : ""}
                </span>
              )}
            </p>
          </div>
        </div>
        <span
          className={`text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          ▼
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          id={`clip-${clip.clip_id}-highlights`}
          className="px-4 pb-4 space-y-3 border-t border-gray-800 pt-4"
        >
          {isTooShort ? (
            <p className="text-sm text-gray-500 italic">
              Clip too short to mark highlights.
            </p>
          ) : (
            <>
              {exceedsAudio && (
                <Banner variant="warning">
                  Your highlights exceed the audio duration — the reel will
                  include all highlights but may be longer than the song.
                </Banner>
              )}

              {error && (
                <Banner variant="error" onDismiss={() => setError(null)}>
                  {error}
                </Banner>
              )}

              {/* Existing highlights */}
              {highlights.length > 0 && (
                <div className="space-y-2">
                  {highlights.map((h) => (
                    <HighlightRange
                      key={h.highlight_id}
                      highlight={h}
                      clipDurationMs={clip.duration_ms}
                      onRemove={handleRemoveHighlight}
                    />
                  ))}
                </div>
              )}

              {highlights.length === 0 && (
                <p className="text-sm text-gray-500">
                  No highlights marked. The AI will use any portion of this
                  clip at its discretion.
                </p>
              )}

              {/* Add form */}
              <AddHighlightForm
                clipDurationMs={clip.duration_ms}
                existingHighlights={highlights}
                onAdd={handleAddHighlight}
                disabled={saving}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
