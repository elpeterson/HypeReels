# HypeReels — REST API Specification

> **Owner:** @backend-engineer
> **Status:** v1.0 — MVP
> **Last updated:** 2026-05-05
> **Format:** OpenAPI 3.0 (prose + schema notation)

---

## Overview

All endpoints are Next.js Route Handlers under `/api/`. The API is REST-only (no GraphQL, no WebSockets). All responses are JSON unless otherwise noted (download endpoint redirects).

### Base URL

```
http://{host}:{port}/api
```

Default: `http://localhost:3000/api`

### Session Identification

Sessions are identified by a UUID v4 token stored in browser `localStorage` and sent as a request body field `session_id` (or as a path parameter `[id]`/`[session_id]`).

> Architecture §8: "No JWT, no auth, no passwords. Possession of the UUID = access to that session."

### Standard Error Envelope

All error responses use this shape:

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {} // optional
  }
}
```

### Standard HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 202 | Accepted (async job enqueued) |
| 204 | No Content (successful delete) |
| 400 | Bad Request |
| 404 | Not Found |
| 409 | Conflict (state violation, duplicate) |
| 410 | Gone (session expired) |
| 422 | Unprocessable Entity (validation failure) |
| 500 | Internal Server Error |

---

## Data Models

### Session

```typescript
{
  id:         string          // UUID v4
  state:      SessionState    // see enum below
  created_at: number          // Unix ms
  clips:      Clip[]
  audio:      AudioTrack | null
  person_id:  string | null   // selected person of interest UUID
  reel_key:   string | null   // MinIO object key for generated reel
  error:      string | null
  persons:    Person[]        // populated after detect-persons completes
}
```

**SessionState enum:** `uploading | detecting | analyzing | generating | ready | failed | expired`

### Clip

```typescript
{
  clip_id:       string          // UUID v4
  filename:      string
  duration_ms:   number          // 0 until thumbnail-extract completes
  size_bytes:    number
  thumbnail_key: string | null   // MinIO object key
  thumbnail_url: string | null   // presigned GET URL (populated by frontend)
  status:        ClipStatus      // uploading | ready | detection_failed
  highlights:    Highlight[]
}
```

### Highlight

```typescript
{
  highlight_id: string  // UUID v4
  start_ms:     number  // >= 0
  end_ms:       number  // > start_ms; end_ms - start_ms >= 1000
}
```

### AudioTrack

```typescript
{
  audio_id:   string  // UUID v4
  filename:   string
  duration_ms: number
  size_bytes:  number
  object_key:  string  // MinIO object key
}
```

### Person

```typescript
{
  person_id:   string                                       // UUID v4
  bbox:        [number, number, number, number]             // [x, y, w, h]
  thumbnail:   string                                       // MinIO object key
  confidence:  number                                       // 0.0–1.0
  appearances: Array<{ clip_id: string; timestamp_ms: number }>
}
```

### JobProgress

```typescript
{
  job_id:     string     // UUID
  status:     "queued" | "processing" | "completed" | "failed"
  stage:      string     // human-readable label
  pct:        number     // 0–100
  message:    string
  updated_at: number     // Unix ms
  error?:     string     // only on failed
}
```

---

## Endpoints

---

### POST /api/session

Create a new ephemeral session.

**Request:** No body required.

**Response 201:**
```json
{ "session_id": "550e8400-e29b-41d4-a716-446655440000" }
```

**Response 500:**
```json
{ "error": { "code": "internal_error", "message": "Internal server error" } }
```

---

### GET /api/session/[id]

Return the full session state.

**Path parameters:**
- `id` — session UUID

**Response 200:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "uploading",
  "created_at": 1714900000000,
  "clips": [],
  "audio": null,
  "person_id": null,
  "reel_key": null,
  "error": null,
  "persons": []
}
```

**Response 404:**
```json
{ "error": { "code": "session_not_found", "message": "Session not found or expired" } }
```

**Response 410:**
```json
{ "error": { "code": "session_expired", "message": "Session has expired. All files have been deleted." } }
```

---

### POST /api/upload/clip

Validate clip file metadata and issue a presigned PUT URL for direct browser-to-MinIO upload.

**Request body:**
```json
{
  "session_id":   "string",
  "filename":     "string",
  "content_type": "string",
  "size_bytes":   "number"
}
```

**Accepted video MIME types:** `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`

**Accepted extensions:** `.mp4`, `.mov`, `.mkv`, `.webm`

**Max size:** 2 GiB (configurable via `MAX_CLIP_SIZE_BYTES` env var)

**Max clips per session:** 10 (configurable via `MAX_CLIPS_PER_SESSION` env var)

**Response 201:**
```json
{
  "clip_id":    "550e8400-e29b-41d4-a716-446655440001",
  "upload_url": "http://minio:9000/hypereels/...?X-Amz-Signature=...",
  "object_key": "550e8400.../clips/550e8400...1.mp4"
}
```

**Response 404:** Session not found

**Response 409:**
```json
{
  "error": {
    "code": "max_clips_exceeded",
    "message": "Maximum 10 clips per session",
    "details": { "current_count": 10 }
  }
}
```

```json
{
  "error": {
    "code": "duplicate_clip",
    "message": "This clip has already been uploaded",
    "details": { "existing_clip_id": "uuid" }
  }
}
```

**Response 422:**
```json
{
  "error": {
    "code": "unsupported_format",
    "message": "Unsupported format — accepted: MP4, MOV, MKV, WebM",
    "details": { "filename": "clip.avi", "content_type": "video/x-msvideo" }
  }
}
```

```json
{
  "error": {
    "code": "file_too_large",
    "message": "File exceeds the 2 GB limit",
    "details": { "filename": "clip.mp4", "size_bytes": 3000000000, "max_size_bytes": 2147483648 }
  }
}
```

---

### POST /api/upload/clip/[clip_id]/complete

Mark a clip as ready after the browser has finished the presigned PUT upload. Enqueues `thumbnail-extract` job.

**Path parameters:**
- `clip_id` — clip UUID from `/api/upload/clip`

**Request body:**
```json
{
  "session_id": "string",
  "object_key": "string"
}
```

**Response 200:**
```json
{
  "clip_id": "uuid",
  "job_id":  "thumbnail-job-uuid"
}
```

**Response 404:** Session not found, or clip not found in session

**Response 409:**
```json
{ "error": { "code": "already_complete", "message": "Clip upload already marked as complete" } }
```

---

### DELETE /api/upload/clip/[clip_id]

Remove a clip from the session and delete its MinIO objects.

**Path parameters:**
- `clip_id` — clip UUID

**Request body:**
```json
{ "session_id": "string" }
```

**Response 204:** No content (success)

**Response 404:** Session not found, or clip not found in session

---

### POST /api/upload/audio

Validate audio file metadata and issue a presigned PUT URL for direct browser-to-MinIO upload.

**Request body:**
```json
{
  "session_id":   "string",
  "filename":     "string",
  "content_type": "string",
  "size_bytes":   "number"
}
```

**Accepted audio MIME types:** `audio/mpeg`, `audio/wav`, `audio/aac`, `audio/flac`, `audio/x-m4a`, `audio/mp4`

**Accepted extensions:** `.mp3`, `.wav`, `.aac`, `.flac`, `.m4a`

**Max size:** 200 MiB (configurable via `MAX_AUDIO_SIZE_BYTES` env var)

**Response 201:**
```json
{
  "audio_id":   "uuid",
  "upload_url": "http://minio:9000/hypereels/...?X-Amz-Signature=...",
  "object_key": "session-uuid/audio.mp3"
}
```

**Response 404:** Session not found

**Response 422:** (same pattern as clip — unsupported_format, file_too_large)

---

### POST /api/upload/audio/complete

Mark audio as ready after the browser has finished the presigned PUT upload.

**Request body:**
```json
{
  "session_id": "string",
  "audio_id":   "string"
}
```

**Response 200:**
```json
{ "audio_id": "uuid" }
```

**Response 404:** Session not found, or audio not found/mismatched

---

### POST /api/jobs/detect-persons

Validate that at least one clip is ready, then enqueue the `detect-persons` job.

**Request body:**
```json
{ "session_id": "string" }
```

**Response 202:**
```json
{ "job_id": "detect-persons-job-uuid" }
```

**Response 409:**
```json
{
  "error": {
    "code": "no_ready_clips",
    "message": "At least one clip must be ready before detecting persons",
    "details": { "clip_count": 0 }
  }
}
```

```json
{
  "error": {
    "code": "detection_in_progress",
    "message": "Person detection is already in progress"
  }
}
```

**Session state transition:** `uploading → detecting`

---

### GET /api/jobs/[job_id]/progress

Poll job progress. Frontend polls every 2 seconds (per architecture §6).

**Path parameters:**
- `job_id` — job UUID returned by a job-enqueue endpoint

**Response 200:**
```json
{
  "job_id":     "uuid",
  "status":     "processing",
  "stage":      "Analyzing clips for people…",
  "pct":        45,
  "message":    "Processed clip 2 of 4",
  "updated_at": 1714900000000
}
```

`pct` rules:
- `queued` → 0
- `processing` → 1–99
- `completed` → 100
- `failed` → unchanged (last value before failure)

**Response 404:** Job not found or progress key expired

---

### PATCH /api/session/[id]/clips/[clip_id]/highlights

**Append** a single new highlight range to the clip's existing highlights array.
The frontend sends `{ start_ms, end_ms }` for the new highlight only; this is
always an append — the server never replaces the full array.

**Path parameters:**
- `id` — session UUID
- `clip_id` — clip UUID

**Request body:**
```json
{
  "start_ms": 5000,
  "end_ms":   12000
}
```

**Validation rules:**
- `start_ms >= 0`
- `end_ms > start_ms`
- `end_ms - start_ms >= 1000` (minimum 1 second)
- `start_ms` and `end_ms` must fall within clip duration (if known)
- New range must not overlap any existing highlight on the clip

**Response 200:**
```json
{
  "highlight": {
    "highlight_id": "uuid",
    "start_ms":     5000,
    "end_ms":       12000
  }
}
```

**Response 404:** Session or clip not found

**Response 422:**
```json
{
  "error": {
    "code": "invalid_range",
    "message": "Highlight must be at least 1 second long (1000ms)",
    "details": { "start_ms": 5000, "end_ms": 5500, "duration_ms": 500 }
  }
}
```

```json
{
  "error": {
    "code": "invalid_range",
    "message": "Highlight range exceeds clip duration",
    "details": { "start_ms": 5000, "end_ms": 90000, "clip_duration_ms": 60000 }
  }
}
```

```json
{
  "error": {
    "code": "highlight_overlap",
    "message": "New highlight overlaps an existing highlight on this clip",
    "details": {
      "new_range": { "start_ms": 5000, "end_ms": 12000 },
      "conflicting_highlight": { "highlight_id": "uuid", "start_ms": 10000, "end_ms": 15000 }
    }
  }
}
```

---

### DELETE /api/session/[id]/clips/[clip_id]/highlights/[highlight_id]

Remove a highlight from a clip.

**Path parameters:**
- `id` — session UUID
- `clip_id` — clip UUID
- `highlight_id` — highlight UUID

**Response 204:** No content (success)

**Response 404:** Session, clip, or highlight not found

---

### POST /api/session/[id]/person

Set or clear the person of interest on a session.

**Path parameters:**
- `id` — session UUID

**Request body:**
```json
{ "person_id": "uuid-or-null" }
```

Pass `null` to clear the selection.

**Response 200:**
```json
{ "person_id": "uuid" }
```

```json
{ "person_id": null }
```

**Response 404:** Session not found

---

### POST /api/jobs/generate-reel

Validate prerequisites, enqueue `analyze-audio` + `generate-reel` jobs (with BullMQ job dependency). Returns the `generate-reel` job_id for frontend progress polling.

**Request body:**
```json
{ "session_id": "string" }
```

**Prerequisites:**
- At least 1 clip in `ready` status
- Audio track present in session
- Session not already in `generating` or `ready` state

**Response 202:**
```json
{
  "job_id":               "generate-reel-job-uuid",
  "analyze_audio_job_id": "analyze-audio-job-uuid"
}
```

**Response 409:**
```json
{
  "error": {
    "code": "no_ready_clips",
    "message": "At least one clip must be ready before generating a reel",
    "details": { "clip_count": 0 }
  }
}
```

```json
{
  "error": {
    "code": "no_audio",
    "message": "An audio track must be uploaded before generating a reel"
  }
}
```

```json
{
  "error": {
    "code": "generation_in_progress",
    "message": "Reel generation is already in progress"
  }
}
```

```json
{
  "error": {
    "code": "reel_already_ready",
    "message": "Reel has already been generated. Download it or start a new session."
  }
}
```

**Session state transition:** `* → generating`

---

### GET /api/session/[id]/persons

Return the deduplicated person list detected for this session (reads Redis key `persons:{session_id}`).
Returns an empty array if person detection has not completed yet.

**Path parameters:**
- `id` — session UUID

**Response 200:**
```json
{
  "persons": [
    {
      "person_id": "uuid",
      "bbox": [120, 45, 80, 100],
      "thumbnail": "session-uuid/persons/person-uuid.jpg",
      "confidence": 0.94,
      "appearances": [{ "clip_id": "uuid", "timestamp_ms": 1200 }]
    }
  ]
}
```

**Response 404:** Session not found

**Response 410:** Session expired

---

### GET /api/download/[session_id]

Issue a presigned GET URL (5-minute TTL) for the completed reel.
Enqueues `cleanup-session` job (delayed 60 seconds).
Returns JSON `{ download_url }` so the frontend can trigger a native browser download
via a hidden `<a download>` anchor element. A 302 redirect cannot simultaneously
trigger a native download when initiated from a `fetch()` call.

> Architecture §4.5: "Cleanup job runs: deletes all MinIO objects under {session_id}/ prefix."

**Path parameters:**
- `session_id` — session UUID

**Response 200:**
```json
{ "download_url": "http://minio:9000/hypereels/session-uuid/reel.mp4?X-Amz-Signature=..." }
```

**Response 404:** Session not found

**Response 409:**
```json
{
  "error": {
    "code": "reel_not_ready",
    "message": "Reel is not yet ready. Current state: generating",
    "details": { "state": "generating" }
  }
}
```

**Response 410:**
```json
{
  "error": {
    "code": "session_expired",
    "message": "Session has expired. All files have been deleted."
  }
}
```

---

### GET /api/health

Service health check. Returns status of application, Redis queue, and MinIO storage.

**Response 200:**
```json
{
  "status":  "ok",
  "queue":   "connected",
  "storage": "connected"
}
```

```json
{
  "status":  "degraded",
  "queue":   "error",
  "storage": "connected"
}
```

---

## Worker Job Types

These are not API endpoints but are documented here for completeness.

| Job | Queue | Timeout | Trigger |
|-----|-------|---------|---------|
| `thumbnail-extract` | `thumbnail-extract` | 2 min | `POST /api/upload/clip/[clip_id]/complete` |
| `detect-persons` | `detect-persons` | 10 min | `POST /api/jobs/detect-persons` |
| `analyze-audio` | `analyze-audio` | 5 min | `POST /api/jobs/generate-reel` |
| `generate-reel` | `generate-reel` | 10 min | `POST /api/jobs/generate-reel` (depends on analyze-audio) |
| `cleanup-session` | `cleanup-session` | 2 min | `GET /api/download/[session_id]` (delayed 60s) |

---

## Session State Machine

```
uploading ──▶ detecting ──▶ uploading
    │               │
    └───────────────┴──▶ generating ──▶ ready
                                │
                                └──▶ failed

any ──▶ expired  (TTL: 2 hours from created_at)
```

Terminal states: `ready`, `failed`, `expired`

---

## Storage Layout (MinIO)

Bucket: `hypereels`

```
{session_id}/
  clips/{clip_id}.{ext}      — uploaded video clip
  thumbs/{clip_id}.jpg       — first-frame JPEG thumbnail
  audio.{ext}                — uploaded audio track
  persons/{person_id}.jpg    — face crop JPEGs from InsightFace
  analysis.json              — audio analysis output (BPM, beats, phrases)
  reel.mp4                   — generated reel
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `MINIO_ENDPOINT` | `http://localhost:9000` | MinIO S3-compatible endpoint |
| `MINIO_ACCESS_KEY_ID` | `minioadmin` | MinIO access key |
| `MINIO_SECRET_ACCESS_KEY` | `minioadmin` | MinIO secret key |
| `MINIO_BUCKET` | `hypereels` | MinIO bucket name |
| `MINIO_REGION` | `us-east-1` | MinIO region (S3 compat) |
| `FFMPEG_HWACCEL` | _(empty)_ | Set to `nvenc` for GPU encoding |
| `INSIGHTFACE_PROVIDERS` | `CPUExecutionProvider` | ONNX execution providers |
| `SESSION_TTL_SECONDS` | `7200` | Session lifetime (2 hours) |
| `MAX_CLIPS_PER_SESSION` | `10` | Maximum clips per session |
| `MAX_CLIP_SIZE_BYTES` | `2147483648` | 2 GiB clip size limit |
| `MAX_AUDIO_SIZE_BYTES` | `209715200` | 200 MiB audio size limit |
| `PRESIGNED_PUT_TTL_SECONDS` | `900` | 15-minute upload URL TTL |
| `PRESIGNED_GET_TTL_SECONDS` | `300` | 5-minute download URL TTL |
| `CLEANUP_DELAY_MS` | `60000` | Cleanup job delay after download |
| `PYTHON_PATH` | `python3` | Python interpreter path |
| `PYTHON_SCRIPTS_DIR` | `/app/workers/scripts` | Path to ML Python scripts |
| `TEMP_DIR` | `/tmp/hypereels` | Worker temp directory |

---

## Assumptions & Notes

1. **File size enforcement:** The API validates `size_bytes` before issuing presigned URLs. MinIO's `Content-Length-Range` policy condition is not used in the presigned URL itself (AWS SDK v3 does not expose this directly); the API layer is the enforcement point.

2. **Clip `duration_ms`:** Set to `0` at clip creation; updated to the actual duration after `thumbnail-extract` completes (via `ffprobe`).

3. **Audio `duration_ms`:** Set to `0` at audio creation. The audio analysis job (`analyze_audio.py`) returns beat/onset data but does not currently update this field. A future iteration can read the duration from the analysis output.

4. **Duplicate clip detection:** Uses `filename` + `size_bytes` as a proxy for content identity (no hash computed). Full content hashing is deferred post-MVP.

5. **`DELETE /api/upload/clip/[clip_id]`:** Accepts `session_id` as request body JSON. Some HTTP clients do not support bodies on DELETE; the endpoint also checks for `session_id` as a query parameter as a fallback.

6. **Beat sync unavailable:** If `analyze_audio.py` returns `beats: []`, the `generate-reel` worker falls back to 2-second fixed-interval cuts and records the message `"Beat sync unavailable — cuts made at regular intervals"` in the session `error` field (non-fatal).

---

> **Next step:** Implementation complete. Handoff → @qa-engineer for integration test plan.
