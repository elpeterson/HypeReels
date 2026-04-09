# HypeReels Test Plan

> Owner: QA Engineer
> Last updated: 2026-04-07
> Model: claude-sonnet-4-6

---

## 1. Overview

### Product

HypeReels is an ephemeral, session-scoped web application that accepts user-uploaded video clips and an audio track, runs an asynchronous AI pipeline to detect persons (InsightFace CPU-only), analyse beat structure (librosa), and assemble a beat-synchronised highlight reel, then delivers a single downloadable MP4 and permanently destroys all uploaded and generated assets.

### Scope

All twenty-one MVP user stories (STORY-001 through STORY-021) across the full stack:

- Fastify REST API (Node.js 20, Case CT 113)
- PostgreSQL 18 session/job state (Quorra Docker hypereels-postgres, 192.168.1.100:7432)
- Redis 7 job queue and pub/sub (Case CT 114, 192.168.1.137:6379)
- MinIO object storage with ILM lifecycle policy (Case CT 115, 192.168.1.138:9000)
- Python workers: audio analysis (librosa), person detection (InsightFace), assembly (FFmpeg)
- React SPA (Vite, Zustand, Tailwind)
- Infrastructure: Proxmox LXC containers, Unraid Docker containers, NPM proxy host, Cloudflare tunnel

### Test Objectives

1. Verify all STORY-001–021 acceptance criteria are testable and pass.
2. Confirm session lifecycle state machine: `active → locked → complete → deleted`.
3. Confirm the `'destroyed'` status anomaly (C6) does not enter the database (only `'deleted'` is a valid CHECK constraint value).
4. Confirm the `r2_key` schema column name (C5) is used consistently by all application code (architecture uses `minio_key`; schema uses `r2_key`).
5. Verify MinIO ILM `session_ttl=true` tag is applied at upload time (I8).
6. Verify cleanup is idempotent and handles missing objects gracefully (I9).
7. Verify clip status transitions occur correctly even without a separate validation worker module (I10).
8. Verify `GET /sessions/:id/reel` endpoint (C7) is covered by tests despite being absent from the OpenAPI spec.
9. Confirm InsightFace initialises with `CPUExecutionProvider` only (ADR-013).

### Out of Scope

- Multi-person selection (post-MVP)
- Spotify integration (post-MVP)
- User authentication and persistent storage (post-MVP)
- Mobile app (post-MVP)
- GPU-accelerated InsightFace (deferred per ADR-013)
- Staging environment (no staging; local Docker Compose is dev environment)

---

## 2. Test Strategy

### 2.1 Unit Tests

**Python (pytest)**

- Location: `workers/tests/`
- Runner: `pytest workers/tests/ -v`
- Scope: pure functions in `audio_analysis/`, `assembly/algorithm.py`, `person_detection/person_detection_worker.py`
- No real media files required; synthetic numpy arrays and mock objects are used.
- No network access, DB connections, or MinIO calls.

**TypeScript (Vitest)**

- Location: `server/src/**/*.test.ts` and `server/tests/`
- Runner: `vitest run` from repo root
- Scope: pure library functions in `server/src/lib/` (cleanup, r2 key helpers)
- All external dependencies (MinIO S3 client, PostgreSQL pool) are mocked with `vi.mock`.

### 2.2 Integration Tests

**API integration (Vitest + real services via Docker Compose)**

- Location: `server/tests/integration/`
- Runner: `docker-compose -f docker-compose.test.yml up -d && vitest run --project integration`
- Real PostgreSQL, Redis, and MinIO containers are spun up.
- No mocking of DB or storage clients; actual HTTP requests hit the Fastify server.
- Each test creates its own session and tears it down via `DELETE /sessions/:id`.
- Media files are small synthetic fixtures (< 1 MB).

**Python integration (pytest + real services)**

- Location: `workers/tests/integration/` (future sprint — not in this plan's automation scope)
- Blocked on CI having access to MinIO and PostgreSQL containers.

### 2.3 End-to-End Tests

- Tool: Playwright
- Location: `e2e/`
- Runner: `playwright test`
- Covers the happy-path seven-step wizard: Upload Clips → Upload Song → Select Person → Mark Highlights → Review → Generate → Download.
- Uses small fixture video files (< 5 s) and a synthetic audio file.
- Requires full Docker Compose stack including Python workers.
- **Status: planned for post-MVP sprint; not included in this test plan's automation deliverables.**

### 2.4 Performance Tests

See Section 6.

### 2.5 Manual / Exploratory Tests

- Browser UX validation across Chrome, Firefox, Safari.
- Drag-and-drop file upload.
- Mobile viewport (< 768 px) step indicator collapse.
- Tab takeover scenario (STORY-018).
- SSE reconnection after browser sleep.
- Download of a large file (> 500 MB) via presigned URL.

---

## 3. Story → Test Coverage Matrix

| Story | Title | Type | Test File(s) | Pass Criteria | Status |
|-------|-------|------|-------------|---------------|--------|
| STORY-001 | Create anonymous session | Integration | `server/tests/integration/sessions.test.ts` | POST /sessions → 201, token UUID, stored in localStorage | ⚠️ partial |
| STORY-002 | Upload video clips | Integration | `server/tests/integration/clips.test.ts` | POST /sessions/:id/clips → 202, clip_id returned, MinIO object created | ❌ missing |
| STORY-003 | Validate clip format/size | Integration + Unit | `server/tests/integration/clips.test.ts` | Invalid MIME → 422, oversized → 422, valid → 202 | ❌ missing |
| STORY-004 | View clip list with thumbnails | Integration | `server/tests/integration/clips.test.ts` | GET /sessions/:id/clips returns correct schema | ❌ missing |
| STORY-005 | Upload audio track | Integration | `server/tests/integration/audio.test.ts` | POST /sessions/:id/audio → 202, audio_id returned | ❌ missing |
| STORY-006 | Validate audio + trigger analysis | Integration + Unit | `server/tests/integration/audio.test.ts`, `workers/tests/test_audio_analysis.py` | Invalid audio → 422; valid → analysis job queued | ✅ covered (audio analysis unit tests) |
| STORY-007 | Trigger person detection | Integration | `server/tests/integration/detection.test.ts` | POST /sessions/:id/detect → 202, jobs queued | ❌ missing |
| STORY-008 | Select person of interest | Integration | `server/tests/integration/persons.test.ts` | PUT /sessions/:id/person-of-interest → 200 | ❌ missing |
| STORY-009 | Handle no persons detected | Unit | `workers/tests/test_person_detection.py` | Empty clip returns empty persons list, not error | ❌ missing |
| STORY-010 | Mark highlight segments | Integration | `server/tests/integration/highlights.test.ts` | PUT /sessions/:id/clips/:id/highlights → 200, DB upserted | ❌ missing |
| STORY-011 | Enforce highlight duration constraints | Unit | `workers/tests/test_assembly_worker.py` | Highlights > song → EDL truncated, no error raised | ✅ covered (test_algorithm.py) |
| STORY-012 | Review and edit highlights | Integration | `server/tests/integration/highlights.test.ts` | Session locked on generate; read-only response for edits | ❌ missing |
| STORY-013 | Submit generation job + progress | Integration | `server/tests/integration/generation.test.ts` | POST /sessions/:id/generate → 202, job_id returned, SSE events fire | ❌ missing |
| STORY-014 | Display status on tab return | Integration | `server/tests/integration/sessions.test.ts` | GET /sessions/:id/state returns correct status + step | ⚠️ partial |
| STORY-015 | Download completed HypeReel | Integration | `server/tests/integration/download.test.ts` | GET /sessions/:id/reel returns presigned URL; file bytes non-empty | ❌ missing |
| STORY-016 | Permanently delete session assets | Unit + Integration | `server/src/workers/cleanupWorker.test.ts` | MinIO objects deleted; DB rows deleted; idempotent on re-run | ❌ missing |
| STORY-017 | Global error boundary | Manual | n/a | JS exception → error screen; 500 response → error screen | Manual only |
| STORY-018 | Prevent simultaneous sessions | Manual + Integration | `server/tests/integration/sessions.test.ts` | BroadcastChannel takeover warning shown | ⚠️ partial (API side only) |
| STORY-019 | Step navigation indicator | Manual | n/a | Progress indicator renders all 7 steps; active step highlighted | Manual only |
| STORY-020 | Deploy full stack | Infrastructure | `server/tests/smoke/smoke.test.ts` | Health check passes; all inter-service connections healthy | ❌ missing |
| STORY-021 | GPU contention mitigation | Unit + Manual | `workers/tests/test_person_detection.py` | CPUExecutionProvider verified; CPU fallback path smoke-tested | ❌ missing |

---

## 4. Critical Path Test Cases

### TC-001: Session Creation Returns Valid Token

- **Story:** STORY-001
- **Type:** Integration
- **Preconditions:** API server running; PostgreSQL reachable
- **Steps:**
  1. POST `/sessions` with no body
  2. Verify HTTP 201
  3. Verify response body has `session_id` (UUID format) and `token` (UUID format)
  4. Verify a row exists in `sessions` table with `status = 'active'` and `current_step = 'upload-clips'`
- **Expected:** 201 response; valid UUIDs; DB row created
- **Priority:** P0

### TC-002: Session Token Required for Protected Routes

- **Story:** STORY-001
- **Type:** Integration
- **Preconditions:** A session exists
- **Steps:**
  1. POST `/sessions` → capture token
  2. GET `/sessions/:id/state` with no Authorization header → expect 401
  3. GET `/sessions/:id/state` with `Authorization: Bearer invalid-uuid` → expect 404
  4. GET `/sessions/:id/state` with valid Bearer token → expect 200
- **Expected:** 401 for missing token; 404 for invalid token; 200 for valid
- **Priority:** P0

### TC-003: Deleted Session Returns 410

- **Story:** STORY-001
- **Type:** Integration
- **Preconditions:** A session exists; session row manually set to `status = 'deleted'`
- **Steps:**
  1. Create session
  2. Directly update `sessions.status = 'deleted'` in DB
  3. GET `/sessions/:id/state` with valid token
- **Expected:** 410 Gone with `SESSION_GONE` error code
- **Priority:** P0

### TC-004: Session Status Does Not Use 'destroyed' Value

- **Story:** STORY-016 (Known Issue C6)
- **Type:** Unit
- **Preconditions:** None (schema validation)
- **Steps:**
  1. Attempt to INSERT a session row with `status = 'destroyed'` directly via SQL
- **Expected:** PostgreSQL CHECK constraint violation; only `active`, `locked`, `complete`, `deleted` are valid
- **Priority:** P0

### TC-005: Valid Video Clip Upload Accepted

- **Story:** STORY-002, STORY-003
- **Type:** Integration
- **Preconditions:** Active session; MinIO bucket exists
- **Steps:**
  1. POST `/sessions/:id/clips` with multipart form containing a small valid `.mp4` file and `Content-Type: video/mp4`
  2. Verify 202 response with `clip_id`
  3. Verify MinIO object exists at `uploads/{session_id}/{clip_id}.mp4`
  4. Verify `clips` DB row with `status = 'uploading'`
- **Expected:** 202; MinIO object present; DB row created
- **Priority:** P0

### TC-006: Invalid Format Rejected Before Upload

- **Story:** STORY-003
- **Type:** Integration
- **Preconditions:** Active session
- **Steps:**
  1. POST `/sessions/:id/clips` with a `.pdf` file and `Content-Type: application/pdf`
  2. Verify 422 response with `UNSUPPORTED_FORMAT` error code
- **Expected:** 422; no MinIO object created; no DB row created
- **Priority:** P0

### TC-007: File Size Limit Enforced

- **Story:** STORY-003
- **Type:** Integration
- **Preconditions:** Active session
- **Steps:**
  1. POST `/sessions/:id/clips` streaming exactly 2 GB + 1 byte
- **Expected:** Upload interrupted; 422 or stream destroyed; MinIO object cleaned up
- **Priority:** P0

### TC-008: Clip Count Limit Enforced

- **Story:** STORY-002
- **Type:** Integration
- **Preconditions:** Active session with 10 existing valid clips
- **Steps:**
  1. POST `/sessions/:id/clips` with an 11th valid file
- **Expected:** 422 with `CLIP_LIMIT_EXCEEDED` error code
- **Priority:** P0

### TC-009: MinIO Upload Tags Session TTL

- **Story:** STORY-016 (Known Issue I8)
- **Type:** Integration
- **Preconditions:** MinIO ILM rule configured for `session_ttl=true`; active session
- **Steps:**
  1. POST `/sessions/:id/clips` with valid file
  2. Use MinIO S3 API `GetObjectTagging` to retrieve tags on the uploaded object
- **Expected:** Object has tag `session_ttl=true`
- **Priority:** P1
- **Note:** This test documents the intent from I8. If the application does not yet set the tag, this test will fail and expose the gap.

### TC-010: Audio Upload Accepted and Analysis Job Queued

- **Story:** STORY-005, STORY-006
- **Type:** Integration
- **Preconditions:** Active session; BullMQ connected
- **Steps:**
  1. POST `/sessions/:id/audio` with a small valid `.mp3` file
  2. Verify 202 with `audio_id`
  3. Verify BullMQ `audio-analysis` queue has a job for this audio track
  4. Verify `audio_tracks` DB row with `analysis_status = 'pending'`
- **Expected:** 202; job queued; DB row created
- **Priority:** P0

### TC-011: Invalid Audio Format Rejected

- **Story:** STORY-006
- **Type:** Integration
- **Preconditions:** Active session
- **Steps:**
  1. POST `/sessions/:id/audio` with a `.exe` file
- **Expected:** 422 with `UNSUPPORTED_FORMAT`
- **Priority:** P0

### TC-012: Person Detection Triggered for All Valid Clips

- **Story:** STORY-007
- **Type:** Integration
- **Preconditions:** Session with at least 2 valid clips (`status = 'valid'`, `detection_status = 'pending'`)
- **Steps:**
  1. POST `/sessions/:id/detect`
  2. Verify 202 with `queued` count equal to number of valid undetected clips
  3. Verify BullMQ `person-detection` queue has jobs
  4. Verify clips' `detection_status` transitions to `'processing'`
- **Expected:** Jobs enqueued for each valid clip
- **Priority:** P0

### TC-013: InsightFace Initialises with CPUExecutionProvider Only

- **Story:** STORY-021 (Known Issue ADR-013)
- **Type:** Unit
- **Preconditions:** None (mocked)
- **Steps:**
  1. Mock `insightface.app.FaceAnalysis` constructor
  2. Call `_get_insight_app()` from `person_detection_worker.py`
  3. Assert `FaceAnalysis` was called with `providers=['CPUExecutionProvider']`
  4. Assert `.prepare()` was called with `ctx_id=-1`
- **Expected:** Only CPUExecutionProvider; ctx_id is -1 (CPU mode)
- **Priority:** P0

### TC-014: Frame Sampling at 2fps Produces Correct Count

- **Story:** STORY-007
- **Type:** Unit
- **Preconditions:** Synthetic test video file (10 s at 25 fps)
- **Steps:**
  1. Call `sample_frames(video_path, interval_sec=0.5)` on a 10 s video
  2. Count returned frames
- **Expected:** Approximately 20 frames (10 s / 0.5 s per frame = 20)
- **Priority:** P1

### TC-015: Cosine Similarity Threshold Groups Same-Person Embeddings

- **Story:** STORY-008
- **Type:** Unit
- **Preconditions:** None
- **Steps:**
  1. Create two near-identical 512-dim numpy embeddings (cosine sim ≈ 0.9)
  2. Call `match_or_create_person(embedding_2, [{"person_ref_id": "uuid-1", "embedding": embedding_1}])`
  3. Create two very different embeddings (cosine sim ≈ 0.1)
  4. Call `match_or_create_person(embedding_b, [{"person_ref_id": "uuid-2", "embedding": embedding_a}])`
- **Expected:** Same-person pair → returns `"uuid-1"` (reuse); Different pair → returns new UUID
- **Priority:** P0

### TC-016: Empty Clip Produces Empty Persons List (Not Error)

- **Story:** STORY-009
- **Type:** Unit
- **Preconditions:** None
- **Steps:**
  1. Create a mock video that has no detectable faces (all-black frames)
  2. Call `detect_faces_in_frame` on the frame; mock InsightFace to return `[]`
  3. Invoke the detection pipeline; verify no exception raised
- **Expected:** `{"clip_id": "...", "persons": []}` returned; `detection_status` set to `'complete'`
- **Priority:** P0

### TC-017: Highlight Stored and Validated in DB

- **Story:** STORY-010
- **Type:** Integration
- **Preconditions:** Session with valid clip
- **Steps:**
  1. PUT `/sessions/:id/clips/:clip_id/highlights` with `{"highlights": [{"start_ms": 1000, "end_ms": 5000}]}`
  2. Verify 200
  3. Verify `highlights` DB row exists with correct `start_ms`, `end_ms`
- **Expected:** 200; DB row created
- **Priority:** P0

### TC-018: Highlight Below 1-Second Duration Rejected

- **Story:** STORY-010
- **Type:** Integration
- **Preconditions:** Session with valid clip
- **Steps:**
  1. PUT `/sessions/:id/clips/:clip_id/highlights` with `{"highlights": [{"start_ms": 1000, "end_ms": 1500}]}`
  2. Verify 422 (DB CHECK constraint `end_ms - start_ms >= 1000` violated)
- **Expected:** 422 response; no DB row created
- **Priority:** P0

### TC-019: Highlight End Greater than Clip Duration Returns 422

- **Story:** STORY-010
- **Type:** Integration
- **Preconditions:** Session with valid clip of known duration
- **Steps:**
  1. PUT highlights with `end_ms` exceeding clip `duration_ms`
- **Expected:** 422 validation error
- **Priority:** P1

### TC-020: Generation Job Submitted and Session Locked

- **Story:** STORY-012, STORY-013
- **Type:** Integration
- **Preconditions:** Session with valid clip, analysed audio
- **Steps:**
  1. POST `/sessions/:id/generate`
  2. Verify 202 with `job_id`
  3. Verify `sessions.status = 'locked'` in DB
  4. Verify `generation_jobs` row with `status = 'queued'`
- **Expected:** Session locked; job created
- **Priority:** P0

### TC-021: Upload to Locked Session Returns 409

- **Story:** STORY-012
- **Type:** Integration
- **Preconditions:** Session with `status = 'locked'`
- **Steps:**
  1. POST `/sessions/:id/clips` with valid file
- **Expected:** 409 with `SESSION_LOCKED`
- **Priority:** P0

### TC-022: Assembly Worker Includes All Highlights in EDL

- **Story:** STORY-011
- **Type:** Unit
- **Preconditions:** None (pure function)
- **Steps:**
  1. Build `AssemblyRequest` with 3 highlights of known time ranges
  2. Call `build_edl(request)`
  3. Verify each highlight's `clip_id`, `start_ms`, `end_ms` appears in `edl.segments`
- **Expected:** All 3 highlights present in EDL as segments with `source = 'highlight'`
- **Priority:** P0

### TC-023: Assembly EDL Segments Ordered Chronologically

- **Story:** STORY-013
- **Type:** Unit
- **Preconditions:** None (pure function)
- **Steps:**
  1. Build request with multiple clips
  2. Call `build_edl(request)`
  3. Assert each segment's `start_ms` in the source clip is non-decreasing for the same clip
- **Expected:** Segments ordered correctly
- **Priority:** P1

### TC-024: EDL Total Duration Does Not Exceed Audio Duration

- **Story:** STORY-011, STORY-013
- **Type:** Unit
- **Preconditions:** None
- **Steps:**
  1. Build request with `song_duration_ms = 10000`
  2. Call `build_edl(request)`
  3. Assert `edl.target_duration_ms <= 10000`
- **Expected:** EDL respects song boundary
- **Priority:** P0

### TC-025: Beat-Sync Alignment Within 100ms Tolerance

- **Story:** STORY-013
- **Type:** Unit
- **Preconditions:** Known beat timestamps
- **Steps:**
  1. Build request with explicit `beats_ms = [0, 500, 1000, 1500, ...]`
  2. Call `build_edl(request)`
  3. For each segment boundary, find nearest beat timestamp
  4. Assert `abs(segment_start_ms - nearest_beat_ms) <= 100`
- **Expected:** All cut points within 100 ms of a beat
- **Priority:** P1

### TC-026: Generation Failure Unlocks Session and Sets Status to 'failed'

- **Story:** STORY-013
- **Type:** Integration
- **Preconditions:** Session in `'locked'` state with queued generation job
- **Steps:**
  1. Mock Python assembly worker to return 500
  2. Trigger job processing
  3. Verify `generation_jobs.status = 'failed'`
  4. Verify `sessions.status = 'active'` (session unlocked for retry)
- **Expected:** Job marked failed; session unlocked
- **Priority:** P0

### TC-027: Session State Restored on Page Reload

- **Story:** STORY-014
- **Type:** Integration
- **Preconditions:** Session in `'complete'` state
- **Steps:**
  1. GET `/sessions/:id/state` with valid token
  2. Verify `status = 'complete'` and `current_step = 'download'` in response
- **Expected:** Correct state returned for step restoration
- **Priority:** P0

### TC-028: Cleanup Deletes All MinIO Objects and DB Rows

- **Story:** STORY-016
- **Type:** Unit
- **Preconditions:** Mocked MinIO client; mocked PostgreSQL pool
- **Steps:**
  1. Mock `listObjects` to return 3 keys
  2. Mock `deleteObjects` to return `[]` (no failures)
  3. Mock `query` for DB operations
  4. Call `cleanupSession(sessionId)`
  5. Verify `deleteObjects` called with all 3 keys
  6. Verify `DELETE FROM sessions` SQL was executed
  7. Verify `CleanupResult.filesDeleted === 3` and `dbDeleted === true`
- **Expected:** All objects deleted; DB row deleted; audit log emitted
- **Priority:** P0

### TC-029: Cleanup is Idempotent (Empty MinIO Prefix)

- **Story:** STORY-016 (Known Issue I9)
- **Type:** Unit
- **Preconditions:** Mocked clients
- **Steps:**
  1. Mock `listObjects` to return `[]`
  2. Call `cleanupSession(sessionId)`
  3. Verify no error thrown
  4. Verify `deleteObjects` was not called
- **Expected:** Returns `{ filesDeleted: 0, failedKeys: [], dbDeleted: true }` without error
- **Priority:** P0

### TC-030: Post-Cleanup Session URL Returns 410

- **Story:** STORY-015, STORY-016
- **Type:** Integration
- **Preconditions:** Session exists, then cleanup runs
- **Steps:**
  1. Create session
  2. Call `cleanupSession(sessionId)` directly
  3. GET `/sessions/:id/state` with the original token
- **Expected:** 410 Gone
- **Priority:** P0

### TC-031: SSE Stream Delivers Events in Order

- **Story:** STORY-013
- **Type:** Integration
- **Preconditions:** Active session; Redis connected
- **Steps:**
  1. Connect to `GET /sessions/:id/events`
  2. Publish `generation-progress` then `generation-complete` events via Redis
  3. Verify events received by SSE client in correct order
- **Expected:** Both events received; `type` fields match published events
- **Priority:** P1

### TC-032: GET /sessions/:id/reel Returns Presigned URL

- **Story:** STORY-015 (Known Issue C7: endpoint exists in code, not in spec)
- **Type:** Integration
- **Preconditions:** Session in `'complete'` state; `generation_jobs.output_url` populated
- **Steps:**
  1. GET `/sessions/:id/reel` with valid token
  2. Verify 200 or 302 with `output_url` or redirect to presigned URL
- **Expected:** Non-empty URL returned; URL is a valid MinIO presigned URL
- **Priority:** P1

### TC-033: r2_key Column Name Consistency (Schema vs Architecture)

- **Story:** Cross-cutting (Known Issue C5)
- **Type:** Unit
- **Preconditions:** Schema SQL loaded
- **Steps:**
  1. Read `server/src/db/schema.sql`
  2. Assert `clips` table has column `r2_key` (not `minio_key`)
  3. Assert `audio_tracks` table has column `r2_key` (not `minio_key`)
  4. Assert all SQL queries in route and worker files reference `r2_key`
- **Expected:** Schema and application code consistently use `r2_key`
- **Priority:** P1
- **Note:** The architecture doc uses `minio_key`; the schema uses `r2_key`. This is a documentation inconsistency, not a code bug, but tests should use the actual column name.

### TC-034: Duplicate Tab Session Takeover API Call

- **Story:** STORY-018
- **Type:** Integration
- **Preconditions:** Active session
- **Steps:**
  1. POST `/sessions/:id/tab-takeover` with valid token
  2. Verify `last_activity_at` is updated in DB
- **Expected:** 200; `last_activity_at` touched
- **Priority:** P1

### TC-035: Concurrent Upload Requests Do Not Exceed Clip Limit

- **Story:** STORY-002, STORY-003
- **Type:** Integration
- **Preconditions:** Session at 9 clips
- **Steps:**
  1. Fire 3 concurrent POST `/sessions/:id/clips` requests simultaneously
  2. Verify at most 1 succeeds (10th clip accepted); others return 422 `CLIP_LIMIT_EXCEEDED`
- **Expected:** No race condition; limit enforced atomically
- **Priority:** P1

---

## 5. Edge Cases

### EC-001: Zero Highlights Selected

- Submitting generation with no highlights → EDL uses filler segments only; `source = 'filler'`
- Covered by `TestNoHighlights` in `test_algorithm.py`

### EC-002: All Highlights Selected (100% of Clip)

- Highlight spans entire clip duration → EDL may contain only highlight segments
- If combined highlight duration equals song duration → generation proceeds without warning
- If combined highlight duration > song duration → EDL truncated, no error raised
- Covered by `TestHighlightsExceedSongDuration` in `test_algorithm.py`

### EC-003: Single Clip, Single Person

- One clip, one person detected → detection completes for single clip; `all_clips_done = true` immediately
- EDL includes person appearance segments plus filler

### EC-004: Maximum Clips (10)

- Ten clips each with detection → 10 BullMQ jobs queued; all processed sequentially (concurrency = 1 for InsightFace per ADR-013)
- Session state correctly accumulates all 10 clips before generation is permitted

### EC-005: Empty Audio Track (Silence)

- All-zero audio → `extract_beats` must not crash; may return BPM = 0 or default BPM
- `compute_energy_envelope` on silence → returns list of zero-amplitude pairs
- Covered by `test_silent_audio_does_not_raise` in `test_audio_analysis.py`

### EC-006: Very Short Clip (< 1 Second)

- `sample_frames` on a 500 ms clip at 2 fps → returns 0 or 1 frame; must not crash
- `detect_faces_in_frame` called 0 or 1 times; empty detection is normal
- Covered by `TestVeryShortSong` in `test_algorithm.py`

### EC-007: Duplicate Tab Session Takeover

- See TC-034. BroadcastChannel coordination is frontend-only; backend only updates `last_activity_at`.
- Manual test required to verify the Tab B warning UI and "Continue in This Tab" action.

### EC-008: Download Twice (Second Attempt After Cleanup)

- First download initiates 5-minute cleanup timer
- If user attempts second download after cleanup runs → 410 Gone from session auth middleware
- Covered by TC-030

### EC-009: Upload Interrupted Mid-Stream

- Browser drops connection mid-upload → Fastify multipart stream ends prematurely
- MinIO partial object may exist → Cleanup worker must handle idempotently
- Test: mock stream to throw `ECONNRESET` mid-upload; verify DB row is not left in `'uploading'` state indefinitely

### EC-010: Generation Job Timeout (15 Minutes)

- Python assembly worker takes > 15 minutes → `AbortController` fires → `fetch` throws
- Assembly worker catches error → sets `generation_jobs.status = 'failed'` → publishes `generation-failed` SSE event
- Covered partially by TC-026

### EC-011: MinIO Unavailable During Upload

- MinIO S3 client throws → upload route returns 503 or 500
- Clip DB row not created (or left in `'uploading'` and cleaned up by TTL sweep)
- Manual test: stop MinIO container, attempt upload

### EC-012: Redis Unavailable

- BullMQ throws connection error on job enqueue → API route returns 503
- No jobs queued; user sees error and can retry

---

## 6. Performance Benchmarks

All benchmarks are measured against the production hardware: Case Proxmox (24 threads @ 2.67 GHz) and Quorra Unraid (CPU-only per ADR-013).

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| InsightFace CPU inference | < 60 s per clip-minute | Timer wrapping `process_detection_job` for a 1-minute synthetic clip |
| Audio analysis (librosa) | < 10 s per 3-minute song | Timer wrapping `extract_beats` + `extract_onsets` + `compute_energy_envelope` |
| Assembly + FFmpeg encode | < 5 min for 60 s output reel | Timer wrapping `_run_assembly` with a 60 s synthetic reel |
| API p95 response time | < 200 ms for non-file endpoints | Vitest + `performance.now()`; 100 sequential requests |
| Upload throughput | > 50 MB/s (LAN) | Large file upload timer in integration test |
| Cleanup latency | < 2 s for session with 10 clips | Timer wrapping `cleanupSession` with mocked fast-delete |

### Performance Test Locations

- Python benchmarks: `workers/tests/test_performance.py` (to be written in a future sprint)
- TypeScript benchmarks: `server/tests/performance/api.bench.ts` (Vitest bench mode)

---

## 7. Infrastructure / Deployment Tests (STORY-020)

These tests are manual smoke tests run by the DevOps engineer during deployment. Automated equivalents are noted where applicable.

| Test | How to Verify | Automated? |
|------|--------------|-----------|
| CT 113 API server reachable | `curl http://192.168.1.136:3001/health` → `{"status":"ok"}` | `server/tests/smoke/smoke.test.ts` |
| PostgreSQL reachable (Quorra Docker) | `psql -h 192.168.1.100 -p 7432 -U hypereels -c 'SELECT 1'` | Part of `/health` endpoint check |
| CT 114 Redis reachable | `redis-cli -h 192.168.1.137 PING` → `PONG` | `server/tests/smoke/smoke.test.ts` |
| CT 115 MinIO bucket exists | `mc ls minio/hypereel` → bucket listed | MinIO health check in smoke test |
| MinIO ILM lifecycle rule active | `mc ilm ls minio/hypereel` → `session-ttl-safety-net` rule listed | Manual |
| NPM proxy host configured | `curl -I https://hypereels.thesquids.ink/health` → 200 | Manual (requires DNS) |
| Cloudflare tunnel routing | Access from external network → 200 | Manual (requires external network) |
| Prometheus scraping API | `curl http://192.168.1.100:9090/api/v1/targets` → `hypereel-api` target `state=up` | Manual |
| Grafana dashboard visible | Open Grafana → HypeReels dashboard → all panels load | Manual |
| LXC autostart enabled | Restart Case; verify all 4 LXC containers start automatically | Manual |
| Docker containers restart policy | Restart Quorra; verify worker containers restart | Manual |
| Quorra workers reach Redis/MinIO | From Quorra Docker: `redis-cli -h 192.168.1.138 PING` | Manual |

---

## 8. Acceptance Criteria Checklist

| Story | All ACs Testable? | Coverage Status | Notes |
|-------|-------------------|----------------|-------|
| STORY-001 | Yes | ⚠️ partial | Session expiry TTL not yet auto-tested; needs scheduled purge unit test |
| STORY-002 | Yes | ❌ missing | Clip upload integration tests needed |
| STORY-003 | Yes | ❌ missing | Format/size validation integration tests needed |
| STORY-004 | Yes | ❌ missing | Clip list schema integration test needed |
| STORY-005 | Yes | ❌ missing | Audio upload integration test needed |
| STORY-006 | ✅ | ✅ covered | Audio analysis unit tests present; format validation missing |
| STORY-007 | Yes | ❌ missing | Detection trigger integration test needed |
| STORY-008 | Yes | ❌ missing | Person selection integration test needed |
| STORY-009 | Yes | ❌ missing | Empty detection unit test written in this plan (TC-016) |
| STORY-010 | Yes | ❌ missing | Highlight PUT integration test needed; DB constraint test needed |
| STORY-011 | Yes | ✅ covered | Highlight constraint tests in test_algorithm.py |
| STORY-012 | Yes | ❌ missing | Session lock + read-only integration test needed |
| STORY-013 | Partial | ❌ missing | SSE integration complex; generation integration needed |
| STORY-014 | Yes | ⚠️ partial | GET /state partially tested; step restoration UI is manual |
| STORY-015 | Yes | ❌ missing | Download route integration test + GET /reel (C7) needed |
| STORY-016 | Yes | ❌ missing | Cleanup unit tests written in this plan (TC-028, TC-029) |
| STORY-017 | Partial | Manual only | React ErrorBoundary is frontend-only; cannot automate without E2E |
| STORY-018 | Partial | ⚠️ partial | BroadcastChannel is frontend-only; API side (tab-takeover) needs integration test |
| STORY-019 | Partial | Manual only | Step indicator UI is frontend-only; no automation without E2E |
| STORY-020 | Yes | ❌ missing | Smoke test script needed |
| STORY-021 | Yes | ❌ missing | CPUExecutionProvider unit test written in this plan (TC-013) |

---

## 9. Known Issues and Open Defects

These issues are documented from the Architect gap analysis and must be explicitly tested or noted as limitations.

| ID | Issue | Type | Test Coverage |
|----|-------|------|--------------|
| C3 | Python workers are HTTP FastAPI endpoints, not direct BullMQ consumers. The Node BullMQ workers call the Python FastAPI via HTTP POST. | Architecture (intentional) | TC-010, TC-012 test the Node→Python HTTP path |
| C5 | DB schema uses `r2_key`; architecture doc uses `minio_key`. All application code must use `r2_key`. | Schema consistency | TC-033 |
| C6 | Metrics query in `index.ts` references `status != 'destroyed'` but DB CHECK constraint only allows `'deleted'`. The `destroyed` value never enters the DB (constraint prevents it), but the Prometheus gauge query is always counting correctly since no row has `status = 'destroyed'`. The query is logically equivalent but misleading. | Code quality | TC-004 |
| C7 | `GET /sessions/:id/reel` exists in the download route implementation but is absent from the OpenAPI spec. | Spec gap | TC-032 |
| I8 | MinIO ILM `session_ttl=true` tag is specified in the architecture but may not be applied in the current upload code. | Implementation gap | TC-009 flags this |
| I9 | Cleanup worker calls `cleanupSession` from `server/src/lib/cleanup.ts`; a dedicated `cleanupWorker.ts` BullMQ consumer file may not exist as a module. Tests should target `cleanup.ts` directly. | Implementation gap | TC-028, TC-029 |
| I10 | Validation worker logic may be co-located in the API server process rather than a separate module. Tests should target the validation behaviour through the POST clip/audio routes. | Implementation gap | TC-005, TC-006, TC-010, TC-011 |

---

## 10. Handoff

### Passing Stories

At the time of this test plan's creation, the following test coverage exists and passes:

- STORY-006 (audio analysis): `workers/tests/test_audio_analysis.py` — full unit coverage of `extract_beats`, `compute_energy_envelope`, `derive_downbeats`, `derive_phrases`
- STORY-011 (highlight duration): `workers/tests/test_algorithm.py` — full unit coverage of `build_edl` including highlight inclusion, overflow truncation, empty highlights, beat snapping

### Open Defects (Failing or Missing Tests)

| Defect | Linked TC | Status |
|--------|-----------|--------|
| No integration tests for clip upload (STORY-002/003) | TC-005, TC-006, TC-007, TC-008 | Missing |
| No integration tests for audio upload (STORY-005/006) | TC-010, TC-011 | Missing |
| No integration tests for person detection trigger | TC-012 | Missing |
| No integration tests for generation lifecycle | TC-020, TC-021, TC-026 | Missing |
| No unit tests for cleanup.ts | TC-028, TC-029 | Missing (written in this plan) |
| No unit tests for InsightFace CPU init | TC-013 | Missing (written in this plan) |
| No unit tests for cosine similarity threshold | TC-015 | Missing (written in this plan) |
| No unit tests for empty clip detection | TC-016 | Missing (written in this plan) |
| GET /sessions/:id/reel not in OpenAPI spec (C7) | TC-032 | Spec gap |
| session_ttl tag not verified on upload (I8) | TC-009 | Implementation gap |
| 'destroyed' used in metrics query vs 'deleted' in schema (C6) | TC-004 | Code quality gap |

### Coverage Gaps

1. E2E Playwright tests: no automated E2E exists. Happy-path wizard (STORY-019, full user journey) is manual only.
2. SSE integration: SSE stream testing requires a real EventSource client in tests. This is technically feasible with `eventsource` npm package but not yet written.
3. Performance benchmarks: no automated performance test exists. All benchmarks are manual with `time` wrapper.
4. Infrastructure smoke tests: all infrastructure tests are manual; no automated smoke test script exists yet.

### Signoff Criteria

When the following P0 test cases pass in CI, this QA sign-off block is satisfied and `@devops-engineer` may proceed:

- TC-001, TC-002, TC-003, TC-004 (session lifecycle)
- TC-005, TC-006, TC-007, TC-008 (clip upload and validation)
- TC-010, TC-011 (audio upload)
- TC-013, TC-015, TC-016 (person detection)
- TC-017, TC-018 (highlights)
- TC-020, TC-022, TC-024, TC-026 (generation)
- TC-028, TC-029, TC-030 (cleanup)

When all P0 TCs pass → `@devops-engineer`
