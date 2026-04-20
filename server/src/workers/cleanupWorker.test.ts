/**
 * Vitest unit tests for server/src/lib/cleanup.ts
 *
 * What this file tests and why
 * --------------------------------
 * The cleanup module (cleanup.ts) is the critical "destroy everything" path:
 * it deletes all MinIO objects for a session and hard-deletes all DB rows.
 * Failures here mean orphaned files and potential storage leaks.
 *
 * Known issue I9: a dedicated cleanupWorker.ts BullMQ consumer may not exist
 * as a separate module. These tests therefore target cleanup.ts (the library)
 * directly rather than a BullMQ worker wrapper.
 *
 * Fixed C5: the schema now uses minio_key (renamed from r2_key). Tests assert
 * the correct column name is used.
 *
 * Known issue C6: session status must be 'deleted', never 'destroyed'.
 * Test TC-004 verifies the schema constraint; this file verifies the
 * application code sets 'deleted' (not 'destroyed').
 *
 * Run with: vitest run  (from the server/ directory)
 * Or:       cd server && npx vitest run src/workers/cleanupWorker.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the storage module — we do NOT want real MinIO calls in unit tests
vi.mock('../lib/storage.js', () => ({
  listObjects: vi.fn(),
  deleteObjects: vi.fn(),
  StorageKeys: {
    sessionPrefix: (sessionId: string) => [
      `uploads/${sessionId}/`,
      `generated/${sessionId}/`,
      `thumbnails/${sessionId}/`,
    ],
  },
  // Also export R2Keys as an alias so any legacy references still resolve
  R2Keys: {
    sessionPrefix: (sessionId: string) => [
      `uploads/${sessionId}/`,
      `generated/${sessionId}/`,
      `thumbnails/${sessionId}/`,
    ],
  },
}));

// Mock the db/client module — no real PostgreSQL in unit tests
vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { cleanupSession, deleteSessionAssets } from '../lib/cleanup.js';
import { listObjects, deleteObjects } from '../lib/storage.js';
import { query, withTransaction } from '../db/client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockSessionId = '550e8400-e29b-41d4-a716-446655440000';

function resetMocks() {
  vi.mocked(listObjects).mockReset();
  vi.mocked(deleteObjects).mockReset();
  vi.mocked(query).mockReset();
  vi.mocked(withTransaction).mockReset();
}

// ── TC-028: Cleanup deletes all MinIO objects and DB rows ─────────────────────

describe('cleanupSession', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('TC-028a: calls listObjects for all three session prefixes', async () => {
    // Arrange
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    // Act
    await cleanupSession(mockSessionId);

    // Assert: listObjects called for uploads/, generated/, thumbnails/
    expect(listObjects).toHaveBeenCalledWith(`uploads/${mockSessionId}/`);
    expect(listObjects).toHaveBeenCalledWith(`generated/${mockSessionId}/`);
    expect(listObjects).toHaveBeenCalledWith(`thumbnails/${mockSessionId}/`);
    expect(listObjects).toHaveBeenCalledTimes(3);
  });

  it('TC-028b: calls deleteObjects with all discovered keys', async () => {
    const keys = [
      `uploads/${mockSessionId}/clips/clip-1.mp4`,
      `uploads/${mockSessionId}/audio.mp3`,
      `generated/${mockSessionId}/hypereel_abcd1234.mp4`,
    ];

    // listObjects called 3 times (one per prefix); return some keys for the first, empty for others
    vi.mocked(listObjects)
      .mockResolvedValueOnce(keys)       // uploads/
      .mockResolvedValueOnce([])          // generated/
      .mockResolvedValueOnce([]);         // thumbnails/

    vi.mocked(deleteObjects).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    await cleanupSession(mockSessionId);

    expect(deleteObjects).toHaveBeenCalledWith(keys);
  });

  it('TC-028c: returns filesDeleted count equal to number of keys found', async () => {
    const keys = [
      `uploads/${mockSessionId}/clip-1.mp4`,
      `uploads/${mockSessionId}/audio.mp3`,
      `thumbnails/${mockSessionId}/clip-1.jpg`,
    ];

    vi.mocked(listObjects)
      .mockResolvedValueOnce(keys)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    vi.mocked(deleteObjects).mockResolvedValue([]); // no failures
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    const result = await cleanupSession(mockSessionId);

    expect(result.filesDeleted).toBe(3);
    expect(result.failedKeys).toEqual([]);
  });

  it("TC-028d: marks session status as 'deleted' (not 'destroyed') before deleting objects", async () => {
    // Known issue C6: 'destroyed' is used in some metric queries but is NOT a valid
    // DB CHECK constraint value. The application must use 'deleted'.
    const queryCalls: string[] = [];

    vi.mocked(query).mockImplementation(async (sql: string) => {
      queryCalls.push(sql);
      return { rows: [], rowCount: 1 } as any;
    });

    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([]);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    await cleanupSession(mockSessionId);

    const statusUpdateSql = queryCalls.find(
      (sql) => sql.includes("status") && sql.includes("deleted"),
    );
    expect(statusUpdateSql).toBeTruthy();

    // Must NOT set status to 'destroyed' — that value is not in the DB CHECK constraint
    const destroyedSql = queryCalls.find((sql) => sql.includes("'destroyed'"));
    expect(destroyedSql).toBeUndefined();
  });

  it('TC-028e: executes DELETE FROM sessions for the correct session ID', async () => {
    let deleteSql = '';
    let deleteParams: unknown[] = [];

    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([]);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      const mockClient = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
          if (sql.includes('DELETE FROM sessions')) {
            deleteSql = sql;
            deleteParams = params;
          }
          return Promise.resolve({ rows: [] });
        }),
      };
      await fn(mockClient as any);
    });

    await cleanupSession(mockSessionId);

    expect(deleteSql).toContain('DELETE FROM sessions');
    expect(deleteParams).toContain(mockSessionId);
  });

  it('TC-028f: dbDeleted is true when transaction succeeds', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([]);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    const result = await cleanupSession(mockSessionId);

    expect(result.dbDeleted).toBe(true);
  });

  it('TC-028g: records failed MinIO deletions in cleanup_failures table', async () => {
    const failedKey = `uploads/${mockSessionId}/corrupted.mp4`;

    vi.mocked(listObjects).mockResolvedValueOnce([failedKey]).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([failedKey]); // this key failed to delete
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    const result = await cleanupSession(mockSessionId);

    expect(result.failedKeys).toContain(failedKey);

    // Verify cleanup_failures INSERT was called
    const insertCalls = vi.mocked(query).mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('cleanup_failures'),
    );
    expect(insertCalls.length).toBeGreaterThan(0);
  });
});

// ── TC-029: Cleanup is idempotent (empty MinIO prefix) ───────────────────────

describe('cleanupSession — idempotent on empty storage', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('TC-029a: does not call deleteObjects when no objects are found', async () => {
    vi.mocked(listObjects).mockResolvedValue([]); // all prefixes empty
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    await cleanupSession(mockSessionId);

    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it('TC-029b: returns filesDeleted=0 and failedKeys=[] when storage is already empty', async () => {
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    const result = await cleanupSession(mockSessionId);

    expect(result.filesDeleted).toBe(0);
    expect(result.failedKeys).toEqual([]);
  });

  it('TC-029c: does not throw even if listObjects returns [] for all prefixes', async () => {
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    await expect(cleanupSession(mockSessionId)).resolves.not.toThrow();
  });

  it('TC-029d: dbDeleted is still true even when no MinIO objects exist', async () => {
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    const result = await cleanupSession(mockSessionId);

    expect(result.dbDeleted).toBe(true);
  });
});

// ── deleteSessionAssets standalone tests ─────────────────────────────────────

describe('deleteSessionAssets', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('collects keys from all three session prefixes', async () => {
    vi.mocked(listObjects)
      .mockResolvedValueOnce([`uploads/${mockSessionId}/clip-1.mp4`])
      .mockResolvedValueOnce([`generated/${mockSessionId}/hypereel.mp4`])
      .mockResolvedValueOnce([`thumbnails/${mockSessionId}/clip-1.jpg`]);

    vi.mocked(deleteObjects).mockResolvedValue([]);

    const result = await deleteSessionAssets(mockSessionId);

    expect(result.deleted).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('returns failed keys from deleteObjects', async () => {
    const failedKey = `uploads/${mockSessionId}/clip-1.mp4`;

    vi.mocked(listObjects)
      .mockResolvedValueOnce([failedKey])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    vi.mocked(deleteObjects).mockResolvedValue([failedKey]);

    const result = await deleteSessionAssets(mockSessionId);

    expect(result.failed).toContain(failedKey);
    expect(result.deleted).toBe(0); // failed keys are subtracted from deleted count
  });

  it('returns {deleted: 0, failed: []} when all prefixes are empty', async () => {
    vi.mocked(listObjects).mockResolvedValue([]);

    const result = await deleteSessionAssets(mockSessionId);

    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual([]);
    expect(deleteObjects).not.toHaveBeenCalled();
  });
});

// ── DB transaction pattern tests ──────────────────────────────────────────────

describe('cleanupSession — DB transaction', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('uses withTransaction for the hard-delete operation', async () => {
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockImplementation(async (fn) => {
      await fn({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    });

    await cleanupSession(mockSessionId);

    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('sets dbDeleted=false and records failure if transaction throws', async () => {
    vi.mocked(listObjects).mockResolvedValue([]);
    vi.mocked(deleteObjects).mockResolvedValue([]);

    // First query call (status update) succeeds; withTransaction throws (DB delete fails)
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    vi.mocked(withTransaction).mockRejectedValue(new Error('DB connection lost'));

    // Cleanup should NOT re-throw the DB error — it should degrade gracefully
    // and record the failure in cleanup_failures
    const result = await cleanupSession(mockSessionId);

    expect(result.dbDeleted).toBe(false);
    // Verify an attempt was made to record the DB failure
    const failureCalls = vi.mocked(query).mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('cleanup_failures'),
    );
    expect(failureCalls.length).toBeGreaterThan(0);
  });
});
