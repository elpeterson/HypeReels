/**
 * Generation routes:
 *   POST   /sessions/:id/generate
 *   GET    /sessions/:id/generate/:job_id
 *   DELETE /sessions/:id/generate/:job_id  (cancel)
 */
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { query, withTransaction } from '../db/client.js';
import { enqueueGeneration } from '../jobs/producers.js';
import { generationQueue } from '../jobs/queues.js';

const generationRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /sessions/:id/generate ───────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/generate',
    async (request, reply) => {
      const { session } = request;

      if (session.status === 'locked' || session.status === 'complete') {
        // Check if there's already an active job
        const existingJob = await query<{
          id: string;
          status: string;
        }>(
          `SELECT id, status FROM generation_jobs
           WHERE session_id = $1
             AND status NOT IN ('failed', 'cancelled')
           ORDER BY created_at DESC LIMIT 1`,
          [session.id],
        );

        if (existingJob.rowCount && existingJob.rowCount > 0) {
          return reply.code(409).send({
            error: {
              code: 'GENERATION_IN_PROGRESS',
              message: 'A generation job is already active for this session.',
              job_id: existingJob.rows[0]!.id,
            },
          });
        }
      }

      // Validate preconditions
      const [validClipsRes, audioRes] = await Promise.all([
        query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM clips
           WHERE session_id = $1 AND status = 'valid'`,
          [session.id],
        ),
        query<{ analysis_status: string }>(
          `SELECT analysis_status FROM audio_tracks
           WHERE session_id = $1 LIMIT 1`,
          [session.id],
        ),
      ]);

      const validClipCount = parseInt(
        validClipsRes.rows[0]?.count ?? '0',
        10,
      );

      if (validClipCount === 0) {
        return reply.code(422).send({
          error: {
            code: 'NO_VALID_CLIPS',
            message: 'At least one valid clip is required to generate a reel.',
          },
        });
      }

      if (audioRes.rowCount === 0) {
        return reply.code(422).send({
          error: {
            code: 'NO_AUDIO',
            message: 'An audio track is required to generate a reel.',
          },
        });
      }

      if (audioRes.rows[0]!.analysis_status !== 'complete') {
        return reply.code(422).send({
          error: {
            code: 'AUDIO_ANALYSIS_PENDING',
            message: 'Audio analysis is not yet complete. Please wait.',
          },
        });
      }

      const jobId = randomUUID();

      await withTransaction(async (client) => {
        // Insert generation job
        await client.query(
          `INSERT INTO generation_jobs (id, session_id, status)
           VALUES ($1, $2, 'queued')`,
          [jobId, session.id],
        );

        // Lock the session
        await client.query(
          `UPDATE sessions SET status = 'locked', current_step = 'generate'
           WHERE id = $1`,
          [session.id],
        );
      });

      // Enqueue and store BullMQ job ID
      const bullJobId = await enqueueGeneration(session.id, jobId);

      await query(
        `UPDATE generation_jobs SET bullmq_job_id = $1 WHERE id = $2`,
        [bullJobId, jobId],
      );

      return reply.code(202).send({ job_id: jobId });
    },
  );

  // ── GET /sessions/:id/generate/:job_id ────────────────────
  fastify.get<{ Params: { id: string; job_id: string } }>(
    '/sessions/:id/generate/:job_id',
    async (request, reply) => {
      const { session } = request;
      const { job_id } = request.params;

      const jobRes = await query(
        `SELECT id, status, output_url, output_duration_ms, output_size_bytes,
                error_message, started_at, completed_at, created_at
         FROM generation_jobs
         WHERE id = $1 AND session_id = $2`,
        [job_id, session.id],
      );

      if (jobRes.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found.' },
        });
      }

      const job = jobRes.rows[0]!;

      // Attempt to get progress from BullMQ
      let progress: number | null = null;
      try {
        const bullJob = await generationQueue.getJob(job_id);
        if (bullJob) {
          const raw = bullJob.progress;
          progress = typeof raw === 'number' ? raw : null;
        }
      } catch {
        // Not critical — progress is a convenience field
      }

      return reply.send({
        ...job,
        progress_pct: progress,
      });
    },
  );

  // ── DELETE /sessions/:id/generate/:job_id (cancel) ────────
  fastify.delete<{ Params: { id: string; job_id: string } }>(
    '/sessions/:id/generate/:job_id',
    async (request, reply) => {
      const { session } = request;
      const { job_id } = request.params;

      const jobRes = await query<{
        id: string;
        status: string;
        bullmq_job_id: string | null;
      }>(
        `SELECT id, status, bullmq_job_id FROM generation_jobs
         WHERE id = $1 AND session_id = $2`,
        [job_id, session.id],
      );

      if (jobRes.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found.' },
        });
      }

      const job = jobRes.rows[0]!;

      if (!['queued', 'processing', 'rendering'].includes(job.status)) {
        return reply.code(409).send({
          error: {
            code: 'JOB_NOT_CANCELLABLE',
            message: `Job in status '${job.status}' cannot be cancelled.`,
          },
        });
      }

      // Attempt to remove from BullMQ queue (only works if still queued)
      if (job.bullmq_job_id) {
        try {
          const bullJob = await generationQueue.getJob(job.bullmq_job_id);
          await bullJob?.remove();
        } catch {
          // May have already started — that's ok
        }
      }

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE generation_jobs SET status = 'cancelled' WHERE id = $1`,
          [job.id],
        );
        await client.query(
          `UPDATE sessions SET status = 'active' WHERE id = $1`,
          [session.id],
        );
      });

      return reply.code(200).send({ message: 'Generation job cancelled.' });
    },
  );
};

export default generationRoutes;
