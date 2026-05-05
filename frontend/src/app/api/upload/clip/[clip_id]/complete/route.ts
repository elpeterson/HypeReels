/**
 * POST /api/upload/clip/[clip_id]/complete
 *
 * Mark a clip as ready after the browser has finished uploading directly to MinIO.
 * Enqueues the thumbnail-extract job.
 *
 * Body (JSON): { session_id: string, object_key: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, updateClipInSession } from "../../../../../../lib/redis";
import { enqueueThumbnailExtract } from "../../../../../../lib/queue";
import {
  sessionNotFound,
  sessionExpired,
  notFound,
  conflict,
  unprocessable,
  internalError,
} from "../../../../../../lib/errors";
import { isExpired } from "../../../../../../lib/fsm";
import { config } from "../../../../../../lib/config";

interface RouteParams {
  params: { clip_id: string };
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { clip_id } = params;

    let body: { session_id?: unknown; object_key?: unknown };
    try {
      body = await req.json();
    } catch {
      return unprocessable("invalid_json", "Request body must be valid JSON");
    }

    const { session_id, object_key } = body;
    if (!session_id || typeof session_id !== "string") {
      return unprocessable("missing_session_id", "session_id is required");
    }
    if (!object_key || typeof object_key !== "string") {
      return unprocessable("missing_object_key", "object_key is required");
    }

    const session = await getSession(session_id);
    if (!session) return sessionNotFound();
    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    const clip = session.clips.find((c) => c.clip_id === clip_id);
    if (!clip) {
      return notFound("Clip not found in session");
    }

    if (clip.status === "ready") {
      return conflict("already_complete", "Clip upload already marked as complete");
    }

    // Mark clip as ready
    await updateClipInSession(session_id, clip_id, { status: "ready" });

    // Enqueue thumbnail extraction (async)
    const jobId = await enqueueThumbnailExtract({
      session_id,
      clip_id,
      object_key,
    });

    return NextResponse.json({ clip_id, job_id: jobId });
  } catch (err) {
    console.error("[POST /api/upload/clip/[clip_id]/complete] error:", err);
    return internalError();
  }
}
