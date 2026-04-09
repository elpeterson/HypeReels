-- Migration 001: Initial schema
-- All tables use CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- so this migration is safe to apply to an existing database.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────
-- Sessions
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token                 UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'locked', 'complete', 'deleted')),
  current_step          TEXT NOT NULL DEFAULT 'upload-clips'
                          CHECK (current_step IN (
                            'upload-clips', 'upload-audio', 'detect-persons',
                            'mark-highlights', 'review', 'generate', 'download'
                          )),
  person_of_interest_id UUID,    -- FK added after person_detections is created
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
CREATE INDEX IF NOT EXISTS idx_sessions_status_activity ON sessions (status, last_activity_at)
  WHERE status != 'deleted';

-- ─────────────────────────────────────────────────────────
-- Clips
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clips (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_filename   TEXT NOT NULL,
  minio_key           TEXT NOT NULL,
  file_size_bytes     BIGINT NOT NULL,
  duration_ms         INTEGER,
  thumbnail_url       TEXT,
  status              TEXT NOT NULL DEFAULT 'uploading'
                        CHECK (status IN ('uploading', 'validating', 'valid', 'invalid')),
  validation_error    TEXT,
  detection_status    TEXT NOT NULL DEFAULT 'pending'
                        CHECK (detection_status IN ('pending', 'processing', 'complete', 'failed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clips_session_id ON clips (session_id);

-- ─────────────────────────────────────────────────────────
-- Audio Tracks
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audio_tracks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_filename   TEXT NOT NULL,
  minio_key           TEXT NOT NULL,
  file_size_bytes     BIGINT NOT NULL,
  duration_ms         INTEGER,
  status              TEXT NOT NULL DEFAULT 'uploading'
                        CHECK (status IN ('uploading', 'validating', 'valid', 'invalid')),
  analysis_status     TEXT NOT NULL DEFAULT 'pending'
                        CHECK (analysis_status IN ('pending', 'processing', 'complete', 'failed')),
  analysis_json       JSONB,
  waveform_url        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_tracks_session_id ON audio_tracks (session_id);

-- ─────────────────────────────────────────────────────────
-- Person Detections
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS person_detections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  clip_id         UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  person_ref_id   UUID NOT NULL,
  thumbnail_url   TEXT NOT NULL,
  confidence      REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  appearances     JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_person_detections_session_id ON person_detections (session_id);
CREATE INDEX IF NOT EXISTS idx_person_detections_clip_id ON person_detections (clip_id);
CREATE INDEX IF NOT EXISTS idx_person_detections_ref_id ON person_detections (session_id, person_ref_id);

-- Add deferred FK from sessions to person_detections
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_sessions_person_of_interest'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT fk_sessions_person_of_interest
      FOREIGN KEY (person_of_interest_id)
      REFERENCES person_detections(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────
-- Highlights
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlights (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  clip_id      UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  start_ms     INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms       INTEGER NOT NULL,
  CONSTRAINT highlights_duration CHECK (end_ms - start_ms >= 1000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_highlights_clip_id ON highlights (clip_id);
CREATE INDEX IF NOT EXISTS idx_highlights_session_id ON highlights (session_id);

-- ─────────────────────────────────────────────────────────
-- Generation Jobs
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'processing', 'rendering', 'complete', 'failed', 'cancelled')),
  bullmq_job_id        TEXT,
  edl_json             JSONB,
  output_minio_key     TEXT,
  output_url           TEXT,
  output_duration_ms   INTEGER,
  output_size_bytes    BIGINT,
  error_message        TEXT,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_session_id ON generation_jobs (session_id);

-- ─────────────────────────────────────────────────────────
-- Cleanup Failures (audit / alert table)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cleanup_failures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT NOT NULL,
  minio_key      TEXT,
  error          TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cleanup_failures_unresolved
  ON cleanup_failures (created_at)
  WHERE resolved_at IS NULL;
