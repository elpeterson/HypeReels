import { useState, useRef, useCallback, useId } from 'react'
import { Plus, Trash2, AlertCircle } from 'lucide-react'
import { cn, formatMs, parseTimestamp, clamp, mergeHighlightRanges } from '@/lib/utils'
import type { Highlight } from '@/types'

const MIN_HIGHLIGHT_MS = 1000

interface PendingRange {
  startMs: number
  endMs: number
}

interface VideoScrubberProps {
  clipId: string
  durationMs: number
  highlights: Highlight[]
  onHighlightsChange: (highlights: Array<{ startMs: number; endMs: number }>) => void
  isReadOnly?: boolean
}

export function VideoScrubber({
  clipId,
  durationMs,
  highlights,
  onHighlightsChange,
  isReadOnly = false,
}: VideoScrubberProps) {
  const [pendingStart, setPendingStart] = useState<number>(0)
  const [pendingEnd, setPendingEnd] = useState<number>(Math.min(durationMs, 5000))
  const [mergeNotice, setMergeNotice] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [startInput, setStartInput] = useState('')
  const [endInput, setEndInput] = useState('')
  const trackRef = useRef<HTMLDivElement>(null)
  const startId = useId()
  const endId = useId()

  const pct = useCallback(
    (ms: number) => (ms / durationMs) * 100,
    [durationMs]
  )

  const msFromPct = useCallback(
    (p: number) => Math.round((p / 100) * durationMs),
    [durationMs]
  )

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isReadOnly || !trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const p = ((e.clientX - rect.left) / rect.width) * 100
      const ms = clamp(msFromPct(p), 0, durationMs)
      // Set start handle if clicking in the first half of the pending range
      const mid = (pendingStart + pendingEnd) / 2
      if (ms < mid) {
        setPendingStart(ms)
        setStartInput('')
      } else {
        setPendingEnd(ms)
        setEndInput('')
      }
    },
    [isReadOnly, msFromPct, durationMs, pendingStart, pendingEnd]
  )

  const addHighlight = () => {
    setValidationError(null)
    setMergeNotice(false)

    if (pendingEnd - pendingStart < MIN_HIGHLIGHT_MS) {
      setValidationError('Highlight must be at least 1 second long.')
      return
    }

    const clampedEnd = Math.min(pendingEnd, durationMs)
    if (clampedEnd !== pendingEnd) {
      setValidationError(
        `End time clamped to clip duration (${formatMs(durationMs)}).`
      )
    }

    const newRange = { startMs: pendingStart, endMs: clampedEnd }
    const existing = highlights.map((h) => ({
      startMs: h.startMs,
      endMs: h.endMs,
    }))
    const merged = mergeHighlightRanges([...existing, newRange])

    if (merged.length < existing.length + 1) {
      setMergeNotice(true)
    }

    onHighlightsChange(merged)
  }

  const removeHighlight = (index: number) => {
    const updated = highlights.filter((_, i) => i !== index)
    onHighlightsChange(updated.map((h) => ({ startMs: h.startMs, endMs: h.endMs })))
  }

  const handleStartInput = (value: string) => {
    setStartInput(value)
    const ms = parseTimestamp(value)
    if (!isNaN(ms)) {
      setPendingStart(clamp(ms, 0, durationMs))
    }
  }

  const handleEndInput = (value: string) => {
    setEndInput(value)
    const ms = parseTimestamp(value)
    if (!isNaN(ms)) {
      setPendingEnd(clamp(ms, 0, durationMs))
    }
  }

  return (
    <div className="flex flex-col gap-4" aria-label="Highlight scrubber">
      {/* Timeline track */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-gray-500">
          <span>0:00</span>
          <span>{formatMs(durationMs)}</span>
        </div>

        {/* Main track */}
        <div
          ref={trackRef}
          role="presentation"
          onClick={handleTrackClick}
          className={cn(
            'relative h-10 rounded-lg bg-gray-100 cursor-crosshair select-none overflow-hidden',
            isReadOnly && 'cursor-default'
          )}
        >
          {/* Existing highlights */}
          {highlights.map((h, i) => (
            <div
              key={h.id || i}
              className="absolute top-0 h-full bg-brand-400 opacity-60"
              style={{
                left: `${pct(h.startMs)}%`,
                width: `${pct(h.endMs - h.startMs)}%`,
              }}
              aria-label={`Highlight ${i + 1}: ${formatMs(h.startMs, true)} to ${formatMs(h.endMs, true)}`}
            />
          ))}

          {/* Pending range */}
          {!isReadOnly && (
            <div
              className="absolute top-0 h-full bg-brand-600 opacity-30 border-x-2 border-brand-600"
              style={{
                left: `${pct(pendingStart)}%`,
                width: `${pct(pendingEnd - pendingStart)}%`,
              }}
              aria-hidden="true"
            />
          )}

          {/* Pending start handle */}
          {!isReadOnly && (
            <div
              className="absolute top-0 h-full w-1 bg-brand-600 cursor-ew-resize"
              style={{ left: `${pct(pendingStart)}%` }}
              role="slider"
              aria-label="Highlight start"
              aria-valuemin={0}
              aria-valuemax={durationMs}
              aria-valuenow={pendingStart}
              tabIndex={0}
              onKeyDown={(e) => {
                const step = 1000
                if (e.key === 'ArrowLeft') setPendingStart((v) => clamp(v - step, 0, pendingEnd - MIN_HIGHLIGHT_MS))
                if (e.key === 'ArrowRight') setPendingStart((v) => clamp(v + step, 0, pendingEnd - MIN_HIGHLIGHT_MS))
              }}
            />
          )}

          {/* Pending end handle */}
          {!isReadOnly && (
            <div
              className="absolute top-0 h-full w-1 bg-brand-600 cursor-ew-resize"
              style={{ left: `${pct(pendingEnd)}%` }}
              role="slider"
              aria-label="Highlight end"
              aria-valuemin={0}
              aria-valuemax={durationMs}
              aria-valuenow={pendingEnd}
              tabIndex={0}
              onKeyDown={(e) => {
                const step = 1000
                if (e.key === 'ArrowLeft') setPendingEnd((v) => clamp(v - step, pendingStart + MIN_HIGHLIGHT_MS, durationMs))
                if (e.key === 'ArrowRight') setPendingEnd((v) => clamp(v + step, pendingStart + MIN_HIGHLIGHT_MS, durationMs))
              }}
            />
          )}
        </div>

        {/* Range inputs */}
        {!isReadOnly && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label htmlFor={startId} className="text-xs text-gray-500 whitespace-nowrap">
                Start
              </label>
              <input
                id={startId}
                type="text"
                placeholder={formatMs(pendingStart, true)}
                value={startInput || formatMs(pendingStart, true)}
                onChange={(e) => handleStartInput(e.target.value)}
                onFocus={() => setStartInput(formatMs(pendingStart, true))}
                className="w-28 rounded border border-gray-300 px-2 py-1 text-xs font-mono focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <span className="text-gray-400 text-xs">→</span>
            <div className="flex items-center gap-2">
              <label htmlFor={endId} className="text-xs text-gray-500 whitespace-nowrap">
                End
              </label>
              <input
                id={endId}
                type="text"
                placeholder={formatMs(pendingEnd, true)}
                value={endInput || formatMs(pendingEnd, true)}
                onChange={(e) => handleEndInput(e.target.value)}
                onFocus={() => setEndInput(formatMs(pendingEnd, true))}
                className="w-28 rounded border border-gray-300 px-2 py-1 text-xs font-mono focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>

            <button
              type="button"
              onClick={addHighlight}
              className="flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              aria-label="Add highlight range"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          </div>
        )}
      </div>

      {/* Validation messages */}
      {validationError && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          {validationError}
        </p>
      )}
      {mergeNotice && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-amber-600">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          Overlapping highlights have been merged.
        </p>
      )}

      {/* Highlight list */}
      {highlights.length > 0 && (
        <ul className="space-y-1.5" aria-label="Defined highlights">
          {highlights.map((h, i) => (
            <li
              key={h.id || i}
              className="flex items-center justify-between rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-xs"
            >
              <span className="font-mono text-brand-800">
                {formatMs(h.startMs, true)}&nbsp;→&nbsp;{formatMs(h.endMs, true)}
              </span>
              {!isReadOnly && (
                <button
                  type="button"
                  onClick={() => removeHighlight(i)}
                  className="ml-2 rounded p-1 text-brand-400 hover:bg-brand-100 hover:text-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
                  aria-label={`Remove highlight ${i + 1}: ${formatMs(h.startMs, true)} to ${formatMs(h.endMs, true)}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {highlights.length === 0 && (
        <p className="text-xs text-gray-400 italic">
          No highlights defined — the AI will choose the best moments from this clip.
        </p>
      )}
    </div>
  )
}
