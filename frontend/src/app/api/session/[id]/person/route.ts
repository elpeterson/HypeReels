/**
 * POST /api/session/[id]/person
 *
 * Set or clear the person_id (person of interest) on a session.
 * Body: { person_id: string | null }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, updateSessionPerson } from "../../../../../lib/redis";
import {
  sessionNotFound,
  sessionExpired,
  unprocessable,
  internalError,
} from "../../../../../lib/errors";
import { isExpired } from "../../../../../lib/fsm";
import { config } from "../../../../../lib/config";

interface RouteParams {
  params: { id: string };
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { id } = params;
    const session = await getSession(id);

    if (!session) return sessionNotFound();
    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    let body: { person_id?: string | null };
    try {
      body = await req.json();
    } catch {
      return unprocessable("invalid_json", "Request body must be valid JSON");
    }

    // person_id can be a UUID string or null (to clear selection)
    const { person_id } = body;
    if (person_id !== undefined && person_id !== null && typeof person_id !== "string") {
      return unprocessable(
        "invalid_person_id",
        "person_id must be a string UUID or null"
      );
    }

    await updateSessionPerson(id, person_id ?? null);

    return NextResponse.json({ person_id: person_id ?? null });
  } catch (err) {
    console.error("[POST /api/session/[id]/person] error:", err);
    return internalError();
  }
}
