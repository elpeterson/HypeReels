/**
 * Next.js instrumentation — runs once at server startup.
 *
 * Starts the BullMQ worker process within the Next.js server.
 * See docs/architecture.md §3.2 (ADR-002): worker is co-located in app container.
 */

export async function register(): Promise<void> {
  // Only run in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./worker");
    startWorker();
  }
}
