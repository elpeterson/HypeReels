/**
 * Session asset deletion logic.
 * Used by the cleanup worker and direct cleanup routes.
 */
import { query, withTransaction } from '../db/client.js';
import { listObjects, deleteObjects, StorageKeys } from './storage.js';
import { createHash } from 'crypto';

export interface CleanupResult {
  filesDeleted: number;
  failedKeys: string[];
  dbDeleted: boolean;
}

/**
 * Delete all R2 assets for a session (uploads, thumbnails, generated).
 * Returns list of keys that could not be deleted.
 */
export async function deleteSessionAssets(
  sessionId: string,
): Promise<{ deleted: number; failed: string[] }> {
  const prefixes = StorageKeys.sessionPrefix(sessionId);
  const allKeys: string[] = [];

  for (const prefix of prefixes) {
    const keys = await listObjects(prefix);
    allKeys.push(...keys);
  }

  if (allKeys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  const failed = await deleteObjects(allKeys);
  return { deleted: allKeys.length - failed.length, failed };
}

/**
 * Full session cleanup:
 * 1. Delete MinIO objects
 * 2. Hard-delete DB rows (cascade)
 * 3. Mark session as deleted
 *
 * InsightFace is stateless per-request — no collection lifecycle cleanup needed.
 * Records any partial failures to cleanup_failures table.
 */
export async function cleanupSession(sessionId: string): Promise<CleanupResult> {
  // 1. Mark session as deleted first so concurrent requests get 410
  await query(
    `UPDATE sessions SET status = 'deleted', deleted_at = NOW() WHERE id = $1`,
    [sessionId],
  );

  // 2. Delete MinIO assets
  const { deleted, failed } = await deleteSessionAssets(sessionId);

  // 3. Record failed MinIO deletions for alerting / retry
  if (failed.length > 0) {
    for (const key of failed) {
      await query(
        `INSERT INTO cleanup_failures (session_id, minio_key, error)
         VALUES ($1, $2, 'MinIO delete failed after cleanup')
         ON CONFLICT DO NOTHING`,
        [sessionId, key],
      ).catch((e) => console.error('Failed to record cleanup failure:', e));
    }
  }

  // 4. Hard-delete all DB rows (sessions cascade deletes children)
  let dbDeleted = false;
  try {
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    });
    dbDeleted = true;
  } catch (err) {
    console.error(`Failed to delete session ${sessionId} from DB:`, err);
    // Record the failure
    await query(
      `INSERT INTO cleanup_failures (session_id, error)
       VALUES ($1, $2)`,
      [sessionId, `DB delete failed: ${String(err)}`],
    ).catch(() => undefined);
  }

  // 5. Write audit log (no PII — only hash of session ID)
  const sessionIdHash = createHash('sha256').update(sessionId).digest('hex');
  console.info(
    JSON.stringify({
      event: 'session_deleted',
      session_id_hash: sessionIdHash,
      files_deleted: deleted,
      files_failed: failed.length,
      db_deleted: dbDeleted,
      deleted_at: new Date().toISOString(),
    }),
  );

  return { filesDeleted: deleted, failedKeys: failed, dbDeleted };
}
