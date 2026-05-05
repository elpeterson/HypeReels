/**
 * POST /api/session
 *
 * Create a new ephemeral session. Returns a UUID session_id.
 * The session_id is stored in browser localStorage and sent as X-Session-Id.
 */

import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createSession } from "../../../lib/redis";
import { internalError } from "../../../lib/errors";

export async function POST(): Promise<NextResponse> {
  try {
    const sessionId = uuidv4();
    await createSession(sessionId);

    return NextResponse.json({ session_id: sessionId }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/session] error:", err);
    return internalError();
  }
}
