/**
 * GET /api/session/[id]/persons
 *
 * Read the deduplicated person list for a session from Redis key persons:{session_id}.
 * Hydrates each person's thumbnail_url with a presigned MinIO GET URL before returning.
 * Returns the array of person objects (empty array if detection not yet complete).
 *
 * Referenced in architecture §4.2: "frontend … polls GET /api/session/{id}/persons"
 */

import { NextResponse } from "next/server";
import { getSession, getPersons } from "../../../../../lib/redis";
import { createPresignedGetUrl } from "../../../../../lib/storage";
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

    // Hydrate thumbnail_url — persons are stored with the MinIO object key in
    // `thumbnail`; the browser needs a time-limited presigned GET URL.
    // Generate all URLs in parallel; fall back to null on error so a single
    // missing thumbnail never blocks the whole response.
    const hydrated = await Promise.all(
      persons.map(async (person) => {
        if (!person.thumbnail) return { ...person, thumbnail_url: null };
        try {
          const url = await createPresignedGetUrl(person.thumbnail);
          return { ...person, thumbnail_url: url };
        } catch {
          return { ...person, thumbnail_url: null };
        }
      })
    );

    return NextResponse.json({ persons: hydrated });
  } catch (err) {
    console.error("[GET /api/session/[id]/persons] error:", err);
    return internalError();
  }
}
