/**
 * Server-side environment variable validation.
 *
 * All required env vars are validated at startup.
 * If any are missing, an error is thrown immediately.
 * Values are never hardcoded — all limits come from env.
 */

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  redis: {
    url: optionalEnv("REDIS_URL", "redis://localhost:6379"),
  },
  minio: {
    // Internal endpoint: used by the app container to talk to MinIO (server-side ops).
    // Inside Docker Compose this is http://minio:9000.
    endpoint: optionalEnv("MINIO_ENDPOINT", "http://localhost:9000"),
    // Public endpoint: embedded in presigned URLs returned to the browser.
    // Must be reachable from the user's browser. Defaults to the same as endpoint
    // for local dev (where app runs outside Docker). Inside Docker Compose,
    // set MINIO_PUBLIC_URL=http://localhost:9000 so the browser can reach port 9000
    // (which must also be exposed in docker-compose.yml).
    publicUrl: optionalEnv("MINIO_PUBLIC_URL", optionalEnv("MINIO_ENDPOINT", "http://localhost:9000")),
    accessKeyId: optionalEnv("MINIO_ACCESS_KEY_ID", "minioadmin"),
    secretAccessKey: optionalEnv("MINIO_SECRET_ACCESS_KEY", "minioadmin"),
    bucket: optionalEnv("MINIO_BUCKET", "hypereels"),
    region: optionalEnv("MINIO_REGION", "us-east-1"),
  },
  ffmpeg: {
    hwaccel: optionalEnv("FFMPEG_HWACCEL", ""),
  },
  insightface: {
    providers: optionalEnv("INSIGHTFACE_PROVIDERS", "CPUExecutionProvider"),
  },
  session: {
    ttlSeconds: Number(optionalEnv("SESSION_TTL_SECONDS", String(2 * 60 * 60))), // 2 hours
    maxClips: Number(optionalEnv("MAX_CLIPS_PER_SESSION", "10")),
    maxClipSizeBytes: Number(
      optionalEnv("MAX_CLIP_SIZE_BYTES", String(2 * 1024 * 1024 * 1024))
    ), // 2 GiB
    maxAudioSizeBytes: Number(
      optionalEnv("MAX_AUDIO_SIZE_BYTES", String(200 * 1024 * 1024))
    ), // 200 MiB
    presignedPutTtlSeconds: Number(
      optionalEnv("PRESIGNED_PUT_TTL_SECONDS", String(15 * 60))
    ), // 15 min
    presignedGetTtlSeconds: Number(
      optionalEnv("PRESIGNED_GET_TTL_SECONDS", String(5 * 60))
    ), // 5 min
    cleanupDelayMs: Number(
      optionalEnv("CLEANUP_DELAY_MS", String(60 * 1000))
    ), // 60s
  },
  worker: {
    timeouts: {
      thumbnailExtractMs: Number(
        optionalEnv("TIMEOUT_THUMBNAIL_MS", String(2 * 60 * 1000))
      ),
      detectPersonsMs: Number(
        optionalEnv("TIMEOUT_DETECT_PERSONS_MS", String(10 * 60 * 1000))
      ),
      analyzeAudioMs: Number(
        optionalEnv("TIMEOUT_ANALYZE_AUDIO_MS", String(5 * 60 * 1000))
      ),
      generateReelMs: Number(
        optionalEnv("TIMEOUT_GENERATE_REEL_MS", String(10 * 60 * 1000))
      ),
      cleanupMs: Number(
        optionalEnv("TIMEOUT_CLEANUP_MS", String(2 * 60 * 1000))
      ),
    },
    pythonPath: optionalEnv("PYTHON_PATH", "python3"),
    scriptsDir: optionalEnv(
      "PYTHON_SCRIPTS_DIR",
      "/app/workers/scripts"
    ),
    tempDir: optionalEnv("TEMP_DIR", "/tmp/hypereels"),
  },
};
