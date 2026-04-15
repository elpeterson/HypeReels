import { useNavigate } from 'react-router-dom'
import { CheckCircle2, User, Music, Film, Layers, AlertTriangle, Pencil } from 'lucide-react'
import { useSessionStore } from '@/store'
import { ClipCard } from '@/components/ClipCard'
import { WaveformDisplay } from '@/components/WaveformDisplay'
import { EphemeralWarningBanner } from '@/components/EphemeralWarningBanner'
import { formatMs, formatBytes } from '@/lib/utils'

export function ReviewPage() {
  const navigate = useNavigate()

  const {
    clips,
    audio,
    persons,
    selectedPersonRefId,
    highlights,
    setCurrentStep,
  } = useSessionStore()

  const personGroups = useSessionStore((s) => s.personGroups())
  const totalHighlightDurationMs = useSessionStore((s) => s.totalHighlightDurationMs())

  const selectedGroup = personGroups.find((g) => g.personRefId === selectedPersonRefId)
  const validClips = clips.filter((c) => c.status === 'valid')
  const audioDurationMs = audio?.durationMs ?? null
  const totalExceedsSong = audioDurationMs !== null && totalHighlightDurationMs > audioDurationMs

  const issues: string[] = []
  if (validClips.length === 0) issues.push('No valid clips available.')
  if (!audio || audio.status !== 'valid') issues.push('No valid audio track.')
  // NOTE: Intentionally NOT blocking generation when no person is selected.
  // STORY-008/009 both permit generation without a person of interest.

  const canGenerate = issues.length === 0
  // Show an amber advisory (non-blocking) when persons were detected but none selected
  const showNoPersonWarning = persons.length > 0 && !selectedPersonRefId

  const handleBack = () => {
    setCurrentStep('mark-highlights')
    navigate('/highlights')
  }

  const handleGenerate = () => {
    setCurrentStep('generate')
    navigate('/generate')
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Review &amp; Generate</h1>
        <p className="mt-1 text-sm text-gray-500">
          Check everything looks right before generating your HypeReel.
        </p>
      </div>

      <EphemeralWarningBanner />

      {/* Blocking issues list */}
      {issues.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {issues.map((issue) => (
            <p key={issue} className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              {issue}
            </p>
          ))}
        </div>
      )}

      {/* Non-blocking advisory: no person selected */}
      {showNoPersonWarning && (
        <div
          role="note"
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden="true" />
          <p>
            No person of interest selected — the AI will choose the best moments from all detected people.
          </p>
        </div>
      )}

      {/* Clips section */}
      <section aria-labelledby="review-clips-heading">
        <div className="flex items-center gap-2 mb-3">
          <Film className="h-5 w-5 text-brand-500" aria-hidden="true" />
          <h2 id="review-clips-heading" className="text-base font-semibold text-gray-800">
            Video Clips ({validClips.length})
          </h2>
        </div>
        {validClips.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Video clips">
            {validClips.map((clip) => {
              const clipHighlights = highlights.filter((h) => h.clipId === clip.id)
              return (
                <li key={clip.id}>
                  <ClipCard clip={clip} isReadOnly />
                  {clipHighlights.length > 0 && (
                    <p className="mt-1 ml-1 text-xs text-brand-600">
                      {clipHighlights.length} highlight{clipHighlights.length !== 1 ? 's' : ''} defined
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-gray-400 italic">No valid clips.</p>
        )}
      </section>

      {/* Audio section */}
      <section aria-labelledby="review-audio-heading">
        <div className="flex items-center gap-2 mb-3">
          <Music className="h-5 w-5 text-brand-500" aria-hidden="true" />
          <h2 id="review-audio-heading" className="text-base font-semibold text-gray-800">
            Audio Track
          </h2>
        </div>
        {audio ? (
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" />
              <span className="text-sm font-medium text-gray-800 truncate">
                {audio.originalFilename}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              <span>{formatBytes(audio.fileSizeBytes)}</span>
              {audioDurationMs !== null && <span>{formatMs(audioDurationMs)}</span>}
              {audio.bpm !== null && <span>{Math.round(audio.bpm)} BPM</span>}
            </div>
            {audio.envelope && audio.envelope.length > 0 && (
              <WaveformDisplay envelope={audio.envelope} height={40} className="rounded" />
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400 italic">No audio track uploaded.</p>
        )}
      </section>

      {/* Person of interest */}
      <section aria-labelledby="review-person-heading">
        <div className="flex items-center gap-2 mb-3">
          <User className="h-5 w-5 text-brand-500" aria-hidden="true" />
          <h2 id="review-person-heading" className="text-base font-semibold text-gray-800">
            Person of Interest
          </h2>
        </div>
        {selectedGroup ? (
          <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
            <img
              src={selectedGroup.thumbnailUrl}
              alt="Selected person"
              className="h-14 w-14 rounded-full object-cover ring-2 ring-brand-500 ring-offset-1"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <div className="text-sm">
              <p className="font-medium text-gray-800">
                Appears in {selectedGroup.clipIds.length} clip{selectedGroup.clipIds.length !== 1 ? 's' : ''}
              </p>
              <p className="text-xs text-gray-500">
                {selectedGroup.totalAppearances} appearance{selectedGroup.totalAppearances !== 1 ? 's' : ''} detected
              </p>
            </div>
          </div>
        ) : persons.length > 0 ? (
          <p className="text-sm text-amber-700 italic">No person selected — the AI will treat all people equally.</p>
        ) : (
          <p className="text-sm text-gray-400 italic">No people detected in clips.</p>
        )}
      </section>

      {/* Highlights section — always shown when there are valid clips */}
      {validClips.length > 0 && (
        <section aria-labelledby="review-highlights-heading">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-5 w-5 text-brand-500" aria-hidden="true" />
            <h2 id="review-highlights-heading" className="text-base font-semibold text-gray-800">
              Highlights
            </h2>
            {highlights.length > 0 && (
              <span className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                {highlights.length} segment{highlights.length !== 1 ? 's' : ''}
              </span>
            )}
            {highlights.length > 0 && (
              <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-600">
                Total: {formatMs(totalHighlightDurationMs)}
              </span>
            )}
          </div>

          <ul className="flex flex-col gap-2" aria-label="Highlight breakdown by clip">
            {validClips.map((clip) => {
              const clipHighlights = highlights.filter((h) => h.clipId === clip.id)
              return (
                <li
                  key={clip.id}
                  className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-medium text-gray-800" title={clip.originalFilename}>
                      {clip.originalFilename}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentStep('mark-highlights')
                        navigate('/highlights')
                      }}
                      className="flex flex-shrink-0 items-center gap-1 text-xs text-brand-600 underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
                      aria-label={`Edit highlights for ${clip.originalFilename}`}
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                      Edit
                    </button>
                  </div>

                  {clipHighlights.length > 0 ? (
                    <ul className="mt-1.5 flex flex-col gap-1" aria-label={`Highlights for ${clip.originalFilename}`}>
                      {clipHighlights.map((h, i) => (
                        <li key={h.id || i} className="font-mono text-xs text-brand-700">
                          {formatMs(h.startMs, true)} – {formatMs(h.endMs, true)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-gray-400 italic">
                      No highlights — AI will choose
                    </p>
                  )}
                </li>
              )
            })}
          </ul>

          {totalExceedsSong && audioDurationMs !== null && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Highlights exceed song length ({formatMs(audioDurationMs)}) — they will be trimmed to fit.
            </p>
          )}
        </section>
      )}

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
          onClick={handleGenerate}
          disabled={!canGenerate}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Generate HypeReel
        </button>
      </div>
    </div>
  )
}
