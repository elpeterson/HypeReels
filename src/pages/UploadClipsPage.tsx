import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud, AlertCircle } from 'lucide-react'
import { useSessionStore } from '@/store'
import { uploadClip, deleteClip } from '@/api/clips'
import { ApiError } from '@/api/client'
import { ClipCard } from '@/components/ClipCard'
import { EphemeralWarningBanner } from '@/components/EphemeralWarningBanner'
import { cn } from '@/lib/utils'

const ACCEPTED_MIME = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm']
const ACCEPTED_EXT = ['.mp4', '.mov', '.mkv', '.webm']
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB
const MAX_CLIPS = 10

function validateFile(file: File): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  if (!ACCEPTED_MIME.includes(file.type) && !ACCEPTED_EXT.includes(ext)) {
    return 'Unsupported format. Please upload MP4, MOV, MKV, or WebM.'
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return 'File too large. Maximum size is 2 GB per clip.'
  }
  return null
}

export function UploadClipsPage() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const {
    sessionId,
    token,
    clips,
    addUploadingClip,
    updateClipProgress,
    finaliseClipUpload,
    failClipUpload,
    removeClip,
    setCurrentStep,
  } = useSessionStore()

  const validClips = clips.filter((c) => c.status === 'valid' || c.status === 'validating')
  const isAtCapacity = clips.length >= MAX_CLIPS
  const canContinue = validClips.length > 0 && clips.every((c) => c.status !== 'uploading')

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!sessionId || !token) return

      const fileArray = Array.from(files)
      const remainingSlots = MAX_CLIPS - clips.length
      const filesToProcess = fileArray.slice(0, remainingSlots)

      for (const file of filesToProcess) {
        const validationError = validateFile(file)
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`

        addUploadingClip(tempId, file.name, file.size)

        if (validationError) {
          failClipUpload(tempId, validationError)
          continue
        }

        try {
          const response = await uploadClip(
            sessionId,
            file,
            token,
            (pct) => updateClipProgress(tempId, pct)
          ) as { clip_id: string }

          // Immediately swap the temp entry with a validating placeholder
          finaliseClipUpload(tempId, {
            id: response.clip_id,
            session_id: sessionId,
            original_filename: file.name,
            file_size_bytes: file.size,
            duration_ms: null,
            thumbnail_url: null,
            status: 'validating',
            validation_error: null,
            detection_status: 'pending',
          })
        } catch (err: unknown) {
          const message =
            err instanceof ApiError
              ? err.message
              : 'Upload failed. Please try again.'
          failClipUpload(tempId, message)
        }
      }
    },
    [sessionId, token, clips.length, addUploadingClip, updateClipProgress, finaliseClipUpload, failClipUpload]
  )

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(e.target.files)
      // Reset so the same file can be re-selected after removal
      e.target.value = ''
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files)
  }

  const handleRemove = async (clipId: string) => {
    if (!sessionId) return
    removeClip(clipId)
    try {
      await deleteClip(sessionId, clipId)
    } catch {
      // Best-effort server delete; clip is already removed from UI
    }
  }

  const handleRetry = (clipId: string) => {
    // Remove the failed entry; user can re-upload via the file picker
    removeClip(clipId)
  }

  const handleContinue = () => {
    setCurrentStep('upload-audio')
    navigate('/upload-song')
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Upload Video Clips</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload one or more video clips (MP4, MOV, MKV, WebM). Max {MAX_CLIPS} clips, 2 GB each.
        </p>
      </div>

      <EphemeralWarningBanner />

      {/* Drop zone */}
      <div
        role="button"
        tabIndex={isAtCapacity ? -1 : 0}
        aria-label="Upload video clips drop zone. Click or drag files here."
        aria-disabled={isAtCapacity}
        onClick={() => !isAtCapacity && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!isAtCapacity && (e.key === 'Enter' || e.key === ' ')) {
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => {
          setIsDragging(false)
        }}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-colors',
          isAtCapacity
            ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
            : isDragging
              ? 'cursor-pointer border-brand-500 bg-brand-100 text-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600'
              : 'cursor-pointer border-brand-300 bg-brand-50 text-brand-700 hover:border-brand-500 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600'
        )}
      >
        <UploadCloud className="h-10 w-10 text-brand-400" aria-hidden="true" />
        {isAtCapacity ? (
          <p className="text-sm font-medium">Maximum of {MAX_CLIPS} clips reached</p>
        ) : (
          <>
            <p className="text-sm font-semibold">
              Drag &amp; drop clips here, or click to browse
            </p>
            <p className="text-xs text-brand-500">MP4, MOV, MKV, WebM — up to 2 GB each</p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXT.join(',')}
        multiple
        className="sr-only"
        aria-hidden="true"
        onChange={handleInputChange}
      />

      {/* Clip list */}
      {clips.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-gray-700">
            {clips.length} clip{clips.length !== 1 ? 's' : ''} added
          </h2>
          <ul className="flex flex-col gap-2" aria-label="Uploaded clips">
            {clips.map((clip) => (
              <li key={clip.id}>
                <ClipCard
                  clip={clip}
                  onRemove={handleRemove}
                  onRetry={handleRetry}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty state */}
      {clips.length === 0 && (
        <p className="text-center text-sm text-gray-400 italic">
          No clips uploaded yet.
        </p>
      )}

      {/* Continue */}
      <div className="flex flex-col gap-2 pt-2">
        {!canContinue && validClips.length === 0 && clips.every((c) => c.status !== 'uploading') && (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            Upload at least one video clip to continue.
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            Continue to Song Upload
          </button>
        </div>
      </div>
    </div>
  )
}
