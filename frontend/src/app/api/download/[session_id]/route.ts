/**
 * GET /api/download/[session_id]
 *
 * Verify session state is ready and not expired.
 * Issue a presigned GET URL (5-minute TTL) for the reel.
 * Enqueues cleanup-session job (delayed 60s).
 * Returns JSON { download_url } so the frontend can trigger a native browser
 * download via a hidden anchor element (a 302 redirect cannot simultaneously
 * trigger a download in the browser's fetch context).
 *
 * If session expired: return 410 Gone.
 * If session not ready: return 409 Conflict.
 */

import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/redis";
import { createPresignedGetUrl, objectKeys } from "../../../../lib/storage";
import { enqueueCleanup } from "../../../../lib/queue";
import {
  sessionNotFound,
  sessionExpired,
  conflict,
  internalError,
} from "../../../../lib/errors";
import { isExpired } from "../../../../lib/fsm";
import { config } from "../../../../lib/config";

interface RouteParams {
  params: { session_id: string };
}

export async function GET(
  _req: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { session_id } = params;
    const session = await getSession(session_id);

    if (!session) return sessionNotFound();

    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    if (session.state !== "ready") {
      return conflict(
        "reel_not_ready",
        `Reel is not yet ready. Current state: ${session.state}`,
        { state: session.state }
      );
    }

    const reelKey = session.reel_key ?? objectKeys.reel(session_id);

    // Issue presigned GET URL (5-minute TTL)
    const downloadUrl = await createPresignedGetUrl(
      reelKey,
      config.session.presignedGetTtlSeconds
    );

    // Enqueue cleanup job (delayed 60s per architecture.md)
    // Fire-and-forget: cleanup failure must not block the download
    enqueueCleanup(
      { session_id, trigger: "download" },
      config.session.cleanupDelayMs
    ).catch((err) => {
      console.error(
        `[download] failed to enqueue cleanup for session=${session_id}:`,
        err
      );
    });

    // Return JSON so the frontend can use a hidden <a download> anchor.
    // A 302 redirect cannot simultaneously trigger a native browser download
    // when initiated from a fetch() call.
    return NextResponse.json({ download_url: downloadUrl });
  } catch (err) {
    console.error("[GET /api/download/[session_id]] error:", err);
    return internalError();
  }
}
