import { AlertTriangle, X } from 'lucide-react'
import { useSessionStore } from '@/store'

/**
 * Shows a one-time ephemeral-data warning on the first upload.
 * Once dismissed it never shows again for this session.
 * Spec: "Ephemeral session warning on FIRST upload: 'Your files will be
 * permanently deleted after download. There is no recovery.'"
 */
export function EphemeralWarningBanner() {
  const dismissed = useSessionStore((s) => s.ephemeralWarningDismissed)
  const dismiss = useSessionStore((s) => s.dismissEphemeralWarning)

  if (dismissed) return null

  return (
    <div
      role="note"
      aria-label="Ephemeral session warning"
      className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
        aria-hidden="true"
      />
      <p className="flex-1">
        <strong className="font-semibold">Heads up:</strong> Your files will be
        permanently deleted after you download your HypeReel.{' '}
        <strong className="font-semibold">There is no recovery.</strong>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss warning"
        className="flex-shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-100 hover:text-amber-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}
