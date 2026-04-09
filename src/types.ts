// ─── Domain types ────────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'locked' | 'complete' | 'deleted'

export type Step =
  | 'upload-clips'
  | 'upload-audio'
  | 'detect-persons'
  | 'mark-highlights'
  | 'review'
  | 'generate'
  | 'download'

export type ClipStatus = 'uploading' | 'validating' | 'valid' | 'invalid'
export type DetectionStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type AudioStatus = 'uploading' | 'validating' | 'valid' | 'invalid'
export type AnalysisStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type JobStatus =
  | 'queued'
  | 'processing'
  | 'rendering'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type GenerationStep =
  | 'analysing'
  | 'selecting'
  | 'sequencing'
  | 'rendering'
  | 'finalising'

export interface Clip {
  id: string
  sessionId: string
  originalFilename: string
  fileSizeBytes: number
  durationMs: number | null
  thumbnailUrl: string | null
  status: ClipStatus
  validationError: string | null
  detectionStatus: DetectionStatus
  /** Upload progress 0–100, only relevant when status === 'uploading' */
  uploadProgress: number
  /** Client-side error message for upload failures before reaching server */
  uploadError: string | null
}

export interface AudioTrack {
  id: string
  sessionId: string
  originalFilename: string
  fileSizeBytes: number
  durationMs: number | null
  status: AudioStatus
  analysisStatus: AnalysisStatus
  waveformUrl: string | null
  envelope: number[] | null
  bpm: number | null
  uploadProgress: number
  uploadError: string | null
}

export interface Appearance {
  startMs: number
  endMs: number
  boundingBox: { left: number; top: number; width: number; height: number }
}

export interface Person {
  id: string
  sessionId: string
  clipId: string
  personRefId: string
  thumbnailUrl: string
  confidence: number
  appearances: Appearance[]
}

/** A person grouped cross-clip by personRefId */
export interface PersonGroup {
  personRefId: string
  thumbnailUrl: string
  confidence: number
  clipIds: string[]
  totalAppearances: number
}

export interface Highlight {
  id: string
  sessionId: string
  clipId: string
  startMs: number
  endMs: number
}

export interface GenerationJob {
  id: string
  sessionId: string
  status: JobStatus
  step: GenerationStep | null
  progressPct: number
  downloadUrl: string | null
  durationMs: number | null
  sizeBytes: number | null
  errorMessage: string | null
}

export interface SessionState {
  sessionId: string
  token: string
  status: SessionStatus
  currentStep: Step
  clips: Clip[]
  audio: AudioTrack | null
  persons: Person[]
  selectedPersonRefId: string | null
  highlights: Highlight[]
  generationJob: GenerationJob | null
}

// ─── API response shapes ─────────────────────────────────────────────────────

export interface CreateSessionResponse {
  session_id: string
  token: string
}

export interface SessionStateResponse {
  session_id: string
  status: SessionStatus
  current_step: Step
  clips: ApiClip[]
  audio: ApiAudio | null
  persons: ApiPerson[]
  selected_person_ref_id: string | null
  highlights: ApiHighlight[]
  generation_job: ApiGenerationJob | null
}

export interface ApiClip {
  id: string
  session_id: string
  original_filename: string
  file_size_bytes: number
  duration_ms: number | null
  thumbnail_url: string | null
  status: ClipStatus
  validation_error: string | null
  detection_status: DetectionStatus
}

export interface ApiAudio {
  id: string
  session_id: string
  original_filename: string
  file_size_bytes: number
  duration_ms: number | null
  status: AudioStatus
  analysis_status: AnalysisStatus
  waveform_url: string | null
  bpm: number | null
  envelope: number[] | null
}

export interface ApiPerson {
  id: string
  session_id: string
  clip_id: string
  person_ref_id: string
  thumbnail_url: string
  confidence: number
  appearances: Appearance[]
}

export interface ApiHighlight {
  id: string
  session_id: string
  clip_id: string
  start_ms: number
  end_ms: number
}

export interface ApiGenerationJob {
  id: string
  session_id: string
  status: JobStatus
  step: GenerationStep | null
  progress_pct: number
  download_url: string | null
  duration_ms: number | null
  size_bytes: number | null
  error_message: string | null
}

export interface UploadClipResponse {
  clip_id: string
}

export interface UploadAudioResponse {
  audio_id: string
}

export interface GenerateResponse {
  job_id: string
}

// ─── SSE event payloads ──────────────────────────────────────────────────────

export type SSEEventType =
  | 'clip-validated'
  | 'clip-validation-failed'
  | 'audio-validated'
  | 'audio-analysed'
  | 'audio-analysis-failed'
  | 'detection-complete'
  | 'detection-failed'
  | 'generation-progress'
  | 'generation-complete'
  | 'generation-failed'

export interface SSEClipValidated {
  type: 'clip-validated'
  clip_id: string
  thumbnail_url: string
  duration_ms: number
}

export interface SSEClipValidationFailed {
  type: 'clip-validation-failed'
  clip_id: string
  error: string
}

export interface SSEAudioValidated {
  type: 'audio-validated'
  audio_id: string
  duration_ms: number
}

export interface SSEAudioAnalysed {
  type: 'audio-analysed'
  audio_id: string
  bpm: number
  waveform_url: string
  envelope: number[]
}

export interface SSEAudioAnalysisFailed {
  type: 'audio-analysis-failed'
  audio_id: string
  error: string
}

export interface SSEDetectionComplete {
  type: 'detection-complete'
  clip_id: string
  persons: ApiPerson[]
}

export interface SSEDetectionFailed {
  type: 'detection-failed'
  clip_id: string
  error: string
}

export interface SSEGenerationProgress {
  type: 'generation-progress'
  job_id: string
  step: GenerationStep
  pct: number
}

export interface SSEGenerationComplete {
  type: 'generation-complete'
  job_id: string
  download_url: string
  duration_ms: number
  size_bytes: number
}

export interface SSEGenerationFailed {
  type: 'generation-failed'
  job_id: string
  error: string
}

export type SSEEvent =
  | SSEClipValidated
  | SSEClipValidationFailed
  | SSEAudioValidated
  | SSEAudioAnalysed
  | SSEAudioAnalysisFailed
  | SSEDetectionComplete
  | SSEDetectionFailed
  | SSEGenerationProgress
  | SSEGenerationComplete
  | SSEGenerationFailed
