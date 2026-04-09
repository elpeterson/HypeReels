/**
 * Session authentication plugin.
 *
 * Validates the Bearer token from the Authorization header against the
 * sessions table. Attaches session row to request for downstream handlers.
 *
 * Returns:
 *  - 401 if no token is provided
 *  - 404 if session token is not found
 *  - 410 if session is deleted / expired
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { query } from '../db/client.js';

export interface SessionRow {
  id: string;
  token: string;
  status: 'active' | 'locked' | 'complete' | 'deleted';
  current_step: string;
  person_of_interest_id: string | null;
  created_at: Date;
  last_activity_at: Date;
  deleted_at: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow;
  }
}

const sessionAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('session', null);

  fastify.addHook(
    'preHandler',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Skip non-session routes
      const routeUrl = request.routeOptions?.url ?? '';
      if (!routeUrl.includes('/sessions/')) return;

      const auth = request.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: {
            code: 'MISSING_TOKEN',
            message: 'Authorization: Bearer <token> header is required.',
          },
        });
      }

      const token = auth.slice(7).trim();

      const result = await query<SessionRow>(
        `SELECT id, token, status, current_step, person_of_interest_id,
                created_at, last_activity_at, deleted_at
         FROM sessions
         WHERE token = $1
         LIMIT 1`,
        [token],
      );

      if (result.rowCount === 0) {
        return reply.code(404).send({
          error: {
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found. Please start over.',
          },
        });
      }

      const session = result.rows[0]!;

      if (session.status === 'deleted') {
        return reply.code(410).send({
          error: {
            code: 'SESSION_GONE',
            message: 'Your session has expired or been deleted. Please start over.',
          },
        });
      }

      request.session = session;

      // Touch last_activity_at (fire-and-forget — don't block the request)
      query(
        `UPDATE sessions SET last_activity_at = NOW() WHERE id = $1`,
        [session.id],
      ).catch((err) => request.log.error({ err }, 'Failed to update last_activity_at'));
    },
  );
};

// fastify-plugin unwraps the scope so the decorator is available app-wide
export default fp(sessionAuthPlugin, { name: 'sessionAuth' });
