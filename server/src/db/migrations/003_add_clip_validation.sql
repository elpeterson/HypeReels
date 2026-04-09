-- Migration 003: Ensure clips.validation_error column exists
-- The column was present in some schema versions. This migration adds it
-- idempotently for databases that may be missing it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clips' AND column_name = 'validation_error'
  ) THEN
    ALTER TABLE clips ADD COLUMN validation_error TEXT;
  END IF;
END
$$;
