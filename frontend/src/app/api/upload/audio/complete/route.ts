/**
 * POST /api/upload/audio/complete
 *
 * Mark audio as ready after the browser has finished uploading directly to MinIO.
 * Body (JSON): { session_id: string, audio_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../../../lib/redis";
import {
  sessionNotFound,
  sessionExpired,
  notFound,
  conflict,
  unprocessable,
  internalError,
} from "../../../../../lib/errors";
import { isExpired } from "../../../../../lib/fsm";
import { config } from "../../../../../lib/config";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let body: { session_id?: unknown; audio_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return unprocessable("invalid_json", "Request body must be valid JSON");
    }

    const { session_id, audio_id } = body;
    if (!session_id || typeof session_id !== "string") {
      return unprocessable("missing_session_id", "session_id is required");
    }
    if (!audio_id || typeof audio_id !== "string") {
      return unprocessable("missing_audio_id", "audio_id is required");
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

    if (session.audio.audio_id !== audio_id) {
      return notFound("Audio ID does not match session");
    }

    // Audio is already tracked in session; no status field on AudioTrack.
    // Simply return success — audio is considered ready after this call.
    // The analyze-audio job will be enqueued as part of generate-reel flow.

    return NextResponse.json({ audio_id });
  } catch (err) {
    console.error("[POST /api/upload/audio/complete] error:", err);
    return internalError();
  }
}
