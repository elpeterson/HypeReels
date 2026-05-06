/**
 * POST /api/upload/audio
 *
 * Validate audio file metadata, issue a presigned PUT URL for
 * browser-to-MinIO direct upload, and register the audio in the session.
 *
 * Header: X-Session-Id: string (session_id)
 *
 * Body (JSON):
 *   filename:     string
 *   content_type: string
 *   size_bytes:   number
 *
 * Returns:
 *   { audio_id, upload_url, object_key }
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession, updateSessionAudio } from "../../../../lib/redis";
import { createPresignedPutUrl, objectKeys } from "../../../../lib/storage";
import {
  sessionNotFound,
  sessionExpired,
  unprocessable,
  internalError,
} from "../../../../lib/errors";
import { isExpired } from "../../../../lib/fsm";
import { config } from "../../../../lib/config";
import type { AudioTrack } from "../../../../types";

const ACCEPTED_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/x-m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
};

const ACCEPTED_EXTENSIONS = ["mp3", "wav", "aac", "flac", "m4a"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // session_id comes from the X-Session-Id header (set by apiFetch)
    const session_id = req.headers.get("X-Session-Id");
    if (!session_id) {
      return unprocessable("missing_session_id", "X-Session-Id header is required");
    }

    let body: {
      filename?: unknown;
      content_type?: unknown;
      size_bytes?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return unprocessable("invalid_json", "Request body must be valid JSON");
    }

    const { filename, content_type, size_bytes } = body;

    if (!filename || typeof filename !== "string") {
      return unprocessable("missing_filename", "filename is required");
    }
    if (!content_type || typeof content_type !== "string") {
      return unprocessable("missing_content_type", "content_type is required");
    }
    if (typeof size_bytes !== "number" || size_bytes <= 0) {
      return unprocessable("invalid_size", "size_bytes must be a positive number");
    }

    // Validate MIME type
    const normalizedType = content_type.toLowerCase().split(";")[0].trim();
    const ext = ACCEPTED_TYPES[normalizedType];
    if (!ext) {
      return unprocessable(
        "unsupported_format",
        `Unsupported format — accepted: MP3, WAV, AAC, FLAC, M4A`,
        { filename, content_type }
      );
    }

    // Validate extension
    const fileExt = filename.split(".").pop()?.toLowerCase();
    if (!fileExt || !ACCEPTED_EXTENSIONS.includes(fileExt)) {
      return unprocessable(
        "unsupported_format",
        `File extension not accepted — accepted: .mp3, .wav, .aac, .flac, .m4a`,
        { filename }
      );
    }

    // Validate file size
    if (size_bytes > config.session.maxAudioSizeBytes) {
      return unprocessable(
        "file_too_large",
        `File exceeds the 200 MB limit`,
        {
          filename,
          size_bytes,
          max_size_bytes: config.session.maxAudioSizeBytes,
        }
      );
    }

    // Look up session
    const session = await getSession(session_id);
    if (!session) return sessionNotFound();
    if (
      session.state === "expired" ||
      isExpired(session.created_at, config.session.ttlSeconds)
    ) {
      return sessionExpired();
    }

    // Create audio record
    const audioId = uuidv4();
    const objectKey = objectKeys.audio(session_id, ext);

    const audio: AudioTrack = {
      audio_id: audioId,
      filename,
      duration_ms: 0, // Updated after analysis
      size_bytes,
      object_key: objectKey,
    };

    // Persist audio to session
    await updateSessionAudio(session_id, audio);

    // Generate presigned PUT URL
    const uploadUrl = await createPresignedPutUrl(
      objectKey,
      normalizedType,
      size_bytes
    );

    return NextResponse.json(
      { audio_id: audioId, upload_url: uploadUrl, object_key: objectKey },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/upload/audio] error:", err);
    return internalError();
  }
}
