/**
 * Next.js instrumentation — runs once at server startup.
 *
 * 1. Configures MinIO bucket CORS so browsers can do presigned PUT/GET directly.
 * 2. Starts the BullMQ worker process within the Next.js server.
 *
 * See docs/architecture.md §3.2 (ADR-002): worker is co-located in app container.
 */

export async function register(): Promise<void> {
  // Only run in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // ── MinIO CORS ──────────────────────────────────────────────────────────
    // Must run before the app accepts requests. app depends_on minio-init
    // completing, so MinIO is ready by the time this executes.
    try {
      const { configureBucketCors } = await import("./lib/storage");
      await configureBucketCors();
    } catch (err) {
      // Log but don't crash — uploads will fail with CORS errors if this didn't
      // apply, which is visible in the browser dev tools.
      console.error("[storage] Failed to configure bucket CORS:", err);
    }

    // ── BullMQ worker ───────────────────────────────────────────────────────
    const { startWorker } = await import("./worker");
    startWorker();
  }
}
