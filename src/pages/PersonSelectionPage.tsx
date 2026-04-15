import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, AlertCircle, Users } from 'lucide-react'
import { useSessionStore } from '@/store'
import { triggerDetection, getPersons, setPersonOfInterest } from '@/api/persons'
import { ApiError } from '@/api/client'
import { connectSSE } from '@/lib/sse'
import { PersonCard } from '@/components/PersonCard'
import type { SSEDetectionComplete, SSEDetectionFailed } from '@/types'

type DetectionPhase = 'idle' | 'triggering' | 'waiting' | 'done' | 'error'

export function PersonSelectionPage() {
  const navigate = useNavigate()

  const {
    sessionId,
    token,
    clips,
    persons,
    selectedPersonRefId,
    addPersons,
    setPersons,
    setSelectedPerson,
    setCurrentStep,
    updateClipFromSSE,
  } = useSessionStore()

  const personGroups = useSessionStore((s) => s.personGroups())

  const [phase, setPhase] = useState<DetectionPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [personSkipped, setPersonSkipped] = useState(false)

  const validClips = clips.filter((c) => c.status === 'valid')
  const clipsNeedingDetection = validClips.filter((c) => c.detectionStatus === 'pending')
  const allComplete = validClips.length > 0 && validClips.every((c) => c.detectionStatus === 'complete' || c.detectionStatus === 'failed')
  // Continue is allowed when: person is selected, skip was explicitly clicked, or no persons were detected
  const canContinue = !!selectedPersonRefId || personSkipped || personGroups.length === 0

  // Kick off detection if clips haven't been processed yet
  useEffect(() => {
    if (!sessionId || !token) return
    if (allComplete || validClips.length === 0) {
      setPhase('done')
      return
    }
    if (clipsNeedingDetection.length === 0) {
      setPhase('done')
      return
    }

    let cancelled = false

    async function run() {
      setPhase('triggering')
      try {
        await triggerDetection(sessionId!)
        if (cancelled) return
        setPhase('waiting')
      } catch (err: unknown) {
        if (cancelled) return
        const message = err instanceof ApiError ? err.message : 'Failed to start detection'
        setError(message)
        setPhase('error')
      }
    }

    run()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // SSE listener for detection events
  useEffect(() => {
    if (!sessionId || !token || phase === 'idle' || phase === 'error') return

    const sse = connectSSE(sessionId, token, (event) => {
      if (event.type === 'detection-complete') {
        const e = event as SSEDetectionComplete
        addPersons(e.persons)
        updateClipFromSSE(e.clip_id, { detectionStatus: 'complete' })

        // Check if all clips are done
        const updatedClips = useSessionStore.getState().clips
        const allDone = updatedClips
          .filter((c) => c.status === 'valid')
          .every((c) => c.detectionStatus === 'complete' || c.detectionStatus === 'failed')
        if (allDone) setPhase('done')
      }

      if (event.type === 'detection-failed') {
        const e = event as SSEDetectionFailed
        updateClipFromSSE(e.clip_id, { detectionStatus: 'failed' })

        const updatedClips = useSessionStore.getState().clips
        const allDone = updatedClips
          .filter((c) => c.status === 'valid')
          .every((c) => c.detectionStatus === 'complete' || c.detectionStatus === 'failed')
        if (allDone) setPhase('done')
      }
    })

    return () => sse.disconnect()
  }, [sessionId, token, phase, addPersons, updateClipFromSSE])

  // If already done, load persons from API in case we navigated back
  useEffect(() => {
    if (!sessionId || persons.length > 0) return
    if (phase !== 'done') return

    getPersons(sessionId)
      .then((apiPersons) => setPersons(apiPersons))
      .catch(() => {/* silently ignore */})
  }, [sessionId, phase, persons.length, setPersons])

  const handleSelect = async (personRefId: string) => {
    if (!sessionId) return
    const newSelection = selectedPersonRefId === personRefId ? null : personRefId
    setSelectedPerson(newSelection)
    if (newSelection) setPersonSkipped(false)
    setSaving(true)
    try {
      await setPersonOfInterest(sessionId, newSelection)
    } catch {
      // Revert on failure
      setSelectedPerson(selectedPersonRefId)
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = async () => {
    if (!sessionId) return
    setSelectedPerson(null)
    setPersonSkipped(true)
    // Best-effort server clear
    try {
      await setPersonOfInterest(sessionId, null)
    } catch {/* ignore */}
  }

  const handleBack = () => {
    setCurrentStep('upload-audio')
    navigate('/upload-song')
  }

  const handleContinue = () => {
    setCurrentStep('mark-highlights')
    navigate('/highlights')
  }

  const isDetecting = phase === 'triggering' || phase === 'waiting'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Select Your Person</h1>
        <p className="mt-1 text-sm text-gray-500">
          Choose the person the reel should focus on. The AI will prioritise moments featuring them.
        </p>
      </div>

      {/* Detection in progress */}
      {isDetecting && (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center justify-center gap-3 rounded-xl border border-brand-200 bg-brand-50 py-12 text-center"
        >
          <Loader2 className="h-10 w-10 animate-spin text-brand-500" aria-hidden="true" />
          <p className="text-sm font-semibold text-brand-700">Detecting people in your clips…</p>
          <p className="text-xs text-brand-500">This may take a minute.</p>
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Detection failed</p>
            <p>{error ?? 'An error occurred during person detection.'}</p>
          </div>
        </div>
      )}

      {/* No persons detected */}
      {phase === 'done' && personGroups.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-gray-200 bg-gray-50 py-12 text-center">
          <Users className="h-10 w-10 text-gray-300" aria-hidden="true" />
          <p className="text-sm font-semibold text-gray-600">No people detected</p>
          <p className="max-w-xs text-xs text-gray-400">
            No faces were found in your clips. You can still continue — the AI will use all footage.
          </p>
        </div>
      )}

      {/* Person grid */}
      {phase === 'done' && personGroups.length > 0 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-gray-600">
            {personGroups.length} person{personGroups.length !== 1 ? 's' : ''} detected.
            {saving && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Saving…
              </span>
            )}
          </p>

          <div
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4"
            role="group"
            aria-label="Detected persons"
          >
            {personGroups.map((group) => (
              <PersonCard
                key={group.personRefId}
                group={group}
                isSelected={selectedPersonRefId === group.personRefId}
                onSelect={handleSelect}
                isDisabled={saving}
              />
            ))}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={handleBack}
          className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
        >
          Back
        </button>

        <div className="flex items-center gap-3">
          {/* Skip button — visible when persons are detected but none selected and not already skipped */}
          {phase === 'done' && personGroups.length > 0 && !selectedPersonRefId && !personSkipped && (
            <button
              type="button"
              onClick={handleSkip}
              className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
            >
              Skip — let AI choose freely
            </button>
          )}

          <button
            type="button"
            onClick={handleContinue}
            disabled={isDetecting || !canContinue}
            className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            Continue to Highlights
          </button>
        </div>
      </div>
    </div>
  )
}
