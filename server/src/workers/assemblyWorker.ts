/**
 * Assembly Worker (Node.js coordinator)
 *
 * Consumes the `generation` BullMQ queue.
 *
 * Pipeline:
 *  1. Mark generation_job.status = 'processing'
 *  2. Gather all session data: clips, highlights, person_detections,
 *     audio analysis JSON
 *  3. POST to Python assembly service at PYTHON_WORKER_URL/assemble-reel
 *     — the Python service builds the EDL, renders with FFmpeg, and returns
 *       the output as a byte stream OR uploads to R2 directly and returns
 *       the R2 key + metadata.
 *  4. (When Python uploads directly) Record output_minio_key + generate a fresh
 *     presigned download URL, update generation_jobs to 'complete'
 *  5. Publish SSE event `generation-complete` with downloadUrl so the frontend
 *     can redirect the user immediately without polling
 *
 * Python assembly service contract:
 *   POST PYTHON_WORKER_URL/assemble-reel
 *   Body (JSON):
 *     {
 *       session_id, job_id,
 *       audio_minio_key,
 *       audio_analysis,       // full AudioAnalysisResult
 *       clips: [{
 *         clip_id, minio_key, duration_ms,
 *         highlights: [{ start_ms, end_ms }],
 *         person_appearances: [{ start_ms, end_ms, confidence }]
 *       }],
 *       person_of_interest_id,   // nullable UUID
 *       minio_endpoint,          // so Python can upload directly
 *       minio_access_key_id,
 *       minio_secret_access_key,
 *       minio_bucket,
 *       output_minio_key         // pre-computed key for Python to PUT the MP4
 *     }
 *   Response (synchronous, timeout = PYTHON_TIMEOUT_MS):
 *     {
 *       output_minio_key: string,  // echoed back
 *       output_size_bytes: number,
 *       output_duration_ms: number,
 *       edl_json: object           // edit decision list for audit
 *     }
 *
 * Python uploads the rendered MP4 directly to MinIO using the provided
 * credentials and the pre-computed output_minio_key.  This avoids piping
 * potentially gigabyte-sized video through the Node process.
 */
import { Worker, type Job } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { query, withTransaction } from '../db/client.js';
import { getSignedDownloadUrl, StorageKeys } from '../lib/storage.js';
import { publishSSEEvent } from '../lib/sse.js';
import {
  QUEUE_GENERATION,
  type GenerationJobData,
} from '../jobs/queues.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const PYTHON_WORKER_URL = process.env['PYTHON_WORKER_URL'] ?? 'http://python-workers:8000';
const PYTHON_TIMEOUT_MS = parseInt(process.env['PYTHON_TIMEOUT_MS'] ?? '900000', 10); // 15 min
// Signed URL TTL for the final download — 2 hours should be generous for MVP
const DOWNLOAD_URL_TTL_SECONDS = 7_200;

// ─── Row shapes ───────────────────────────────────────────────────────────────

interface ClipRow {
  id: string;
  minio_key: string;
  duration_ms: number | null;
  detection_status: string;
}

interface HighlightRow {
  clip_id: string;
  start_ms: number;
  end_ms: number;
}

interface PersonDetectionRow {
  clip_id: string;
  person_ref_id: string;
  confidence: number;
  appearances: Array<{ start_ms: number; end_ms: number; confidence?: number }>;
}

interface AudioTrackRow {
  id: string;
  minio_key: string;
  analysis_json: string | null; // JSONB comes back as parsed object from pg
  duration_ms: number | null;
}

interface PythonAssemblyResponse {
  output_minio_key: string;
  output_size_bytes: number;
  output_duration_ms: number;
  edl_json: Record<string, unknown>;
}

// ─── Core processor ──────────────────────────────────────────────────────────

async function processAssembly(
  job: Job<GenerationJobData>,
): Promise<void> {
  const { sessionId, jobId } = job.data;

  // 1. Mark job as processing
  await query(
    `UPDATE generation_jobs
     SET status = 'processing', started_at = NOW()
     WHERE id = $1 AND session_id = $2`,
    [jobId, sessionId],
  );

  try {
    await job.updateProgress(5);

    // 2. Load all session data in parallel
    const [clipsRes, audioRes, highlightsRes, personsRes, sessionRes] =
      await Promise.all([
        query<ClipRow>(
          `SELECT id, minio_key, duration_ms, detection_status
           FROM clips
           WHERE session_id = $1 AND status = 'valid'
           ORDER BY created_at`,
          [sessionId],
        ),
        query<AudioTrackRow>(
          `SELECT id, minio_key, analysis_json, duration_ms
           FROM audio_tracks
           WHERE session_id = $1 AND analysis_status = 'complete'
           ORDER BY created_at LIMIT 1`,
          [sessionId],
        ),
        query<HighlightRow>(
          `SELECT clip_id, start_ms, end_ms
           FROM highlights
           WHERE session_id = $1
           ORDER BY clip_id, start_ms`,
          [sessionId],
        ),
        query<PersonDetectionRow>(
          `SELECT clip_id, person_ref_id, confidence, appearances
           FROM person_detections
           WHERE session_id = $1
           ORDER BY confidence DESC`,
          [sessionId],
        ),
        query<{ person_of_interest_id: string | null }>(
          `SELECT person_of_interest_id FROM sessions WHERE id = $1`,
          [sessionId],
        ),
      ]);

    if (clipsRes.rowCount === 0) {
      throw new Error('No valid clips found for assembly');
    }
    if (audioRes.rowCount === 0) {
      throw new Error('No analysed audio track found for assembly');
    }

    const audio = audioRes.rows[0]!;
    const personOfInterestId = sessionRes.rows[0]?.person_of_interest_id ?? null;

    // Group highlights by clip_id
    const highlightsByClip = new Map<string, Array<{ start_ms: number; end_ms: number }>>();
    for (const h of highlightsRes.rows) {
      const arr = highlightsByClip.get(h.clip_id) ?? [];
      arr.push({ start_ms: h.start_ms, end_ms: h.end_ms });
      highlightsByClip.set(h.clip_id, arr);
    }

    // Group person appearances by clip_id
    const appearancesByClip = new Map<
      string,
      Array<{ start_ms: number; end_ms: number; confidence: number; person_ref_id: string }>
    >();
    for (const det of personsRes.rows) {
      const clip_id = det.clip_id;
      const arr = appearancesByClip.get(clip_id) ?? [];
      // appearances is stored as JSONB — pg returns it already parsed
      const parsed: Array<{ start_ms: number; end_ms: number; confidence?: number }> =
        typeof det.appearances === 'string'
          ? (JSON.parse(det.appearances) as typeof parsed)
          : (det.appearances as typeof parsed);

      for (const app of parsed) {
        arr.push({
          start_ms: app.start_ms,
          end_ms: app.end_ms,
          confidence: app.confidence ?? det.confidence,
          person_ref_id: det.person_ref_id,
        });
      }
      appearancesByClip.set(clip_id, arr);
    }

    // Pre-compute the output MinIO key
    const outputMinioKey = StorageKeys.generatedReel(sessionId, jobId);

    await job.updateProgress(20);

    // 3. Build Python request payload
    const clipsPayload = clipsRes.rows.map((clip) => ({
      clip_id: clip.id,
      minio_key: clip.minio_key,
      duration_ms: clip.duration_ms,
      highlights: highlightsByClip.get(clip.id) ?? [],
      person_appearances: appearancesByClip.get(clip.id) ?? [],
    }));

    const assemblyPayload = {
      session_id: sessionId,
      job_id: jobId,
      audio_minio_key: audio.minio_key,
      audio_analysis: audio.analysis_json,
      clips: clipsPayload,
      person_of_interest_id: personOfInterestId,
      // MinIO credentials so Python can upload the rendered file directly
      minio_endpoint: process.env['MINIO_ENDPOINT'],
      minio_access_key_id: process.env['MINIO_ACCESS_KEY_ID'],
      minio_secret_access_key: process.env['MINIO_SECRET_ACCESS_KEY'],
      minio_bucket: process.env['MINIO_BUCKET'],
      output_minio_key: outputMinioKey,
    };

    await job.updateProgress(25);

    // 4. Call Python assembly service (long-running, generous timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PYTHON_TIMEOUT_MS);

    let assemblyResult: PythonAssemblyResponse;
    try {
      // Mark as 'rendering' so the frontend can show appropriate progress
      await query(
        `UPDATE generation_jobs SET status = 'rendering' WHERE id = $1`,
        [jobId],
      );
      await publishSSEEvent(sessionId, {
        type: 'generation-progress',
        job_id: jobId,
        status: 'rendering',
        progress_pct: 30,
      });

      const response = await fetch(`${PYTHON_WORKER_URL}/assemble-reel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assemblyPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'no body');
        throw new Error(
          `Python assembly service returned HTTP ${response.status}: ${errText}`,
        );
      }

      assemblyResult = (await response.json()) as PythonAssemblyResponse;
    } finally {
      clearTimeout(timeoutId);
    }

    await job.updateProgress(90);

    // 5. Generate a fresh presigned download URL (stored in DB so GET /reel
    //    can redirect immediately without re-signing on every request — the
    //    URL TTL is 2 h which covers the typical download window).
    const downloadUrl = await getSignedDownloadUrl(
      assemblyResult.output_minio_key,
      DOWNLOAD_URL_TTL_SECONDS,
    );

    // 6. Persist result and mark complete (in a single transaction)
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE generation_jobs
         SET status              = 'complete',
             completed_at        = NOW(),
             output_minio_key    = $1,
             output_url          = $2,
             output_size_bytes   = $3,
             output_duration_ms  = $4,
             edl_json            = $5::jsonb
         WHERE id = $6 AND session_id = $7`,
        [
          assemblyResult.output_minio_key,
          downloadUrl,
          assemblyResult.output_size_bytes,
          assemblyResult.output_duration_ms,
          JSON.stringify(assemblyResult.edl_json),
          jobId,
          sessionId,
        ],
      );

      await client.query(
        `UPDATE sessions SET status = 'complete', current_step = 'download'
         WHERE id = $1`,
        [sessionId],
      );
    });

    await job.updateProgress(100);

    // 7. Publish SSE event so the frontend can redirect immediately
    await publishSSEEvent(sessionId, {
      type: 'generation-complete',
      job_id: jobId,
      download_url: downloadUrl,
      output_duration_ms: assemblyResult.output_duration_ms,
      output_size_bytes: assemblyResult.output_size_bytes,
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unknown assembly error';

    await query(
      `UPDATE generation_jobs
       SET status        = 'failed',
           completed_at  = NOW(),
           error_message = $1
       WHERE id = $2 AND session_id = $3`,
      [errorMessage, jobId, sessionId],
    );

    // Unlock the session so the user can retry
    await query(
      `UPDATE sessions SET status = 'active' WHERE id = $1`,
      [sessionId],
    );

    await publishSSEEvent(sessionId, {
      type: 'generation-failed',
      job_id: jobId,
      error: errorMessage,
    });

    throw err; // Let BullMQ handle retries
  }
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function startAssemblyWorker(): Worker<GenerationJobData> {
  const worker = new Worker<GenerationJobData>(
    QUEUE_GENERATION,
    processAssembly,
    {
      connection: getRedis(),
      concurrency: 2, // generation is resource-intensive
    },
  );

  worker.on('completed', (job) => {
    console.info(`Assembly job ${job.id} completed for session ${job.data.sessionId}`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `Assembly job ${job?.id} failed for session ${job?.data.sessionId}:`,
      err,
    );
  });

  worker.on('error', (err) => {
    console.error('AssemblyWorker error:', err);
  });

  return worker;
}
