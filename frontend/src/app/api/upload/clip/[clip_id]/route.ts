/**
 * DELETE /api/upload/clip/[clip_id]
 *
 * Remove a clip from the session and delete its MinIO object.
 * Body (JSON): { session_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, removeClipFromSession } from "../../../../../lib/redis";
import { deleteObject, objectKeys } from "../../../../../lib/storage";
import {
  sessionNotFound,
  sessionExpired,
  notFound,
  internalError,
} from "../../../../../lib/errors";
import { isExpired } from "../../../../../lib/fsm";
import { config } from "../../../../../lib/config";

interface RouteParams {
  params: { clip_id: string };
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { clip_id } = params;

    let body: { session_id?: unknown };
    try {
      body = await req.json();
    } catch {
      // Also check query param
      const url = new URL(req.url);
      body = { session_id: url.searchParams.get("session_id") ?? undefined };
    }

    const session_id =
      typeof body.session_id === "string" ? body.session_id : null;
    if (!session_id) {
      const url = new URL(req.url);
      const qs = url.searchParams.get("session_id");
      if (!qs) {
        const { errorResponse } = await import("../../../../../lib/errors");
        return errorResponse(422, "missing_session_id", "session_id is required");
      }
    }

    const sessionId = session_id!;
    const session = await getSession(sessionId);
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

    // Remove clip from session record
    await removeClipFromSession(sessionId, clip_id);

    // Delete MinIO objects (best-effort; log failures but don't surface to user)
    const ext = clip.filename.split(".").pop()?.toLowerCase() ?? "mp4";
    const clipKey = objectKeys.clip(sessionId, clip_id, ext);
    const thumbKey = objectKeys.thumbnail(sessionId, clip_id);

    const deletePromises = [
      deleteObject(clipKey).catch((err) =>
        console.error(`[storage] failed to delete clip ${clipKey}:`, err)
      ),
      deleteObject(thumbKey).catch(() => {
        /* thumbnail may not exist yet */
      }),
    ];

    await Promise.allSettled(deletePromises);

    console.log(
      `[storage] deleted clip objects for session=${sessionId}, clip_id=${clip_id}`
    );

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[DELETE /api/upload/clip/[clip_id]] error:", err);
    return internalError();
  }
}
