/**
 * Person detection routes:
 *   GET  /sessions/:id/persons
 *   PUT  /sessions/:id/person-of-interest
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';

const SetPersonOfInterestBody = z.object({
  person_ref_id: z.string().uuid().nullable(),
});

const personsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /sessions/:id/persons ─────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/persons',
    async (request, reply) => {
      const { session } = request;

      // Group by person_ref_id and aggregate clip appearances
      const personsRes = await query(
        `SELECT
           person_ref_id,
           MAX(thumbnail_url) AS thumbnail_url,
           MAX(confidence)    AS confidence,
           JSON_AGG(
             JSON_BUILD_OBJECT(
               'detection_id', id,
               'clip_id', clip_id,
               'appearances', appearances
             )
             ORDER BY confidence DESC
           ) AS clip_appearances
         FROM person_detections
         WHERE session_id = $1
         GROUP BY person_ref_id
         ORDER BY MAX(confidence) DESC`,
        [session.id],
      );

      return reply.send({
        persons: personsRes.rows,
        person_of_interest_id: session.person_of_interest_id,
      });
    },
  );

  // ── PUT /sessions/:id/person-of-interest ──────────────────
  fastify.put<{ Params: { id: string } }>(
    '/sessions/:id/person-of-interest',
    async (request, reply) => {
      const { session } = request;

      const body = SetPersonOfInterestBody.parse(request.body);

      if (body.person_ref_id !== null) {
        // Verify the person belongs to this session
        const personRes = await query(
          `SELECT id FROM person_detections
           WHERE session_id = $1 AND person_ref_id = $2
           LIMIT 1`,
          [session.id, body.person_ref_id],
        );

        if (personRes.rowCount === 0) {
          return reply.code(404).send({
            error: {
              code: 'PERSON_NOT_FOUND',
              message: 'Person not found in this session.',
            },
          });
        }

        const detectionId = personRes.rows[0]!.id as string;

        await query(
          `UPDATE sessions SET person_of_interest_id = $1 WHERE id = $2`,
          [detectionId, session.id],
        );
      } else {
        // Clear person of interest
        await query(
          `UPDATE sessions SET person_of_interest_id = NULL WHERE id = $1`,
          [session.id],
        );
      }

      return reply.send({ person_of_interest_id: body.person_ref_id });
    },
  );
};

export default personsRoutes;
