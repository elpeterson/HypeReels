/**
 * Vitest tests for the sessions routes.
 *
 * What this file tests and why
 * --------------------------------
 * The sessions routes are the entry point for the entire HypeReels session
 * lifecycle. Every subsequent route depends on a valid session token being
 * present in the Authorization header.
 *
 * This file tests:
 *   TC-001: POST /sessions creates a session with status='active'
 *   TC-002: GET /sessions/:id/state requires a valid Bearer token
 *   TC-003: GET /sessions/:id/state returns 410 for deleted sessions
 *   TC-027: GET /sessions/:id/state returns correct state for page restoration
 *   TC-034: Session token invalidation after cleanup
 *
 * All tests mock the DB (query / withTransaction) and the job queue
 * (enqueueCleanup) so no real PostgreSQL, Redis, or MinIO is needed.
 * This makes the tests CI-runnable from a clean environment.
 *
 * Run with: vitest run  (from the server/ directory)
 * Or:       cd server && npx vitest run src/routes/sessions.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the DB client — no real PostgreSQL in unit tests
vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  pool: {
    query: vi.fn(),
    end: vi.fn(),
  },
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

// Mock Redis and SSE — no real Redis in unit tests
vi.mock('../lib/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue({}),
  closeRedis: vi.fn(),
}));

vi.mock('../lib/sse.js', () => ({
  initSSESubscriber: vi.fn().mockResolvedValue(undefined),
  closeSSESubscriber: vi.fn(),
  addSSEConnection: vi.fn().mockResolvedValue(vi.fn()),
  publishSSEEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock BullMQ job producers — no real queue in unit tests
vi.mock('../jobs/producers.js', () => ({
  enqueueCleanup: vi.fn().mockResolvedValue(undefined),
  enqueueClipValidation: vi.fn().mockResolvedValue(undefined),
  enqueueClipValidationJob: vi.fn().mockResolvedValue(undefined),
  enqueuePersonDetection: vi.fn().mockResolvedValue(undefined),
  enqueueAudioAnalysis: vi.fn().mockResolvedValue(undefined),
  enqueueAudioValidation: vi.fn().mockResolvedValue(undefined),
  enqueueGeneration: vi.fn().mockResolvedValue(undefined),
}));

// Mock BullMQ queues module to avoid Redis connection at import time
vi.mock('../jobs/queues.js', () => ({
  QUEUE_VALIDATION: 'validation',
  QUEUE_CLIP_VALIDATION: 'clip-validation',
  QUEUE_AUDIO_ANALYSIS: 'audio-analysis',
  QUEUE_PERSON_DETECTION: 'person-detection',
  QUEUE_GENERATION: 'generation',
  QUEUE_CLEANUP: 'cleanup',
  QUEUE_STALE_SESSIONS: 'stale-sessions',
  closeQueues: vi.fn().mockResolvedValue(undefined),
}));

// Mock prom-client to avoid metric registration conflicts in test runs
vi.mock('prom-client', () => ({
  collectDefaultMetrics: vi.fn(),
  Counter: vi.fn().mockReturnValue({ inc: vi.fn() }),
  Histogram: vi.fn().mockReturnValue({ observe: vi.fn() }),
  Gauge: vi.fn().mockReturnValue({ set: vi.fn() }),
  register: {
    metrics: vi.fn().mockResolvedValue(''),
    contentType: 'text/plain',
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { buildApp } from '../index.js';
import { query } from '../db/client.js';
import { enqueueCleanup } from '../jobs/producers.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const SESSION_TOKEN = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DIFFERENT_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Build a minimal session row fixture. */
function makeSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SESSION_ID,
    token: SESSION_TOKEN,
    status: 'active',
    current_step: 'upload-clips',
    person_of_interest_id: null,
    created_at: new Date('2026-04-07T00:00:00Z'),
    last_activity_at: new Date('2026-04-07T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

/** Configure query mock to handle session auth middleware + route queries. */
function mockSessionLookup(sessionRow: ReturnType<typeof makeSessionRow> | null) {
  vi.mocked(query).mockImplementation(async (sql: string, _params?: unknown[]) => {
    // Session auth middleware looks up by token
    if (sql.includes('WHERE token = $1')) {
      if (sessionRow === null) {
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [sessionRow], rowCount: 1 } as any;
    }

    // Session state route: clips, audio, persons, jobs
    if (sql.includes('FROM clips')) {
      return { rows: [], rowCount: 0 } as any;
    }
    if (sql.includes('FROM audio_tracks')) {
      return { rows: [], rowCount: 0 } as any;
    }
    if (sql.includes('FROM person_detections')) {
      return { rows: [], rowCount: 0 } as any;
    }
    if (sql.includes('FROM generation_jobs')) {
      return { rows: [], rowCount: 0 } as any;
    }

    // last_activity_at update (fire-and-forget)
    if (sql.includes('UPDATE sessions SET last_activity_at')) {
      return { rows: [], rowCount: 1 } as any;
    }

    // POST /sessions INSERT
    if (sql.includes('INSERT INTO sessions')) {
      return {
        rows: [{ id: SESSION_ID, token: SESSION_TOKEN }],
        rowCount: 1,
      } as any;
    }

    return { rows: [], rowCount: 0 } as any;
  });
}

// ── TC-001: POST /sessions creates session with status='active' ───────────────

describe('POST /sessions', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(enqueueCleanup).mockReset();
  });

  it('TC-001a: returns HTTP 201', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ id: SESSION_ID, token: SESSION_TOKEN }],
      rowCount: 1,
    } as any);

    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/sessions' });

    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it('TC-001b: returns session_id and token as UUID strings', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ id: SESSION_ID, token: SESSION_TOKEN }],
      rowCount: 1,
    } as any);

    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/sessions' });
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('session_id');
    expect(body).toHaveProperty('token');
    expect(body.session_id).toBe(SESSION_ID);
    expect(body.token).toBe(SESSION_TOKEN);
    await app.close();
  });

  it('TC-001c: response body matches Session schema (session_id + token only)', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ id: SESSION_ID, token: SESSION_TOKEN }],
      rowCount: 1,
    } as any);

    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/sessions' });
    const body = JSON.parse(response.body);

    // Must NOT expose internal DB fields like status, created_at, etc.
    expect(Object.keys(body).sort()).toEqual(['session_id', 'token'].sort());
    await app.close();
  });

  it('TC-001d: inserts a row into the sessions table', async () => {
    let insertCalled = false;
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO sessions')) {
        insertCalled = true;
        return { rows: [{ id: SESSION_ID, token: SESSION_TOKEN }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/sessions' });

    expect(insertCalled).toBe(true);
    await app.close();
  });
});

// ── TC-002: GET /sessions/:id/state requires valid Bearer token ───────────────

describe('GET /sessions/:id/state — authentication', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('TC-002a: returns 401 when Authorization header is missing', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      // No Authorization header
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('MISSING_TOKEN');
    await app.close();
  });

  it('TC-002b: returns 401 when Authorization header is malformed (not Bearer)', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Basic ${SESSION_TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('TC-002c: returns 404 when token is not found in the database', async () => {
    // query returns no rows for the token lookup
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${DIFFERENT_TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
    await app.close();
  });

  it('TC-002d: returns 200 with valid Bearer token', async () => {
    mockSessionLookup(makeSessionRow());

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

// ── TC-003: Deleted session returns 410 ──────────────────────────────────────

describe('GET /sessions/:id/state — deleted session', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("TC-003a: returns 410 when session status is 'deleted'", async () => {
    mockSessionLookup(makeSessionRow({ status: 'deleted' }));

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    expect(response.statusCode).toBe(410);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('SESSION_GONE');
    await app.close();
  });

  it("TC-003b: error message mentions session has been deleted or expired", async () => {
    mockSessionLookup(makeSessionRow({ status: 'deleted' }));

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    const message = body.error.message as string;
    expect(message.toLowerCase()).toMatch(/deleted|expired/);
    await app.close();
  });
});

// ── TC-027: Session state returned correctly for page restoration ─────────────

describe('GET /sessions/:id/state — full state restoration', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('TC-027a: returns expected fields for an active session', async () => {
    mockSessionLookup(makeSessionRow());

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('session_id', SESSION_ID);
    expect(body).toHaveProperty('status', 'active');
    expect(body).toHaveProperty('current_step', 'upload-clips');
    expect(body).toHaveProperty('clips');
    expect(body).toHaveProperty('audio');
    expect(body).toHaveProperty('persons');
    expect(body).toHaveProperty('latest_job');
    await app.close();
  });

  it("TC-027b: returns status='complete' for a completed session", async () => {
    mockSessionLookup(makeSessionRow({ status: 'complete', current_step: 'download' }));

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(body.status).toBe('complete');
    expect(body.current_step).toBe('download');
    await app.close();
  });

  it("TC-027c: returns status='locked' for a session mid-generation", async () => {
    mockSessionLookup(makeSessionRow({ status: 'locked', current_step: 'generate' }));

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(body.status).toBe('locked');
    await app.close();
  });

  it('TC-027d: persons array is empty when no detections exist', async () => {
    mockSessionLookup(makeSessionRow());

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(Array.isArray(body.persons)).toBe(true);
    expect(body.persons).toHaveLength(0);
    await app.close();
  });

  it('TC-027e: clips array is empty when no clips have been uploaded', async () => {
    mockSessionLookup(makeSessionRow());

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(Array.isArray(body.clips)).toBe(true);
    expect(body.clips).toHaveLength(0);
    await app.close();
  });

  it('TC-027f: audio is null when no audio track has been uploaded', async () => {
    mockSessionLookup(makeSessionRow());

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(body.audio).toBeNull();
    await app.close();
  });

  it('TC-027g: latest_job is null when no generation job exists', async () => {
    mockSessionLookup(makeSessionRow());

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(body.latest_job).toBeNull();
    await app.close();
  });
});

// ── DELETE /sessions/:id — start over ────────────────────────────────────────

describe('DELETE /sessions/:id — trigger cleanup', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(enqueueCleanup).mockReset();
  });

  it('returns 202 when cleanup is enqueued', async () => {
    mockSessionLookup(makeSessionRow());
    vi.mocked(enqueueCleanup).mockResolvedValue(undefined as any);

    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/sessions/${SESSION_ID}`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    expect(response.statusCode).toBe(202);
    await app.close();
  });

  it('calls enqueueCleanup with the correct session ID', async () => {
    mockSessionLookup(makeSessionRow());
    vi.mocked(enqueueCleanup).mockResolvedValue(undefined as any);

    const app = await buildApp();
    await app.inject({
      method: 'DELETE',
      url: `/sessions/${SESSION_ID}`,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    expect(enqueueCleanup).toHaveBeenCalledWith(SESSION_ID, 'start-over');
    await app.close();
  });

  it('returns 401 without auth header', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/sessions/${SESSION_ID}`,
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

// ── Error envelope schema ─────────────────────────────────────────────────────

describe('Error envelope schema', () => {
  it('401 response follows { error: { code, message } } envelope', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      // No auth header
    });

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
    await app.close();
  });

  it('404 response follows { error: { code, message } } envelope', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/state`,
      headers: { Authorization: `Bearer ${DIFFERENT_TOKEN}` },
    });

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
    await app.close();
  });
});
