# HypeReels — Architecture

> **Status:** v1.0 — Initial Architecture
> **Last updated:** 2026-05-05
> **Author:** @architect

---

## Assumptions

- **STORY-001** — "thumbnail extracted from first frame" interpreted as: backend extracts a JPEG thumbnail via FFmpeg during the upload-complete webhook, not a separate scheduled job.
- **STORY-003** — Person detection is triggered automatically once the user advances to the person-selection step, not on each individual upload. All clips are analyzed as a batch.
- **STORY-005** — Highlight time ranges are stored as millisecond-precision integers on the session record; the 1-second UI minimum is enforced client-side only.
- **STORY-006** — "stage labels" are derived from job progress events published to a Redis key that the frontend polls. No WebSocket connection required for MVP.
- **STORY-007** — "flagged for destruction" means the cleanup task is enqueued the moment the download endpoint is first hit; cleanup runs within 60 seconds regardless of whether the browser download completes.
- **STORY-008 / STORY-009** — A single `docker-compose.yml` handles both CPU-only and GPU-enabled profiles via environment variables. No override files.

---

## 1. System Overview

HypeReels is a single-server web application. Users upload video clips and an audio track through a browser UI; a background worker analyzes them and assembles a beat-synced MP4 reel. There is no user account system — every session is an ephemeral UUID token, and all assets are deleted on download or TTL expiry.

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│  Next.js SPA  ──HTTP──▶  Next.js API Routes             │
└─────────────────────────┬───────────────────────────────┘
                          │ REST / multipart upload
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Next.js Server                         │
│  API Routes  ──enqueue──▶  BullMQ  ──▶  Worker Process  │
│                              │                          │
│                           Redis                         │
│  (job queue + progress KV + session metadata)           │
└──────────┬─────────────────────────────────────────────-┘
           │ object storage (upload / download)
           ▼
┌─────────────────────────┐
│   MinIO  (S3-compatible) │
│   Local Docker volume   │
└─────────────────────────┘

Worker uses:
  • InsightFace  — person detection (CUDA → CPU fallback)
  • librosa      — audio analysis
  • FFmpeg       — thumbnail extraction + reel assembly (NVENC → x264 fallback)
```

All services run in a single Docker Compose stack on one machine.

---

## 2. Tech Stack

| Layer | Tech | Rationale |
|---|---|---|
| Frontend | Next.js 14 (App Router, React) | Full-stack framework; API routes eliminate a separate API server; SSR not needed but RSC coexist cleanly with a SPA flow |
| API | Next.js Route Handlers | Co-located with frontend; no second Node process to operate |
| Job queue | BullMQ + Redis | Node-native; integrates directly into the Next.js server process; no separate language runtime for queue management (see ADR-001) |
| Worker | Node.js child process (BullMQ worker) | Spawned by the same Next.js container; calls Python scripts via subprocess for ML/audio work (see ADR-002) |
| Person detection | InsightFace (Python) | OSS; no per-call cost; CUDA + CPU provider support built-in (see ADR-003) |
| Audio analysis | librosa (Python) | Forced by platform constraint — no exceptions |
| Video assembly | FFmpeg | Forced by platform constraint — NVENC opt-in via `FFMPEG_HWACCEL=nvenc`; x264 default |
| Object storage | MinIO (S3-compatible, local Docker volume) | Self-hosted; no cloud dependency; S3 SDK compatible so a future swap to R2/S3 is a one-line env change (see ADR-004) |
| Session store | Redis (BullMQ's Redis instance) | Reuses the queue's Redis for session metadata KV; no second Redis instance |
| Language — ML scripts | Python 3.11 | Required by InsightFace and librosa |
| Container runtime | Docker Compose | Single-machine; single compose file; env vars select GPU path |

---

## 3. Components

### 3.1 Next.js Application (Frontend + API)

**Purpose:** Serves the browser UI and exposes the REST API surface.

**Tech:** Next.js 14, TypeScript, React

**Responsibilities:**
- Render all pages: upload, person selection, highlight marking, generation progress, download
- Accept multipart file uploads; stream directly to MinIO using presigned PUT URLs (files never buffered on the app server's disk)
- Validate session tokens (UUID) on every mutating request
- Enqueue BullMQ jobs: `detect-persons`, `analyze-audio`, `generate-reel`, `cleanup-session`
- Expose job-status polling endpoint; read progress from Redis KV
- Issue presigned GET URL for final reel download; enqueue cleanup on first download hit

**Interfaces:**
- Inbound: HTTP from browser
- Outbound: BullMQ job enqueue (Redis), MinIO S3 API, Redis GET/SET for session/progress KV

---

### 3.2 BullMQ Worker

**Purpose:** Executes all async jobs — person detection, audio analysis, reel assembly, and session cleanup.

**Tech:** Node.js, BullMQ, child_process (spawns Python scripts)

**Responsibilities:**
- Subscribe to job queues: `person-detection`, `audio-analysis`, `reel-assembly`, `cleanup`
- For each job: download assets from MinIO, invoke appropriate Python script or FFmpeg binary, write outputs back to MinIO, update progress KV in Redis
- Enforce job timeout: 10 minutes maximum per job; mark failed and surface error detail
- On cleanup job: delete all MinIO objects for the session; delete session Redis keys

**Interfaces:**
- Inbound: BullMQ job (Redis)
- Outbound: MinIO S3 API (GET/PUT/DELETE), Python subprocess (stdin/stdout JSON), FFmpeg subprocess, Redis SET (progress updates)

---

### 3.3 Python ML Scripts

**Purpose:** Perform InsightFace person detection and librosa audio analysis. Invoked as subprocesses by the BullMQ worker.

**Tech:** Python 3.11, InsightFace, librosa, numpy, onnxruntime

**Responsibilities:**
- `detect_persons.py` — accepts a video file path, runs InsightFace face detection across sampled frames, emits JSON matching the person detection contract, extracts face-crop JPEG thumbnails
- `analyze_audio.py` — accepts an audio file path, runs librosa beat tracking and onset detection, emits JSON matching the audio analysis contract
- On startup: check for CUDA device; use `CUDAExecutionProvider` if available, else `CPUExecutionProvider`; log provider selected

**Interfaces:**
- Inbound: CLI args (file path) + stdin JSON (job parameters)
- Outbound: stdout JSON (result contract); stderr (logs); exit code 0 = success, non-zero = failure

**Output contracts (immutable):**

Person detection:
```json
{
  "person_id": "string (UUID)",
  "bbox": [x, y, w, h],
  "thumbnail": "string (MinIO object key)",
  "confidence": 0.0–1.0,
  "appearances": [{"clip_id": "uuid", "timestamp_ms": 0}]
}
```

Audio analysis:
```json
{
  "bpm": 120.0,
  "beats": [0, 500, 1000],
  "onsets": [0, 250, 500],
  "phrases": [{"start_ms": 0, "end_ms": 8000}]
}
```

---

### 3.4 FFmpeg (invoked by worker)

**Purpose:** Extract thumbnails from video clips; assemble the final reel from the EDL.

**Tech:** FFmpeg binary (system-installed in Docker image)

**Responsibilities:**
- Thumbnail extraction: first-frame JPEG from each uploaded clip
- Reel assembly: read EDL, cut/concat source clips, mix audio track, encode to MP4
- Encoder selection: `FFMPEG_HWACCEL=nvenc` → attempt NVENC; if CUDA device absent, log warning and fall back to `libx264`

**EDL contract (immutable):**
```json
[
  {"clip_id": "uuid", "start_ms": 0, "end_ms": 2000, "transition": "cut"}
]
```

---

### 3.5 MinIO (Object Storage)

**Purpose:** Ephemeral object storage for all user assets and generated files.

**Tech:** MinIO (Docker), S3-compatible API

**Responsibilities:**
- Store uploaded clips and audio tracks (keys: `{session_id}/clips/{clip_id}.{ext}`, `{session_id}/audio.{ext}`)
- Store extracted thumbnails and person crop JPEGs (keys: `{session_id}/thumbs/{clip_id}.jpg`, `{session_id}/persons/{person_id}.jpg`)
- Store generated reel (key: `{session_id}/reel.mp4`)
- Issue presigned PUT URLs (upload) and presigned GET URLs (download) — assets never proxied through the app server
- MinIO lifecycle policy: auto-delete all objects under `{session_id}/` prefix after 2 hours (belt-and-suspenders behind application-level cleanup)

**Interfaces:**
- Inbound: S3 API calls from Next.js and Worker
- No public internet exposure — internal Docker network only; presigned URLs are the sole access path

---

### 3.6 Redis

**Purpose:** BullMQ job queue + session/progress key-value store.

**Tech:** Redis 7

**Responsibilities:**
- BullMQ job queues: `person-detection`, `audio-analysis`, `reel-assembly`, `cleanup`
- Session metadata: `session:{id}` hash (state, created_at, clip_ids[], audio_id, person_id, highlights, reel_key)
- Job progress: `progress:{job_id}` string (JSON: `{stage, pct, message}`) — polled by frontend every 2 seconds
- TTL: session keys expire after 2 hours; progress keys expire after 15 minutes post-completion

---

## 4. Data Flow

### 4.1 Upload Flow

1. User opens browser → Next.js serves the SPA.
2. Browser requests presigned PUT URL from `POST /api/upload/clip` (or `/api/upload/audio`).
3. Next.js creates session UUID (if first upload), stores session record in Redis, returns presigned PUT URL + `clip_id`.
4. Browser uploads file directly to MinIO using the presigned URL. **[Upload is browser → MinIO direct; app server not in path.]**
5. Browser confirms upload via `POST /api/upload/clip/{clip_id}/complete`.
6. Next.js enqueues `thumbnail-extract` sub-job. **[async]**
7. Worker downloads clip from MinIO, runs FFmpeg first-frame extraction, uploads JPEG to MinIO, updates session record with `thumbnail_key`.
8. Frontend polls `GET /api/session/{id}/clips` to display updated clip list with thumbnail.

### 4.2 Person Detection Flow

1. User advances to person selection step → browser calls `POST /api/jobs/detect-persons`.
2. Next.js validates session; enqueues `detect-persons` job with `{session_id, clip_ids[]}`. **[async]**
3. Worker picks up job; for each clip: downloads from MinIO, invokes `detect_persons.py`, receives person detection JSON, uploads crop thumbnails to MinIO.
4. Worker merges per-clip results into a deduplicated person list, writes to session Redis key `persons:[]`, sets `progress:{job_id}` at 100%.
5. Frontend polls `GET /api/jobs/{job_id}/progress` every 2 seconds; on completion polls `GET /api/session/{id}/persons`.
6. UI renders person grid.

### 4.3 Highlight Saving Flow

1. User marks highlight range in the timeline UI.
2. Browser calls `PATCH /api/session/{id}/clips/{clip_id}/highlights` with `{start_ms, end_ms}`.
3. Next.js validates (start < end, duration ≥ 1000 ms), updates session Redis hash.
4. Response is synchronous — no job enqueued.

### 4.4 Reel Generation Flow

1. User clicks "Generate Reel" → browser calls `POST /api/jobs/generate-reel`.
2. Next.js validates prerequisites (≥1 clip, audio present), enqueues `analyze-audio` + `generate-reel` jobs (audio analysis must complete before reel assembly; BullMQ job dependency used). **[async]**
3. Worker: `analyze-audio` job → downloads audio from MinIO, runs `analyze_audio.py`, writes result JSON to MinIO `{session_id}/analysis.json`, signals `generate-reel` job to proceed. **[async]**
4. Worker: `generate-reel` job → reads session state (clips, highlights, person_id, analysis.json), runs scene selection algorithm, produces EDL, invokes FFmpeg with EDL, uploads `reel.mp4` to MinIO, updates session state to `ready`, writes final progress entry. **[async]**
5. Frontend polls `GET /api/jobs/{job_id}/progress` every 2 seconds, displaying stage labels as they update.
6. On `state=ready`, frontend transitions to download screen.

### 4.5 Download & Destroy Flow

1. User clicks "Download Reel" → browser calls `GET /api/download/{session_id}`.
2. Next.js verifies session state is `ready` and not expired; enqueues `cleanup-session` job (runs in 60 seconds). **[async]**
3. Next.js issues presigned GET URL for `{session_id}/reel.mp4` (5-minute TTL); returns redirect.
4. Browser downloads MP4 directly from MinIO.
5. If download fails: presigned URL is still valid for up to 5 minutes; frontend can retry `GET /api/download/{session_id}` to get a fresh URL **before** cleanup job runs.
6. Cleanup job runs: deletes all MinIO objects under `{session_id}/` prefix; deletes all Redis keys for session. **[async]**
7. If session TTL expires before download: MinIO lifecycle policy deletes objects; Next.js returns `410 Gone` with `{"error":"session_expired"}`.

---

## 5. Data Models

### Session (Redis hash — `session:{id}`)

```
id            UUID string
state         enum: uploading | detecting | analyzing | generating | ready | failed | expired
created_at    Unix ms
clips         JSON array of Clip objects
audio         Audio object or null
person_id     UUID string or null
reel_key      MinIO object key or null
error         string or null
```

### Clip (embedded in Session)

```
clip_id       UUID string
filename      string
duration_ms   integer
size_bytes    integer
thumbnail_key MinIO object key
status        enum: uploading | ready | detection_failed
highlights    array of Highlight
```

### Highlight (embedded in Clip)

```
highlight_id  UUID string
start_ms      integer (≥ 0)
end_ms        integer (> start_ms, end_ms - start_ms ≥ 1000)
```

### Audio (embedded in Session)

```
audio_id      UUID string
filename      string
duration_ms   integer
size_bytes    integer
object_key    MinIO object key
```

### Person (Redis key — `persons:{session_id}`, JSON array)

```
person_id     UUID string
bbox          [x, y, w, h]
thumbnail     MinIO object key
confidence    float (0.0–1.0)
appearances   array of { clip_id: UUID, timestamp_ms: integer }
```

### JobProgress (Redis string — `progress:{job_id}`, JSON)

```
stage         string (human-readable label)
pct           integer (0–100)
message       string
updated_at    Unix ms
```

### Entity Relationships

```
Session 1──* Clip
Clip    1──* Highlight
Session 1──1 Audio (optional)
Session 1──* Person (optional, via persons:{session_id})
Session 1──1 JobProgress (via progress:{job_id}, multiple jobs per session)
```

---

## 6. API Surface

Full API specification belongs in `docs/api-spec.md` — not in scope for this agent.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/session` | Create session, returns `session_id` UUID |
| `POST` | `/api/upload/clip` | Request presigned PUT URL for a clip upload |
| `POST` | `/api/upload/clip/{clip_id}/complete` | Confirm clip upload complete; enqueue thumbnail extraction |
| `DELETE` | `/api/upload/clip/{clip_id}` | Remove a clip from the session |
| `POST` | `/api/upload/audio` | Request presigned PUT URL for audio upload |
| `POST` | `/api/upload/audio/complete` | Confirm audio upload complete |
| `GET` | `/api/session/{id}` | Get full session state (clips, audio, persons, state) |
| `POST` | `/api/jobs/detect-persons` | Enqueue person detection across all session clips |
| `GET` | `/api/jobs/{job_id}/progress` | Poll job progress (stage, pct, message) |
| `PATCH` | `/api/session/{id}/clips/{clip_id}/highlights` | Add or update a highlight range on a clip |
| `DELETE` | `/api/session/{id}/clips/{clip_id}/highlights/{highlight_id}` | Remove a highlight |
| `POST` | `/api/session/{id}/person` | Set selected person of interest (or clear) |
| `POST` | `/api/jobs/generate-reel` | Enqueue reel generation |
| `GET` | `/api/download/{session_id}` | Issue presigned download URL; enqueue cleanup |

---

## 7. Infra & Deployment

### Services (single `docker-compose.yml`)

| Service | Image | Role |
|---|---|---|
| `app` | Custom Node.js 20 image | Next.js server + BullMQ worker in one process |
| `redis` | `redis:7-alpine` | Job queue + session KV |
| `minio` | `minio/minio:latest` | Object storage |

> **Design note:** The BullMQ worker runs inside the same Node.js process as the Next.js server. For MVP this is sufficient — a single-machine deployment with one concurrent reel generation job at a time. If concurrency requirements grow, the worker is extracted to a separate service without API contract changes (see ADR-002).

### GPU / CPU Configuration

```yaml
# docker-compose.yml (excerpt)
services:
  app:
    environment:
      - FFMPEG_HWACCEL=${FFMPEG_HWACCEL:-}          # set to "nvenc" for GPU
      - INSIGHTFACE_PROVIDERS=${INSIGHTFACE_PROVIDERS:-CPUExecutionProvider}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

The `deploy.resources` GPU reservation is silently ignored by Docker Compose when no NVIDIA Container Toolkit is present — CPU-only machines require no config change.

### Storage Layout (MinIO)

Bucket: `hypereels` (created on first start via init container or startup script)

```
{session_id}/
  clips/{clip_id}.{ext}
  thumbs/{clip_id}.jpg
  audio.{ext}
  persons/{person_id}.jpg
  analysis.json
  reel.mp4
```

### TTL / Cleanup Policy

| Trigger | Action | Deadline |
|---|---|---|
| Download confirmed | Enqueue `cleanup-session` job | Runs within 60 seconds |
| Session TTL (2 hours from `created_at`) | Redis keys auto-expire; MinIO lifecycle rule deletes all objects | ≤ 2 hours |
| MinIO lifecycle fallback | Delete all objects under `{session_id}/` prefix | ≤ 2 hours (belt-and-suspenders) |

### Worker Job Timeouts

| Job | Timeout |
|---|---|
| Thumbnail extraction | 2 minutes |
| Person detection (per session) | 10 minutes |
| Audio analysis | 5 minutes |
| Reel assembly | 10 minutes |
| Cleanup | 2 minutes |

### Health Checks

- `app`: HTTP GET `/api/health` → 200 with `{status:"ok", queue:"connected", storage:"connected"}`
- `redis`: `redis-cli ping`
- `minio`: MinIO built-in healthcheck endpoint

---

## 8. Security & Privacy

### Session Model

- Sessions are identified by a UUID v4 token issued at first upload.
- The token is stored in browser `localStorage` and sent as `X-Session-Id` header on all API requests.
- No JWT, no auth, no passwords. Possession of the UUID = access to that session.
- Sessions are single-user by design — no sharing, no collaboration.

### Ephemeral Asset Handling

- User files (clips, audio) are uploaded directly from the browser to MinIO via presigned PUT URLs — they never transit the Next.js server process or touch local disk.
- The generated reel is downloaded directly from MinIO via a presigned GET URL — same principle.
- Application-level cleanup (on download) + MinIO lifecycle policy (2-hour TTL) provide dual-layer deletion guarantees.
- The cleanup job explicitly deletes all MinIO objects under the session prefix and all Redis keys for the session. No orphaned data.

### Presigned URL Security

- Presigned PUT URLs: 15-minute TTL; scoped to a single object key under the session prefix.
- Presigned GET URLs (download): 5-minute TTL; issued only when session state is `ready`.
- MinIO is not exposed to the public internet — it is on the internal Docker network. Presigned URLs are the sole access mechanism.

### No Persistent PII

- No user accounts, no email addresses, no names stored.
- Person thumbnails (face crops) are keyed only by UUID; no name association exists at any layer.
- All biometric-adjacent data (face crop images, detection results) is deleted within 60 seconds of download or within 2 hours of session creation.

### Input Validation

- File type: validated by MIME type + extension allowlist on the API layer before presigned URL issuance. Files are not parsed server-side before validation.
- File size: enforced by presigned URL content-length constraint (MinIO supports `Content-Length-Range` policy condition).
- Session state machine transitions: validated server-side — e.g., `generate-reel` cannot be enqueued unless session has ≥1 clip and an audio track in `ready` state.

---

## 9. Architectural Decision Records

---

### ADR-001: Job Queue — BullMQ over Celery+Redis

**Status:** Accepted

**Context:** The agent definition requires a queue. Two viable options: BullMQ (Node.js, uses Redis) or Celery+Redis (Python). The ML work is Python, but the API layer is Node.js.

**Decision:** Use BullMQ. The API layer and worker are both Node.js; BullMQ integrates directly without introducing a second runtime to operate. Python ML scripts are invoked as subprocesses (stdin/stdout JSON protocol) — this keeps the queue management in one language while still running Python where required.

**Consequences:** Workers are Node.js processes that shell out to Python. The subprocess protocol adds a small serialization overhead (negligible for media workloads). If the Python scripts grow complex enough to need their own queue consumer, Celery can be adopted later without changing the API surface. Alternative considered: Celery+Redis — deferred due to MVP scope (adds a second runtime and separate worker deployment unit).

---

### ADR-002: Worker Co-location — Single Container over Separate Worker Service

**Status:** Accepted

**Context:** The BullMQ worker could run in a separate Docker service (more isolation, independent scaling) or co-located in the `app` container (simpler ops).

**Decision:** Co-locate the BullMQ worker in the `app` container as a separate Node.js worker thread/process started at app boot. For MVP, one concurrent job at a time is sufficient. The worker is structured as a standalone module that can be extracted to its own service without API changes.

**Consequences:** Simpler `docker-compose.yml` — three services instead of four. No independent worker scaling in MVP. If job concurrency becomes a concern post-MVP, the worker module is extracted into a `worker` service; queue contracts are unchanged. Alternative considered: separate `worker` service — deferred due to MVP scope (adds operational complexity with no MVP benefit).

---

### ADR-003: Person Detection — InsightFace (OSS) over Managed APIs

**Status:** Accepted

**Context:** Person detection options: managed (AWS Rekognition, Google Vision API) or OSS (InsightFace, MTCNN, DeepFace). The platform constraint requires local/self-hosted operation with no cloud dependencies.

**Decision:** Use InsightFace. It runs locally, supports both `CUDAExecutionProvider` and `CPUExecutionProvider` out of the box, requires no per-call cost, and produces the required output contract fields (bbox, confidence, face crop).

**Consequences:** InsightFace is a Python dependency adding ~500 MB to the image (ONNX models included). CUDA-accelerated path requires NVIDIA Container Toolkit on the host — CPU path is automatic fallback. Alternative considered: Rekognition/Vision API — eliminated due to cloud dependency constraint and per-call cost.

---

### ADR-004: Object Storage — MinIO over S3/GCS/R2

**Status:** Accepted

**Context:** The agent definition says "S3, GCS, or R2" for storage. The platform constraint says local deployment with no cloud hosting. Managed cloud storage (S3, GCS, R2) would require internet access and account credentials — incompatible with an air-gapped local install.

**Decision:** Use MinIO, a self-hosted S3-compatible store, running as a Docker service. The application uses the AWS SDK (S3-compatible) for all MinIO calls; switching to R2 or S3 post-MVP is a single environment variable change (`MINIO_ENDPOINT` → cloud endpoint).

**Consequences:** Storage is limited to local disk capacity. For MVP single-machine deployment, this is acceptable. MinIO adds one Docker service to the stack. The S3 API compatibility layer means no application code changes for a future cloud migration. Alternative considered: R2/S3 — deferred because it requires cloud credentials and internet access, violating the local-deployment requirement for MVP.

---

### ADR-005: Frontend Framework — Next.js (Full-Stack) over Separate SPA + API

**Status:** Accepted

**Context:** Options: (a) Next.js serving both UI and API routes in one process, (b) a React SPA (Vite/CRA) plus a separate Express/Fastify API server.

**Decision:** Use Next.js with Route Handlers for the API. Eliminates a second service, a second port to configure, and a second CORS concern. For an MVP with a small API surface, co-location is net simpler.

**Consequences:** The Next.js server handles both UI rendering and API requests. If the API grows beyond what Route Handlers can cleanly support, or if the frontend needs to go to a CDN, the API routes can be extracted to a standalone server without changing the client-facing contract. Alternative considered: Vite SPA + Fastify API — deferred due to MVP scope (adds a second service with no functional benefit).

---

### ADR-006: No WebSockets — Polling for Job Progress

**Status:** Accepted

**Context:** Generation jobs can take up to 10 minutes. Options: WebSocket push for progress updates, or client polling of a progress endpoint.

**Decision:** Use polling (`GET /api/jobs/{job_id}/progress`) every 2 seconds. The progress value is a Redis key updated by the worker. This is simpler to implement, test, and operate than a WebSocket connection — no connection management, no reconnect logic, no stateful server.

**Consequences:** Up to 2 seconds of progress update latency, which is imperceptible for a job that takes minutes. Network overhead is ~200 bytes per poll × 0.5/sec = negligible. Alternative considered: WebSocket (Socket.io) — deferred due to MVP scope (adds server-side connection state management).

---

> **Next step:** Architecture ready. Run in parallel: `@frontend-engineer`, `@backend-engineer`, `@ai-ml-engineer`.
