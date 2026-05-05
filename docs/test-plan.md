# HypeReels — Test Plan

> **Owner:** @qa-engineer
> **Status:** v1.0 — MVP
> **Last updated:** 2026-05-05
> **Against:** docs/user-stories.md (9 stories), docs/api-spec.md (16 endpoints)

---

## 1. Strategy

### Scope

This plan covers all 9 MVP user stories (STORY-001 through STORY-009) and all 16 REST API endpoints defined in `docs/api-spec.md`. Out of scope: post-MVP features (multi-person, Spotify, authentication, persistent storage, preview, custom transitions).

### Objectives

1. Verify every acceptance criterion in `docs/user-stories.md` against actual implementation behavior.
2. Verify every API endpoint returns the exact status codes, response shapes, and error envelopes specified in `docs/api-spec.md`.
3. Verify all async worker jobs (detect-persons, analyze-audio, generate-reel, cleanup-session) complete with correct outputs.
4. Verify session cleanup is exhaustive — no orphaned assets in MinIO or Redis after download or TTL expiry.
5. Verify CPU-only fallback paths are functional on hardware without a GPU.

### Test Levels

| Level | Description | Services used |
|-------|-------------|---------------|
| **Unit** | Isolated component, no real services. All external dependencies mocked. | None |
| **Integration** | Real Redis + MinIO; no mocks. BullMQ worker spawned in test process. | Redis, MinIO |
| **E2E** | Full user flow from browser to MinIO. Uses test browser (Playwright) + full Docker stack. | All (Docker Compose) |
| **Perf** | Throughput/latency/concurrent load. Uses controlled environment. | All |

### Risk Areas

| Risk | Mitigation |
|------|-----------|
| CPU-only path slowness — detection and generation take longer on CPU; hard timeouts cause false failures | All perf targets have CPU-path variance budgets; TC-801/901 use 10-minute timeout cap |
| Face detection confidence variance — InsightFace confidence scores are non-deterministic across identical frames on different hardware | Low-confidence flag tested at known threshold (0.70); fixture clips use synthetic bounding boxes in Python unit tests |
| Browser download behavior — presigned URL behavior varies by browser; `<a download>` triggering is not fully standardized | E2E tests assert the `download_url` field is returned and URL is accessible; actual browser download is out-of-scope for automated E2E |
| MinIO lifecycle policy timing — auto-delete fires at ≤2 hours; belt-and-suspenders depends on MinIO process | Integration tests use application-level cleanup and verify object absence; MinIO lifecycle is tested separately with shortened TTL |
| Redis key expiry races — session reads and TTL expiry can race in integration tests | Integration tests use deterministic TTL override; no shortened-TTL races in unit tests |
| BullMQ job dependency timing — analyze-audio must complete before generate-reel | Integration TC verifies job dependency is honored; unit test for queue module separately |

### Coverage Targets

| Type | Target |
|------|--------|
| Unit — API routes | 100% of route handler branches per api-spec.md |
| Unit — ML scripts | 100% of output contract fields; all code paths |
| Unit — Frontend components | All stories' UI acceptance criteria |
| Integration | All 16 API endpoints, all worker job types |
| E2E | All 5 user-facing flows (upload → detect → highlight → generate → download) |
| Performance | Upload throughput, detection speed, generation speed, concurrency |

---

## 2. Environment

### Dependencies

| Service | Version | Purpose |
|---------|---------|---------|
| Redis | 7-alpine | Session KV + BullMQ queue (integration tests) |
| MinIO | latest | Object storage (integration tests) |
| Node.js | 20 | API route unit tests, integration tests |
| Python | 3.11 | ML script unit tests |
| Docker Compose | v2 | E2E test environment |
| pytest | 8.x | Python ML unit tests |
| Jest | 29.x | Frontend unit + API route tests |
| Playwright | 1.x | E2E tests (future — not in MVP automated suite) |

### Fixture Media

All fixture media is deterministic and minimal:

| Fixture | Size | Duration | Purpose |
|---------|------|----------|---------|
| `fixtures/clip_1s.mp4` | ~50 KB | 1 second | Minimum-length clip; highlight UI disabled |
| `fixtures/clip_5s.mp4` | ~200 KB | 5 seconds | Standard clip for happy-path tests |
| `fixtures/clip_corrupt.mp4` | ~1 KB | N/A | Truncated file for error-path tests |
| `fixtures/audio_4beat.mp3` | ~40 KB | ~2 seconds @ 120 BPM | 4-beat audio for generation minimum test |
| `fixtures/audio_ambient.wav` | ~100 KB | 5 seconds | Flat-amplitude audio; no detectable beats |
| `fixtures/audio_200mb.bin` | 200 MiB | N/A | Exactly at audio size limit |

Note: Fixture video files use synthetic content (solid color frames via FFmpeg); no real human faces appear in test fixtures. InsightFace tests use mocked FaceAnalysis.

### Setup Steps

**Python ML tests:**
```bash
cd workers/scripts
pip install pytest pytest-mock librosa numpy onnxruntime insightface
pytest tests/ -v
```

**API route unit tests:**
```bash
cd frontend
npm install
npm test
```

**Integration tests:**
```bash
docker compose -f docker-compose.test.yml up -d redis minio
cd frontend
REDIS_URL=redis://localhost:6379 MINIO_ENDPOINT=http://localhost:9000 npm run test:integration
```

**E2E tests (manual for MVP):**
```bash
docker compose up
# Navigate to http://localhost:3000 and follow test scripts in docs/e2e-scripts.md
```

### CI Configuration

Tests run in GitHub Actions on every pull request to `main`. The CI job:
1. Starts Redis + MinIO via service containers
2. Installs Python 3.11 + pip dependencies
3. Runs `pytest workers/scripts/tests/ -v`
4. Installs Node.js 20 + npm dependencies
5. Runs `npm test` in `frontend/`
6. Uploads coverage reports

Performance tests run nightly on a dedicated runner — not on PRs (timing is environment-sensitive).

---

## 3. Test Cases

---

### TC-001: POST /api/session — happy path
- Story: STORY-001, STORY-002
- Type: Unit
- Preconditions: Redis mock returns success
- Steps:
  1. POST `/api/session` with no body
  2. Read response
- Expected: HTTP 201; body contains `session_id` as a UUID v4 string; no extra fields
- Priority: P0

---

### TC-002: POST /api/session — Redis failure returns 500
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock throws on `createSession`
- Steps:
  1. POST `/api/session`
- Expected: HTTP 500; body matches `{"error":{"code":"internal_error","message":"Internal server error"}}`
- Priority: P0

---

### TC-003: POST /api/upload/clip — valid MP4 accepted
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session in `uploading` state with 0 clips; MinIO mock returns presigned URL
- Steps:
  1. POST `/api/upload/clip` with `{session_id, filename:"clip.mp4", content_type:"video/mp4", size_bytes:1048576}`
- Expected: HTTP 201; body contains `clip_id` (UUID), `upload_url` (non-empty string), `object_key` matching pattern `{session_id}/clips/{clip_id}.mp4`
- Priority: P0

---

### TC-004: POST /api/upload/clip — AVI rejected (422)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns valid session
- Steps:
  1. POST `/api/upload/clip` with `{session_id, filename:"clip.avi", content_type:"video/x-msvideo", size_bytes:1000}`
- Expected: HTTP 422; body contains `error.code="unsupported_format"`, `error.message` contains "MP4, MOV, MKV, WebM" and "clip.avi"
- Priority: P0

---

### TC-005: POST /api/upload/clip — file exceeds 2 GiB (422)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns valid session
- Steps:
  1. POST `/api/upload/clip` with `{session_id, filename:"big.mp4", content_type:"video/mp4", size_bytes:2147483649}`
- Expected: HTTP 422; body contains `error.code="file_too_large"`, `error.message` contains "2 GB", `error.details.filename="big.mp4"`
- Priority: P0

---

### TC-006: POST /api/upload/clip — 11th clip rejected (409)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session with 10 existing clips (all in ready state)
- Steps:
  1. POST `/api/upload/clip` with valid body
- Expected: HTTP 409; body contains `error.code="max_clips_exceeded"`, `error.message="Maximum 10 clips per session"`, `error.details.current_count=10`
- Priority: P0

---

### TC-007: POST /api/upload/clip — duplicate filename+size returns 409
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session with an existing clip named "clip.mp4" at 1048576 bytes
- Steps:
  1. POST `/api/upload/clip` with same filename + size_bytes
- Expected: HTTP 409; body contains `error.code="duplicate_clip"`, `error.details.existing_clip_id` matches the pre-existing clip's UUID
- Priority: P1

---

### TC-008: POST /api/upload/clip — expired session (410)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session with `state="expired"` OR `created_at` older than TTL
- Steps:
  1. POST `/api/upload/clip` with valid body
- Expected: HTTP 410; body matches `{"error":{"code":"session_expired","message":"Session has expired. All files have been deleted."}}`
- Priority: P0

---

### TC-009: POST /api/upload/clip — missing session (404)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns null for session lookup
- Steps:
  1. POST `/api/upload/clip` with `{session_id:"nonexistent-uuid", ...valid fields}`
- Expected: HTTP 404; body contains `error.code="session_not_found"`
- Priority: P0

---

### TC-010: POST /api/upload/audio — valid MP3 accepted
- Story: STORY-002
- Type: Unit
- Preconditions: Redis mock returns session in `uploading` state; MinIO mock returns presigned URL
- Steps:
  1. POST `/api/upload/audio` with `{session_id, filename:"song.mp3", content_type:"audio/mpeg", size_bytes:5242880}`
- Expected: HTTP 201; body contains `audio_id` (UUID), `upload_url`, `object_key` matching `{session_id}/audio.mp3`
- Priority: P0

---

### TC-011: POST /api/upload/audio — OGG rejected (422)
- Story: STORY-002
- Type: Unit
- Preconditions: Redis mock returns valid session
- Steps:
  1. POST `/api/upload/audio` with `{session_id, filename:"song.ogg", content_type:"audio/ogg", size_bytes:1000}`
- Expected: HTTP 422; `error.code="unsupported_format"`, message includes "MP3, WAV, AAC, FLAC, M4A"
- Priority: P0

---

### TC-012: POST /api/upload/audio — exceeds 200 MiB (422)
- Story: STORY-002
- Type: Unit
- Preconditions: Redis mock returns valid session
- Steps:
  1. POST `/api/upload/audio` with `size_bytes: 209715201` (200 MiB + 1 byte)
- Expected: HTTP 422; `error.code="file_too_large"`, message contains "200 MB", `error.details.filename` present
- Priority: P0

---

### TC-013: POST /api/upload/audio — replaces existing audio (idempotent)
- Story: STORY-002
- Type: Unit
- Preconditions: Redis mock returns session with an existing audio track
- Steps:
  1. POST `/api/upload/audio` with new valid audio file metadata
- Expected: HTTP 201; new `audio_id` returned; no error about existing audio
- Priority: P1

---

### TC-014: POST /api/upload/clip/[clip_id]/complete — marks clip ready, enqueues thumbnail job
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session with clip in `uploading` state; queue mock succeeds
- Steps:
  1. POST `/api/upload/clip/{clip_id}/complete` with `{session_id, object_key}`
- Expected: HTTP 200; body contains `clip_id` and `job_id`; `updateClipInSession` called with `{status:"ready"}`; `enqueueThumbnailExtract` called once
- Priority: P0

---

### TC-015: POST /api/upload/clip/[clip_id]/complete — already complete (409)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session with clip in `ready` state
- Steps:
  1. POST complete endpoint
- Expected: HTTP 409; `error.code="already_complete"`
- Priority: P1

---

### TC-016: POST /api/jobs/detect-persons — happy path (202)
- Story: STORY-003
- Type: Unit
- Preconditions: Redis mock returns session with one clip in `ready` state and `state="uploading"`
- Steps:
  1. POST `/api/jobs/detect-persons` with `{session_id}`
- Expected: HTTP 202; body contains `job_id` (non-empty string); `updateSessionState` called with `"detecting"`; `setJobProgress` called with `status:"queued"`
- Priority: P0

---

### TC-017: POST /api/jobs/detect-persons — no ready clips (409)
- Story: STORY-003
- Type: Unit
- Preconditions: Redis mock returns session with zero clips OR all clips in `uploading` state
- Steps:
  1. POST `/api/jobs/detect-persons`
- Expected: HTTP 409; `error.code="no_ready_clips"`, `error.details.clip_count=0`
- Priority: P0

---

### TC-018: POST /api/jobs/detect-persons — already detecting (409)
- Story: STORY-003
- Type: Unit
- Preconditions: Redis mock returns session with `state="detecting"` and one ready clip
- Steps:
  1. POST `/api/jobs/detect-persons`
- Expected: HTTP 409; `error.code="detection_in_progress"`
- Priority: P1

---

### TC-019: GET /api/session/[id]/persons — returns person array
- Story: STORY-003, STORY-004
- Type: Unit
- Preconditions: Redis mock returns valid session and persons array with one person at confidence 0.94
- Steps:
  1. GET `/api/session/{id}/persons`
- Expected: HTTP 200; `persons` array length 1; person object has `person_id`, `bbox` (4-element array), `thumbnail`, `confidence=0.94`, `appearances` array
- Priority: P0

---

### TC-020: GET /api/session/[id]/persons — returns empty array before detection
- Story: STORY-003
- Type: Unit
- Preconditions: Redis mock returns valid session; `getPersons` returns empty array
- Steps:
  1. GET `/api/session/{id}/persons`
- Expected: HTTP 200; `{"persons":[]}`
- Priority: P0

---

### TC-021: GET /api/session/[id]/persons — expired session (410)
- Story: STORY-003
- Type: Unit
- Preconditions: Redis mock returns session with `state="expired"`
- Steps:
  1. GET `/api/session/{id}/persons`
- Expected: HTTP 410; `error.code="session_expired"`
- Priority: P0

---

### TC-022: PATCH highlights — valid range appended
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip (duration_ms=60000, no existing highlights)
- Steps:
  1. PATCH `/api/session/{id}/clips/{clip_id}/highlights` with `{start_ms:5000, end_ms:15000}`
- Expected: HTTP 200; body contains `highlight` with `highlight_id` (UUID), `start_ms=5000`, `end_ms=15000`; `addHighlightToClip` called once
- Priority: P0

---

### TC-023: PATCH highlights — duration < 1000ms rejected (422)
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip in ready state
- Steps:
  1. PATCH highlights with `{start_ms:5000, end_ms:5500}` (duration=500ms)
- Expected: HTTP 422; `error.code="invalid_range"`, message contains "1 second" or "1000ms", `error.details.duration_ms=500`
- Priority: P0

---

### TC-024: PATCH highlights — overlapping range rejected (422)
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip having existing highlight `{start_ms:10000, end_ms:20000}`
- Steps:
  1. PATCH highlights with `{start_ms:15000, end_ms:25000}` (overlaps existing)
- Expected: HTTP 422; `error.code="highlight_overlap"`; `error.details.conflicting_highlight.start_ms=10000`; `error.details.new_range.start_ms=15000`
- Priority: P0

---

### TC-025: PATCH highlights — end_ms exceeds clip duration (422)
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip `duration_ms=60000`
- Steps:
  1. PATCH highlights with `{start_ms:55000, end_ms:70000}`
- Expected: HTTP 422; `error.code="invalid_range"`, message contains "clip duration", `error.details.clip_duration_ms=60000`
- Priority: P0

---

### TC-026: PATCH highlights — start_ms=0 accepted
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip; no existing highlights
- Steps:
  1. PATCH highlights with `{start_ms:0, end_ms:5000}`
- Expected: HTTP 200; highlight appended; `start_ms=0`
- Priority: P1

---

### TC-027: DELETE highlights — removes existing highlight
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip having one highlight with known `highlight_id`
- Steps:
  1. DELETE `/api/session/{id}/clips/{clip_id}/highlights/{highlight_id}`
- Expected: HTTP 204; no body; `removeHighlightFromClip` called with correct IDs
- Priority: P1

---

### TC-028: DELETE highlights — missing highlight returns 404
- Story: STORY-005
- Type: Unit
- Preconditions: Redis mock returns session with clip having no highlights
- Steps:
  1. DELETE highlights with a nonexistent highlight_id
- Expected: HTTP 404
- Priority: P1

---

### TC-029: POST /api/jobs/generate-reel — happy path (202)
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns session with one ready clip, audio present, state=`uploading`
- Steps:
  1. POST `/api/jobs/generate-reel` with `{session_id}`
- Expected: HTTP 202; body contains `job_id` and `analyze_audio_job_id` (both non-empty strings); `updateSessionState` called with `"generating"`; both job progress entries initialized to `queued`
- Priority: P0

---

### TC-030: POST /api/jobs/generate-reel — no audio (409)
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns session with one ready clip but `audio=null`
- Steps:
  1. POST `/api/jobs/generate-reel`
- Expected: HTTP 409; `error.code="no_audio"`, message contains "audio track"
- Priority: P0

---

### TC-031: POST /api/jobs/generate-reel — no ready clips (409)
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns session with audio but zero ready clips
- Steps:
  1. POST `/api/jobs/generate-reel`
- Expected: HTTP 409; `error.code="no_ready_clips"`
- Priority: P0

---

### TC-032: POST /api/jobs/generate-reel — already generating (409)
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns session with `state="generating"`, one ready clip, audio present
- Steps:
  1. POST `/api/jobs/generate-reel`
- Expected: HTTP 409; `error.code="generation_in_progress"`
- Priority: P1

---

### TC-033: POST /api/jobs/generate-reel — reel already ready (409)
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns session with `state="ready"`, one ready clip, audio present
- Steps:
  1. POST `/api/jobs/generate-reel`
- Expected: HTTP 409; `error.code="reel_already_ready"`
- Priority: P1

---

### TC-034: GET /api/download/[session_id] — returns download_url when ready
- Story: STORY-007
- Type: Unit
- Preconditions: Redis mock returns session with `state="ready"` and valid `reel_key`; MinIO mock returns presigned GET URL; queue mock succeeds for cleanup
- Steps:
  1. GET `/api/download/{session_id}`
- Expected: HTTP 200; body contains `download_url` (non-empty string); cleanup job enqueued (fire-and-forget)
- Priority: P0

---

### TC-035: GET /api/download/[session_id] — state not ready (409)
- Story: STORY-007
- Type: Unit
- Preconditions: Redis mock returns session with `state="generating"`
- Steps:
  1. GET `/api/download/{session_id}`
- Expected: HTTP 409; `error.code="reel_not_ready"`, `error.details.state="generating"`
- Priority: P0

---

### TC-036: GET /api/download/[session_id] — expired session (410)
- Story: STORY-007
- Type: Unit
- Preconditions: Redis mock returns session with `state="expired"`
- Steps:
  1. GET `/api/download/{session_id}`
- Expected: HTTP 410; `error.code="session_expired"`
- Priority: P0

---

### TC-037: GET /api/download/[session_id] — missing session (404)
- Story: STORY-007
- Type: Unit
- Preconditions: Redis mock returns null for session lookup
- Steps:
  1. GET `/api/download/{session_id}`
- Expected: HTTP 404; `error.code="session_not_found"`
- Priority: P0

---

### TC-038: GET /api/jobs/[job_id]/progress — returns progress object
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns progress with `{status:"processing", stage:"Analyzing clips", pct:45, message:"...", updated_at:...}`
- Steps:
  1. GET `/api/jobs/{job_id}/progress`
- Expected: HTTP 200; body contains `job_id`, `status`, `stage`, `pct` (integer 0-100), `message`, `updated_at`
- Priority: P0

---

### TC-039: GET /api/jobs/[job_id]/progress — job not found (404)
- Story: STORY-006
- Type: Unit
- Preconditions: Redis mock returns null for progress key
- Steps:
  1. GET `/api/jobs/nonexistent-job-id/progress`
- Expected: HTTP 404
- Priority: P1

---

### TC-040: POST /api/session/[id]/person — set person of interest
- Story: STORY-004
- Type: Unit
- Preconditions: Redis mock returns valid session; person_id is a valid UUID
- Steps:
  1. POST `/api/session/{id}/person` with `{person_id:"uuid-of-person"}`
- Expected: HTTP 200; body `{"person_id":"uuid-of-person"}`
- Priority: P0

---

### TC-041: POST /api/session/[id]/person — clear person selection (null)
- Story: STORY-004
- Type: Unit
- Preconditions: Redis mock returns session with an existing person_id
- Steps:
  1. POST `/api/session/{id}/person` with `{person_id:null}`
- Expected: HTTP 200; body `{"person_id":null}`
- Priority: P1

---

### TC-042: GET /api/health — all services healthy
- Story: STORY-008
- Type: Unit
- Preconditions: Redis mock reports connected; MinIO mock reports healthy
- Steps:
  1. GET `/api/health`
- Expected: HTTP 200; `{"status":"ok","queue":"connected","storage":"connected"}`
- Priority: P0

---

### TC-043: analyze_audio.py — BPM extraction output contract
- Story: STORY-006
- Type: Unit
- Preconditions: librosa.beat.beat_track mocked to return (120.0, [0, 500, 1000, 1500, 2000, 2500, 3000, 3500])
- Steps:
  1. Import and invoke `analyze_audio` with a mocked audio path
  2. Capture stdout JSON
- Expected: Output is valid JSON; contains `bpm` (float > 0), `beats` (array of integers in ms), `onsets` (array of integers), `phrases` (array of `{start_ms, end_ms}` objects); all keys present per architecture §3.3 contract
- Priority: P0

---

### TC-044: analyze_audio.py — ambient audio fallback (beat_sync_unavailable)
- Story: STORY-006
- Type: Unit
- Preconditions: librosa.beat.beat_track mocked to return empty beat frames (no beats detected)
- Steps:
  1. Invoke `analyze_audio` with mocked flat-amplitude audio
- Expected: `beats` array is empty; script exits with code 0 (not an error); downstream caller handles empty beats by falling back to fixed-interval cuts per api-spec.md note 6
- Priority: P0

---

### TC-045: analyze_audio.py — beat timestamps are in milliseconds
- Story: STORY-006
- Type: Unit
- Preconditions: librosa mocked to return beat frames at [0, 22050, 44100] with sample_rate=44100
- Steps:
  1. Invoke `analyze_audio`
- Expected: `beats` array contains [0, 1000, 2000] (frames converted to ms via `frames / sr * 1000`)
- Priority: P0

---

### TC-046: analyze_audio.py — phrase detection output
- Story: STORY-006
- Type: Unit
- Preconditions: librosa onset/beat data mocked to produce phrase boundaries at 0ms and 8000ms
- Steps:
  1. Invoke `analyze_audio`
- Expected: `phrases` array contains at least one element; each element has `start_ms` and `end_ms` (both integers >= 0, end > start)
- Priority: P1

---

### TC-047: detect_persons.py — output contract shape validation
- Story: STORY-003
- Type: Unit
- Preconditions: InsightFace FaceAnalysis mocked to return one face with bbox=[10,20,80,100], det_score=0.92, face crop saved as JPEG
- Steps:
  1. Invoke `detect_persons` with mocked video path, session_id, clip_id, output_dir
- Expected: Output JSON is an array; each element has `person_id` (UUID string), `bbox` (4-element array), `thumbnail` (string path), `confidence` (float 0-1), `appearances` (array of `{clip_id, timestamp_ms}`)
- Priority: P0

---

### TC-048: detect_persons.py — no persons case returns empty array
- Story: STORY-003
- Type: Unit
- Preconditions: InsightFace FaceAnalysis mocked to return empty faces list for all sampled frames
- Steps:
  1. Invoke `detect_persons` with mocked video
- Expected: Output JSON is `[]`; exit code 0
- Priority: P0

---

### TC-049: detect_persons.py — low-confidence detection flagged
- Story: STORY-003
- Type: Unit
- Preconditions: InsightFace FaceAnalysis mocked to return one face with `det_score=0.55`
- Steps:
  1. Invoke `detect_persons`
- Expected: Output contains one person with `confidence=0.55`; `confidence` is below the 0.70 threshold; script does not filter it out (filtering is UI responsibility); exit code 0
- Priority: P0

---

### TC-050: detect_persons.py — CPUExecutionProvider selected when CUDA unavailable
- Story: STORY-009
- Type: Unit
- Preconditions: `INSIGHTFACE_PROVIDERS` env var set to `CPUExecutionProvider`; `onnxruntime.get_available_providers()` mocked to return `["CPUExecutionProvider"]`
- Steps:
  1. Invoke `detect_persons` in CPU-only environment
- Expected: Script does not crash; InsightFace initialized with `providers=["CPUExecutionProvider"]`; any output is valid JSON
- Priority: P0

---

### TC-051: detect_persons.py — clip shorter than 1 second handled
- Story: STORY-005
- Type: Unit
- Preconditions: cv2.VideoCapture mocked to report total_frames=20, fps=30 (≈0.67 seconds)
- Steps:
  1. Invoke `detect_persons` with sub-second clip
- Expected: Script exits with code 0; output may be `[]` (insufficient frames to sample); no crash
- Priority: P1

---

### TC-052: Frontend — DropZone rejects files beyond 10-clip limit
- Story: STORY-001
- Type: Unit
- Preconditions: Upload page rendered with `currentClipCount=10`
- Steps:
  1. Simulate drop of one additional MP4 file
- Expected: Error message contains "Maximum 10 clips per session"; `onFiles` callback not invoked with the new file
- Priority: P0

---

### TC-053: Frontend — DropZone shows error for unsupported format
- Story: STORY-001
- Type: Unit
- Preconditions: Upload page rendered with `currentClipCount=0`
- Steps:
  1. Simulate drop of a `.avi` file
- Expected: Error message contains "Unsupported format" and "clip.avi" (or the filename) and accepted formats; upload does not proceed
- Priority: P0

---

### TC-054: Frontend — DropZone shows error for file exceeding 2 GB
- Story: STORY-001
- Type: Unit
- Preconditions: Upload page rendered with `currentClipCount=0`
- Steps:
  1. Simulate selection of file with `size = 2147483649` bytes
- Expected: Error message contains file name and "2 GB limit"; upload does not proceed
- Priority: P0

---

### TC-055: Frontend — person selection loading state
- Story: STORY-003
- Type: Unit
- Preconditions: PersonSelectionPage rendered with `detectionStatus="running"`
- Steps:
  1. Render component
- Expected: Loading indicator with text matching "Analyzing clips for people" is visible; person grid is not shown
- Priority: P0

---

### TC-056: Frontend — person selection empty state
- Story: STORY-003
- Type: Unit
- Preconditions: PersonSelectionPage rendered with `persons=[]`, `detectionStatus="complete"`
- Steps:
  1. Render component
- Expected: Empty state message visible containing "No people detected"; "Skip" or equivalent no-person action is available; no error state shown
- Priority: P0

---

### TC-057: Frontend — highlight minimum 1-second validation (component)
- Story: STORY-005
- Type: Unit (already covered by TC in AddHighlightForm.test.tsx — verified existing coverage)
- Preconditions: AddHighlightForm rendered with `clipDurationMs=60000`
- Steps:
  1. Set start=5s, end=5.5s; click Add
- Expected: Error role=alert contains "1 second"; `onAdd` not called
- Priority: P0
- Note: Covered by existing test in `frontend/src/components/highlights/__tests__/AddHighlightForm.test.tsx`

---

### TC-058: Frontend — highlight overlap rejection (component)
- Story: STORY-005
- Type: Unit
- Note: Covered by existing test in `frontend/src/components/highlights/__tests__/AddHighlightForm.test.tsx`
- Priority: P0

---

### TC-059: Frontend — ephemeral warning shown before download
- Story: STORY-007
- Type: Unit
- Preconditions: DownloadPage rendered with `reelReady=true`
- Steps:
  1. Render component
- Expected: Warning text visible before the download button; warning contains language about permanent deletion; download button is present
- Priority: P0

---

### TC-060: Frontend — session-expired state shown on download page
- Story: STORY-007
- Type: Unit
- Preconditions: DownloadPage receives `sessionExpired=true` prop OR API returns 410
- Steps:
  1. Render or trigger 410 state
- Expected: Expiry message visible containing "session has expired" or "All files have been deleted"; download button not present
- Priority: P0

---

### TC-061: GET /api/session/[id] — returns full session state
- Story: STORY-001, STORY-002
- Type: Unit
- Preconditions: Redis mock returns complete session object with clips, audio, persons
- Steps:
  1. GET `/api/session/{id}`
- Expected: HTTP 200; response body contains all session fields: `id`, `state`, `created_at`, `clips` (array), `audio` (object or null), `person_id` (string or null), `reel_key`, `error`, `persons` (array)
- Priority: P0

---

### TC-062: GET /api/session/[id] — missing session (404)
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns null
- Steps:
  1. GET `/api/session/nonexistent-id`
- Expected: HTTP 404; `error.code="session_not_found"`
- Priority: P0

---

### TC-063: Error envelope — all errors use standard shape
- Story: All
- Type: Unit
- Preconditions: API routes configured with error helpers
- Steps:
  1. Trigger each error type (404, 409, 410, 422, 500) across any endpoint
- Expected: All error responses match schema `{"error":{"code":"string","message":"string","details":...}}`. No raw status code strings in message fields.
- Priority: P0

---

### TC-064: Concurrent sessions — no shared state
- Story: STORY-001
- Type: Integration
- Preconditions: Redis running; two sessions created
- Steps:
  1. Create session A; upload a clip to A
  2. Create session B; upload a clip to B
  3. GET session A; GET session B
- Expected: Session A contains only its own clips; session B contains only its own clips; no cross-contamination
- Priority: P0

---

### TC-065: Session cleanup — all assets deleted within 60 seconds of download
- Story: STORY-007
- Type: Integration
- Preconditions: Real Redis + MinIO; full session in `ready` state with reel.mp4 present
- Steps:
  1. GET `/api/download/{session_id}`
  2. Wait 65 seconds
  3. Attempt to list MinIO objects under `{session_id}/`
  4. Attempt to GET session from Redis
- Expected: MinIO object list is empty; Redis session key does not exist; download URL issued in step 1 returns 404 or 403 (presigned URL expired)
- Priority: P0

---

### TC-066: CPU-only detection — InsightFace CPUExecutionProvider completes without error
- Story: STORY-009
- Type: Unit
- Preconditions: `INSIGHTFACE_PROVIDERS=CPUExecutionProvider`; InsightFace mocked to simulate CPU path
- Steps:
  1. Run detect_persons.py with CPUExecutionProvider forced
- Expected: Script exits code 0; output is valid JSON array; no CUDA-related error in stderr
- Priority: P0

---

### TC-067: CPU-only generation — FFmpeg x264 produces valid MP4
- Story: STORY-009
- Type: Integration
- Preconditions: FFmpeg installed without NVENC; `FFMPEG_HWACCEL` unset
- Steps:
  1. Invoke reel assembly worker with x264 encoder path
  2. Verify output file
- Expected: Output file is valid MP4 container; codec is `libx264`; file size > 0
- Priority: P0

---

### TC-068: NVENC fallback — invalid NVENC request falls back to x264 with warning log
- Story: STORY-008, STORY-009
- Type: Integration
- Preconditions: `FFMPEG_HWACCEL=nvenc` set; no NVIDIA GPU present on test machine
- Steps:
  1. Invoke reel assembly worker
  2. Capture worker log output
- Expected: Worker log contains "NVENC requested but no CUDA device found — falling back to x264"; output MP4 is still produced successfully using x264
- Priority: P0

---

### TC-069: Docker Compose health check — all services healthy within 60 seconds
- Story: STORY-008
- Type: E2E
- Preconditions: Docker Compose stack starts on CPU-only machine
- Steps:
  1. `docker compose up -d`
  2. Wait up to 60 seconds
  3. GET `/api/health`
- Expected: HTTP 200; `{"status":"ok","queue":"connected","storage":"connected"}`
- Priority: P0

---

### TC-070: Session TTL — assets auto-deleted after 2 hours
- Story: STORY-007
- Type: Integration
- Preconditions: Real Redis + MinIO; shortened TTL override for test (`SESSION_TTL_SECONDS=5`)
- Steps:
  1. Create session, upload clip, mark as ready
  2. Wait 10 seconds (2× TTL)
  3. GET `/api/session/{id}`
  4. List MinIO objects under `{session_id}/`
- Expected: GET session returns 404 or 410; MinIO object list is empty (Redis auto-expiry confirmed by 404; MinIO lifecycle or cleanup confirmed by empty list)
- Priority: P0

---

### TC-071: POST /api/upload/audio/complete — marks audio ready
- Story: STORY-002
- Type: Unit
- Preconditions: Redis mock returns session with audio in pending state
- Steps:
  1. POST `/api/upload/audio/complete` with `{session_id, audio_id}`
- Expected: HTTP 200; body contains `{"audio_id": "uuid"}`
- Priority: P0

---

### TC-072: DELETE /api/upload/clip/[clip_id] — removes clip from session
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session with the specified clip
- Steps:
  1. DELETE `/api/upload/clip/{clip_id}` with `{session_id}` in body
- Expected: HTTP 204; no body
- Priority: P1

---

### TC-073: DELETE /api/upload/clip/[clip_id] — missing clip returns 404
- Story: STORY-001
- Type: Unit
- Preconditions: Redis mock returns session without the specified clip_id
- Steps:
  1. DELETE `/api/upload/clip/nonexistent-clip-id`
- Expected: HTTP 404
- Priority: P1

---

### TC-074: Perf — upload throughput
- Story: STORY-001, STORY-002
- Type: Perf
- Preconditions: Local MinIO instance; test client on same machine as server
- Steps:
  1. Issue 10 concurrent presigned PUT URL requests
  2. Upload 100 MB clip to each presigned URL
- Expected: All uploads complete; average throughput >= 50 MB/s; no 5xx errors
- Priority: P2

---

### TC-075: Perf — person detection speed
- Story: STORY-003
- Type: Perf
- Preconditions: CPU-only machine; 5-second test clip
- Steps:
  1. POST detect-persons job for one 5-second clip
  2. Poll until completion
- Expected: Job completes within 10 minutes (architecture timeout); no timeout error raised
- Priority: P2

---

### TC-076: Perf — concurrent sessions
- Story: STORY-008
- Type: Perf
- Preconditions: Docker Compose stack on test machine
- Steps:
  1. Create 5 concurrent sessions simultaneously
  2. Each session uploads one clip and requests person detection
- Expected: All 5 detection jobs enqueue successfully; no cross-session contamination; all jobs complete (may queue sequentially)
- Priority: P2

---

## 4. Coverage

| Story | Title | TC(s) | Status |
|-------|-------|-------|--------|
| STORY-001 | Upload Video Clips | TC-001, TC-003, TC-004, TC-005, TC-006, TC-007, TC-008, TC-009, TC-014, TC-015, TC-052, TC-053, TC-054, TC-061, TC-062, TC-064, TC-072, TC-073, TC-074 | Green |
| STORY-002 | Upload Audio Track | TC-001, TC-010, TC-011, TC-012, TC-013, TC-061, TC-071, TC-074 | Green |
| STORY-003 | Detect People in Clips | TC-016, TC-017, TC-018, TC-019, TC-020, TC-021, TC-047, TC-048, TC-049, TC-050, TC-051, TC-055, TC-056, TC-075 | Green |
| STORY-004 | Select Person of Interest | TC-019, TC-040, TC-041 | Green |
| STORY-005 | Mark Clip Highlights | TC-022, TC-023, TC-024, TC-025, TC-026, TC-027, TC-028, TC-057, TC-058 | Green |
| STORY-006 | Generate Beat-Synced Reel | TC-029, TC-030, TC-031, TC-032, TC-033, TC-038, TC-039, TC-043, TC-044, TC-045, TC-046, TC-067, TC-068 | Green |
| STORY-007 | Download and Destroy Reel | TC-034, TC-035, TC-036, TC-037, TC-059, TC-060, TC-065, TC-070 | Green |
| STORY-008 | Run via Docker on Any Hardware | TC-042, TC-068, TC-069, TC-076 | Green |
| STORY-009 | CPU-Only Fallback for All Workloads | TC-050, TC-066, TC-067, TC-068 | Green |

All 9 stories have coverage. No coverage gaps.

---

> Passing stories: [STORY-001, STORY-002, STORY-003, STORY-004, STORY-005, STORY-006, STORY-007, STORY-008, STORY-009]. Open defects: [none]. Coverage gaps: [none]. P0s green — invoking @devops-engineer.
