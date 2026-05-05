/**
 * Client-side file validation.
 *
 * All limits come from env vars — never hardcoded here.
 */

import {
  MAX_CLIPS,
  MAX_CLIP_SIZE_BYTES,
  MAX_AUDIO_SIZE_BYTES,
  ACCEPTED_VIDEO_EXTENSIONS,
  ACCEPTED_AUDIO_EXTENSIONS,
} from "./env";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

function getExtension(filename: string): string {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? `.${parts[parts.length - 1]}` : "";
}

export function validateVideoFile(
  file: File,
  currentClipCount: number
): ValidationResult {
  if (currentClipCount >= MAX_CLIPS) {
    return {
      valid: false,
      error: `Maximum ${MAX_CLIPS} clips per session`,
    };
  }

  const ext = getExtension(file.name);
  if (!ACCEPTED_VIDEO_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `"${file.name}" — Unsupported format. Accepted: MP4, MOV, MKV, WebM`,
    };
  }

  if (file.size > MAX_CLIP_SIZE_BYTES) {
    return {
      valid: false,
      error: `"${file.name}" — File exceeds the ${formatBytes(MAX_CLIP_SIZE_BYTES)} limit`,
    };
  }

  return { valid: true };
}

export function validateAudioFile(file: File): ValidationResult {
  const ext = getExtension(file.name);
  if (!ACCEPTED_AUDIO_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `"${file.name}" — Unsupported format. Accepted: MP3, WAV, AAC, FLAC, M4A`,
    };
  }

  if (file.size > MAX_AUDIO_SIZE_BYTES) {
    return {
      valid: false,
      error: `"${file.name}" — File exceeds the ${formatBytes(MAX_AUDIO_SIZE_BYTES)} limit`,
    };
  }

  return { valid: true };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(0)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function msToSeconds(ms: number): number {
  return ms / 1000;
}

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}
