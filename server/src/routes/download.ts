/**
 * Download & cleanup routes:
 *   POST /sessions/:id/download-initiated
 *   POST /sessions/:id/done
 *   GET  /sessions/:id/reel  (redirect to signed URL)
 */
import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client.js';
import { enqueueCleanup } from '../jobs/producers.js';

// 5 minutes in milliseconds
const DOWNLOAD_GRACE_MS = 5 * 60 * 1000;

const downloadRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /sessions/:id/reel ────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/reel',
    async (request, reply) => {
      const { session } = request;

      const jobRes = await query<{ output_url: string | null; status: string }>(
        `SELECT status, output_url FROM generation_jobs
         WHERE session_id = $1 AND status = 'complete'
         ORDER BY created_at DESC LIMIT 1`,
        [session.id],
      );

      if (jobRes.rowCount === 0) {
        return reply.code(404).send({
          error: {
            code: 'REEL_NOT_READY',
            message: 'HypeReel is not yet ready for download.',
          },
        });
      }

      const { output_url } = jobRes.rows[0]!;
      if (!output_url) {
        return reply.code(404).send({
          error: {
            code: 'REEL_URL_MISSING',
            message: 'Download URL is not available. Please try again.',
          },
        });
      }

      // Redirect to the pre-signed R2 URL directly — no proxying through API
      return reply.redirect(302, output_url);
    },
  );

  // ── POST /sessions/:id/download-initiated ─────────────────
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/download-initiated',
    async (request, reply) => {
      const { session } = request;

      // Schedule cleanup after 5-minute grace period
      await enqueueCleanup(
        session.id,
        'download-initiated',
        DOWNLOAD_GRACE_MS,
      );

      // Move session to download step
      await query(
        `UPDATE sessions SET current_step = 'download' WHERE id = $1`,
        [session.id],
      );

      return reply.code(202).send({
        message: 'Download initiated. Session will be cleaned up in 5 minutes.',
      });
    },
  );

  // ── POST /sessions/:id/done ───────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/done',
    async (request, reply) => {
      const { session } = request;

      // Immediate cleanup (0 delay)
      await enqueueCleanup(session.id, 'done', 0);

      return reply.code(202).send({
        message: 'Thank you! Your HypeReel and all uploads are being permanently deleted.',
      });
    },
  );
};

export default downloadRoutes;
