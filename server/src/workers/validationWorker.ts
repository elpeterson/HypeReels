/**
 * Validation Worker — BullMQ consumer for the 'clip-validation' queue
 *
 * Triggered immediately after a clip is uploaded to MinIO.
 * Jobs are enqueued by the clips upload route (POST /sessions/:id/clips).
 *
 * Validates:
 *   - MIME type is video/* (via file-type sniff on first bytes from MinIO)
 *   - Duration <= MAX_CLIP_DURATION_MS (env var, default 300_000 = 5 min)
 *   - File size <= MAX_CLIP_SIZE_BYTES (env var, default 500_000_000 = 500 MB)
 *
 * On success:
 *   - Updates clip status to 'valid'
 *   - Publishes SSE 'clip-ready' event
 *
 * On failure:
 *   - Updates clip status to 'invalid' with validation_error reason
 *   - Publishes SSE 'clip-invalid' event
 *
 * Duration detection: calls the Python worker POST /probe endpoint which
 * runs ffprobe on the provided presigned URL and returns metadata.
 * Falls back to null duration if the Python worker is unavailable.
 *
 * STORY-016: Part of the clip lifecycle — clips stuck in 'uploading' are
 * caught by the stale session TTL sweep (48h).
 */
import { Worker, type Job } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { query } from '../db/client.js';
import { getSignedDownloadUrl, storageClient, BUCKET } from '../lib/storage.js';
import { publishSSEEvent } from '../lib/sse.js';
import {
  QUEUE_CLIP_VALIDATION,
  type ClipValidationJobData,
} from '../jobs/queues.js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_CLIP_DURATION_MS = parseInt(
  process.env['MAX_CLIP_DURATION_MS'] ?? '300000',
  10,
); // 5 minutes
const MAX_CLIP_SIZE_BYTES = parseInt(
  process.env['MAX_CLIP_SIZE_BYTES'] ?? '500000000',
  10,
); // 500 MB
const PYTHON_WORKER_URL =
  process.env['PYTHON_WORKER_URL'] ?? 'http://python-workers:8000';
const PYTHON_TIMEOUT_MS = parseInt(
  process.env['PYTHON_WORKER_AUDIO_TIMEOUT_MS'] ?? '60000',
  10,
); // 1 minute for probe

// Presigned URL TTL for probe requests
const PROBE_URL_TTL_SECONDS = 900; // 15 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProbeResult {
  duration_ms: number | null;
  codec: string | null;
  width: number | null;
  height: number | null;
}

// ─── Core processor ──────────────────────────────────────────────────────────

async function processClipValidation(
  job: Job<ClipValidationJobData>,
): Promise<void> {
  const { sessionId, clipId, minioKey } = job.data;

  // Mark as validating
  await query(
    `UPDATE clips SET status = 'validating' WHERE id = $1 AND session_id = $2`,
    [clipId, sessionId],
  );

  await job.updateProgress(10);

  let validationError: string | null = null;
  let durationMs: number | null = null;
  let fileSizeBytes: number | null = null;

  try {
    // 1. Check file size from MinIO HEAD request (no download needed)
    try {
      const headResult = await storageClient.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: minioKey }),
      );
      fileSizeBytes = headResult.ContentLength ?? null;

      if (fileSizeBytes !== null && fileSizeBytes > MAX_CLIP_SIZE_BYTES) {
        validationError = `File too large: ${fileSizeBytes} bytes exceeds maximum of ${MAX_CLIP_SIZE_BYTES} bytes`;
      }

      // Check Content-Type from MinIO metadata as a quick MIME check
      const contentType = headResult.ContentType ?? '';
      if (validationError === null && !contentType.startsWith('video/')) {
        validationError = `Invalid content type: ${contentType}. Only video files are accepted.`;
      }
    } catch (err) {
      console.warn(
        `Failed to HEAD MinIO object ${minioKey} during validation:`,
        err,
      );
      // Non-fatal: continue with duration probe
    }

    await job.updateProgress(30);

    // 2. Probe duration via Python worker (if size check passed)
    if (validationError === null) {
      try {
        const presignedUrl = await getSignedDownloadUrl(
          minioKey,
          PROBE_URL_TTL_SECONDS,
        );

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PYTHON_TIMEOUT_MS);

        try {
          const response = await fetch(`${PYTHON_WORKER_URL}/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: presignedUrl }),
            signal: controller.signal,
          });

          if (response.ok) {
            const probeData = (await response.json()) as ProbeResult;
            durationMs = probeData.duration_ms;

            if (
              durationMs !== null &&
              durationMs > MAX_CLIP_DURATION_MS
            ) {
              validationError = `Clip too long: ${Math.round(durationMs / 1000)}s exceeds maximum of ${Math.round(MAX_CLIP_DURATION_MS / 1000)}s`;
            }
          } else {
            // Python probe failed — log but don't fail validation on probe error
            console.warn(
              `Python probe returned ${response.status} for clip ${clipId} — skipping duration check`,
            );
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        // Probe failure is non-fatal — we accept clips without duration if the probe is unavailable
        console.warn(
          `Probe failed for clip ${clipId} (will accept without duration):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await job.updateProgress(80);

    // 3. Apply result
    if (validationError !== null) {
      // Validation failed
      await query(
        `UPDATE clips
         SET status = 'invalid',
             validation_error = $1
         WHERE id = $2 AND session_id = $3`,
        [validationError, clipId, sessionId],
      );

      await publishSSEEvent(sessionId, {
        type: 'clip-invalid',
        clip_id: clipId,
        error: validationError,
      });
    } else {
      // Validation passed
      await query(
        `UPDATE clips
         SET status = 'valid',
             duration_ms = COALESCE($1::integer, duration_ms)
         WHERE id = $2 AND session_id = $3`,
        [durationMs ?? null, clipId, sessionId],
      );

      await publishSSEEvent(sessionId, {
        type: 'clip-ready',
        clip_id: clipId,
        duration_ms: durationMs,
      });
    }

    await job.updateProgress(100);
  } catch (err) {
    // Unexpected error — mark as invalid so the clip doesn't stay stuck in 'validating'
    const errorMessage =
      err instanceof Error ? err.message : 'Unexpected validation error';

    await query(
      `UPDATE clips
       SET status = 'invalid',
           validation_error = $1
       WHERE id = $2 AND session_id = $3`,
      [errorMessage, clipId, sessionId],
    ).catch((dbErr) =>
      console.error(
        `Failed to mark clip ${clipId} as invalid after error:`,
        dbErr,
      ),
    );

    await publishSSEEvent(sessionId, {
      type: 'clip-invalid',
      clip_id: clipId,
      error: errorMessage,
    }).catch(() => undefined);

    throw err; // Re-throw so BullMQ applies retry policy
  }
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function startValidationWorker(): Worker<ClipValidationJobData> {
  const worker = new Worker<ClipValidationJobData>(
    QUEUE_CLIP_VALIDATION,
    processClipValidation,
    {
      connection: getRedis(),
      concurrency: 10, // validation is I/O-bound (MinIO HEAD + short HTTP probe)
    },
  );

  worker.on('completed', (job) => {
    console.info(
      `Validation job ${job.id} completed for clip ${job.data.clipId}`,
    );
  });

  worker.on('failed', (job, err) => {
    console.error(
      `Validation job ${job?.id} failed for clip ${job?.data.clipId}:`,
      err,
    );
  });

  worker.on('error', (err) => {
    console.error('ValidationWorker error:', err);
  });

  return worker;
}
