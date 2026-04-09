/**
 * Highlight routes:
 *   PUT /sessions/:id/clips/:clip_id/highlights
 *   GET /sessions/:id/clips/:clip_id/highlights
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query, withTransaction } from '../db/client.js';

const HighlightSchema = z.object({
  start_ms: z.number().int().min(0),
  end_ms: z.number().int(),
});

const PutHighlightsBody = z.object({
  highlights: z.array(HighlightSchema),
});

const highlightsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── PUT /sessions/:id/clips/:clip_id/highlights ────────────
  fastify.put<{ Params: { id: string; clip_id: string } }>(
    '/sessions/:id/clips/:clip_id/highlights',
    async (request, reply) => {
      const { session } = request;
      const { clip_id } = request.params;

      if (session.status === 'locked') {
        return reply.code(409).send({
          error: { code: 'SESSION_LOCKED', message: 'Session is locked.' },
        });
      }

      // Verify clip belongs to session and get duration
      const clipRes = await query<{
        id: string;
        duration_ms: number | null;
        status: string;
      }>(
        `SELECT id, duration_ms, status FROM clips
         WHERE id = $1 AND session_id = $2`,
        [clip_id, session.id],
      );

      if (clipRes.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'CLIP_NOT_FOUND', message: 'Clip not found.' },
        });
      }

      const clip = clipRes.rows[0]!;
      if (clip.status !== 'valid') {
        return reply.code(409).send({
          error: {
            code: 'CLIP_NOT_VALID',
            message: 'Highlights can only be set on validated clips.',
          },
        });
      }

      const body = PutHighlightsBody.parse(request.body);

      // Validate each highlight range
      for (const h of body.highlights) {
        if (h.end_ms - h.start_ms < 1000) {
          return reply.code(422).send({
            error: {
              code: 'HIGHLIGHT_TOO_SHORT',
              message: `Highlight from ${h.start_ms}ms to ${h.end_ms}ms is too short (minimum 1 second).`,
            },
          });
        }
        if (clip.duration_ms !== null && h.end_ms > clip.duration_ms) {
          return reply.code(422).send({
            error: {
              code: 'HIGHLIGHT_OUT_OF_RANGE',
              message: `Highlight end_ms (${h.end_ms}) exceeds clip duration (${clip.duration_ms}ms).`,
            },
          });
        }
      }

      // Upsert: delete all existing highlights for this clip, then re-insert
      await withTransaction(async (client) => {
        await client.query(
          `DELETE FROM highlights WHERE clip_id = $1`,
          [clip_id],
        );

        for (const h of body.highlights) {
          await client.query(
            `INSERT INTO highlights (session_id, clip_id, start_ms, end_ms)
             VALUES ($1, $2, $3, $4)`,
            [session.id, clip_id, h.start_ms, h.end_ms],
          );
        }
      });

      // Return the saved highlights
      const savedRes = await query(
        `SELECT id, start_ms, end_ms FROM highlights
         WHERE clip_id = $1 ORDER BY start_ms`,
        [clip_id],
      );

      return reply.send({ highlights: savedRes.rows });
    },
  );

  // ── GET /sessions/:id/clips/:clip_id/highlights ────────────
  fastify.get<{ Params: { id: string; clip_id: string } }>(
    '/sessions/:id/clips/:clip_id/highlights',
    async (request, reply) => {
      const { session } = request;
      const { clip_id } = request.params;

      const clipCheck = await query(
        `SELECT id FROM clips WHERE id = $1 AND session_id = $2`,
        [clip_id, session.id],
      );

      if (clipCheck.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'CLIP_NOT_FOUND', message: 'Clip not found.' },
        });
      }

      const highlightsRes = await query(
        `SELECT id, start_ms, end_ms FROM highlights
         WHERE clip_id = $1 ORDER BY start_ms`,
        [clip_id],
      );

      return reply.send({ highlights: highlightsRes.rows });
    },
  );
};

export default highlightsRoutes;
