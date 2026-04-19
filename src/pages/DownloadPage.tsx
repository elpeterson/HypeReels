import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { useSessionStore } from '@/store'
import { notifyDownloadInitiated, notifyDone } from '@/api/generation'
import { ApiError } from '@/api/client'
import { formatMs, formatBytes } from '@/lib/utils'

/**
 * Download flow (spec):
 * 1. Single prominent download CTA
 * 2. Confirmation modal first — "Downloading will permanently delete all your
 *    files. This cannot be undone. Download now?" with "Download and delete"
 *    (primary) / "Cancel" (secondary)
 * 3. Follow redirect — NEVER show the signed URL to the user
 * 4. After download attempt succeeds: trigger cleanup, then show
 *    "Your files have been deleted."
 * 5. On failure: show error + retry. Do NOT repeat deletion confirmation on retry.
 */

type DownloadPhase =
  | 'ready'        // Waiting for user to click Download
  | 'confirming'   // Modal is open, user has not yet confirmed
  | 'downloading'  // Notifying backend + triggering browser download
  | 'cleaning'     // Calling /done endpoint
  | 'done'         // Cleanup complete, files deleted
  | 'error'        // Download or cleanup failed

export function DownloadPage() {
  const navigate = useNavigate()

  const {
    sessionId,
    generationJob,
    clearSession,
    setCurrentStep,
    setGenerationJob,
  } = useSessionStore()

  const downloadFilename = sessionId ? `hypereel-${sessionId.slice(0, 8)}.mp4` : 'hypereel.mp4'

  const [phase, setPhase] = useState<DownloadPhase>('ready')
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // Once the user has confirmed once, we skip the confirmation modal on retry
  const [hasConfirmed, setHasConfirmed] = useState(false)

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

  const executeDownload = async () => {
    if (!sessionId || !downloadUrl) return

    setPhase('downloading')
    setDownloadError(null)

    // Notify backend that download is starting (schedules cleanup on their side)
    try {
      await notifyDownloadInitiated(sessionId)
    } catch {
      // Non-fatal — proceed with download regardless
    }

    // Trigger browser download via a temporary <a> element.
    // We do NOT expose downloadUrl in any visible UI element.
    try {
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = downloadFilename
      // Keep the <a> off-screen and not visible
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch {
      setDownloadError('Failed to initiate download. Please try again.')
      setPhase('error')
      return
    }

    // Immediately trigger cleanup after kicking off the browser download
    setPhase('cleaning')
    try {
      await notifyDone(sessionId)
      clearSession()
      setPhase('done')
    } catch (err: unknown) {
      const message =
        err instanceof ApiError ? err.message : 'Cleanup failed. Your files will be purged automatically within 24 hours.'
      setDownloadError(message)
      setPhase('error')
    }
  }

  const handleDownloadClick = () => {
    if (hasConfirmed) {
      // On retry: skip the modal
      executeDownload()
    } else {
      setPhase('confirming')
    }
  }

  const handleConfirm = () => {
    setHasConfirmed(true)
    executeDownload()
  }

  const handleCancelConfirm = () => {
    setPhase('ready')
  }

  // Fully done state
  if (phase === 'done') {
    return (
      <div className="flex flex-col items-center gap-6 py-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <CheckCircle2 className="h-10 w-10 text-green-500" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-gray-900">Your files have been deleted.</h1>
          <p className="max-w-xs text-sm text-gray-500">
            Your HypeReel has been downloaded and all uploaded files have been
            permanently deleted from our servers.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            clearSession()
            navigate('/', { replace: true })
          }}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Create Another HypeReel
        </button>
      </div>
    )
  }

  const isLoading = phase === 'downloading' || phase === 'cleaning'

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
          <p className="text-base font-semibold text-gray-800">{downloadFilename}</p>
          <div className="flex justify-center gap-3 text-xs text-gray-500">
            {durationMs !== null && <span>{formatMs(durationMs)}</span>}
            {sizeBytes !== null && <span>{formatBytes(sizeBytes)}</span>}
          </div>
        </div>

        {/* Error state with retry — no repeat of confirmation modal */}
        {phase === 'error' && downloadError && (
          <div
            role="alert"
            className="w-full flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>{downloadError}</span>
          </div>
        )}

        {/* Download / retry button */}
        <button
          type="button"
          onClick={handleDownloadClick}
          disabled={isLoading}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          aria-label={phase === 'error' ? 'Retry download' : 'Download your HypeReel video'}
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {phase === 'cleaning' ? 'Deleting files…' : 'Starting download…'}
            </>
          ) : (
            <>
              <Download className="h-4 w-4" aria-hidden="true" />
              {phase === 'error' ? 'Retry Download' : 'Download HypeReel'}
            </>
          )}
        </button>

        {/* Destruction warning — text only, no URL exposed */}
        <p className="text-center text-xs text-amber-700">
          Downloading will permanently delete all your uploaded files and the
          generated reel from our servers. This cannot be undone.
        </p>
      </div>

      {/* Confirmation modal — shown on first download attempt only */}
      {phase === 'confirming' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="download-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h2 id="download-confirm-title" className="text-base font-semibold text-gray-900">
              Ready to download?
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Downloading will permanently delete all your uploaded clips, your audio
              track, and the generated reel from our servers.{' '}
              <strong className="font-semibold text-gray-800">This cannot be undone.</strong>{' '}
              Download now?
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={handleCancelConfirm}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="flex-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                Download and delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
