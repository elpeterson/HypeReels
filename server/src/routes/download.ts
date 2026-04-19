/**
 * Download & cleanup routes:
 *   GET  /sessions/:id/reel                (redirect or JSON — triggers cleanup)
 *   POST /sessions/:id/download-initiated  (explicit 5-minute grace period cleanup)
 *   POST /sessions/:id/done               (immediate cleanup)
 */
import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client.js';
import { enqueueCleanup } from '../jobs/producers.js';

// Grace period before storage deletion after reel is served
const DOWNLOAD_GRACE_MS = 5 * 60 * 1000; // 5 minutes

const downloadRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /sessions/:id/reel ────────────────────────────────
  // Ephemeral lifecycle: on successful serve → enqueue cleanup with grace period.
  // NEVER deletes assets before the reel has been successfully served.
  //
  // Content negotiation:
  //   Accept: text/html or */* (browser) → HTTP 302 redirect to presigned URL
  //   Accept: application/json           → HTTP 200 with { download_url, expires_at }
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/reel',
    async (request, reply) => {
      const { session } = request;

      const jobRes = await query<{ output_url: string | null; status: string; completed_at: Date | null }>(
        `SELECT status, output_url, completed_at FROM generation_jobs
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

      const { output_url, completed_at } = jobRes.rows[0]!;
      if (!output_url) {
        return reply.code(404).send({
          error: {
            code: 'REEL_URL_MISSING',
            message: 'Download URL is not available. Please try again.',
          },
        });
      }

      // Ephemeral lifecycle: schedule cleanup with grace period now that the
      // reel URL has been successfully served. This is a fire-and-forget enqueue
      // — failure to enqueue is logged but does NOT prevent the download.
      enqueueCleanup(session.id, 'download-initiated', DOWNLOAD_GRACE_MS).catch(
        (err) => request.log.error({ err, session_id: session.id }, 'Failed to enqueue post-reel cleanup'),
      );

      // Content negotiation: JSON clients get a structured response,
      // browser clients get a 302 redirect.
      const acceptHeader = request.headers.accept ?? '';
      if (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html')) {
        // Approximate expiry: completed_at + 2 hours (DOWNLOAD_URL_TTL_SECONDS in assemblyWorker)
        const expiresAt = completed_at
          ? new Date(completed_at.getTime() + 2 * 60 * 60 * 1000).toISOString()
          : null;
        return reply.code(200).send({
          download_url: output_url,
          expires_at: expiresAt,
        });
      }

      // Default: redirect to the pre-signed MinIO URL
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
