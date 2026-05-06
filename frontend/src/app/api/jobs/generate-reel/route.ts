/**
 * POST /api/jobs/generate-reel
 *
 * Validate prerequisites, enqueue analyze-audio and generate-reel jobs
 * (with BullMQ job dependency so generate-reel waits for analyze-audio).
 *
 * Body (JSON): { session_id: string }
 * Returns: { job_id } — the generate-reel job_id (frontend polls this)
 *
 * Preconditions:
 * - At least 1 clip in ready state
 * - Audio present in session
 * - Session not in generating or ready state already
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getSession,
  updateSessionState,
  setJobProgress,
} from "../../../../lib/redis";
import {
  enqueueReelGenerationFlow,
} from "../../../../lib/queue";
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
        "At least one clip must be ready before generating a reel",
        { clip_count: session.clips.length }
      );
    }

    // Validate: audio must be present
    if (!session.audio) {
      return conflict(
        "no_audio",
        "An audio track must be uploaded before generating a reel"
      );
    }

    // Prevent duplicate generation
    if (session.state === "generating") {
      return conflict(
        "generation_in_progress",
        "Reel generation is already in progress"
      );
    }

    if (session.state === "ready") {
      return conflict(
        "reel_already_ready",
        "Reel has already been generated. Download it or start a new session."
      );
    }

    // Enqueue analyze-audio → generate-reel as a BullMQ flow.
    // generate-reel stays in "waiting-children" state until analyze-audio
    // completes; only then does it become active. This guarantees analysis.json
    // is in MinIO before generate-reel tries to read it.
    const { analyzeJobId, generateJobId } = await enqueueReelGenerationFlow(
      {
        session_id,
        audio_id: session.audio.audio_id,
        object_key: session.audio.object_key,
      },
      { session_id }
    );

    // Update session state to generating
    await updateSessionState(session_id, "generating");

    // Initialize progress for both jobs
    await Promise.all([
      setJobProgress(analyzeJobId, {
        status: "queued",
        stage: "Queued",
        pct: 0,
        message: "Audio analysis queued",
        updated_at: Date.now(),
      }),
      setJobProgress(generateJobId, {
        status: "queued",
        stage: "Queued",
        pct: 0,
        message: "Reel generation queued (waiting for audio analysis)",
        updated_at: Date.now(),
      }),
    ]);

    return NextResponse.json(
      {
        job_id: generateJobId,
        analyze_audio_job_id: analyzeJobId,
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("[POST /api/jobs/generate-reel] error:", err);
    return internalError();
  }
}
