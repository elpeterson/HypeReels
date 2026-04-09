/**
 * Standalone migration runner.
 * Usage: npm run db:migrate
 */
import { runMigrations, pool } from './client.js';

try {
  await runMigrations();
  console.log('Migrations complete.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await pool.end();
}
