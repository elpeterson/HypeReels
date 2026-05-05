/**
 * GET /api/session/[id]/persons
 *
 * Read the deduplicated person list for a session from Redis key persons:{session_id}.
 * Returns the array of person objects (empty array if detection not yet complete).
 *
 * Referenced in architecture §4.2: "frontend … polls GET /api/session/{id}/persons"
 */

import { NextResponse } from "next/server";
import { getSession, getPersons } from "../../../../../lib/redis";
import { sessionNotFound, sessionExpired, internalError } from "../../../../../lib/errors";
import { isExpired } from "../../../../../lib/fsm";
import { config } from "../../../../../lib/config";

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

    const persons = await getPersons(id);

    return NextResponse.json({ persons });
  } catch (err) {
    console.error("[GET /api/session/[id]/persons] error:", err);
    return internalError();
  }
}
