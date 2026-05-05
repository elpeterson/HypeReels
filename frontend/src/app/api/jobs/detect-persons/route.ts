/**
 * POST /api/jobs/detect-persons
 *
 * Validate that at least one clip is ready, then enqueue the detect-persons job.
 * Body (JSON): { session_id: string }
 * Returns: { job_id }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, updateSessionState, setJobProgress } from "../../../../lib/redis";
import { enqueueDetectPersons } from "../../../../lib/queue";
import {
  sessionNotFound,
  sessionExpired,
  conflict,
  unprocessable,
  internalError,
} from "../../../../lib/errors";
import { isExpired } from "../../../../lib/fsm";
import { config } from "../../../../lib/config";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let body: { session_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return unprocessable("invalid_json", "Request body must be valid JSON");
    }

    const { session_id } = body;
    if (!session_id || typeof session_id !== "string") {
      return unprocessable("missing_session_id", "session_id is required");
    }

    const session = await getSession(session_id);
    if (!session) return sessionNotFound();
    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    // Validate: at least one clip must be ready
    const readyClips = session.clips.filter((c) => c.status === "ready");
    if (readyClips.length === 0) {
      return conflict(
        "no_ready_clips",
        "At least one clip must be ready before detecting persons",
        { clip_count: session.clips.length }
      );
    }

    // Prevent double-enqueue if already detecting
    if (session.state === "detecting") {
      return conflict(
        "detection_in_progress",
        "Person detection is already in progress"
      );
    }

    // Enqueue job
    const jobId = await enqueueDetectPersons({
      session_id,
      clip_ids: readyClips.map((c) => c.clip_id),
    });

    // Update session state to detecting
    await updateSessionState(session_id, "detecting");

    // Initialize job progress
    await setJobProgress(jobId, {
      status: "queued",
      stage: "Queued",
      pct: 0,
      message: "Person detection queued",
      updated_at: Date.now(),
    });

    return NextResponse.json({ job_id: jobId }, { status: 202 });
  } catch (err) {
    console.error("[POST /api/jobs/detect-persons] error:", err);
    return internalError();
  }
}
