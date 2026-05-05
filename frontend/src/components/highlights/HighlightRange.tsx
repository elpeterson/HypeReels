"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { formatDuration } from "@/lib/validation";
import type { Highlight } from "@/types";

interface HighlightRangeProps {
  highlight: Highlight;
  clipDurationMs: number;
  onRemove: (highlightId: string) => void;
}

export function HighlightRange({
  highlight,
  clipDurationMs,
  onRemove,
}: HighlightRangeProps) {
  const startPct = (highlight.start_ms / clipDurationMs) * 100;
  const widthPct =
    ((highlight.end_ms - highlight.start_ms) / clipDurationMs) * 100;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3">
      <div className="flex justify-between items-center mb-2">
        <div className="text-sm font-medium text-gray-200">
          <span className="tabular-nums">{formatDuration(highlight.start_ms)}</span>
          <span className="text-gray-500 mx-2">→</span>
          <span className="tabular-nums">{formatDuration(highlight.end_ms)}</span>
          <span className="text-xs text-gray-500 ml-2">
            ({formatDuration(highlight.end_ms - highlight.start_ms)} long)
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRemove(highlight.highlight_id)}
          aria-label={`Remove highlight from ${formatDuration(highlight.start_ms)} to ${formatDuration(highlight.end_ms)}`}
        >
          Remove
        </Button>
      </div>

      {/* Visual timeline band */}
      <div
        className="relative h-3 bg-gray-800 rounded-full overflow-hidden"
        aria-hidden="true"
      >
        <div
          className="absolute h-full bg-red-500 rounded-full"
          style={{ left: `${startPct}%`, width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Add Highlight Form ───

interface AddHighlightFormProps {
  clipDurationMs: number;
  existingHighlights: Highlight[];
  onAdd: (startMs: number, endMs: number) => void;
  disabled?: boolean;
}

export function AddHighlightForm({
  clipDurationMs,
  existingHighlights,
  onAdd,
  disabled = false,
}: AddHighlightFormProps) {
  const maxSeconds = Math.floor(clipDurationMs / 1000);
  const [startSec, setStartSec] = useState("");
  const [endSec, setEndSec] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setError(null);
    const start = Number(startSec);
    const end = Number(endSec);

    if (isNaN(start) || isNaN(end)) {
      setError("Please enter valid start and end times.");
      return;
    }
    if (start < 0) {
      setError("Start time must be 0 or greater.");
      return;
    }
    if (end <= start) {
      setError("End time must be after start time.");
      return;
    }
    if (end - start < 1) {
      setError("Highlight must be at least 1 second long.");
      return;
    }
    if (end > maxSeconds) {
      setError(`End time cannot exceed clip duration (${formatDuration(clipDurationMs)}).`);
      return;
    }

    const startMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);

    // Check for overlaps
    const hasOverlap = existingHighlights.some(
      (h) => startMs < h.end_ms && endMs > h.start_ms
    );
    if (hasOverlap) {
      setError("This range overlaps with an existing highlight. Adjust the times.");
      return;
    }

    onAdd(startMs, endMs);
    setStartSec("");
    setEndSec("");
  };

  return (
    <div className="bg-gray-900 border border-gray-700 border-dashed rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium text-gray-300">Add highlight range</p>

      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label
            htmlFor="hl-start"
            className="block text-xs text-gray-400 mb-1"
          >
            Start (seconds)
          </label>
          <input
            id="hl-start"
            type="number"
            min={0}
            max={maxSeconds - 1}
            step={1}
            value={startSec}
            onChange={(e) => setStartSec(e.target.value)}
            placeholder="0"
            disabled={disabled}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent disabled:opacity-50"
            aria-describedby={error ? "hl-error" : undefined}
          />
        </div>
        <div className="flex-1">
          <label
            htmlFor="hl-end"
            className="block text-xs text-gray-400 mb-1"
          >
            End (seconds)
          </label>
          <input
            id="hl-end"
            type="number"
            min={1}
            max={maxSeconds}
            step={1}
            value={endSec}
            onChange={(e) => setEndSec(e.target.value)}
            placeholder={String(maxSeconds)}
            disabled={disabled}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent disabled:opacity-50"
          />
        </div>
        <Button
          onClick={handleAdd}
          disabled={disabled || !startSec || !endSec}
          aria-label="Add highlight range"
        >
          Add
        </Button>
      </div>

      {error && (
        <p id="hl-error" className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      <p className="text-xs text-gray-600">
        Clip duration: {formatDuration(clipDurationMs)} ·
        Minimum 1 second
      </p>
    </div>
  );
}
