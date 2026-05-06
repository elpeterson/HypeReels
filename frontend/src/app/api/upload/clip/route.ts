/**
 * POST /api/upload/clip
 *
 * Validate file metadata, issue a presigned PUT URL for browser-to-MinIO
 * direct upload, and register the clip in the session.
 *
 * Header: X-Session-Id: string (session_id)
 *
 * Body (JSON):
 *   filename:   string
 *   content_type: string
 *   size_bytes: number
 *
 * Returns:
 *   { clip_id, upload_url, object_key }
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession, addClipToSession } from "../../../../lib/redis";
import { createPresignedPutUrl, objectKeys } from "../../../../lib/storage";
import {
  sessionNotFound,
  sessionExpired,
  conflict,
  unprocessable,
  internalError,
} from "../../../../lib/errors";
import { isExpired } from "../../../../lib/fsm";
import { config } from "../../../../lib/config";
import type { Clip } from "../../../../types";

const ACCEPTED_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
};

const ACCEPTED_EXTENSIONS = ["mp4", "mov", "mkv", "webm"];

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

    // Validate required fields
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
        `Unsupported format — accepted: MP4, MOV, MKV, WebM`,
        { filename, content_type }
      );
    }

    // Validate extension matches MIME type
    const fileExt = filename.split(".").pop()?.toLowerCase();
    if (!fileExt || !ACCEPTED_EXTENSIONS.includes(fileExt)) {
      return unprocessable(
        "unsupported_format",
        `File extension not accepted — accepted: .mp4, .mov, .mkv, .webm`,
        { filename }
      );
    }

    // Validate file size
    if (size_bytes > config.session.maxClipSizeBytes) {
      return unprocessable(
        "file_too_large",
        `File exceeds the 2 GB limit`,
        {
          filename,
          size_bytes,
          max_size_bytes: config.session.maxClipSizeBytes,
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

    // Enforce clip limit
    if (session.clips.length >= config.session.maxClips) {
      return conflict(
        "max_clips_exceeded",
        `Maximum ${config.session.maxClips} clips per session`,
        { current_count: session.clips.length }
      );
    }

    // Check for duplicate content (by filename + size as a basic proxy)
    const duplicate = session.clips.find(
      (c) => c.filename === filename && c.size_bytes === size_bytes
    );
    if (duplicate) {
      return conflict(
        "duplicate_clip",
        "This clip has already been uploaded",
        { existing_clip_id: duplicate.clip_id }
      );
    }

    // Create clip record
    const clipId = uuidv4();
    const objectKey = objectKeys.clip(session_id, clipId, ext);

    const clip: Clip = {
      clip_id: clipId,
      filename,
      duration_ms: 0, // Will be updated after thumbnail extraction
      size_bytes,
      object_key: objectKey,
      thumbnail_key: null,
      thumbnail_url: null,
      status: "uploading",
      highlights: [],
    };

    // Persist clip to session before issuing presigned URL
    await addClipToSession(session_id, clip);

    // Generate presigned PUT URL
    const uploadUrl = await createPresignedPutUrl(
      objectKey,
      normalizedType,
      size_bytes
    );

    return NextResponse.json(
      { clip_id: clipId, upload_url: uploadUrl, object_key: objectKey },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/upload/clip] error:", err);
    return internalError();
  }
}
