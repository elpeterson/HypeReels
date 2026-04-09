import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useSessionStore } from '@/store'
import { startGeneration, getJobStatus, cancelJob } from '@/api/generation'
import { ApiError } from '@/api/client'
import { connectSSE, type SSEClient } from '@/lib/sse'
import { JobProgressBar } from '@/components/JobProgressBar'
import type { SSEGenerationProgress, SSEGenerationComplete, SSEGenerationFailed } from '@/types'

const POLL_INTERVAL_MS = 5000

type BootstrapPhase = 'starting' | 'running' | 'complete' | 'failed'

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
  const sseRef = useRef<SSEClient | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // SSE + polling setup
  const setupRealtime = (jobId: string) => {
    if (!sessionId || !token) return

    // SSE
    sseRef.current = connectSSE(sessionId, token, (event) => {
      if (event.type === 'generation-progress') {
        const e = event as SSEGenerationProgress
        if (e.job_id === jobId) {
          updateJobProgress(jobId, e.step, e.pct)
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

    // Fallback polling in case SSE drops
    pollTimerRef.current = setInterval(async () => {
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
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          teardown()
          failJob(jobId, job.error_message ?? 'Generation failed')
          setPhase('failed')
        }
      } catch {
        // Silently ignore poll errors — SSE is the primary channel
      }
    }, POLL_INTERVAL_MS)
  }

  const teardown = () => {
    sseRef.current?.disconnect()
    sseRef.current = null
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
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
        const message = err instanceof ApiError ? err.message : 'Failed to start generation'
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

  const handleBack = () => {
    setCurrentStep('review')
    navigate('/review')
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
              className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
            >
              Back to Review
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
    </div>
  )
}
