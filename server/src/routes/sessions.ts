/**
 * Session routes:
 *   POST   /sessions
 *   GET    /sessions/:id/state
 *   DELETE /sessions/:id
 *   GET    /sessions/:id/events  (SSE)
 */
import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client.js';
import { addSSEConnection } from '../lib/sse.js';
import { enqueueCleanup } from '../jobs/producers.js';

const sessionsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /sessions ────────────────────────────────────────
  fastify.post('/sessions', async (_request, reply) => {
    const result = await query<{ id: string; token: string }>(
      `INSERT INTO sessions DEFAULT VALUES
       RETURNING id, token`,
    );

    const session = result.rows[0]!;

    return reply.code(201).send({
      session_id: session.id,
      token: session.token,
    });
  });

  // ── GET /sessions/:id/state ───────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/state',
    async (request, reply) => {
      const { session } = request;

      // Load related counts / metadata for step-restoration
      const [clipsRes, audioRes, personsRes, jobRes] = await Promise.all([
        query(
          `SELECT id, original_filename, status, detection_status,
                  thumbnail_url, duration_ms, file_size_bytes, validation_error
           FROM clips WHERE session_id = $1 ORDER BY created_at`,
          [session.id],
        ),
        query(
          `SELECT id, original_filename, status, analysis_status,
                  duration_ms, waveform_url, file_size_bytes
           FROM audio_tracks WHERE session_id = $1 ORDER BY created_at LIMIT 1`,
          [session.id],
        ),
        query(
          `SELECT DISTINCT ON (person_ref_id)
                  id, person_ref_id, thumbnail_url, confidence, appearances, clip_id
           FROM person_detections WHERE session_id = $1
           ORDER BY person_ref_id, confidence DESC`,
          [session.id],
        ),
        query(
          `SELECT id, status, error_message, output_url, output_duration_ms, output_size_bytes
           FROM generation_jobs WHERE session_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [session.id],
        ),
      ]);

      return reply.send({
        session_id: session.id,
        status: session.status,
        current_step: session.current_step,
        person_of_interest_id: session.person_of_interest_id,
        clips: clipsRes.rows,
        audio: audioRes.rows[0] ?? null,
        persons: personsRes.rows,
        latest_job: jobRes.rows[0] ?? null,
      });
    },
  );

  // ── DELETE /sessions/:id ──────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    async (request, reply) => {
      const { session } = request;

      await enqueueCleanup(session.id, 'start-over');

      return reply.code(202).send({
        message: 'Session cleanup has been initiated.',
      });
    },
  );

  // ── GET /sessions/:id/events (SSE) ────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/events',
    async (request, reply) => {
      const { session } = request;

      // Prevent Fastify from auto-closing the response
      reply.hijack();

      const cleanup = await addSSEConnection(session.id, reply);

      request.raw.on('close', () => {
        cleanup().catch((err) =>
          request.log.error({ err }, 'SSE cleanup error'),
        );
      });

      request.raw.on('error', () => {
        cleanup().catch((err) =>
          request.log.error({ err }, 'SSE cleanup error'),
        );
      });
    },
  );
};

export default sessionsRoutes;
