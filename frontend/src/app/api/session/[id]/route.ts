/**
 * GET /api/session/[id]
 *
 * Return the full session state from Redis.
 * Returns 404 if session not found or expired.
 */

import { NextResponse } from "next/server";
import { getSession, getPersons } from "../../../../lib/redis";
import { sessionNotFound, sessionExpired, internalError } from "../../../../lib/errors";
import { isExpired } from "../../../../lib/fsm";
import { config } from "../../../../lib/config";

interface RouteParams {
  params: { id: string };
}

export async function GET(
  _req: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { id } = params;
    const session = await getSession(id);

    if (!session) {
      return sessionNotFound();
    }

    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    // Attach persons list if available
    const persons = await getPersons(id);

    return NextResponse.json({ ...session, persons });
  } catch (err) {
    console.error("[GET /api/session/[id]] error:", err);
    return internalError();
  }
}
