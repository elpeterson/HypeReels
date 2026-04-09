import { AlertTriangle } from 'lucide-react'

export function EphemeralWarningBanner() {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
        aria-hidden="true"
      />
      <p>
        <strong className="font-semibold">Heads up:</strong> Your files will be
        permanently deleted after you download your HypeReel. There is no way to
        recover them.
      </p>
    </div>
  )
}
