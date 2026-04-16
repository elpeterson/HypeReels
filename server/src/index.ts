/**
 * HypeReels API Server — Fastify entry point.
 *
 * Boot order:
 *  1. Register plugins (cors, helmet, multipart, rate-limit)
 *  2. Register sessionAuth + errorHandler
 *  3. Register all route files
 *  4. Register /health and /metrics (outside session-auth)
 *  5. Register static file serving (React SPA from client-dist/)
 *  6. Initialise SSE Redis subscriber
 *  7. Start workers (person-detection, audio-analysis, assembly, cleanup)
 *  8. Listen
 *  9. Wire SIGTERM/SIGINT for graceful shutdown
 */
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { existsSync } from 'fs';
import * as promClient from 'prom-client';

import { runMigrations, waitForDatabase, pool } from './db/client.js';
import { closeRedis } from './lib/redis.js';
import { initSSESubscriber, closeSSESubscriber } from './lib/sse.js';
import { closeQueues } from './jobs/queues.js';

import sessionAuthPlugin from './middleware/sessionAuth.js';
import errorHandlerPlugin from './middleware/errorHandler.js';

import sessionsRoutes from './routes/sessions.js';
import clipsRoutes from './routes/clips.js';
import audioRoutes from './routes/audio.js';
import personsRoutes from './routes/persons.js';
import highlightsRoutes from './routes/highlights.js';
import generationRoutes from './routes/generation.js';
import downloadRoutes from './routes/download.js';

import { startPersonDetectionWorker } from './workers/personDetectionWorker.js';
import { startAudioAnalysisWorker } from './workers/audioAnalysisWorker.js';
import { startAssemblyWorker } from './workers/assemblyWorker.js';
import { startCleanupWorker } from './workers/cleanupWorker.js';
import { startValidationWorker } from './workers/validationWorker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ─── Prometheus metrics setup ─────────────────────────────────────────────────

// Enable default Node.js runtime metrics (event loop lag, GC, heap, etc.)
promClient.collectDefaultMetrics();

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

const httpRequestDurationSeconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const bullmqJobsTotal = new promClient.Counter({
  name: 'bullmq_jobs_total',
  help: 'Total number of BullMQ jobs processed',
  labelNames: ['queue', 'status'] as const,
});

const activeSessionsTotal = new promClient.Gauge({
  name: 'active_sessions_total',
  help: 'Number of active (non-deleted, non-complete) sessions in the database',
  async collect() {
    try {
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM sessions WHERE status NOT IN ('deleted', 'complete')`,
      );
      this.set(parseInt(res.rows[0]?.count ?? '0', 10));
    } catch {
      // If the DB is unreachable during scrape, emit 0 rather than crashing
      this.set(0);
    }
  },
});

// Export so workers can increment their own job counters
export { bullmqJobsTotal };

// ─── Build app ────────────────────────────────────────────────────────────────

export async function buildApp() {
  const isProd = process.env['NODE_ENV'] === 'production';
  const metricsPath = process.env['METRICS_PATH'] ?? '/metrics';

  const fastify = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      ...(isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            },
          }),
    },
    trustProxy: true,
  });

  // ── Plugins ────────────────────────────────────────────────────────────────

  await fastify.register(helmet, {
    // Content-Security-Policy would break SSE from a different origin in dev
    contentSecurityPolicy: isProd,
    crossOriginEmbedderPolicy: false,
  });

  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    // Exempt health check
    skipOnError: false,
    keyGenerator: (req) => {
      // Use X-Forwarded-For when behind a proxy (trustProxy is true above)
      return (
        req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ??
        req.ip
      );
    },
  });

  await fastify.register(multipart, {
    // Stream-only; do not store files to disk
    attachFieldsToBody: false,
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB (enforced per-route as well)
      files: 1,
      fields: 0,
    },
  });

  // ── Prometheus request instrumentation ────────────────────────────────────
  // Hook fires after every response; skips /metrics and /health to avoid
  // metric cardinality noise from the scraper itself.

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done) => {
      const route = request.routerPath ?? request.url;

      // Skip instrumentation for internal endpoints
      if (route === metricsPath || route === '/health') {
        done();
        return;
      }

      const method = request.method;
      const statusCode = String(reply.statusCode);
      const durationSeconds = reply.elapsedTime / 1000;

      httpRequestsTotal.inc({ method, route, status_code: statusCode });
      httpRequestDurationSeconds.observe({ method, route }, durationSeconds);

      done();
    },
  );

  // ── Auth + error handling ──────────────────────────────────────────────────

  await fastify.register(sessionAuthPlugin);
  await fastify.register(errorHandlerPlugin);

  // ── Routes ─────────────────────────────────────────────────────────────────

  await fastify.register(sessionsRoutes);
  await fastify.register(clipsRoutes);
  await fastify.register(audioRoutes);
  await fastify.register(personsRoutes);
  await fastify.register(highlightsRoutes);
  await fastify.register(generationRoutes);
  await fastify.register(downloadRoutes);

  // ── Health check ───────────────────────────────────────────────────────────

  fastify.get('/health', async (_request, reply) => {
    // Lightweight DB ping
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      return reply.code(503).send({
        status: 'error',
        message: 'Database unreachable',
      });
    }
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Prometheus metrics endpoint ────────────────────────────────────────────
  // Exposed outside session-auth middleware so the Prometheus scraper on
  // Quorra (192.168.1.100) can reach it without a session token.

  fastify.get(metricsPath, async (_request, reply) => {
    const metrics = await promClient.register.metrics();
    return reply
      .header('Content-Type', promClient.register.contentType)
      .send(metrics);
  });

  // ── React SPA static file serving ─────────────────────────────────────────
  // Build the SPA and copy to client-dist/ before starting the server in production:
  //   cd <repo-root> && VITE_API_URL="" npm run build    # use relative URLs (same-origin serving)
  //   cp -r dist/ server/client-dist/                    # make it available to the API
  // In development, leave CLIENT_DIST_PATH unset — Vite dev server runs separately on :5173.
  //
  // Serves the Vite build output from client-dist/ when present.
  // If the directory doesn't exist (e.g. API-only dev), this block is skipped.
  // SPA routing: any unmatched GET that the browser would navigate to (Accept: text/html)
  // gets index.html so React Router can handle it client-side.

  const clientDistPath =
    process.env['CLIENT_DIST_PATH'] ??
    path.join(process.cwd(), 'client-dist');

  if (existsSync(clientDistPath)) {
    await fastify.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
      wildcard: false,       // Only serve exact file matches; fall through to notFoundHandler
      decorateReply: false,  // reply.sendFile() already decorated by fastifyStatic
    });

    // Override the notFoundHandler set by errorHandlerPlugin:
    // - Browser navigation (Accept: text/html) → serve index.html for React Router
    // - Everything else → standard JSON 404
    fastify.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        (request.headers.accept?.includes('text/html') ||
          request.headers.accept?.includes('*/*'))
      ) {
        try {
          return reply.sendFile('index.html', clientDistPath);
        } catch {
          // index.html not found — fall through to JSON 404
        }
      }
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${request.method} ${request.url} not found.`,
        },
      });
    });

    fastify.log.info(`Serving React SPA from ${clientDistPath}`);
  } else {
    fastify.log.info(
      `No client-dist found at ${clientDistPath} — API-only mode`,
    );
    // No SPA to serve — register a plain JSON 404 handler.
    fastify.setNotFoundHandler(async (request, reply) => {
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${request.method} ${request.url} not found.`,
        },
      });
    });
  }

  return fastify;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const port = parseInt(process.env['PORT'] ?? '3001', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  // Wait for PostgreSQL to be reachable before running migrations.
  // Uses exponential backoff (2s → 4s → … → 30s cap, 10 attempts) so that
  // a race condition on first boot or a DB restart doesn't crash-loop the API.
  await waitForDatabase();

  // Apply DB migrations before anything else
  await runMigrations();

  // Initialise SSE subscriber (dedicated Redis connection)
  await initSSESubscriber();

  const fastify = await buildApp();

  // Start BullMQ workers inside the same process for the monorepo dev setup.
  // In production these can be split to separate Node.js processes or containers.
  const personWorker = startPersonDetectionWorker();
  const audioWorker = startAudioAnalysisWorker();
  const assemblyWorker = startAssemblyWorker();
  const validationWorker = startValidationWorker();
  const { cleanupWorker, staleSessionsWorker } = startCleanupWorker();

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal} — shutting down gracefully…`);

    // Stop accepting new connections
    await fastify.close();

    // Close workers (wait for in-progress jobs to complete or timeout)
    await Promise.allSettled([
      personWorker.close(),
      audioWorker.close(),
      assemblyWorker.close(),
      validationWorker.close(),
      cleanupWorker.close(),
      staleSessionsWorker.close(),
    ]);

    // Close queues, Redis, and DB pool
    await Promise.allSettled([closeQueues(), closeSSESubscriber(), closeRedis()]);

    await pool.end();

    fastify.log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Unhandled errors — log and continue (BullMQ errors are handled per-worker)
  process.on('unhandledRejection', (reason) => {
    fastify.log.error({ reason }, 'Unhandled promise rejection');
  });

  try {
    await fastify.listen({ port, host });
    fastify.log.info(`HypeReels API listening on http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
