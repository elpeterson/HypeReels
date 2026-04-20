import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { useSessionStore } from '@/store'
import { startGeneration, getJobStatus, cancelJob } from '@/api/generation'
import { ApiError } from '@/api/client'
import { connectSSE, type SSEClient } from '@/lib/sse'
import { JobProgressBar } from '@/components/JobProgressBar'
import { cn } from '@/lib/utils'
import type { GenerationStep, SSEGenerationProgress, SSEGenerationComplete, SSEGenerationFailed } from '@/types'

// Spec: poll every 3s
const POLL_INTERVAL_BASE_MS = 3000
// Spec: exponential backoff when progress unchanged for 3 polls, max 15s
const POLL_INTERVAL_MAX_MS = 15000
const STALL_POLL_COUNT = 3
// Spec: after 10 min stalled, show "Keep waiting" / "Cancel generation"
const STALL_TIMEOUT_MS = 10 * 60 * 1000

type BootstrapPhase = 'starting' | 'running' | 'complete' | 'failed'

interface GenerationStepDef {
  key: GenerationStep
  label: string
}

const GENERATION_STEPS: GenerationStepDef[] = [
  { key: 'analysing', label: 'Analysing clips and detecting persons' },
  { key: 'selecting', label: 'Selecting your best moments' },
  { key: 'sequencing', label: 'Syncing cuts to the beat' },
  { key: 'rendering', label: 'Encoding your HypeReel' },
]

export function GeneratePage() {
  const navigate = useNavigate()

  const {
    sessionId,
    token,
    generationJob,
    setGenerationJob,
    updateJobProgress,
    completeJob,
    failJob,
    setCurrentStep,
  } = useSessionStore()

  const [phase, setPhase] = useState<BootstrapPhase>('starting')
  const [initError, setInitError] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)
  const [showStallDialog, setShowStallDialog] = useState(false)
  const sseRef = useRef<SSEClient | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Backoff tracking
  const pollIntervalRef = useRef<number>(POLL_INTERVAL_BASE_MS)
  const lastProgressRef = useRef<number>(-1)
  const unchangedPollCountRef = useRef<number>(0)

  const scheduleNextPoll = (jobId: string) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    pollTimerRef.current = setTimeout(() => pollJob(jobId), pollIntervalRef.current)
  }

  const pollJob = async (jobId: string) => {
    if (!sessionId) return
    try {
      const job = await getJobStatus(sessionId, jobId)
      setGenerationJob(job)

      if (job.status === 'complete' && job.download_url) {
        teardown()
        completeJob(jobId, job.download_url, job.duration_ms ?? 0, job.size_bytes ?? 0)
        setPhase('complete')
        setCurrentStep('download')
        navigate('/download')
        return
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        teardown()
        failJob(jobId, job.error_message ?? 'Generation failed')
        setPhase('failed')
        return
      }

      // Exponential backoff when progress stalls
      const currentPct = job.progress_pct ?? 0
      if (currentPct === lastProgressRef.current) {
        unchangedPollCountRef.current += 1
        if (unchangedPollCountRef.current >= STALL_POLL_COUNT) {
          pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, POLL_INTERVAL_MAX_MS)
        }
      } else {
        lastProgressRef.current = currentPct
        unchangedPollCountRef.current = 0
        pollIntervalRef.current = POLL_INTERVAL_BASE_MS
      }

      scheduleNextPoll(jobId)
    } catch {
      // Poll errors are non-fatal — SSE is the primary channel
      scheduleNextPoll(jobId)
    }
  }

  // SSE + polling setup
  const setupRealtime = (jobId: string) => {
    if (!sessionId || !token) return

    // Reset backoff state
    pollIntervalRef.current = POLL_INTERVAL_BASE_MS
    lastProgressRef.current = -1
    unchangedPollCountRef.current = 0

    // SSE
    sseRef.current = connectSSE(sessionId, token, (event) => {
      if (event.type === 'generation-progress') {
        const e = event as SSEGenerationProgress
        if (e.job_id === jobId) {
          updateJobProgress(jobId, e.step, e.pct)
          // Reset backoff on any SSE progress
          pollIntervalRef.current = POLL_INTERVAL_BASE_MS
          unchangedPollCountRef.current = 0
        }
      }
      if (event.type === 'generation-complete') {
        const e = event as SSEGenerationComplete
        if (e.job_id === jobId) {
          teardown()
          completeJob(jobId, e.download_url, e.duration_ms, e.size_bytes)
          setPhase('complete')
          setCurrentStep('download')
          navigate('/download')
        }
      }
      if (event.type === 'generation-failed') {
        const e = event as SSEGenerationFailed
        if (e.job_id === jobId) {
          teardown()
          failJob(jobId, e.error)
          setPhase('failed')
        }
      }
    })

    // Polling fallback
    scheduleNextPoll(jobId)

    // Stall timer — after 10 min show the stall dialog (no auto-cancel)
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current)
    stallTimerRef.current = setTimeout(() => {
      setShowStallDialog(true)
    }, STALL_TIMEOUT_MS)
  }

  const teardown = () => {
    sseRef.current?.disconnect()
    sseRef.current = null
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current)
      stallTimerRef.current = null
    }
    setShowStallDialog(false)
  }

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (!sessionId) return

      // If there's already a running job (e.g. page refresh), reconnect
      if (generationJob && (generationJob.status === 'queued' || generationJob.status === 'processing' || generationJob.status === 'rendering')) {
        setPhase('running')
        setupRealtime(generationJob.id)
        return
      }

      // Already complete — redirect
      if (generationJob?.status === 'complete' && generationJob.downloadUrl) {
        setCurrentStep('download')
        navigate('/download', { replace: true })
        return
      }

      // Start a new job
      try {
        const { job_id } = await startGeneration(sessionId)
        if (cancelled) return

        // Fetch initial state
        const job = await getJobStatus(sessionId, job_id)
        if (cancelled) return

        setGenerationJob(job)
        setPhase('running')
        setupRealtime(job_id)
      } catch (err: unknown) {
        if (cancelled) return
        // 409 means a job is already active (e.g. double-submit)
        const is409 = err instanceof ApiError && err.status === 409
        const message = is409
          ? 'A generation is already in progress. Please wait or go back and try again.'
          : err instanceof ApiError ? err.message : 'Failed to start generation'
        setInitError(message)
        setPhase('failed')
      }
    }

    bootstrap()

    return () => {
      cancelled = true
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleRetry = async () => {
    if (!sessionId || !generationJob) return
    setInitError(null)
    setShowStallDialog(false)
    setPhase('starting')

    // Cancel the old job first (best-effort)
    try {
      if (generationJob.status !== 'complete') {
        await cancelJob(sessionId, generationJob.id)
      }
    } catch {/* ignore */}

    try {
      const { job_id } = await startGeneration(sessionId)
      const job = await getJobStatus(sessionId, job_id)
      setGenerationJob(job)
      setPhase('running')
      setupRealtime(job_id)
    } catch (err: unknown) {
      const message = err instanceof ApiError ? err.message : 'Failed to retry generation'
      setInitError(message)
      setPhase('failed')
    }
  }

  const handleBack = async () => {
    if (!sessionId || !generationJob) {
      setCurrentStep('review')
      navigate('/review')
      return
    }

    setIsCancelling(true)
    const CANCEL_TIMEOUT_MS = 3000
    const cancelPromise = cancelJob(sessionId, generationJob.id).catch(() => {/* best-effort */})
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, CANCEL_TIMEOUT_MS))

    await Promise.race([cancelPromise, timeoutPromise])

    teardown()
    setIsCancelling(false)
    setCurrentStep('review')
    navigate('/review')
  }

  const handleKeepWaiting = () => {
    setShowStallDialog(false)
    // Restart the stall timer
    if (generationJob?.id) {
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current)
      stallTimerRef.current = setTimeout(() => {
        setShowStallDialog(true)
      }, STALL_TIMEOUT_MS)
    }
  }

  const isActive = phase === 'starting' || phase === 'running'

  return (
    <div className="flex flex-col items-center gap-8 py-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900">Generating Your HypeReel</h1>
        <p className="mt-1 text-sm text-gray-500">
          Sit tight — this usually takes a minute or two.
        </p>
      </div>

      {/* Progress */}
      {isActive && (
        <div className="w-full max-w-lg">
          <JobProgressBar
            step={generationJob?.step ?? null}
            pct={generationJob?.progressPct ?? 0}
          />
        </div>
      )}

      {/* Starting spinner */}
      {phase === 'starting' && !generationJob && (
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
          <p className="text-sm">Submitting job…</p>
        </div>
      )}

      {/* Generation steps list — shown during queued/processing */}
      {isActive && (
        <ol className="w-full max-w-lg space-y-2" aria-label="Generation steps">
          {GENERATION_STEPS.map(({ key, label }) => {
            const currentStepIndex = GENERATION_STEPS.findIndex(
              (s) => s.key === generationJob?.step
            )
            const thisStepIndex = GENERATION_STEPS.findIndex((s) => s.key === key)
            const isCurrent = generationJob?.step === key
            const isDone = currentStepIndex >= 0 && thisStepIndex < currentStepIndex
            const isFuture = !isCurrent && !isDone

            return (
              <li
                key={key}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm',
                  isCurrent && 'bg-brand-50 font-semibold text-brand-700',
                  isDone && 'text-green-700',
                  isFuture && 'text-gray-400'
                )}
              >
                <span className="flex-shrink-0 w-5 text-center">
                  {isDone && <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" />}
                  {isCurrent && <Loader2 className="h-4 w-4 animate-spin text-brand-500" aria-hidden="true" />}
                  {isFuture && <span className="inline-block h-4 w-4 rounded-full border border-gray-300" aria-hidden="true" />}
                </span>
                {label}
              </li>
            )
          })}
        </ol>
      )}

      {/* Failure state */}
      {phase === 'failed' && (
        <div className="flex w-full max-w-lg flex-col items-center gap-4">
          <div
            role="alert"
            className="flex w-full items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <div>
              <p className="font-semibold">Generation failed</p>
              <p>{initError ?? generationJob?.errorMessage ?? 'An unexpected error occurred.'}</p>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleBack}
              disabled={isCancelling}
              className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
            >
              {isCancelling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Cancelling…
                </>
              ) : (
                'Back to Review'
              )}
            </button>
            <button
              type="button"
              onClick={handleRetry}
              className="flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* Informational text while running */}
      {isActive && (
        <p className="max-w-md text-center text-xs text-gray-400">
          The AI is selecting your best moments, syncing cuts to the beat, and
          rendering the final video. Keep this tab open.
        </p>
      )}

      {/* 10-min stall dialog — no auto-cancel */}
      {showStallDialog && isActive && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="stall-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h2 id="stall-dialog-title" className="text-base font-semibold text-gray-900">
              This is taking longer than expected
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Generation has been running for over 10 minutes without completing.
              Your job is still in progress — it has not been cancelled.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={handleBack}
                disabled={isCancelling}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
              >
                Cancel generation
              </button>
              <button
                type="button"
                onClick={handleKeepWaiting}
                className="flex-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                Keep waiting
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
