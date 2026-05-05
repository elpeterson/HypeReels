/**
 * Environment variable accessors.
 *
 * All limits and URLs MUST come from here — never hardcoded in component code.
 * NEXT_PUBLIC_* variables are available in the browser.
 * Non-prefixed variables are server-only.
 */

/** Base URL for the Next.js API routes. Defaults to empty string (same origin). */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/** Maximum number of video clips per session */
export const MAX_CLIPS = Number(process.env.NEXT_PUBLIC_MAX_CLIPS ?? "10");

/** Maximum clip file size in bytes (default 2 GiB) */
export const MAX_CLIP_SIZE_BYTES = Number(
  process.env.NEXT_PUBLIC_MAX_CLIP_SIZE_BYTES ?? String(2 * 1024 * 1024 * 1024)
);

/** Maximum audio file size in bytes (default 200 MiB) */
export const MAX_AUDIO_SIZE_BYTES = Number(
  process.env.NEXT_PUBLIC_MAX_AUDIO_SIZE_BYTES ?? String(200 * 1024 * 1024)
);

/** Accepted video MIME types */
export const ACCEPTED_VIDEO_MIME_TYPES = (
  process.env.NEXT_PUBLIC_ACCEPTED_VIDEO_MIME_TYPES ??
  "video/mp4,video/quicktime,video/x-matroska,video/webm"
).split(",");

/** Accepted video extensions (lowercase, with dot) */
export const ACCEPTED_VIDEO_EXTENSIONS = (
  process.env.NEXT_PUBLIC_ACCEPTED_VIDEO_EXTENSIONS ?? ".mp4,.mov,.mkv,.webm"
).split(",");

/** Accepted audio MIME types */
export const ACCEPTED_AUDIO_MIME_TYPES = (
  process.env.NEXT_PUBLIC_ACCEPTED_AUDIO_MIME_TYPES ??
  "audio/mpeg,audio/wav,audio/aac,audio/flac,audio/x-m4a,audio/mp4"
).split(",");

/** Accepted audio extensions (lowercase, with dot) */
export const ACCEPTED_AUDIO_EXTENSIONS = (
  process.env.NEXT_PUBLIC_ACCEPTED_AUDIO_EXTENSIONS ??
  ".mp3,.wav,.aac,.flac,.m4a"
).split(",");

/** Job progress polling interval in ms (default 2000) */
export const POLL_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_POLL_INTERVAL_MS ?? "2000"
);

/** Stall detection: polls with unchanged pct before backoff */
export const STALL_POLL_COUNT = Number(
  process.env.NEXT_PUBLIC_STALL_POLL_COUNT ?? "3"
);

/** Max stall time before showing warning (ms, default 10 min) */
export const STALL_WARNING_MS = Number(
  process.env.NEXT_PUBLIC_STALL_WARNING_MS ?? String(10 * 60 * 1000)
);

/** Confidence threshold below which a person is "low confidence" */
export const LOW_CONFIDENCE_THRESHOLD = Number(
  process.env.NEXT_PUBLIC_LOW_CONFIDENCE_THRESHOLD ?? "0.7"
);

/** LocalStorage key for session ID */
export const SESSION_STORAGE_KEY =
  process.env.NEXT_PUBLIC_SESSION_STORAGE_KEY ?? "hypereels_session_id";
