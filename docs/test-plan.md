# HypeReels Test Plan

> Owner: QA Engineer
> Last updated: 2026-04-19
> Model: claude-sonnet-4-6

---

## 1. Strategy

### Scope

All twenty-six MVP user stories (STORY-001 through STORY-026) across the full stack:

- Fastify REST API (Node.js 20, Case CT 113 / single-machine Docker)
- PostgreSQL 18 session/job state (co-located Docker container, per ADR-019)
- Redis 7 job queue and pub/sub (co-located LXC or Docker container)
- MinIO object storage with ILM lifecycle policy
- Python workers: audio analysis (librosa), person detection (InsightFace CPU-only), assembly (FFmpeg)
- React SPA (Vite, Zustand, Tailwind)
- Deployment: Profile 1 (CPU-only single machine) and Profile 2 (GPU-enabled single machine)

### Objectives

1. Verify all STORY-001–026 acceptance criteria are testable and produce a pass/fail signal.
2. Confirm session lifecycle state machine: `active → locked → complete → deleted`.
3. Confirm InsightFace initialises with `CPUExecutionProvider` only (ADR-013).
4. Confirm the `minio_key` schema column name is used consistently by all application code.
5. Verify MinIO ILM `session_ttl=true` tag is applied at upload time.
6. Verify cleanup is idempotent and handles missing objects gracefully.
7. Confirm both single-system deployment profiles start cleanly from `docker compose up -d`.
8. Confirm Profile 3 (split-system) deprecation notice is in place and no active docs promote it.
9. Confirm no hardcoded IPs appear in generic deployment documentation.

### Risk Areas

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| ADR-003 stale Rekognition code in main.py | Resolved (main.py now calls detect_persons() correctly) | P0 blocker if regressed | TC-013 + TC-016 catch any regression |
| ADR-006 r2_client.py renamed to minio_client.py | Resolved per architecture doc | Runtime import failure | TC-033 (column/import consistency) |
| InsightFace GPU contention (Frigate on Quorra) | Resolved by CPU-only mode | Service degradation | TC-013 verifies CPUExecutionProvider |
| Session cleanup leaves orphaned MinIO objects | Medium | Storage leak | TC-028, TC-029, TC-030 |
| Highlights total > song duration causes generation error | Medium | User-facing failure | TC-022, TC-024 cover truncation |
| Profile 3 docs mislead deployers | Low (marked deprecated) | Wasted deployer time | TC-050 checks deprecation notice |
| Hardcoded IPs in profile docs | Low (fixed per ADR-019) | Non-portable docs | TC-051, TC-052 scan docs |

### Test Levels

| Level | Tool | Location | When Run |
|-------|------|----------|----------|
| Unit | pytest | `workers/tests/` | Every commit |
| Unit | Vitest | `server/src/**/*.test.ts` | Every commit |
| Integration | Vitest + real services | `server/tests/integration/` | Pre-merge |
| E2E | Playwright | `e2e/` | Planned post-MVP |
| Deployment / smoke | shell script | `scripts/smoke-test.sh` | Post-deploy |
| Performance | Manual / bench | `workers/tests/test_performance.py` | Sprint-end |

### CI Configuration

```yaml
# .github/workflows/test.yml (or equivalent)
jobs:
  python-unit:
    steps:
      - run: pip install -r workers/requirements.txt
      - run: pytest workers/tests/ -v --tb=short
  node-unit:
    steps:
      - run: npm ci --prefix server
      - run: npm run test --prefix server
  integration:
    services:
      postgres: { image: "postgres:18", env: { POSTGRES_PASSWORD: test } }
      redis:    { image: "redis:7" }
      minio:    { image: "minio/minio", command: "server /data" }
    steps:
      - run: npm run test:integration --prefix server
```

---

## 2. Environment

### Dependencies

| Service | Version | Purpose |
|---------|---------|---------|
| PostgreSQL | 18 | Session/job state |
| Redis | 7 | BullMQ + SSE pub/sub |
| MinIO | latest | Object storage (S3-compatible) |
| Node.js | 20 LTS | API server + BullMQ workers |
| Python | 3.12 | Audio analysis, person detection, assembly |
| FFmpeg | 6+ | Video assembly (in worker container) |
| InsightFace buffalo_l | latest | Person detection (CPU-only) |

### Fixture Media

| Fixture | Size | Description | Used In |
|---------|------|-------------|---------|
| `fixtures/tiny.mp4` | < 200 KB | Valid 2-second H.264 clip, 1 person visible | TC-005, TC-012, TC-020 |
| `fixtures/tiny_audio.mp3` | < 50 KB | Valid 3-second 128 kbps MP3, audible beat | TC-010, TC-020 |
| `fixtures/corrupt.mp4` | 1 KB | Truncated file with `.mp4` extension | TC-006 (mime sniff) |
| `fixtures/zero_byte.mp4` | 0 bytes | Empty file | TC-007 (zero-byte rejection) |
| `fixtures/too_large.mp4` | 2 GB+1 byte | Just over the 2 GB clip limit | TC-007 (size boundary) |
| `fixtures/no_faces.mp4` | < 200 KB | Valid 2-second clip, no people | TC-016 |
| `fixtures/silent_audio.mp3` | < 50 KB | All-zero audio, valid MP3 container | EC-005 |
| `fixtures/audio.wav` | < 200 KB | Valid WAV file | TC-011 (format acceptance) |

All fixtures must be deterministic (checked into the repo or generated with a fixed seed).
No system clock or random data is used in any test.

### Setup Steps

```bash
# 1. Start test services
docker compose -f docker-compose.test.yml up -d

# 2. Run migrations
cd server && npm run db:migrate

# 3. Create MinIO test bucket
mc mb local/hypereels-test

# 4. Run unit tests
pytest workers/tests/ -v
cd server && npx vitest run

# 5. Run integration tests
cd server && npx vitest run --project integration

# 6. Teardown
docker compose -f docker-compose.test.yml down -v
```

### Environment Variables for Tests

```env
DATABASE_URL=postgresql://hypereels:test@localhost:5432/hypereels_test
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=hypereels-test
PYTHON_WORKER_URL=http://localhost:8000
SESSION_TTL_HOURS=24
CLEANUP_GRACE_MS=300000
```

---

## 3. Test Cases

### TC-001: Session Creation Returns Valid Token
- Story: STORY-001
- Type: Unit (mocked DB)
- Preconditions: API server built; DB client mocked
- Steps:
  1. POST `/sessions` with no body
  2. Verify HTTP 201
  3. Verify response body has `session_id` (UUID) and `token` (UUID)
  4. Verify INSERT into sessions SQL was called
- Expected: 201 response; valid UUIDs; DB insert called
- Priority: P0

### TC-002: Session Token Required for Protected Routes
- Story: STORY-001
- Type: Unit (mocked DB)
- Preconditions: API built; DB mocked
- Steps:
  1. GET `/sessions/:id/state` with no Authorization header — expect 401 with `MISSING_TOKEN`
  2. GET `/sessions/:id/state` with `Authorization: Basic <token>` — expect 401
  3. GET `/sessions/:id/state` with `Authorization: Bearer invalid-token-not-in-db` — expect 404 with `SESSION_NOT_FOUND`
  4. GET `/sessions/:id/state` with valid Bearer token (DB returns session) — expect 200
- Expected: 401 for missing/malformed; 404 for unknown; 200 for valid
- Priority: P0

### TC-003: Deleted Session Returns 410
- Story: STORY-001
- Type: Unit (mocked DB)
- Preconditions: DB mocked to return session with `status='deleted'`
- Steps:
  1. GET `/sessions/:id/state` with valid token
  2. Assert HTTP 410
  3. Assert `error.code == 'SESSION_GONE'`
  4. Assert `error.message` contains "deleted" or "expired"
- Expected: 410 Gone; SESSION_GONE error code
- Priority: P0

### TC-004: Session Status Constraint — 'destroyed' Never Stored
- Story: STORY-016 (Known Issue C6)
- Type: Unit (mocked DB)
- Preconditions: cleanupSession available; mocks in place
- Steps:
  1. Run `cleanupSession(sessionId)` with mocked storage and DB
  2. Capture all SQL calls to the `query` mock
  3. Assert at least one SQL call contains `'deleted'` in a status update
  4. Assert NO SQL call contains `'destroyed'`
- Expected: Only `'deleted'` is used; `'destroyed'` never appears
- Priority: P0

### TC-005: Valid Video Clip Upload Accepted
- Story: STORY-002, STORY-003
- Type: Integration (real MinIO + DB)
- Preconditions: Active session; MinIO bucket exists
- Steps:
  1. POST `/sessions/:id/clips` multipart with `fixtures/tiny.mp4` and `Content-Type: video/mp4`
  2. Assert HTTP 202 with `clip_id` (UUID)
  3. Assert MinIO object exists at `uploads/{session_id}/clips/{clip_id}.mp4`
  4. Assert `clips` DB row with `status='uploading'`
- Expected: 202; MinIO object present; DB row created
- Priority: P0

### TC-006: Invalid Format Rejected Before Upload
- Story: STORY-003
- Type: Integration (real MinIO + DB)
- Preconditions: Active session
- Steps:
  1. POST `/sessions/:id/clips` with `fixtures/corrupt.mp4` and `Content-Type: application/pdf`
  2. Assert HTTP 422
  3. Assert `error.code == 'UNSUPPORTED_FORMAT'`
  4. Assert no MinIO object was created
  5. Assert no `clips` DB row was created
- Expected: 422; no storage write; no DB row
- Priority: P0

### TC-007: Size Boundary — At Limit Passes, 1 Byte Over Returns 422
- Story: STORY-003
- Type: Integration (real MinIO + DB)
- Preconditions: Active session
- Steps:
  1. Upload a clip of exactly 2 GB (2 147 483 648 bytes) — expect 202
  2. Upload a clip of 2 GB + 1 byte (2 147 483 649 bytes) — expect 422 with `FILE_TOO_LARGE`
- Expected: 202 at limit; 422 one byte over
- Priority: P0

### TC-007b: Zero-Byte Upload Rejected Without Crash
- Story: STORY-003
- Type: Integration (real MinIO + DB)
- Preconditions: Active session
- Steps:
  1. POST `/sessions/:id/clips` with `fixtures/zero_byte.mp4` (0 bytes)
  2. Assert HTTP 422 or 400
  3. Assert server does not return 500
  4. Assert API remains responsive (GET `/health` returns 200)
- Expected: Non-500 error response; server remains healthy
- Priority: P0

### TC-008: Clip Count Limit Enforced (10 max)
- Story: STORY-002
- Type: Integration (real DB)
- Preconditions: Session with 10 existing valid clips in DB
- Steps:
  1. POST `/sessions/:id/clips` with an 11th valid file
  2. Assert HTTP 422 with `error.code == 'CLIP_LIMIT_EXCEEDED'`
- Expected: 422; no new clip row created
- Priority: P0

### TC-009: MinIO Upload Tags Object with session_ttl=true
- Story: STORY-016 (Implementation gap I8)
- Type: Integration (real MinIO)
- Preconditions: Active session; MinIO ILM rule configured for `session_ttl=true`
- Steps:
  1. POST `/sessions/:id/clips` with valid `fixtures/tiny.mp4`
  2. Use MinIO S3 API `GetObjectTagging` on the uploaded object
  3. Assert tag `session_ttl=true` is present
- Expected: Object carries `session_ttl=true` tag
- Priority: P1

### TC-010: Audio Upload Accepted and Analysis Job Queued
- Story: STORY-005, STORY-006
- Type: Integration (real MinIO + Redis + DB)
- Preconditions: Active session; BullMQ connected to Redis
- Steps:
  1. POST `/sessions/:id/audio` with `fixtures/tiny_audio.mp3`
  2. Assert HTTP 202 with `audio_id` (UUID)
  3. Assert BullMQ `audio-analysis` queue has a job with correct session and audio IDs
  4. Assert `audio_tracks` DB row with `analysis_status='pending'`
  5. Assert MinIO object exists at `uploads/{session_id}/audio.mp3`
- Expected: 202; job queued; DB row created; MinIO object present
- Priority: P0

### TC-011: Invalid Audio Format Rejected
- Story: STORY-006
- Type: Integration (real MinIO + DB)
- Preconditions: Active session
- Steps:
  1. POST `/sessions/:id/audio` with a `.exe` file and `Content-Type: application/octet-stream`
  2. Assert HTTP 422 with `error.code == 'UNSUPPORTED_FORMAT'`
- Expected: 422; no MinIO object created; no DB row
- Priority: P0

### TC-012: Person Detection Triggered for All Valid Clips
- Story: STORY-007
- Type: Integration (real Redis + DB)
- Preconditions: Session with 2 clips in `status='valid'`, `detection_status='pending'`
- Steps:
  1. POST `/sessions/:id/detect`
  2. Assert HTTP 202 with `queued` count equal to 2
  3. Assert BullMQ `person-detection` queue has 2 jobs
  4. Assert both clips' `detection_status` transitions to `'processing'`
- Expected: 2 jobs queued; clips marked processing
- Priority: P0

### TC-013: InsightFace Initialises with CPUExecutionProvider Only
- Story: STORY-007, STORY-021 (ADR-013)
- Type: Unit (mocked InsightFace)
- Preconditions: None (mocked)
- Steps:
  1. Mock `insightface.app.FaceAnalysis` constructor
  2. Reset the module-level singleton (`_insight_app = None`)
  3. Call `_get_insight_app()` from `person_detection_worker.py`
  4. Assert `FaceAnalysis` called with `providers=['CPUExecutionProvider']`
  5. Assert `'CUDAExecutionProvider'` does NOT appear in `providers`
  6. Assert `.prepare()` called with `ctx_id=-1`
- Expected: Only CPUExecutionProvider; ctx_id is -1
- Priority: P0

### TC-014: Frame Sampling at 2fps Produces Correct Count
- Story: STORY-007
- Type: Unit (mocked cv2)
- Preconditions: Mocked `cv2.VideoCapture` for a 10-second 25fps clip
- Steps:
  1. Call `sample_frames(Path("/fake/video.mp4"), interval_sec=0.5)`
  2. Assert returned list length is between 18 and 22 (≈20 frames)
  3. Assert each element is a `(int, np.ndarray)` tuple
  4. Assert timestamps are non-negative and in ascending order
- Expected: ~20 frames; ascending timestamps; correct tuple type
- Priority: P1

### TC-015: Cosine Similarity Threshold Groups Same-Person Embeddings
- Story: STORY-008
- Type: Unit (pure numpy)
- Preconditions: None
- Steps:
  1. Create two near-identical 512-dim unit embeddings (cosine sim ≈ 0.99)
  2. Call `match_or_create_person(embedding_2, [{"person_ref_id": "uuid-1", "embedding": embedding_1}])`
  3. Assert result equals `"uuid-1"` (same person, existing ref reused)
  4. Create two very different embeddings (cosine sim ≈ 0.05)
  5. Call `match_or_create_person(different_embedding, [{"person_ref_id": "uuid-2", "embedding": different_base}])`
  6. Assert result is a new UUID (different person)
  7. Assert `FACE_COSINE_THRESHOLD == 0.45`
- Expected: Same-person reuses ref_id; different person creates new UUID; threshold is 0.45
- Priority: P0

### TC-016: Empty Clip Produces Empty Persons List (Not Error)
- Story: STORY-009
- Type: Unit (mocked InsightFace)
- Preconditions: None
- Steps:
  1. Mock `_get_insight_app()` to return an app whose `get()` returns `[]` (no faces)
  2. Call `detect_faces_in_frame(black_frame)`
  3. Assert result is `[]`
  4. Assert no exception raised
  5. Run `cluster_detections_within_clip([], {})` — assert returns `{}`
- Expected: Empty list returned; no exception; detection_status set to 'complete' not 'failed'
- Priority: P0

### TC-017: Highlight Stored and Validated in DB
- Story: STORY-010
- Type: Integration (real DB)
- Preconditions: Session with valid clip (`duration_ms=30000`)
- Steps:
  1. PUT `/sessions/:id/clips/:clip_id/highlights` with `{"highlights": [{"start_ms": 1000, "end_ms": 5000}]}`
  2. Assert HTTP 200
  3. Assert `highlights` DB row exists with `start_ms=1000`, `end_ms=5000`
  4. Assert response includes `highlights` array with 1 entry containing `id`, `start_ms`, `end_ms`
- Expected: 200; DB row created; response matches schema
- Priority: P0

### TC-018: Highlight Below 1000ms Duration Rejected
- Story: STORY-010
- Type: Integration (real DB)
- Preconditions: Session with valid clip
- Steps:
  1. PUT `/sessions/:id/clips/:clip_id/highlights` with `{"highlights": [{"start_ms": 1000, "end_ms": 1500}]}`
  2. Assert HTTP 422
  3. Assert `error.code` indicates duration constraint violation
  4. Assert no DB row created
- Expected: 422; DB CHECK constraint violation (`end_ms - start_ms >= 1000`)
- Priority: P0

### TC-019: Highlight End Greater than Clip Duration Returns 422
- Story: STORY-010
- Type: Integration (real DB)
- Preconditions: Session with valid clip of `duration_ms=10000`
- Steps:
  1. PUT highlights with `{"highlights": [{"start_ms": 0, "end_ms": 15000}]}`
  2. Assert HTTP 422
  3. Assert `error.details` or message mentions `end_ms` exceeds clip duration
- Expected: 422; no DB row created
- Priority: P1

### TC-019b: Overlapping Highlights Return 422 with Conflicting Range Details
- Story: STORY-010
- Type: Integration (real DB)
- Preconditions: Session with valid clip of `duration_ms=30000`
- Steps:
  1. PUT highlights with two overlapping ranges: `[{start_ms:0,end_ms:5000},{start_ms:3000,end_ms:8000}]`
  2. Assert HTTP 422
  3. Assert `error.code` indicates overlapping ranges
- Expected: 422 identifying the conflicting range
- Priority: P1

### TC-020: Generation Job Submitted and Session Locked
- Story: STORY-012, STORY-013
- Type: Integration (real DB + Redis)
- Preconditions: Session with 1 valid clip, audio in `analysis_status='complete'`
- Steps:
  1. POST `/sessions/:id/generate`
  2. Assert HTTP 202 with `job_id` (UUID)
  3. Assert `sessions.status='locked'` in DB
  4. Assert `generation_jobs` row with `status='queued'` and matching `session_id`
  5. Assert BullMQ `generation` queue has a job
- Expected: Session locked; job created; job queued
- Priority: P0

### TC-021: Upload to Locked Session Returns 409
- Story: STORY-012
- Type: Integration (real DB)
- Preconditions: Session with `status='locked'`
- Steps:
  1. POST `/sessions/:id/clips` with valid `fixtures/tiny.mp4`
  2. Assert HTTP 409 with `error.code == 'SESSION_LOCKED'`
- Expected: 409; no new clip row created
- Priority: P0

### TC-022: Assembly Worker Includes All Highlights in EDL
- Story: STORY-011, STORY-013
- Type: Unit (pure function)
- Preconditions: None
- Steps:
  1. Build `AssemblyRequest` with 3 highlights on clip-1: `[{0,3000},{5000,8000},{10000,13000}]`
  2. Call `build_edl(request)` with song_duration_ms=20000
  3. Assert each highlight's time range appears in `edl.segments` as `source='highlight'`
  4. Assert all 3 highlight clip_ids match `clip-1`
- Expected: All 3 highlights present in EDL as highlight segments
- Priority: P0

### TC-023: Assembly EDL Segments Have Positive Duration
- Story: STORY-013
- Type: Unit (pure function)
- Preconditions: None
- Steps:
  1. Build request with multiple clips and highlights
  2. Call `build_edl(request)`
  3. Assert `seg.duration_ms > 0` for every segment
  4. Assert `seg.end_ms > seg.start_ms` for every segment
  5. Assert no segment has `duration_ms < 200` (minimum filter from architecture)
- Expected: All segments have positive, valid durations ≥ 200ms
- Priority: P1

### TC-024: EDL Total Duration Does Not Exceed Audio Duration
- Story: STORY-011, STORY-013
- Type: Unit (pure function)
- Preconditions: None
- Steps:
  1. Build request with `song_duration_ms=10000`
  2. Call `build_edl(request)`
  3. Assert `edl.target_duration_ms <= 10000`
- Expected: EDL respects song boundary
- Priority: P0

### TC-025: Beat-Sync Cut Points Within 100ms of a Beat
- Story: STORY-013
- Type: Unit (pure function)
- Preconditions: Known beat timestamps at 120 BPM
- Steps:
  1. Build request with explicit `beats_ms=[0,500,1000,1500,2000,...]`
  2. Call `build_edl(request)`
  3. For each segment boundary (`start_ms`), find nearest beat timestamp
  4. Assert `abs(segment_start_ms - nearest_beat_ms) <= 100`
- Expected: All cut points within 100ms of a beat
- Priority: P1

### TC-026: Generation Failure Sets Status to 'failed' and Preserves Session
- Story: STORY-013
- Type: Integration (mocked Python worker)
- Preconditions: Session locked with queued generation job
- Steps:
  1. Configure Python worker mock to return HTTP 500 for `/assemble-reel`
  2. Trigger assembly worker job processing
  3. Assert `generation_jobs.status='failed'` in DB
  4. Assert `generation_jobs.error_message` is non-null
  5. Assert session status is NOT 'deleted' (session preserved for retry/start-over)
- Expected: Job marked failed; session preserved; error recorded
- Priority: P0

### TC-027: Session State Restored on Page Reload
- Story: STORY-014
- Type: Unit (mocked DB)
- Preconditions: DB mocked with various session states
- Steps:
  1. Mock session in `status='complete'`, `current_step='download'`
  2. GET `/sessions/:id/state` — assert `status='complete'`, `current_step='download'`
  3. Mock session in `status='locked'`, `current_step='generate'`
  4. GET `/sessions/:id/state` — assert `status='locked'`
  5. Assert response includes `session_id`, `status`, `current_step`, `clips`, `audio`, `persons`, `latest_job`
  6. Assert `audio=null` when no audio uploaded; `latest_job=null` when no job
- Expected: All state fields returned correctly per session state
- Priority: P0

### TC-028: Cleanup Deletes All MinIO Objects and DB Rows
- Story: STORY-016
- Type: Unit (mocked MinIO + DB)
- Preconditions: Mocked `listObjects`, `deleteObjects`, `query`, `withTransaction`
- Steps:
  1. Mock `listObjects` to return 3 keys across uploads/, generated/, thumbnails/
  2. Mock `deleteObjects` to return `[]` (no failures)
  3. Call `cleanupSession(sessionId)`
  4. Assert `deleteObjects` called with all 3 keys
  5. Assert `DELETE FROM sessions` SQL executed with correct session ID
  6. Assert `result.filesDeleted === 3` and `result.dbDeleted === true`
  7. Assert session status update uses `'deleted'` not `'destroyed'`
- Expected: All objects deleted; DB row deleted; audit log emitted; 'deleted' status used
- Priority: P0

### TC-029: Cleanup is Idempotent on Empty Storage
- Story: STORY-016
- Type: Unit (mocked storage + DB)
- Preconditions: Mocked `listObjects` returning `[]` for all prefixes
- Steps:
  1. Call `cleanupSession(sessionId)`
  2. Assert `deleteObjects` was NOT called
  3. Assert `result.filesDeleted === 0` and `result.failedKeys === []`
  4. Assert `result.dbDeleted === true` (DB cleanup still runs)
  5. Assert no exception thrown
- Expected: Graceful empty-cleanup; `{filesDeleted:0, failedKeys:[], dbDeleted:true}`
- Priority: P0

### TC-030: Post-Cleanup Session Returns 410
- Story: STORY-015, STORY-016
- Type: Unit (mocked DB)
- Preconditions: DB mocked to return session with `status='deleted'`
- Steps:
  1. GET `/sessions/:id/state` with the original token (session now `status='deleted'`)
  2. Assert HTTP 410 Gone with `SESSION_GONE` error code
- Expected: 410 Gone; cannot access deleted session
- Priority: P0

### TC-031: SSE Stream Delivers Events in Correct Order
- Story: STORY-013
- Type: Integration (real Redis)
- Preconditions: Active session; Redis connected
- Steps:
  1. Connect to `GET /sessions/:id/events` via `EventSource`
  2. Publish `generation-progress` event to Redis `session:{id}:events` channel
  3. Publish `generation-complete` event
  4. Assert both events received by SSE client in FIFO order
  5. Assert `type` fields match published event types
- Expected: Both events received in order; correct type field
- Priority: P1

### TC-032: GET /sessions/:id/reel Returns Presigned URL
- Story: STORY-015
- Type: Integration (mocked DB + MinIO)
- Preconditions: Session `status='complete'`; `generation_jobs.output_url` populated
- Steps:
  1. GET `/sessions/:id/reel` with valid token and `Accept: application/json`
  2. Assert HTTP 200 with `download_url` (non-empty string, MinIO presigned URL format)
  3. Assert `expires_at` field is a valid ISO 8601 timestamp
- Expected: 200 with presigned URL; URL is non-empty
- Priority: P1

### TC-033: Schema Column Name Consistency (minio_key)
- Story: Cross-cutting (ADR-006 fix)
- Type: Unit (source code scan)
- Preconditions: None
- Steps:
  1. Read `server/src/db/schema.sql` (or equivalent migration file)
  2. Assert `clips` table has column `minio_key` (not `r2_key`)
  3. Assert `audio_tracks` table has column `minio_key`
  4. Assert no active import of `common.r2_client` in Python workers (should be `minio_client`)
- Expected: Consistent use of `minio_key` / `minio_client` throughout
- Priority: P1

### TC-034: Concurrent Upload Requests Do Not Exceed Clip Limit (Race Safety)
- Story: STORY-002, STORY-003
- Type: Integration (real DB)
- Preconditions: Session at 9 clips
- Steps:
  1. Fire 3 concurrent POST `/sessions/:id/clips` requests simultaneously (Promise.all)
  2. Assert at most 1 succeeds with 202 (10th clip accepted)
  3. Assert remaining requests return 422 `CLIP_LIMIT_EXCEEDED`
  4. Assert final clip count in DB is exactly 10
- Expected: No race condition allows > 10 clips; limit enforced atomically
- Priority: P1

### TC-035: Duplicate Content Hash Returns 409 with existing_clip_id
- Story: STORY-002
- Type: Integration (real MinIO + DB)
- Preconditions: Session with 1 existing valid clip
- Steps:
  1. Upload the same `fixtures/tiny.mp4` file a second time
  2. Assert HTTP 409 with `error.code == 'DUPLICATE_CONTENT'`
  3. Assert response body includes `existing_clip_id`
- Expected: 409 with existing clip ID
- Priority: P1

### TC-036: Network Interrupt Mid-Upload — Failed Clip Marked, Others Continue
- Story: STORY-002
- Type: Integration (simulated)
- Preconditions: Active session
- Steps:
  1. Begin upload of two clips concurrently
  2. Abort the first request mid-stream (simulate via `AbortController`)
  3. Assert first clip is marked with error state (not left as `'uploading'` indefinitely)
  4. Assert second clip upload completes normally with 202
  5. Assert API remains healthy (GET `/health` → 200)
- Expected: Failed upload does not block others; no indefinite 'uploading' state
- Priority: P1

### TC-037: Person Detection — N Persons Detected Correctly
- Story: STORY-007, STORY-008
- Type: Unit (mocked InsightFace with N faces)
- Preconditions: Mocked InsightFace returning 3 distinct face detections
- Steps:
  1. Mock `_get_insight_app().get()` to return 3 face objects with distinct embeddings
  2. Call `detect_faces_in_frame(frame)` — assert 3 results returned
  3. Run clustering across 3 frames with same 3 faces — assert 3 distinct `person_ref_id`s
- Expected: N distinct persons tracked correctly; each has unique ref_id
- Priority: P1

### TC-038: Person Detection — Partial Frame / Occlusion Handled
- Story: STORY-007
- Type: Unit (mocked InsightFace)
- Preconditions: None
- Steps:
  1. Mock InsightFace to return faces with `det_score < MIN_FACE_CONFIDENCE` (occluded/partial)
  2. Call `detect_faces_in_frame(frame)`
  3. Assert low-confidence faces are filtered (returned list is empty)
  4. Assert no exception raised
- Expected: Low-confidence faces filtered; no crash
- Priority: P1

### TC-039: Person Detection Job Failure — Clip Marked 'failed', Others Continue
- Story: STORY-007
- Type: Integration (mocked Python worker)
- Preconditions: Session with 2 clips pending detection
- Steps:
  1. Configure Python worker to return HTTP 500 for clip-1's detection
  2. Run detection jobs
  3. Assert clip-1's `detection_status='failed'`
  4. Assert clip-2's detection proceeds independently and completes
  5. Assert session is not blocked from proceeding to generation
- Expected: Failed clip marked 'failed'; other clips unaffected; session usable
- Priority: P0

### TC-040: Audio Analysis Job Failure — User Notified via SSE
- Story: STORY-006
- Type: Integration (mocked Python worker)
- Preconditions: Session with uploaded audio
- Steps:
  1. Configure Python worker to return HTTP 422 for `/analyse-audio`
  2. Trigger audio analysis job
  3. Assert `audio_tracks.analysis_status='failed'` in DB
  4. Assert `audio-analysis-failed` SSE event published to Redis
- Expected: Analysis failure recorded; SSE event published; audio_id in event payload
- Priority: P0

### TC-041: Generation Happy Path — Valid EDL, Presigned URL Returned
- Story: STORY-013, STORY-014
- Type: Unit (mocked assembly + MinIO)
- Preconditions: AssemblyRequest with 1 clip, 1 highlight, 10s song
- Steps:
  1. Build `AssemblyRequest` with valid inputs
  2. Call `build_edl(request)` — assert non-empty EDL
  3. Mock FFmpeg trim, concat, encode steps to produce a valid output path
  4. Mock MinIO `upload_file` to succeed
  5. Assert `AssembleReelResponse` has non-empty `output_r2_key` and `output_size_bytes > 0`
- Expected: EDL produced; output key set; response valid
- Priority: P0

### TC-042: All-Highlights Generation — Only Highlight Segments in EDL
- Story: STORY-011, STORY-013
- Type: Unit (pure function)
- Preconditions: Highlights span entire clip; song duration equals total highlight duration
- Steps:
  1. Build request where all clip content is highlighted and song_duration_ms equals highlight total
  2. Call `build_edl(request)`
  3. Assert all segments have `source='highlight'`
  4. Assert `edl.target_duration_ms == song_duration_ms`
- Expected: EDL contains only highlight segments; no filler
- Priority: P1

### TC-043: Total Highlights > Song Duration — EDL Truncated, No Error
- Story: STORY-011
- Type: Unit (pure function)
- Preconditions: None
- Steps:
  1. Build request with 3×5s highlights but song_duration_ms=8000
  2. Call `build_edl(request)` — assert no exception
  3. Assert `edl.target_duration_ms <= 8000`
  4. Assert all segments have non-negative duration
- Expected: EDL truncated to fit song; no exception; `target_duration_ms <= song`
- Priority: P0

### TC-044: Single-Clip Single-Person Happy Path
- Story: STORY-007, STORY-008, STORY-013
- Type: Unit (pure function)
- Preconditions: None
- Steps:
  1. Build `AssemblyRequest` with 1 clip, 1 PersonAppearance, no highlights
  2. Call `build_edl(request)`
  3. Assert at least one segment has `source='person'`
  4. Assert `edl.target_duration_ms <= song_duration_ms`
- Expected: Person appearance appears in EDL; song length respected
- Priority: P1

### TC-045: Song Under 10s — Generation Does Not Error
- Story: STORY-013
- Type: Unit (pure function)
- Preconditions: None
- Steps:
  1. Build request with `song_duration_ms=5000` (5 seconds) and `beats_ms=[0,500,1000,1500,2000,2500,3000,3500,4000,4500]`
  2. Call `build_edl(request)` — assert no exception
  3. Assert `isinstance(edl, EDL)` and `len(edl.segments) > 0`
- Expected: Short song handled gracefully; valid EDL produced
- Priority: P1

### TC-046: Download — Valid File Returned via Presigned URL
- Story: STORY-015
- Type: Integration (real MinIO)
- Preconditions: Session `status='complete'`; generated MP4 uploaded to MinIO
- Steps:
  1. GET `/sessions/:id/reel` with `Accept: application/json`
  2. Assert 200 with `download_url`
  3. Issue GET against `download_url` — assert HTTP 200
  4. Assert response Content-Type is `video/mp4`
  5. Assert response body is non-empty (bytes > 0)
- Expected: Valid presigned URL; 200 from MinIO; non-empty MP4 body
- Priority: P0

### TC-047: Signed URL Returns 404 or 403 on Second Access After TTL
- Story: STORY-015, STORY-016
- Type: Integration (real MinIO with shortened TTL)
- Preconditions: Session complete; presigned URL generated with 5-second TTL (test env)
- Steps:
  1. GET `/sessions/:id/reel` → capture `download_url`
  2. Wait 10 seconds (TTL expired)
  3. GET `download_url` directly
  4. Assert HTTP 403 (expired signature) or 404 (object deleted)
- Expected: Expired URL returns 403 or 404
- Priority: P1

### TC-048: Storage Empty After Cleanup
- Story: STORY-016
- Type: Integration (real MinIO + DB)
- Preconditions: Session with uploaded clips, audio, and generated reel in MinIO
- Steps:
  1. POST `/sessions/:id/done` (trigger immediate cleanup)
  2. Wait for cleanup job to complete
  3. Assert MinIO `uploads/{session_id}/` prefix lists 0 objects
  4. Assert MinIO `generated/{session_id}/` prefix lists 0 objects
  5. Assert MinIO `thumbnails/{session_id}/` prefix lists 0 objects
  6. Assert `sessions` DB row has `status='deleted'`
- Expected: All MinIO objects deleted; session marked 'deleted'
- Priority: P0

### TC-049: Concurrent Sessions — No Shared State or Races
- Story: STORY-001, STORY-002
- Type: Integration (real DB + MinIO)
- Preconditions: None
- Steps:
  1. Create 3 sessions concurrently (3× POST `/sessions`)
  2. Upload a clip to each session concurrently
  3. Assert each session has exactly its own clips (no cross-session contamination)
  4. Assert no 500 errors in any response
  5. Delete all 3 sessions
- Expected: Sessions are fully isolated; no shared state; no errors
- Priority: P1

---

## Deployment Test Cases (STORY-022 through STORY-026)

### TC-050: Profile-1-cpu.md Contains No Hardcoded Case/Quorra IPs as Requirements
- Story: STORY-022, STORY-023
- Type: Unit (documentation scan)
- Preconditions: `docs/deployment/profile-1-cpu.md` exists
- Steps:
  1. Read `docs/deployment/profile-1-cpu.md`
  2. Assert `192.168.1.122`, `192.168.1.136`, `192.168.1.137`, `192.168.1.138`, `192.168.1.100` do NOT appear outside of clearly-labelled reference callout blocks (lines containing `> `, `Reference Implementation`, `callout`, or `Example:`)
  3. Assert the document contains `<HOST_IP>`, `<PLACEHOLDER>`, or `<YOUR_HOST_IP>` as the canonical placeholder for the host address
- Expected: All IPs appear only in reference callout boxes; `<PLACEHOLDER>` used generically
- Priority: P0

### TC-051: Profile-2-gpu.md Contains No Hardcoded IPs as Requirements
- Story: STORY-022, STORY-024
- Type: Unit (documentation scan)
- Preconditions: `docs/deployment/profile-2-gpu.md` exists
- Steps:
  1. Read `docs/deployment/profile-2-gpu.md`
  2. Assert Quorra-specific IP (`192.168.1.100`) does NOT appear outside of clearly-labelled reference callout blocks
  3. Assert the document contains a `<PLACEHOLDER>` or `<HOST_IP>` variable for the deployment host
  4. Assert the document contains GPU-fallback language: "falls back" or "CPU fallback" (InsightFace graceful degradation)
- Expected: IPs only in reference callouts; GPU fallback documented
- Priority: P0

### TC-052: infrastructure.md Has Deprecation Notice for Profile 3
- Story: STORY-026
- Type: Unit (documentation scan)
- Preconditions: `docs/infrastructure.md` exists
- Steps:
  1. Read the first 20 lines of `docs/infrastructure.md`
  2. Assert text contains "DEPRECATED" (case-insensitive) within the first 20 lines
  3. Assert text contains "Profile 3" within the first 20 lines
  4. Assert text directs readers to `profile-1-cpu.md` and `profile-2-gpu.md`
- Expected: Deprecation notice present at top of file; canonical profiles referenced
- Priority: P0

### TC-053: CPU-Only Profile — docker compose up Starts All Services
- Story: STORY-023, STORY-025
- Type: Integration (Docker Compose)
- Preconditions: Docker Engine 24+; `docker-compose.yml` at repo root; `.env` from `.env.example`
- Steps:
  1. Copy `.env.example` to `.env`; fill placeholders with test values
  2. Run `docker compose up -d` — assert exit code 0
  3. Wait up to 60 seconds for all containers to report healthy
  4. Run `docker compose ps` — assert all services are `Up (healthy)` or `Up`
  5. GET `http://localhost:3001/health` — assert HTTP 200 with `{"status":"ok"}`
  6. GET `http://localhost:8000/health` — assert HTTP 200 with `{"status":"ok","service":"hypereels-python-worker"}`
  7. Run `docker compose down -v`
- Expected: All services start healthy within 60 seconds; health endpoints return 200
- Priority: P0

### TC-054: CPU-Only Profile — InsightFace Worker Starts Without GPU
- Story: STORY-023
- Type: Integration (Docker Compose)
- Preconditions: `docker-compose.yml` CPU-only profile; no GPU on host or GPU passthrough disabled
- Steps:
  1. Start stack with `docker compose up -d`
  2. GET `http://localhost:8000/health` — assert 200
  3. Check worker container logs: assert line containing "CPUExecutionProvider" or "CPU mode"
  4. Assert NO log line contains "CUDA" or "GPU detected" as an active mode
- Expected: Worker starts in CPU-only mode; CUDA not used
- Priority: P0

### TC-055: GPU-Enabled Profile — InsightFace Falls Back to CPU When No GPU
- Story: STORY-024
- Type: Integration (Docker Compose — simulated no-GPU)
- Preconditions: `docker-compose.gpu.yml` or GPU-enabled compose file; no NVIDIA runtime on test host
- Steps:
  1. Start GPU-enabled stack without NVIDIA runtime (remove `deploy.resources` or run on CPU-only host)
  2. Assert worker starts without crashing (exit code 0)
  3. GET `http://localhost:8000/health` — assert 200
  4. Check worker logs: assert fallback warning "GPU not available — falling back to CPU inference"
- Expected: Graceful CPU fallback; worker does NOT crash; logs warning
- Priority: P0

### TC-056: Smoke Test Script Exits 0 When All Services Pass
- Story: STORY-025
- Type: Integration (smoke test)
- Preconditions: Full stack running (from TC-053 or equivalent); `scripts/smoke-test.sh` exists
- Steps:
  1. Run `bash scripts/smoke-test.sh <HOST_IP>` against a running stack
  2. Assert exit code 0
  3. Assert stdout contains "All systems operational"
  4. Assert each of the following services is reported as PASS: API /health, Python worker /health, Redis PING, PostgreSQL SELECT 1, MinIO /minio/health/live, MinIO bucket 'hypereels' exists
- Expected: All 6 checks pass; exit code 0; "All systems operational" in output
- Priority: P0

### TC-057: Smoke Test Script Exits Non-Zero and Reports Failed Service
- Story: STORY-025
- Type: Integration (smoke test)
- Preconditions: Stack running but PostgreSQL container stopped
- Steps:
  1. Stop the PostgreSQL container: `docker compose stop postgres`
  2. Run `bash scripts/smoke-test.sh <HOST_IP>`
  3. Assert exit code non-zero
  4. Assert stdout contains a human-readable error identifying PostgreSQL as the failed service
  5. Restart PostgreSQL: `docker compose start postgres`
- Expected: Non-zero exit; clear error message naming the failed service
- Priority: P0

### TC-058: Profile 3 (Split-System) Not Promoted Anywhere Active
- Story: STORY-026
- Type: Unit (documentation scan)
- Preconditions: None
- Steps:
  1. Read `docs/infrastructure.md` — assert first line or block contains "DEPRECATED"
  2. Read `docs/user-stories.md` — locate STORY-020; assert it contains "Superseded by STORY-023"
  3. Search `docs/deployment/profile-1-cpu.md` and `docs/deployment/profile-2-gpu.md` for "Profile 3" — assert no occurrence that presents it as an active deployment path
  4. Search README.md for any mention of "split-system" as an active path
- Expected: Profile 3 only exists under deprecation/history notices; no active docs promote it
- Priority: P0

### TC-059: .env Template Has PLACEHOLDER Markers and Password Generation Instructions
- Story: STORY-025
- Type: Unit (documentation scan)
- Preconditions: `.env.example` exists at repo root
- Steps:
  1. Read `.env.example`
  2. Assert every variable that requires a secret value has `<PLACEHOLDER>` or `CHANGE_ME` as its default
  3. Assert a comment exists explaining how to generate strong passwords (e.g., `openssl rand -base64 32`)
  4. Assert no real credentials appear in the file
- Expected: All secrets have placeholder values; password generation instructions present
- Priority: P0

### TC-060: Startup from Restart — Services Auto-Restart
- Story: STORY-023, STORY-024
- Type: Integration (Docker Compose)
- Preconditions: Full stack running
- Steps:
  1. Run `docker compose restart` (restart all services)
  2. Wait up to 60 seconds
  3. Assert all containers return to healthy state
  4. GET `http://localhost:3001/health` — assert 200
  5. Assert no container exited with a non-zero code
- Expected: All services recover after restart; health endpoints respond
- Priority: P1

---

## 4. Coverage

| Story | Title | TC(s) | Status |
|-------|-------|-------|--------|
| STORY-001 | Create anonymous session | TC-001, TC-002, TC-003 | Covered |
| STORY-002 | Upload video clips | TC-005, TC-007, TC-007b, TC-008, TC-034, TC-035, TC-036 | Covered |
| STORY-003 | Validate clip format/size | TC-006, TC-007, TC-007b | Covered |
| STORY-004 | View clip list with thumbnails | TC-005 (202+schema) | Partial — clip list schema test needed |
| STORY-005 | Upload audio track | TC-010 | Covered |
| STORY-006 | Validate audio + trigger analysis | TC-010, TC-011, TC-040 | Covered |
| STORY-007 | Trigger person detection | TC-012, TC-013, TC-014, TC-037, TC-038, TC-039 | Covered |
| STORY-008 | Select person of interest | TC-015, TC-044 | Covered |
| STORY-009 | Handle no persons detected | TC-016 | Covered |
| STORY-010 | Mark highlight segments | TC-017, TC-018, TC-019, TC-019b | Covered |
| STORY-011 | Enforce highlight duration constraints | TC-022, TC-024, TC-042, TC-043 | Covered |
| STORY-012 | Review and edit highlights | TC-020, TC-021 | Covered |
| STORY-013 | Submit generation job + progress | TC-020, TC-022, TC-023, TC-024, TC-025, TC-026, TC-031, TC-041, TC-044, TC-045 | Covered |
| STORY-014 | Display status on tab return | TC-027 | Covered |
| STORY-015 | Download completed HypeReel | TC-032, TC-046, TC-047 | Covered |
| STORY-016 | Permanently delete session assets | TC-004, TC-009, TC-028, TC-029, TC-030, TC-048 | Covered |
| STORY-017 | Global error boundary | Manual E2E | Manual only — no automated test (requires Playwright) |
| STORY-018 | Prevent simultaneous sessions | TC-049 (API side) | Partial — BroadcastChannel UI is manual-only |
| STORY-019 | Step navigation indicator | Manual E2E | Manual only — frontend UI, no automated test |
| STORY-020 | Deploy full stack (Case/Quorra reference) | TC-053, TC-056 | Covered (profile-agnostic tests apply) |
| STORY-021 | InsightFace CPU monitoring | TC-013, TC-054 | Covered |
| STORY-022 | Publish hardware requirements for self-hosters | TC-050, TC-051 | Covered |
| STORY-023 | Deploy CPU-only on single machine | TC-053, TC-054, TC-060, TC-050 | Covered |
| STORY-024 | Deploy GPU-enabled on single machine | TC-055, TC-051, TC-060 | Covered |
| STORY-025 | Near-single-command deploy with health-check | TC-056, TC-057, TC-059 | Covered |
| STORY-026 | Retire Profile 3 and consolidate docs | TC-052, TC-058 | Covered |

---

## 5. Defects

### DEFECT-001: r2_client.py Import Name Mismatch
- Failing TC: TC-033
- Story: STORY-002, STORY-006, STORY-007 (all workers)
- Severity: P0
- Responsible agent: @ai-ml-engineer
- Observed: `workers/common/r2_client.py` exists; `person_detection_worker.py` imports `from common.minio_client import ...`; the import fails at runtime with `ModuleNotFoundError: No module named 'common.minio_client'`
- Expected: File renamed to `workers/common/minio_client.py` OR a re-export shim added; all worker imports use `minio_client`
- Reproduction steps:
  1. `cd workers && python -c "from person_detection.person_detection_worker import detect_persons"`
  2. Observe `ModuleNotFoundError: No module named 'common.minio_client'`

### DEFECT-002: session_ttl Tag May Not Be Applied at Upload Time
- Failing TC: TC-009
- Story: STORY-016
- Severity: P1
- Responsible agent: @backend-engineer
- Observed: Architecture specifies objects must be tagged `session_ttl=true` at upload; code review of `server/src/lib/storage.ts` upload path does not confirm tag is set; MinIO ILM safety-net may not activate for orphaned objects
- Expected: All objects uploaded to MinIO carry the `session_ttl=true` tag so the 48-hour ILM policy applies
- Reproduction steps:
  1. Upload a clip via POST `/sessions/:id/clips`
  2. Run `mc tag list local/hypereels uploads/{session_id}/{clip_id}.mp4`
  3. Observe: tag absent

### DEFECT-003: GET /sessions/:id/reel Absent from OpenAPI Spec
- Failing TC: TC-032
- Story: STORY-015
- Severity: P2 (spec gap, implementation exists)
- Responsible agent: @backend-engineer
- Observed: `GET /sessions/:id/reel` is implemented in `server/src/routes/download.ts` but does not appear in `docs/api-spec.md`
- Expected: Endpoint documented in OpenAPI spec with correct 200/302/401/404/409/410 responses
- Reproduction steps:
  1. Search `docs/api-spec.md` for `/reel` — not found
  2. Check `server/src/routes/download.ts` — endpoint exists

---

## 6. Performance Benchmarks

All benchmarks measured on the profile hardware or CI equivalent.

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| InsightFace CPU inference | ≤ 60 s per clip-minute | Timer wrapping `process_detection_job` for a 1-min synthetic clip |
| Audio analysis (librosa) | ≤ 20 s per 3-min song | Timer wrapping `extract_beats` + `extract_onsets` + `compute_energy_envelope` |
| Assembly + FFmpeg encode | ≤ 5 min for 60 s output reel | Timer wrapping `_run_assembly` with 60 s synthetic reel |
| API p95 response time (non-file) | ≤ 200 ms | `performance.now()`, 100 sequential requests |
| Upload throughput (LAN) | ≥ 50 MB/s | Large file upload timer in integration test |
| Cleanup latency (10 clips) | ≤ 2 s | Timer wrapping `cleanupSession` with mocked fast-delete |
| CPU-only docker compose up | ≤ 5 min to healthy | TC-053 docker compose startup timer |

### Performance Test Locations

- Python benchmarks: `workers/tests/test_performance.py` (planned; not in automation scope for this sprint)
- TypeScript benchmarks: `server/tests/performance/api.bench.ts` (Vitest bench mode; planned)

---

## 7. Edge Cases

### EC-001: Zero Highlights Selected
- Generation with no highlights → EDL uses filler segments only (`source='filler'`)
- Covered by `TestNoHighlights` in `workers/tests/test_algorithm.py`

### EC-002: All Highlights Selected
- Covered by TC-042 and `TestHighlightsExceedSongDuration` in `test_algorithm.py`

### EC-003: Single Clip, Single Person
- Covered by TC-044; single detection-complete event fires immediately

### EC-004: Maximum Clips (10) with Detection
- Ten BullMQ detection jobs queued; BullMQ concurrency=1 for InsightFace (ADR-013)
- Covered by TC-008 (count enforcement)

### EC-005: Empty Audio Track (Silence)
- Covered by `test_silent_audio_does_not_raise` in `workers/tests/test_audio_analysis.py`

### EC-006: Very Short Clip (< 1 Second)
- `sample_frames` on 500ms clip → 0 or 1 frame; must not crash
- Covered by `TestVeryShortSong` in `test_algorithm.py`

### EC-007: Duplicate Tab Session Takeover
- BroadcastChannel coordination is frontend-only; backend only updates `last_activity_at`
- Manual test required for Tab B warning UI

### EC-008: Download Twice After Cleanup
- Covered by TC-047 (second access to expired/deleted URL)

### EC-009: Upload Interrupted Mid-Stream
- Covered by TC-036

### EC-010: Generation Job Timeout
- Covered partially by TC-026 (failure handling path)

### EC-011: MinIO Unavailable During Upload
- Manual test: stop MinIO container, attempt upload; expect 503 or 500 with descriptive error

### EC-012: Redis Unavailable During Job Enqueue
- Manual test: stop Redis; expect 503 with `QUEUE_UNAVAILABLE` error

### EC-013: CPU-Only Deployment — InsightFace Buffalo_l Model Download
- Covered by TC-054 and deployment guide TC-053
- Both online path (auto-download) and offline path (volume-mount) must be documented

---

## 8. Infrastructure / Deployment Tests

| Test | Automated? | TC |
|------|-----------|-----|
| CPU-only `docker compose up -d` → all healthy | Yes | TC-053 |
| CPU-only InsightFace CPU mode confirmed | Yes | TC-054 |
| GPU profile CPU fallback (no GPU host) | Yes | TC-055 |
| Smoke test script passes all checks | Yes | TC-056 |
| Smoke test script reports failed service | Yes | TC-057 |
| Profile 3 deprecation notice in infrastructure.md | Yes | TC-052 |
| Profile 1/2 docs use `<PLACEHOLDER>` not hardcoded IPs | Yes | TC-050, TC-051 |
| .env template has no real credentials | Yes | TC-059 |
| Stack recovers from restart | Yes | TC-060 |
| Profile 3 not promoted in any active docs | Yes | TC-058 |
| NPM proxy host configured | Manual | — |
| Cloudflare tunnel routing (external network) | Manual | — |
| Prometheus scraping API (Grafana/Quorra stack) | Manual | — |
| LXC autostart enabled on Proxmox host | Manual | — |

---

## 9. Signoff Criteria

### P0 Tests Required to Pass Before @devops-engineer Handoff

**Session lifecycle:**
TC-001, TC-002, TC-003, TC-004

**Clip upload and validation:**
TC-005, TC-006, TC-007, TC-007b, TC-008

**Audio upload:**
TC-010, TC-011

**Person detection:**
TC-012, TC-013, TC-015, TC-016, TC-039, TC-040

**Highlights:**
TC-017, TC-018, TC-022, TC-024, TC-043

**Generation:**
TC-020, TC-026, TC-041

**Cleanup:**
TC-028, TC-029, TC-030, TC-048

**Download:**
TC-046

**Deployment (E10):**
TC-050, TC-051, TC-052, TC-053, TC-054, TC-055, TC-056, TC-057, TC-058, TC-059

---

> Passing stories: STORY-001 (partial), STORY-006 (unit tests), STORY-007 (unit tests), STORY-008 (unit tests), STORY-009 (unit tests), STORY-010 (unit tests), STORY-011 (unit tests), STORY-013 (unit tests), STORY-016 (unit tests), STORY-021 (unit tests), STORY-022 (doc scan), STORY-023 (doc scan), STORY-024 (doc scan), STORY-026 (doc scan).
> Open defects: DEFECT-001 (P0 — r2_client.py import mismatch blocks all Python workers at runtime), DEFECT-002 (P1 — session_ttl tag not verified on upload), DEFECT-003 (P2 — /reel endpoint missing from OpenAPI spec).
> Coverage gaps: STORY-004 (clip list schema integration test), STORY-017 (requires Playwright E2E), STORY-018 BroadcastChannel UI (requires Playwright E2E), STORY-019 (requires Playwright E2E).
> P0s BLOCKED — DEFECT-001 (r2_client.py → minio_client.py rename) must be resolved by @ai-ml-engineer before @devops-engineer handoff.
