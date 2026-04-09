import { useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Music, UploadCloud, X, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { useSessionStore } from '@/store'
import { uploadAudio, deleteAudio } from '@/api/audio'
import { ApiError } from '@/api/client'
import { WaveformDisplay } from '@/components/WaveformDisplay'
import { cn, formatMs, formatBytes } from '@/lib/utils'

const ACCEPTED_MIME = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/flac']
const ACCEPTED_EXT = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac']
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 500 MB

function validateAudioFile(file: File): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  if (!ACCEPTED_MIME.includes(file.type) && !ACCEPTED_EXT.includes(ext)) {
    return 'Unsupported format. Please upload MP3, M4A, WAV, AAC, OGG, or FLAC.'
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return 'File too large. Maximum size is 500 MB for audio.'
  }
  return null
}

export function UploadSongPage() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    sessionId,
    token,
    audio,
    setUploadingAudio,
    updateAudioProgress,
    finaliseAudioUpload,
    failAudioUpload,
    clearAudio,
    setCurrentStep,
  } = useSessionStore()

  const isUploading = audio?.status === 'uploading'
  const isValidating = audio?.status === 'validating'
  const isAnalysing = audio?.analysisStatus === 'processing'
  const isReady = audio?.status === 'valid' && audio?.analysisStatus === 'complete'
  const hasError = audio?.status === 'invalid' || audio?.uploadError !== null
  const canContinue = audio?.status === 'valid'

  const handleFile = useCallback(
    async (file: File) => {
      if (!sessionId || !token) return

      const error = validateAudioFile(file)
      if (error) {
        // Set uploading first so we have something to show the error on
        setUploadingAudio(file.name, file.size)
        failAudioUpload(error)
        return
      }

      setUploadingAudio(file.name, file.size)

      try {
        const response = await uploadAudio(
          sessionId,
          file,
          token,
          (pct) => updateAudioProgress(pct)
        ) as { audio_id: string }

        finaliseAudioUpload({
          id: response.audio_id,
          session_id: sessionId,
          original_filename: file.name,
          file_size_bytes: file.size,
          duration_ms: null,
          status: 'validating',
          analysis_status: 'pending',
          waveform_url: null,
          bpm: null,
          envelope: null,
        })
      } catch (err: unknown) {
        const message =
          err instanceof ApiError
            ? err.message
            : 'Upload failed. Please try again.'
        failAudioUpload(message)
      }
    },
    [sessionId, token, setUploadingAudio, updateAudioProgress, finaliseAudioUpload, failAudioUpload]
  )

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFile(file)
      e.target.value = ''
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const handleRemove = async () => {
    clearAudio()
    if (!sessionId) return
    try {
      await deleteAudio(sessionId)
    } catch {
      // Best-effort
    }
  }

  const handleBack = () => {
    setCurrentStep('upload-clips')
    navigate('/upload-clips')
  }

  const handleContinue = () => {
    setCurrentStep('detect-persons')
    navigate('/person-selection')
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Upload Your Song</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload the audio track for your HypeReel. MP3, M4A, WAV, AAC, OGG, or FLAC — up to 500 MB.
        </p>
      </div>

      {/* Current audio track */}
      {audio ? (
        <div
          className={cn(
            'rounded-xl border bg-white p-4 shadow-sm',
            hasError ? 'border-red-200 bg-red-50' : 'border-gray-200'
          )}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-100">
              <Music className="h-5 w-5 text-brand-600" aria-hidden="true" />
            </div>

            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-semibold text-gray-800" title={audio.originalFilename}>
                {audio.originalFilename}
              </p>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-gray-500">
                <span>{formatBytes(audio.fileSizeBytes)}</span>
                {audio.durationMs !== null && <span>{formatMs(audio.durationMs)}</span>}
                {audio.bpm !== null && <span>{Math.round(audio.bpm)} BPM</span>}
              </div>

              {/* Status */}
              {isUploading && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Uploading… {audio.uploadProgress}%
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={audio.uploadProgress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
                  >
                    <div
                      className="h-full rounded-full bg-brand-600 transition-all"
                      style={{ width: `${audio.uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
              {isValidating && (
                <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Validating…
                </p>
              )}
              {isAnalysing && (
                <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Analysing beat structure…
                </p>
              )}
              {isReady && (
                <p className="mt-1 flex items-center gap-1 text-xs text-green-600">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  Ready
                </p>
              )}
              {hasError && (
                <p className="mt-1 flex items-center gap-1 text-xs text-red-600">
                  <AlertCircle className="h-3 w-3" aria-hidden="true" />
                  {audio.uploadError ?? (audio.status === 'invalid' ? 'Validation failed. Please check the file.' : 'Unknown error')}
                </p>
              )}

              {/* Waveform */}
              {(audio.analysisStatus === 'processing' || audio.analysisStatus === 'complete') && (
                <div className="mt-3">
                  <WaveformDisplay
                    envelope={audio.envelope}
                    isLoading={audio.analysisStatus === 'processing'}
                    height={48}
                    className="rounded"
                  />
                </div>
              )}
            </div>

            {/* Remove button */}
            {!isUploading && (
              <button
                type="button"
                onClick={handleRemove}
                className="flex-shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
                aria-label={`Remove ${audio.originalFilename}`}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ) : (
        /* Drop zone */
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload audio file. Click or drag a file here."
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-brand-300 bg-brand-50 p-10 text-center cursor-pointer hover:border-brand-500 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 transition-colors"
        >
          <UploadCloud className="h-10 w-10 text-brand-400" aria-hidden="true" />
          <p className="text-sm font-semibold text-brand-700">
            Drag &amp; drop your song here, or click to browse
          </p>
          <p className="text-xs text-brand-500">MP3, M4A, WAV, AAC, OGG, FLAC — up to 500 MB</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXT.join(',')}
        className="sr-only"
        aria-hidden="true"
        onChange={handleInputChange}
      />

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
          onClick={handleContinue}
          disabled={!canContinue}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Continue to Person Selection
        </button>
      </div>
    </div>
  )
}
