// ─────────────────────────────────────────────
// Domain types — derived from docs/architecture.md data models
// ─────────────────────────────────────────────

export type SessionState =
  | "uploading"
  | "detecting"
  | "analyzing"
  | "generating"
  | "ready"
  | "failed"
  | "expired";

export type ClipStatus = "uploading" | "ready" | "detection_failed";

export interface Highlight {
  highlight_id: string;
  start_ms: number;
  end_ms: number;
}

export interface Clip {
  clip_id: string;
  filename: string;
  duration_ms: number;
  size_bytes: number;
  thumbnail_key: string | null;
  thumbnail_url: string | null;
  status: ClipStatus;
  highlights: Highlight[];
}

export interface AudioTrack {
  audio_id: string;
  filename: string;
  duration_ms: number;
  size_bytes: number;
  object_key: string;
}

export interface Person {
  person_id: string;
  bbox: [number, number, number, number];
  thumbnail: string;
  thumbnail_url: string | null;
  confidence: number;
  appearances: Array<{ clip_id: string; timestamp_ms: number }>;
}

export interface Session {
  id: string;
  state: SessionState;
  created_at: number;
  clips: Clip[];
  audio: AudioTrack | null;
  person_id: string | null;
  reel_key: string | null;
  error: string | null;
}

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface JobProgress {
  job_id: string;
  status: JobStatus;
  stage: string;
  pct: number;
  message: string;
  updated_at: number;
  error?: string;
}

// ─────────────────────────────────────────────
// API response shapes
// ─────────────────────────────────────────────

export interface CreateSessionResponse {
  session_id: string;
}

export interface PresignedUploadResponse {
  clip_id?: string;
  audio_id?: string;
  upload_url: string;
  object_key: string;
}

export interface StartJobResponse {
  job_id: string;
}

export interface DownloadResponse {
  download_url: string;
}

// ─────────────────────────────────────────────
// UI state types
// ─────────────────────────────────────────────

export type UploadState =
  | "idle"
  | "validating"
  | "invalid"
  | "uploading"
  | "upload_error"
  | "complete";

export interface FileUploadEntry {
  file: File;
  clip_id?: string;
  state: UploadState;
  progress: number; // 0-100
  error?: string;
}

export type PersonSelectionState =
  | "processing"
  | "none_detected"
  | "low_confidence"
  | "partial"
  | "ready";

export type GenerationState =
  | "idle"
  | "queued"
  | "processing"
  | "completed"
  | "failed";
