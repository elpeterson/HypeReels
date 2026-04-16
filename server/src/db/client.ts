import pg from 'pg';
import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (!process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env['DATABASE_SSL'] === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error', err);
});

/** Run a query with automatic client acquisition / release. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, values);
}

/** Run multiple statements inside a single transaction. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Wait for the database to become available before proceeding.
 *
 * Uses exponential backoff starting at 2 s and capping at 30 s.
 * Throws after maxAttempts if the DB never responds, so the process
 * exits cleanly and PM2 / systemd can restart with its own backoff.
 */
export async function waitForDatabase(maxAttempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      const delayMs = Math.min(1000 * 2 ** attempt, 30_000); // 2s, 4s, 8s… cap at 30s
      console.log(
        `[db] Database not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    '[db] Database did not become available after maximum retry attempts',
  );
}

/**
 * Run all pending SQL migrations from server/src/db/migrations/.
 *
 * Idempotent: tracks applied migrations in a `schema_migrations` table.
 * Migrations are applied in filename order (001_, 002_, …) inside individual
 * transactions so a partial failure does not corrupt the migration log.
 */
export async function runMigrations(): Promise<void> {
  const migrationsDir = join(__dirname, 'migrations');

  // Ensure the migrations tracking table exists before doing anything else
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Collect migration files sorted numerically
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found — schema is up to date');
    return;
  }

  // Fetch already-applied migrations
  const appliedRes = await pool.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations ORDER BY filename`,
  );
  const applied = new Set(appliedRes.rows.map((r) => r.filename));

  for (const filename of files) {
    if (applied.has(filename)) {
      continue; // already applied
    }

    const filePath = join(migrationsDir, filename);
    const sql = await readFile(filePath, 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1)`,
        [filename],
      );
      await client.query('COMMIT');
      console.log(`Migration applied: ${filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      client.release();
    }
  }

  console.log('All migrations applied successfully');
}

export default pool;
