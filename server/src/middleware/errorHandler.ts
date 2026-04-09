/**
 * Global error handler plugin for Fastify.
 * Normalises all errors to the standard { error: { code, message, details? } } envelope.
 */
import type {
  FastifyPluginAsync,
  FastifyError,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler(
    (
      error: FastifyError | ZodError | Error,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      request.log.error({ err: error }, 'Request error');

      // Zod validation errors (from route schemas or manual parsing)
      if (error instanceof ZodError) {
        return reply.code(422).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed.',
            details: error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
        });
      }

      // Fastify schema validation errors (ajv)
      const fastifyErr = error as FastifyError;
      if (fastifyErr.validation) {
        return reply.code(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Request schema validation failed.',
            details: fastifyErr.validation,
          },
        });
      }

      // Fastify built-in HTTP errors (e.g. 404 from reply.code(404).send())
      if (fastifyErr.statusCode) {
        return reply.code(fastifyErr.statusCode).send({
          error: {
            code: fastifyErr.code ?? 'HTTP_ERROR',
            message: fastifyErr.message,
          },
        });
      }

      // Unhandled errors → 500
      return reply.code(500).send({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message:
            process.env['NODE_ENV'] === 'production'
              ? 'An unexpected error occurred.'
              : error.message,
        },
      });
    },
  );

  // Handle 404 from route not found
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found.`,
      },
    });
  });
};

export default fp(errorHandlerPlugin, { name: 'errorHandler' });
