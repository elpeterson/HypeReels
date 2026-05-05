/**
 * Standard error envelope helpers.
 *
 * Every error response: {"error":{"code":"string","message":"string","details?":any}}
 */

import { NextResponse } from "next/server";

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown
): NextResponse {
  const body: { error: ApiError } = {
    error: { code, message },
  };
  if (details !== undefined) {
    body.error.details = details;
  }
  return NextResponse.json(body, { status });
}

export function notFound(message = "Not found"): NextResponse {
  return errorResponse(404, "not_found", message);
}

export function sessionNotFound(): NextResponse {
  return errorResponse(404, "session_not_found", "Session not found or expired");
}

export function sessionExpired(): NextResponse {
  return errorResponse(410, "session_expired", "Session has expired. All files have been deleted.");
}

export function conflict(code: string, message: string, details?: unknown): NextResponse {
  return errorResponse(409, code, message, details);
}

export function unprocessable(
  code: string,
  message: string,
  details?: unknown
): NextResponse {
  return errorResponse(422, code, message, details);
}

export function internalError(message = "Internal server error"): NextResponse {
  return errorResponse(500, "internal_error", message);
}

export function badRequest(
  code: string,
  message: string,
  details?: unknown
): NextResponse {
  return errorResponse(400, code, message, details);
}
