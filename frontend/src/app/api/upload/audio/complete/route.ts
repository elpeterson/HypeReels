/**
 * POST /api/upload/audio/complete
 *
 * Mark audio as ready after the browser has finished uploading directly to MinIO.
 * Header: X-Session-Id: string (session_id)
 * Body: (none required)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../../../lib/redis";
import {
  sessionNotFound,
  sessionExpired,
  notFound,
  unprocessable,
  internalError,
} from "../../../../../lib/errors";
import { isExpired } from "../../../../../lib/fsm";
import { config } from "../../../../../lib/config";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // session_id comes from the X-Session-Id header (set by apiFetch)
    const session_id = req.headers.get("X-Session-Id");
    if (!session_id) {
      return unprocessable("missing_session_id", "X-Session-Id header is required");
    }

    const session = await getSession(session_id);
    if (!session) return sessionNotFound();
    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    if (!session.audio) {
      return notFound("No audio found in session");
    }

    const audio_id = session.audio.audio_id;

    // Audio is already tracked in session; no status field on AudioTrack.
    // Simply return success — audio is considered ready after this call.
    // The analyze-audio job will be enqueued as part of generate-reel flow.

    return NextResponse.json({ audio_id });
  } catch (err) {
    console.error("[POST /api/upload/audio/complete] error:", err);
    return internalError();
  }
}
