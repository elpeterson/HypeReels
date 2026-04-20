/**
 * Cleanup Worker — BullMQ consumer + repeatable stale-session purge
 *
 * Two responsibilities:
 *
 * 1. CONSUMER: Processes individual cleanup jobs enqueued by:
 *    - POST /sessions/:id/download-initiated (5-minute delay)
 *    - POST /sessions/:id/done              (immediate)
 *    - DELETE /sessions/:id                 (immediate, start-over)
 *    - The repeatable stale-session scanner (ttl-expired)
 *
 * 2. REPEATABLE SCAN: Runs every 60 minutes (pattern: '0 * * * *').
 *    Queries PostgreSQL for stale sessions:
 *      a. status='complete' and completed_at > 24 hours ago (post-download cleanup)
 *      b. status='active'|'locked' and created_at > 48 hours ago (abandoned sessions)
 *    Enqueues a cleanup job for each stale session found.
 *
 * STORY-016: Ephemeral lifecycle — no session persists beyond 48 hours.
 */
import { Worker, Queue, type Job } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { cleanupSession } from '../lib/cleanup.js';
import { pool } from '../db/client.js';
import {
  QUEUE_CLEANUP,
  QUEUE_STALE_SESSIONS,
  type CleanupJobData,
} from '../jobs/queues.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const SESSION_TTL_HOURS = parseInt(process.env['SESSION_TTL_HOURS'] ?? '24', 10);
const ABANDONED_SESSION_HOURS = 48; // Always 48h regardless of SESSION_TTL_HOURS

// ─── Stale-session scanner ────────────────────────────────────────────────────

/**
 * Find sessions that have exceeded their TTL and enqueue cleanup jobs for them.
 * Called by the repeatable 'stale-sessions' job every hour.
 */
async function scanAndEnqueueStaleSessions(): Promise<{
  found: number;
  queued: number;
  failed: number;
}> {
  // Load the cleanup queue to enqueue individual session cleanup jobs
  const cleanupQueue = new Queue<CleanupJobData>(QUEUE_CLEANUP, {
    connection: getRedis(),
  });

  let found = 0;
  let queued = 0;
  let failed = 0;

  try {
    // Query for stale sessions in two categories
    const staleRes = await pool.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM sessions
       WHERE
         -- Post-download cleanup: completed more than SESSION_TTL_HOURS ago
         (status = 'complete'
          AND last_activity_at < NOW() - INTERVAL '${SESSION_TTL_HOURS} hours')
         OR
         -- Abandoned sessions: active/locked but older than 48 hours
         (status IN ('active', 'locked')
          AND created_at < NOW() - INTERVAL '${ABANDONED_SESSION_HOURS} hours')
       ORDER BY created_at ASC`,
    );

    found = staleRes.rowCount ?? 0;

    for (const session of staleRes.rows) {
      try {
        await cleanupQueue.add(
          `cleanup:${session.id}`,
          { sessionId: session.id, reason: 'ttl-expired' },
          {
            delay: 0,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { count: 200 },
            removeOnFail: { count: 200 },
            // Dedup: only one cleanup job per session in the queue at a time
            jobId: `cleanup:${session.id}`,
          },
        );
        queued++;
      } catch (err) {
        failed++;
        console.error(
          `Failed to enqueue cleanup for stale session ${session.id}:`,
          err,
        );
      }
    }
  } finally {
    await cleanupQueue.close();
  }

  return { found, queued, failed };
}

// ─── Individual cleanup job processor ────────────────────────────────────────

async function processCleanupJob(job: Job<CleanupJobData>): Promise<void> {
  const { sessionId, reason } = job.data;

  console.info(
    `Processing cleanup job for session ${sessionId} (reason: ${reason})`,
  );

  await job.updateProgress(10);

  const result = await cleanupSession(sessionId);

  await job.updateProgress(100);

  console.info(
    `Cleanup complete for session ${sessionId}: ` +
      `${result.filesDeleted} files deleted, ` +
      `${result.failedKeys.length} failed, ` +
      `db=${result.dbDeleted}`,
  );

  if (result.failedKeys.length > 0) {
    // Partial success — log but don't re-throw (BullMQ would re-run the whole job)
    console.warn(
      `Cleanup for ${sessionId} had ${result.failedKeys.length} MinIO deletion failures. ` +
        `MinIO ILM policy will clean up orphaned objects within 48 hours.`,
    );
  }
}

// ─── Stale-session scan job processor ────────────────────────────────────────

async function processStaleSessionScan(): Promise<void> {
  console.info('Starting stale session scan…');
  const { found, queued, failed } = await scanAndEnqueueStaleSessions();
  console.info(
    `Stale session scan complete: ${found} found, ${queued} queued, ${failed} failed`,
  );
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function startCleanupWorker(): {
  cleanupWorker: Worker<CleanupJobData>;
  staleSessionsWorker: Worker<Record<string, never>>;
} {
  // Worker 1: Processes individual session cleanup jobs
  const cleanupWorker = new Worker<CleanupJobData>(
    QUEUE_CLEANUP,
    processCleanupJob,
    {
      connection: getRedis(),
      concurrency: 5, // cleanup is I/O-bound (MinIO + DB), moderate concurrency is fine
    },
  );

  cleanupWorker.on('completed', (job) => {
    console.info(`Cleanup job ${job.id} completed for session ${job.data.sessionId}`);
  });

  cleanupWorker.on('failed', (job, err) => {
    console.error(
      `Cleanup job ${job?.id} failed for session ${job?.data.sessionId}:`,
      err,
    );
  });

  cleanupWorker.on('error', (err) => {
    console.error('CleanupWorker error:', err);
  });

  // Worker 2: Runs the repeatable stale-session scan
  const staleSessionsWorker = new Worker<Record<string, never>>(
    QUEUE_STALE_SESSIONS,
    processStaleSessionScan,
    {
      connection: getRedis(),
      concurrency: 1, // Only one scan at a time
    },
  );

  staleSessionsWorker.on('completed', (job) => {
    console.info(`Stale sessions scan job ${job.id} completed`);
  });

  staleSessionsWorker.on('failed', (job, err) => {
    console.error(`Stale sessions scan job ${job?.id} failed:`, err);
  });

  staleSessionsWorker.on('error', (err) => {
    console.error('StaleSessionsWorker error:', err);
  });

  // Schedule the repeatable stale-session scan (every 60 minutes)
  const staleSessionsQueue = new Queue<Record<string, never>>(QUEUE_STALE_SESSIONS, {
    connection: getRedis(),
  });

  staleSessionsQueue
    .add(
      'scan-stale-sessions',
      {},
      {
        repeat: { pattern: '0 * * * *' }, // every hour at :00
        jobId: 'stale-sessions-repeatable',
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    )
    .catch((err) => {
      console.error('Failed to register repeatable stale-session scan job:', err);
    })
    .finally(() => {
      staleSessionsQueue.close().catch(() => undefined);
    });

  return { cleanupWorker, staleSessionsWorker };
}
