/**
 * HypeReels API client.
 *
 * All API calls go through this module. No fetch() calls in component code.
 *
 * WARNING: docs/api-spec.md does not exist at time of implementation.
 * Endpoints are derived from docs/architecture.md §6 API Surface.
 * API contract details (request/response shapes) are best-effort.
 * Flag any mismatches to @backend-engineer.
 *
 * @api_issues [UNVERIFIED] All endpoint request/response shapes are derived
 * from architecture.md only — docs/api-spec.md was missing at implementation
 * time. Backend engineer must verify schemas match.
 */

import { API_BASE_URL } from "./env";
import type {
  Session,
  JobProgress,
  Person,
  StartJobResponse,
  PresignedUploadResponse,
  Highlight,
} from "@/types";

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("hypereels_session_id");
}

type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface FetchOptions {
  method?: RequestMethod;
  body?: unknown;
  sessionId?: string | null;
  signal?: AbortSignal;
}

/**
 * Core fetch wrapper. Adds X-Session-Id header, JSON serialization,
 * and surfaces API error messages (never raw objects).
 */
async function apiFetch<T>(
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const { method = "GET", body, signal } = options;
  const sessionId = options.sessionId ?? getSessionId();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (sessionId) {
    headers["X-Session-Id"] = sessionId;
  }

  const url = `${API_BASE_URL}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new ApiError("Network request failed. Check your connection.", 0);
  }

  if (response.status === 410) {
    throw new SessionExpiredError();
  }

  if (!response.ok) {
    let errorMessage = `Request failed (${response.status})`;
    try {
      const errorBody = await response.json();
      if (typeof errorBody?.error === "string") {
        errorMessage = errorBody.error;
      } else if (typeof errorBody?.message === "string") {
        errorMessage = errorBody.message;
      }
    } catch {
      // Could not parse error body — use status-derived message
    }
    throw new ApiError(errorMessage, response.status);
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// ─────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired. All files have been deleted.");
    this.name = "SessionExpiredError";
  }
}

// ─────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────

/**
 * POST /api/session
 * Creates a new ephemeral session. Returns session_id UUID.
 *
 * @api_issues [UNVERIFIED] Response shape assumed: { session_id: string }
 */
export async function createSession(): Promise<string> {
  const data = await apiFetch<{ session_id: string }>("/api/session", {
    method: "POST",
    sessionId: null,
  });
  return data.session_id;
}

/**
 * GET /api/session/{id}
 * Returns full session state.
 *
 * @api_issues [UNVERIFIED] Response shape derived from architecture §5.
 */
export async function getSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<Session> {
  return apiFetch<Session>(`/api/session/${sessionId}`, {
    sessionId,
    signal,
  });
}

// ─────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────

/**
 * POST /api/upload/clip
 * Requests a presigned PUT URL for a video clip.
 *
 * @api_issues [UNVERIFIED] Request body shape assumed: { filename, size_bytes, content_type }
 */
export async function requestClipUploadUrl(
  sessionId: string,
  filename: string,
  sizeBytes: number,
  contentType: string
): Promise<PresignedUploadResponse> {
  return apiFetch<PresignedUploadResponse>("/api/upload/clip", {
    method: "POST",
    sessionId,
    body: { filename, size_bytes: sizeBytes, content_type: contentType },
  });
}

/**
 * POST /api/upload/clip/{clip_id}/complete
 * Confirms a clip upload is complete.
 *
 * @api_issues [UNVERIFIED] Response shape assumed: { clip: Clip }
 */
export async function confirmClipUpload(
  sessionId: string,
  clipId: string
): Promise<void> {
  return apiFetch<void>(`/api/upload/clip/${clipId}/complete`, {
    method: "POST",
    sessionId,
  });
}

/**
 * DELETE /api/upload/clip/{clip_id}
 * Removes a clip from the session.
 *
 * @api_issues [UNVERIFIED] No request body. 204 assumed on success.
 */
export async function deleteClip(
  sessionId: string,
  clipId: string
): Promise<void> {
  return apiFetch<void>(`/api/upload/clip/${clipId}`, {
    method: "DELETE",
    sessionId,
  });
}

/**
 * POST /api/upload/audio
 * Requests a presigned PUT URL for audio upload.
 *
 * @api_issues [UNVERIFIED] Request body shape assumed: { filename, size_bytes, content_type }
 */
export async function requestAudioUploadUrl(
  sessionId: string,
  filename: string,
  sizeBytes: number,
  contentType: string
): Promise<PresignedUploadResponse> {
  return apiFetch<PresignedUploadResponse>("/api/upload/audio", {
    method: "POST",
    sessionId,
    body: { filename, size_bytes: sizeBytes, content_type: contentType },
  });
}

/**
 * POST /api/upload/audio/complete
 * Confirms audio upload is complete.
 *
 * @api_issues [UNVERIFIED] No request body. 200/204 assumed on success.
 */
export async function confirmAudioUpload(sessionId: string): Promise<void> {
  return apiFetch<void>("/api/upload/audio/complete", {
    method: "POST",
    sessionId,
  });
}

/**
 * Uploads a file directly to MinIO via a presigned PUT URL.
 * The app server is NOT in the request path — this is browser → MinIO direct.
 *
 * Accepts onProgress callback for per-file upload tracking.
 */
export function uploadFileToStorage(
  presignedUrl: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(
          new ApiError(
            `Storage upload failed. Please try again.`,
            xhr.status
          )
        );
      }
    };

    xhr.onerror = () => {
      reject(new ApiError("Network error during upload. Check your connection.", 0));
    };

    xhr.open("PUT", presignedUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });
}

// ─────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────

/**
 * POST /api/jobs/detect-persons
 * Enqueues person detection for all clips in the session.
 *
 * @api_issues [UNVERIFIED] Request body shape assumed: { session_id }
 */
export async function startPersonDetection(
  sessionId: string
): Promise<StartJobResponse> {
  return apiFetch<StartJobResponse>("/api/jobs/detect-persons", {
    method: "POST",
    sessionId,
    body: { session_id: sessionId },
  });
}

/**
 * GET /api/jobs/{job_id}/progress
 * Polls job progress. Caller handles polling interval.
 *
 * @api_issues [UNVERIFIED] Response shape derived from architecture §5 JobProgress.
 */
export async function getJobProgress(
  sessionId: string,
  jobId: string,
  signal?: AbortSignal
): Promise<JobProgress> {
  return apiFetch<JobProgress>(`/api/jobs/${jobId}/progress`, {
    sessionId,
    signal,
  });
}

/**
 * GET /api/session/{id}/persons
 * Returns detected persons for the session after detection completes.
 *
 * @api_issues [UNVERIFIED] This endpoint is NOT listed in architecture.md §6.
 * Derived from data flow §4.2 which states "polls GET /api/session/{id}/persons".
 * Backend engineer must confirm this endpoint exists and its response shape.
 */
export async function getSessionPersons(
  sessionId: string,
  signal?: AbortSignal
): Promise<Person[]> {
  return apiFetch<Person[]>(`/api/session/${sessionId}/persons`, {
    sessionId,
    signal,
  });
}

/**
 * POST /api/session/{id}/person
 * Sets or clears the selected person of interest.
 *
 * @api_issues [UNVERIFIED] Request body assumed: { person_id: string | null }
 */
export async function setPersonOfInterest(
  sessionId: string,
  personId: string | null
): Promise<void> {
  return apiFetch<void>(`/api/session/${sessionId}/person`, {
    method: "POST",
    sessionId,
    body: { person_id: personId },
  });
}

// ─────────────────────────────────────────────
// Highlights
// ─────────────────────────────────────────────

/**
 * PATCH /api/session/{id}/clips/{clip_id}/highlights
 * Adds or updates a highlight range on a clip.
 *
 * @api_issues [UNVERIFIED] Architecture says "Add or update" but doesn't
 * clarify if this replaces all highlights or appends one. Assumed: sends
 * full array to replace. Backend engineer must confirm.
 */
export async function saveHighlights(
  sessionId: string,
  clipId: string,
  highlights: Array<{ start_ms: number; end_ms: number }>
): Promise<Highlight[]> {
  return apiFetch<Highlight[]>(
    `/api/session/${sessionId}/clips/${clipId}/highlights`,
    {
      method: "PATCH",
      sessionId,
      body: { highlights },
    }
  );
}

/**
 * DELETE /api/session/{id}/clips/{clip_id}/highlights/{highlight_id}
 * Removes a single highlight from a clip.
 *
 * @api_issues [UNVERIFIED] 204 assumed on success.
 */
export async function deleteHighlight(
  sessionId: string,
  clipId: string,
  highlightId: string
): Promise<void> {
  return apiFetch<void>(
    `/api/session/${sessionId}/clips/${clipId}/highlights/${highlightId}`,
    {
      method: "DELETE",
      sessionId,
    }
  );
}

// ─────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────

/**
 * POST /api/jobs/generate-reel
 * Enqueues reel generation (audio analysis + assembly).
 *
 * @api_issues [UNVERIFIED] Request body assumed: { session_id }
 */
export async function startReelGeneration(
  sessionId: string
): Promise<StartJobResponse> {
  return apiFetch<StartJobResponse>("/api/jobs/generate-reel", {
    method: "POST",
    sessionId,
    body: { session_id: sessionId },
  });
}

// ─────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────

/**
 * GET /api/download/{session_id}
 * Issues a presigned download URL and enqueues cleanup.
 *
 * The presigned URL is returned in the response body — never shown to the user.
 * Architecture §4.5 says the server "returns redirect" but for client-side
 * handling we need the URL in the body to programmatically trigger download.
 *
 * @api_issues [UNVERIFIED] Architecture says "returns redirect (302)" but the
 * frontend cannot follow a redirect to a presigned URL and trigger a native
 * browser download simultaneously. Assumed the endpoint returns JSON with the
 * presigned URL. Backend engineer must confirm: does this return 302 or JSON
 * with { download_url }? If 302, client must handle via window.location.
 */
export async function getDownloadUrl(
  sessionId: string
): Promise<{ download_url: string }> {
  return apiFetch<{ download_url: string }>(`/api/download/${sessionId}`, {
    sessionId,
  });
}
