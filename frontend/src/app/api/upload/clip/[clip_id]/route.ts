/**
 * DELETE /api/upload/clip/[clip_id]
 *
 * Remove a clip from the session and delete its MinIO object.
 * Header: X-Session-Id: string (session_id)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, removeClipFromSession } from "../../../../../lib/redis";
import { deleteObject, objectKeys } from "../../../../../lib/storage";
import {
  errorResponse,
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

    // session_id comes from the X-Session-Id header (set by apiFetch)
    const sessionId = req.headers.get("X-Session-Id");
    if (!sessionId) {
      return errorResponse(422, "missing_session_id", "X-Session-Id header is required");
    }

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
    // object_key was stored when the clip was created; thumbnail may not exist yet
    const clipKey = clip.object_key;
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
