/**
 * Person Detection Worker (Node.js coordinator)
 *
 * Consumes the `person-detection` BullMQ queue.
 *
 * Pipeline:
 *  1. Mark clip.detection_status = 'processing'
 *  2. Generate a presigned MinIO download URL for the clip
 *  3. POST to the InsightFace Python worker via lib/insightface.ts
 *  4. Persist the returned persons to the person_detections table
 *  5. Mark clip.detection_status = 'complete'
 *  6. If all clips in the session are done → publish 'detection-complete' SSE event
 *
 * On error:
 *  - Mark clip.detection_status = 'failed'
 *  - Publish 'detection-failed' SSE event
 *  - Re-throw so BullMQ marks the job failed and handles retries
 *
 * InsightFace is stateless per-request — no collection lifecycle management
 * (no createFaceCollection / deleteFaceCollection calls are needed).
 * The session_id is passed as collection_id so the Python worker can group
 * embeddings for cross-clip identity clustering within a session.
 *
 * See docs/architecture.md — ADR-013: GPU reserved for Frigate NVR.
 * InsightFace runs CPU-only on Quorra; expect ~30–60 s per clip-minute.
 */
import { Worker, type Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { query, withTransaction } from '../db/client.js';
import { getRedis } from '../lib/redis.js';
import { getSignedDownloadUrl } from '../lib/storage.js';
import { detectPersonsInClip } from '../lib/insightface.js';
import { publishSSEEvent } from '../lib/sse.js';
import {
  QUEUE_PERSON_DETECTION,
  type PersonDetectionJobData,
} from '../jobs/queues.js';

// Presigned URL TTL must exceed the InsightFace processing window.
// CPU-only inference on a long clip can take several minutes.
const PRESIGNED_TTL_SECONDS = 3600; // 1 hour

// ─── Core processor ──────────────────────────────────────────────────────────

async function processPersonDetection(
  job: Job<PersonDetectionJobData>,
): Promise<void> {
  const { sessionId, clipId, minioKey } = job.data;

  // 1. Mark clip as processing
  await query(
    `UPDATE clips SET detection_status = 'processing' WHERE id = $1`,
    [clipId],
  );

  try {
    // 2. Generate a presigned URL so the Python worker can download the clip
    const clipPresignedUrl = await getSignedDownloadUrl(
      minioKey,
      PRESIGNED_TTL_SECONDS,
    );

    await job.updateProgress(10);

    // 3. Call the InsightFace Python worker
    const result = await detectPersonsInClip(sessionId, clipId, clipPresignedUrl);

    await job.updateProgress(80);

    // 4. Persist person_detections rows in a transaction, then mark clip complete
    await withTransaction(async (client) => {
      for (const person of result.persons) {
        await client.query(
          `INSERT INTO person_detections
             (id, session_id, clip_id, person_ref_id, thumbnail_url, confidence, appearances)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            sessionId,
            clipId,
            person.person_ref_id,
            person.thumbnail_url,
            person.confidence,
            JSON.stringify(person.appearances),
          ],
        );
      }

      // 5. Mark clip complete
      await client.query(
        `UPDATE clips SET detection_status = 'complete' WHERE id = $1`,
        [clipId],
      );
    });

    await job.updateProgress(95);

    // 6. Check whether all valid clips in the session have been processed
    const pendingRes = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM clips
       WHERE session_id = $1
         AND status = 'valid'
         AND detection_status NOT IN ('complete', 'failed')`,
      [sessionId],
    );

    const remaining = parseInt(pendingRes.rows[0]?.count ?? '0', 10);

    // Publish per-clip completion event (frontend updates the clip card)
    await publishSSEEvent(sessionId, {
      type: 'detection-complete',
      clip_id: clipId,
      persons: result.persons.map((p) => ({
        person_ref_id: p.person_ref_id,
        thumbnail_url: p.thumbnail_url,
        confidence: p.confidence,
        appearances: p.appearances,
      })),
      all_clips_done: remaining === 0,
    });

    await job.updateProgress(100);
  } catch (err) {
    // Mark clip as failed
    await query(
      `UPDATE clips SET detection_status = 'failed' WHERE id = $1`,
      [clipId],
    );

    // Publish failure SSE so the frontend can surface an error for this clip
    await publishSSEEvent(sessionId, {
      type: 'detection-failed',
      clip_id: clipId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err; // Re-throw so BullMQ marks the job failed and applies retry policy
  }
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function startPersonDetectionWorker(): Worker<PersonDetectionJobData> {
  const worker = new Worker<PersonDetectionJobData>(
    QUEUE_PERSON_DETECTION,
    processPersonDetection,
    {
      connection: getRedis(),
      // InsightFace is CPU-bound on Quorra; keep concurrency low to avoid
      // saturating the machine that also runs Frigate NVR.
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    console.info(
      `Person detection job ${job.id} completed for clip ${job.data.clipId}`,
    );
  });

  worker.on('failed', (job, err) => {
    console.error(
      `Person detection job ${job?.id} failed for clip ${job?.data.clipId}:`,
      err,
    );
  });

  worker.on('error', (err) => {
    console.error('PersonDetectionWorker error:', err);
  });

  return worker;
}
