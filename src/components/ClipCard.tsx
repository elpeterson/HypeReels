import { X, RefreshCw, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { cn, formatMs, formatBytes } from '@/lib/utils'
import type { Clip } from '@/types'

interface ClipCardProps {
  clip: Clip
  onRemove?: (clipId: string) => void
  onRetry?: (clipId: string) => void
  isReadOnly?: boolean
}

export function ClipCard({ clip, onRemove, onRetry, isReadOnly = false }: ClipCardProps) {
  const isUploading = clip.status === 'uploading'
  const isValidating = clip.status === 'validating'
  const isValid = clip.status === 'valid'
  const isInvalid = clip.status === 'invalid'
  const hasError = isInvalid || clip.uploadError !== null

  return (
    <div
      className={cn(
        'group relative flex items-start gap-3 rounded-lg border bg-white p-3 shadow-sm transition-shadow hover:shadow-md',
        hasError && 'border-red-200 bg-red-50',
        isValid && 'border-gray-200',
        (isUploading || isValidating) && 'border-gray-200 opacity-80'
      )}
      aria-label={`Clip: ${clip.originalFilename}`}
    >
      {/* Thumbnail */}
      <div className="relative h-16 w-28 flex-shrink-0 overflow-hidden rounded bg-gray-100">
        {clip.thumbnailUrl ? (
          <img
            src={clip.thumbnailUrl}
            alt={`Thumbnail for ${clip.originalFilename}`}
            className="h-full w-full object-cover"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-gray-300"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-8 w-8">
              <path d="M4 4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2H4zm0 2h16v12H4V6zm6 2v8l6-4-6-4z" />
            </svg>
          </div>
        )}

        {/* Upload progress overlay */}
        {isUploading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
            <Loader2 className="h-5 w-5 animate-spin text-white" />
            <span className="mt-1 text-xs font-medium text-white">
              {clip.uploadProgress}%
            </span>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className="truncate text-sm font-medium text-gray-800"
          title={clip.originalFilename}
        >
          {clip.originalFilename}
        </p>

        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
          {clip.durationMs !== null && (
            <span>{formatMs(clip.durationMs)}</span>
          )}
          <span>{formatBytes(clip.fileSizeBytes)}</span>
        </div>

        {/* Status badges */}
        {isValidating && (
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Validating…
          </span>
        )}
        {isValid && !isUploading && (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            Ready
          </span>
        )}
        {hasError && (
          <span className="flex items-center gap-1 text-xs text-red-600">
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            {clip.uploadError ?? clip.validationError ?? 'Upload failed'}
          </span>
        )}

        {/* Upload progress bar */}
        {isUploading && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuenow={clip.uploadProgress} aria-valuemin={0} aria-valuemax={100}>
            <div
              className="h-full rounded-full bg-brand-600 transition-all duration-200"
              style={{ width: `${clip.uploadProgress}%` }}
            />
          </div>
        )}
      </div>

      {/* Action buttons */}
      {!isReadOnly && (
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          {hasError && onRetry && (
            <button
              type="button"
              onClick={() => onRetry(clip.id)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
              aria-label={`Retry upload for ${clip.originalFilename}`}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          {onRemove && !isUploading && (
            <button
              type="button"
              onClick={() => onRemove(clip.id)}
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
              aria-label={`Remove ${clip.originalFilename}`}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
