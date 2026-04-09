-- Migration 002: Rename r2_key → minio_key throughout
-- Applies to existing databases that were bootstrapped from the old schema.sql.
-- Safe to re-run: each ALTER TABLE is guarded by a column-existence check.

DO $$
BEGIN
  -- clips.r2_key → minio_key
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clips' AND column_name = 'r2_key'
  ) THEN
    ALTER TABLE clips RENAME COLUMN r2_key TO minio_key;
  END IF;

  -- audio_tracks.r2_key → minio_key
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audio_tracks' AND column_name = 'r2_key'
  ) THEN
    ALTER TABLE audio_tracks RENAME COLUMN r2_key TO minio_key;
  END IF;

  -- generation_jobs.output_r2_key → output_minio_key
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generation_jobs' AND column_name = 'output_r2_key'
  ) THEN
    ALTER TABLE generation_jobs RENAME COLUMN output_r2_key TO output_minio_key;
  END IF;

  -- cleanup_failures.r2_key → minio_key
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cleanup_failures' AND column_name = 'r2_key'
  ) THEN
    ALTER TABLE cleanup_failures RENAME COLUMN r2_key TO minio_key;
  END IF;
END
$$;
