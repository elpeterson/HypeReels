/**
 * PATCH /api/session/[id]/clips/[clip_id]/highlights
 *
 * Add a new highlight range to a clip.
 * Body: { start_ms: number, end_ms: number }
 *
 * Validation rules:
 * - start_ms >= 0
 * - end_ms > start_ms
 * - end_ms - start_ms >= 1000 (minimum 1 second)
 * - start_ms and end_ms must be within clip duration
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  getSession,
  addHighlightToClip,
} from "../../../../../../../lib/redis";
import {
  sessionNotFound,
  sessionExpired,
  notFound,
  unprocessable,
  internalError,
} from "../../../../../../../lib/errors";
import { isExpired } from "../../../../../../../lib/fsm";
import { config } from "../../../../../../../lib/config";
import type { Highlight } from "../../../../../../../types";

interface RouteParams {
  params: { id: string; clip_id: string };
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { id, clip_id } = params;
    const session = await getSession(id);

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

    let body: { start_ms?: unknown; end_ms?: unknown };
    try {
      body = await req.json();
    } catch {
      return unprocessable("invalid_json", "Request body must be valid JSON");
    }

    const { start_ms, end_ms } = body;

    if (typeof start_ms !== "number" || typeof end_ms !== "number") {
      return unprocessable(
        "invalid_range",
        "start_ms and end_ms must be numbers",
        { start_ms, end_ms }
      );
    }

    if (start_ms < 0) {
      return unprocessable("invalid_range", "start_ms must be >= 0", {
        start_ms,
      });
    }

    if (end_ms <= start_ms) {
      return unprocessable("invalid_range", "end_ms must be > start_ms", {
        start_ms,
        end_ms,
      });
    }

    if (end_ms - start_ms < 1000) {
      return unprocessable(
        "invalid_range",
        "Highlight must be at least 1 second long (1000ms)",
        { start_ms, end_ms, duration_ms: end_ms - start_ms }
      );
    }

    // Validate within clip duration (if duration is known)
    if (clip.duration_ms > 0) {
      if (start_ms >= clip.duration_ms || end_ms > clip.duration_ms) {
        return unprocessable(
          "invalid_range",
          "Highlight range exceeds clip duration",
          {
            start_ms,
            end_ms,
            clip_duration_ms: clip.duration_ms,
          }
        );
      }
    }

    const highlight: Highlight = {
      highlight_id: uuidv4(),
      start_ms,
      end_ms,
    };

    await addHighlightToClip(id, clip_id, highlight);

    return NextResponse.json({ highlight });
  } catch (err) {
    console.error("[PATCH /api/session/[id]/clips/[clip_id]/highlights] error:", err);
    return internalError();
  }
}
