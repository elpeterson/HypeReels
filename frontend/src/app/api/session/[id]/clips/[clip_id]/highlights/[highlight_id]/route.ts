/**
 * DELETE /api/session/[id]/clips/[clip_id]/highlights/[highlight_id]
 *
 * Remove a specific highlight from a clip.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, removeHighlightFromClip } from "../../../../../../../../lib/redis";
import {
  sessionNotFound,
  sessionExpired,
  notFound,
  internalError,
} from "../../../../../../../../lib/errors";
import { isExpired } from "../../../../../../../../lib/fsm";
import { config } from "../../../../../../../../lib/config";

interface RouteParams {
  params: { id: string; clip_id: string; highlight_id: string };
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { id, clip_id, highlight_id } = params;
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

    const highlight = clip.highlights.find(
      (h) => h.highlight_id === highlight_id
    );
    if (!highlight) {
      return notFound("Highlight not found");
    }

    await removeHighlightFromClip(id, clip_id, highlight_id);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error(
      "[DELETE /api/session/[id]/clips/[clip_id]/highlights/[highlight_id]] error:",
      err
    );
    return internalError();
  }
}
