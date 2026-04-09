/**
 * Audio Analysis Worker (Node.js coordinator)
 *
 * Consumes the `audio-analysis` BullMQ queue.
 *
 * Pipeline:
 *  1. Mark audio_track.analysis_status = 'processing'
 *  2. POST the MinIO presigned download URL to the Python audio-analysis service
 *     at PYTHON_WORKER_URL/analyse-audio (matches the pattern used by the
 *     Python assembly service — HTTP POST with JSON, poll-or-wait for result).
 *  3. Receive structured analysis JSON: { bpm, beats_ms, downbeats_ms,
 *     onsets_ms, energy_envelope, phrases }
 *  4. Persist analysis_json + set analysis_status = 'complete'
 *  5. Publish SSE event `audio-analysed` to the session channel
 *
 * The Python worker contract:
 *   POST PYTHON_WORKER_URL/analyse-audio
 *   Body: { audio_url: string, session_id: string, audio_track_id: string }
 *   Response (synchronous): { bpm, beats_ms, downbeats_ms, onsets_ms,
 *                             energy_envelope, phrases, duration_ms }
 *
 * The Python worker downloads the audio via `audio_url`, runs librosa analysis,
 * and returns the result synchronously (with a generous HTTP timeout).
 * For very long tracks the Python side should stream-process; the Node worker
 * waits up to PYTHON_TIMEOUT_MS for the response.
 */
import { Worker, type Job } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { query } from '../db/client.js';
import { getSignedDownloadUrl } from '../lib/storage.js';
import { publishSSEEvent } from '../lib/sse.js';
import {
  QUEUE_AUDIO_ANALYSIS,
  type AudioAnalysisJobData,
} from '../jobs/queues.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AudioAnalysisResult {
  bpm: number;
  beats_ms: number[];
  downbeats_ms: number[];
  onsets_ms: number[];
  /** Amplitude envelope sampled at ~10 Hz: array of [time_ms, amplitude] pairs */
  energy_envelope: Array<[number, number]>;
  /** Musical phrase boundaries in ms */
  phrases: Array<{ start_ms: number; end_ms: number; label?: string }>;
  duration_ms: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PYTHON_WORKER_URL = process.env['PYTHON_WORKER_URL'] ?? 'http://python-workers:8000';
const PYTHON_TIMEOUT_MS = parseInt(process.env['PYTHON_TIMEOUT_MS'] ?? '300000', 10); // 5 min
// Presigned URL TTL — must exceed the Python processing window
const PRESIGNED_TTL_SECONDS = 3600; // 1 hour

// ─── Core processor ──────────────────────────────────────────────────────────

async function processAudioAnalysis(
  job: Job<AudioAnalysisJobData>,
): Promise<void> {
  const { sessionId, audioTrackId, minioKey } = job.data;

  // 1. Mark as processing
  await query(
    `UPDATE audio_tracks
     SET analysis_status = 'processing'
     WHERE id = $1 AND session_id = $2`,
    [audioTrackId, sessionId],
  );

  try {
    // 2. Generate presigned URL so Python can download the file
    const audioUrl = await getSignedDownloadUrl(minioKey, PRESIGNED_TTL_SECONDS);

    await job.updateProgress(10);

    // 3. Call the Python audio-analysis service
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PYTHON_TIMEOUT_MS);

    let analysisResult: AudioAnalysisResult;
    try {
      const response = await fetch(`${PYTHON_WORKER_URL}/analyse-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: audioUrl,
          session_id: sessionId,
          audio_track_id: audioTrackId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'no body');
        throw new Error(
          `Python audio-analysis service returned HTTP ${response.status}: ${errText}`,
        );
      }

      analysisResult = (await response.json()) as AudioAnalysisResult;
    } finally {
      clearTimeout(timeoutId);
    }

    await job.updateProgress(80);

    // 4. Validate that the response has the required fields
    if (
      typeof analysisResult.bpm !== 'number' ||
      !Array.isArray(analysisResult.beats_ms)
    ) {
      throw new Error(
        'Invalid response from Python audio-analysis service: missing bpm or beats_ms',
      );
    }

    // 5. Persist to DB
    await query(
      `UPDATE audio_tracks
       SET analysis_status  = 'complete',
           analysis_json    = $1::jsonb,
           duration_ms      = COALESCE($2::integer, duration_ms)
       WHERE id = $3 AND session_id = $4`,
      [
        JSON.stringify(analysisResult),
        analysisResult.duration_ms ?? null,
        audioTrackId,
        sessionId,
      ],
    );

    await job.updateProgress(95);

    // 6. Publish SSE event
    await publishSSEEvent(sessionId, {
      type: 'audio-analysed',
      audio_track_id: audioTrackId,
      bpm: analysisResult.bpm,
      beats_count: analysisResult.beats_ms.length,
      duration_ms: analysisResult.duration_ms,
    });

    await job.updateProgress(100);
  } catch (err) {
    // Mark analysis as failed
    await query(
      `UPDATE audio_tracks
       SET analysis_status = 'failed'
       WHERE id = $1 AND session_id = $2`,
      [audioTrackId, sessionId],
    );

    await publishSSEEvent(sessionId, {
      type: 'audio-analysis-failed',
      audio_track_id: audioTrackId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err; // Re-throw so BullMQ marks the job as failed and handles retries
  }
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function startAudioAnalysisWorker(): Worker<AudioAnalysisJobData> {
  const worker = new Worker<AudioAnalysisJobData>(
    QUEUE_AUDIO_ANALYSIS,
    processAudioAnalysis,
    {
      connection: getRedis(),
      concurrency: 5, // audio analysis is CPU-bound in Python, keep Node side liberal
    },
  );

  worker.on('completed', (job) => {
    console.info(`Audio analysis job ${job.id} completed for track ${job.data.audioTrackId}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Audio analysis job ${job?.id} failed for track ${job?.data.audioTrackId}:`, err);
  });

  worker.on('error', (err) => {
    console.error('AudioAnalysisWorker error:', err);
  });

  return worker;
}
