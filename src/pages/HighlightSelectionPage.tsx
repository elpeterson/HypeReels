import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp, AlertTriangle, Loader2 } from 'lucide-react'
import { useSessionStore } from '@/store'
import { putHighlights } from '@/api/clips'
import { ApiError } from '@/api/client'
import { VideoScrubber } from '@/components/VideoScrubber'
import { ClipCard } from '@/components/ClipCard'
import { cn, formatMs } from '@/lib/utils'

export function HighlightSelectionPage() {
  const navigate = useNavigate()

  const {
    sessionId,
    clips,
    audio,
    highlights,
    setClipHighlights,
    setCurrentStep,
  } = useSessionStore()

  const highlightsForClip = useSessionStore((s) => s.highlightsForClip)
  const totalHighlightDurationMs = useSessionStore((s) => s.totalHighlightDurationMs())

  const [expandedClipId, setExpandedClipId] = useState<string | null>(null)
  const [savingClipId, setSavingClipId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const validClips = clips.filter((c) => c.status === 'valid' && c.durationMs !== null)

  const audioDurationMs = audio?.durationMs ?? null
  const totalExceedsSong =
    audioDurationMs !== null && totalHighlightDurationMs > audioDurationMs

  const handleHighlightsChange = async (
    clipId: string,
    newRanges: Array<{ startMs: number; endMs: number }>
  ) => {
    if (!sessionId) return
    setSavingClipId(clipId)
    setSaveError(null)
    try {
      const saved = await putHighlights(
        sessionId,
        clipId,
        newRanges.map((r) => ({ start_ms: r.startMs, end_ms: r.endMs }))
      )
      setClipHighlights(clipId, saved)
    } catch (err: unknown) {
      const message =
        err instanceof ApiError ? err.message : 'Failed to save highlights'
      setSaveError(message)
    } finally {
      setSavingClipId(null)
    }
  }

  const toggleExpand = (clipId: string) => {
    setExpandedClipId((prev) => (prev === clipId ? null : clipId))
  }

  const handleBack = () => {
    setCurrentStep('detect-persons')
    navigate('/person-selection')
  }

  const handleContinue = () => {
    setCurrentStep('review')
    navigate('/review')
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Mark Highlights</h1>
        <p className="mt-1 text-sm text-gray-500">
          Optionally mark time ranges in each clip that must appear in your reel.
          Unmarked portions are handled by the AI.
        </p>
      </div>

      {/* Duration warning */}
      {totalExceedsSong && audioDurationMs !== null && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden="true" />
          <p>
            Your total highlight duration ({formatMs(totalHighlightDurationMs)}) exceeds the
            song length ({formatMs(audioDurationMs)}). Highlights will be trimmed to fit.
          </p>
        </div>
      )}

      {/* Save error */}
      {saveError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {saveError}
        </div>
      )}

      {/* Empty state */}
      {validClips.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 py-12 text-center text-sm text-gray-400">
          No valid clips available. Go back and check your uploads.
        </div>
      )}

      {/* Clip list with expandable scrubbers */}
      <div className="flex flex-col gap-3">
        {validClips.map((clip) => {
          const clipHighlights = highlightsForClip(clip.id)
          const isExpanded = expandedClipId === clip.id
          const isSaving = savingClipId === clip.id

          return (
            <div
              key={clip.id}
              className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
            >
              {/* Header row */}
              <button
                type="button"
                onClick={() => toggleExpand(clip.id)}
                aria-expanded={isExpanded}
                aria-controls={`scrubber-${clip.id}`}
                className="flex w-full items-center gap-3 p-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
              >
                <div className="flex-1 min-w-0">
                  <ClipCard clip={clip} isReadOnly />
                </div>
                <div className="flex flex-shrink-0 items-center gap-2 text-xs text-gray-500">
                  {isSaving && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" aria-hidden="true" />
                  )}
                  {clipHighlights.length > 0 && (
                    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                      {clipHighlights.length} highlight{clipHighlights.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-gray-400" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-gray-400" aria-hidden="true" />
                  )}
                </div>
              </button>

              {/* Scrubber panel */}
              {isExpanded && clip.durationMs !== null && (
                <div
                  id={`scrubber-${clip.id}`}
                  className={cn(
                    'border-t border-gray-100 p-4',
                    isSaving && 'pointer-events-none opacity-70'
                  )}
                >
                  <VideoScrubber
                    clipId={clip.id}
                    durationMs={clip.durationMs}
                    highlights={clipHighlights}
                    onHighlightsChange={(ranges) => handleHighlightsChange(clip.id, ranges)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <button
          type="button"
          onClick={handleBack}
          className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={!!savingClipId}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Continue to Review
        </button>
      </div>
    </div>
  )
}
