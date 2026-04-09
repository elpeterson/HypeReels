/**
 * InsightFace HTTP client for person detection.
 *
 * Calls the self-hosted Python InsightFace worker running on Quorra
 * (192.168.1.100:8000 in production, PYTHON_WORKER_URL in config).
 *
 * The Python worker runs InsightFace (buffalo_l model) CPU-only.
 * GPU is reserved exclusively for Frigate NVR (ADR-013 / STORY-021).
 *
 * Worker contract:
 *   POST {PYTHON_WORKER_URL}/detect-persons
 *   Body: { clip_id, clip_url, session_id, collection_id }
 *   Response: {
 *     clip_id: string,
 *     persons: [{
 *       person_ref_id: string,
 *       thumbnail_url: string,
 *       confidence: number,
 *       appearances: [{ start_ms: number, end_ms: number }]
 *     }]
 *   }
 *
 * The collection_id is simply the session_id — InsightFace uses it for
 * in-memory embedding clustering within a session. No collection lifecycle
 * management is needed (unlike Rekognition's CreateCollection/DeleteCollection).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PersonAppearance {
  start_ms: number;
  end_ms: number;
}

export interface DetectedPerson {
  person_ref_id: string;
  thumbnail_url: string;
  confidence: number;
  appearances: PersonAppearance[];
}

export interface InsightFaceResult {
  clip_id: string;
  persons: DetectedPerson[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PYTHON_WORKER_URL =
  process.env['PYTHON_WORKER_URL'] ?? 'http://python-workers:8000';

/**
 * Detection timeout — default 120 s, longer than audio analysis default because
 * InsightFace runs CPU-only and processes per-frame embeddings across the full clip.
 */
const PYTHON_TIMEOUT_MS = parseInt(
  process.env['PYTHON_TIMEOUT_MS'] ?? '120000',
  10,
);

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Detect persons in a video clip by calling the InsightFace Python worker.
 *
 * @param sessionId       - The current session UUID (used as collection_id for
 *                          in-session clustering on the Python side).
 * @param clipId          - The clip UUID to detect persons in.
 * @param clipPresignedUrl - A presigned MinIO GET URL the Python worker uses to
 *                          download the clip for frame extraction.
 * @returns Structured detection result with per-person thumbnails and appearances.
 */
export async function detectPersonsInClip(
  sessionId: string,
  clipId: string,
  clipPresignedUrl: string,
): Promise<InsightFaceResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PYTHON_TIMEOUT_MS);

  try {
    const response = await fetch(`${PYTHON_WORKER_URL}/detect-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clip_id: clipId,
        clip_url: clipPresignedUrl,
        session_id: sessionId,
        collection_id: sessionId, // InsightFace uses session_id as grouping key
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Surface the Python error detail to the caller
      let detail: string;
      try {
        const body = (await response.json()) as { detail?: string; error?: string };
        detail = body.detail ?? body.error ?? await response.text();
      } catch {
        detail = await response.text().catch(() => 'no response body');
      }
      throw new Error(
        `InsightFace worker returned HTTP ${response.status}: ${detail}`,
      );
    }

    const result = (await response.json()) as InsightFaceResult;

    // Basic shape validation
    if (result.clip_id === undefined || !Array.isArray(result.persons)) {
      throw new Error(
        'InsightFace worker returned an unexpected response shape: missing clip_id or persons',
      );
    }

    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `InsightFace worker timed out after ${PYTHON_TIMEOUT_MS}ms for clip ${clipId}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
