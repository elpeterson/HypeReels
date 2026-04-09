import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, Trash2, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { useSessionStore } from '@/store'
import { notifyDownloadInitiated, notifyDone } from '@/api/generation'
import { ApiError } from '@/api/client'
import { formatMs, formatBytes } from '@/lib/utils'

type DownloadPhase = 'ready' | 'downloading' | 'confirming' | 'cleaning' | 'done' | 'error'

export function DownloadPage() {
  const navigate = useNavigate()

  const {
    sessionId,
    generationJob,
    clearSession,
    setCurrentStep,
  } = useSessionStore()

  const [phase, setPhase] = useState<DownloadPhase>('ready')
  const [error, setError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  const downloadUrl = generationJob?.downloadUrl ?? null
  const durationMs = generationJob?.durationMs ?? null
  const sizeBytes = generationJob?.sizeBytes ?? null

  // No completed job — redirect back
  if (!generationJob || generationJob.status !== 'complete' || !downloadUrl) {
    return (
      <div className="flex flex-col items-center gap-6 py-12 text-center">
        <AlertCircle className="h-10 w-10 text-amber-400" aria-hidden="true" />
        <p className="text-sm text-gray-600">
          No completed HypeReel found. Please go back and generate your reel.
        </p>
        <button
          type="button"
          onClick={() => {
            setCurrentStep('generate')
            navigate('/generate')
          }}
          className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Back to Generate
        </button>
      </div>
    )
  }

  const handleDownloadClick = async () => {
    if (!sessionId || !downloadUrl) return
    setPhase('downloading')
    setError(null)

    try {
      // Notify backend that download is starting (schedules cleanup)
      await notifyDownloadInitiated(sessionId)
    } catch {
      // Non-fatal — the download itself is more important
    }

    // Trigger browser download via a temporary <a> element
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = 'HypeReel.mp4'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)

    setPhase('confirming')
    setShowConfirm(true)
  }

  const handleConfirmDone = async () => {
    if (!sessionId) return
    setPhase('cleaning')
    setError(null)

    try {
      await notifyDone(sessionId)
      clearSession()
      setPhase('done')
    } catch (err: unknown) {
      const message =
        err instanceof ApiError ? err.message : 'Failed to confirm cleanup'
      setError(message)
      setPhase('error')
    }
  }

  const handleStartOver = () => {
    clearSession()
    navigate('/', { replace: true })
  }

  // Fully done state
  if (phase === 'done') {
    return (
      <div className="flex flex-col items-center gap-6 py-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <CheckCircle2 className="h-10 w-10 text-green-500" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-gray-900">All done!</h1>
          <p className="max-w-xs text-sm text-gray-500">
            Your HypeReel has been downloaded and all uploaded files have been
            permanently deleted.
          </p>
        </div>
        <button
          type="button"
          onClick={handleStartOver}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Create Another HypeReel
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-8 py-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900">Your HypeReel is Ready!</h1>
        <p className="mt-1 text-sm text-gray-500">
          Download your video below. Once downloaded, all files will be permanently deleted.
        </p>
      </div>

      {/* Reel info card */}
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-100">
          <CheckCircle2 className="h-8 w-8 text-brand-600" aria-hidden="true" />
        </div>

        <div className="text-center space-y-1">
          <p className="text-base font-semibold text-gray-800">HypeReel.mp4</p>
          <div className="flex justify-center gap-3 text-xs text-gray-500">
            {durationMs !== null && <span>{formatMs(durationMs)}</span>}
            {sizeBytes !== null && <span>{formatBytes(sizeBytes)}</span>}
          </div>
        </div>

        {/* Download button */}
        {(phase === 'ready' || phase === 'downloading') && (
          <button
            type="button"
            onClick={handleDownloadClick}
            disabled={phase === 'downloading'}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            aria-label="Download your HypeReel video"
          >
            {phase === 'downloading' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Starting download…
              </>
            ) : (
              <>
                <Download className="h-4 w-4" aria-hidden="true" />
                Download HypeReel
              </>
            )}
          </button>
        )}

        {/* Destruction warning */}
        <p className="text-center text-xs text-amber-700">
          Downloading will permanently delete all your uploaded files and the
          generated reel from our servers. This cannot be undone.
        </p>
      </div>

      {/* Post-download confirmation */}
      {showConfirm && (phase === 'confirming' || phase === 'cleaning' || phase === 'error') && (
        <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-gray-800">
            Did your download complete?
          </p>
          <p className="text-xs text-gray-500">
            Once you confirm, all uploaded clips, your audio track, and the
            generated reel will be permanently deleted from our servers.
          </p>

          {phase === 'error' && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              {error ?? 'Cleanup failed. Your files will be purged automatically within 24 hours.'}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setShowConfirm(false)
                setPhase('ready')
              }}
              disabled={phase === 'cleaning'}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Download Again
            </button>
            <button
              type="button"
              onClick={handleConfirmDone}
              disabled={phase === 'cleaning'}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
              aria-label="Confirm download completed and delete all files"
            >
              {phase === 'cleaning' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Done — Delete Files
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
