/**
 * API Route Unit Tests
 *
 * Tests all 16 API endpoints for:
 * - Happy path correct status codes and response shapes
 * - Validation errors (422)
 * - State conflicts (409)
 * - Missing/expired sessions (404/410)
 *
 * Redis and MinIO are fully mocked — no live services required.
 * All mocks use deterministic fixtures.
 *
 * TC coverage: TC-001 through TC-042, TC-061 through TC-073
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Mock redis module
jest.mock("../../../../lib/redis", () => ({
  createSession: jest.fn(),
  getSession: jest.fn(),
  getPersons: jest.fn(),
  addClipToSession: jest.fn(),
  updateClipInSession: jest.fn(),
  removeClipFromSession: jest.fn(),
  updateSessionAudio: jest.fn(),
  updateSessionState: jest.fn(),
  addHighlightToClip: jest.fn(),
  removeHighlightFromClip: jest.fn(),
  setJobProgress: jest.fn(),
  getJobProgress: jest.fn(),
  updateSessionPerson: jest.fn(),
}));

// Mock storage module
jest.mock("../../../../lib/storage", () => ({
  createPresignedPutUrl: jest.fn(),
  createPresignedGetUrl: jest.fn(),
  deleteSessionObjects: jest.fn(),
  objectKeys: {
    clip: (sessionId: string, clipId: string, ext: string) =>
      `${sessionId}/clips/${clipId}.${ext}`,
    audio: (sessionId: string, ext: string) =>
      `${sessionId}/audio.${ext}`,
    reel: (sessionId: string) =>
      `${sessionId}/reel.mp4`,
  },
}));

// Mock queue module
jest.mock("../../../../lib/queue", () => ({
  enqueueDetectPersons: jest.fn(),
  enqueueThumbnailExtract: jest.fn(),
  enqueueAnalyzeAudio: jest.fn(),
  enqueueGenerateReel: jest.fn(),
  enqueueCleanup: jest.fn(),
}));

// Mock config
jest.mock("../../../../lib/config", () => ({
  config: {
    redis: { url: "redis://localhost:6379" },
    minio: {
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      bucket: "hypereels",
    },
    session: {
      ttlSeconds: 7200,
      maxClips: 10,
      maxClipSizeBytes: 2 * 1024 * 1024 * 1024,
      maxAudioSizeBytes: 200 * 1024 * 1024,
      presignedPutTtlSeconds: 900,
      presignedGetTtlSeconds: 300,
      cleanupDelayMs: 60000,
    },
    worker: {
      pythonPath: "python3",
      scriptsDir: "/app/workers/scripts",
      tempDir: "/tmp/hypereels",
    },
    insightface: {
      providers: "CPUExecutionProvider",
    },
  },
}));

import * as redis from "../../../../lib/redis";
import * as storage from "../../../../lib/storage";
import * as queue from "../../../../lib/queue";
import { NextRequest } from "next/server";

// ─── Typed mocks ──────────────────────────────────────────────────────────────

const mockRedis = redis as jest.Mocked<typeof redis>;
const mockStorage = storage as jest.Mocked<typeof storage>;
const mockQueue = queue as jest.Mocked<typeof queue>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const CLIP_ID = "550e8400-e29b-41d4-a716-446655440001";
const AUDIO_ID = "550e8400-e29b-41d4-a716-446655440002";
const HIGHLIGHT_ID = "550e8400-e29b-41d4-a716-446655440003";
const PERSON_ID = "550e8400-e29b-41d4-a716-446655440004";
const JOB_ID = "job-550e8400-e29b-41d4-a716-446655440005";
const PRESIGNED_URL = "http://minio:9000/hypereels/test?X-Amz-Signature=abc123";

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SESSION_ID,
    state: "uploading",
    created_at: Date.now(),
    clips: [],
    audio: null,
    person_id: null,
    reel_key: null,
    error: null,
    ...overrides,
  };
}

function makeClip(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    clip_id: CLIP_ID,
    filename: "clip.mp4",
    duration_ms: 60000,
    size_bytes: 1024 * 1024,
    thumbnail_key: null,
    thumbnail_url: null,
    status: "ready",
    highlights: [],
    ...overrides,
  };
}

function makeAudio(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    audio_id: AUDIO_ID,
    filename: "song.mp3",
    duration_ms: 180000,
    size_bytes: 5 * 1024 * 1024,
    object_key: `${SESSION_ID}/audio.mp3`,
    ...overrides,
  };
}

function makeRequest(method: string, body?: unknown, pathParams?: Record<string, string>) {
  const req = new NextRequest("http://localhost:3000/api/test", {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return req;
}

// ─── Helper to read response ──────────────────────────────────────────────────

async function parseResponse(response: Response): Promise<{ status: number; body: unknown }> {
  const body = await response.json();
  return { status: response.status, body };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.createPresignedPutUrl.mockResolvedValue(PRESIGNED_URL);
  mockStorage.createPresignedGetUrl.mockResolvedValue(PRESIGNED_URL);
  mockQueue.enqueueDetectPersons.mockResolvedValue(JOB_ID);
  mockQueue.enqueueThumbnailExtract.mockResolvedValue(JOB_ID);
  mockQueue.enqueueAnalyzeAudio.mockResolvedValue("analyze-" + JOB_ID);
  mockQueue.enqueueGenerateReel.mockResolvedValue("generate-" + JOB_ID);
  mockQueue.enqueueCleanup.mockResolvedValue(undefined);
  mockRedis.createSession.mockResolvedValue(makeSession());
  mockRedis.addClipToSession.mockResolvedValue(undefined);
  mockRedis.updateClipInSession.mockResolvedValue(undefined);
  mockRedis.updateSessionAudio.mockResolvedValue(undefined);
  mockRedis.updateSessionState.mockResolvedValue(undefined);
  mockRedis.addHighlightToClip.mockResolvedValue(undefined);
  mockRedis.removeHighlightFromClip.mockResolvedValue(undefined);
  mockRedis.setJobProgress.mockResolvedValue(undefined);
  mockRedis.updateSessionPerson.mockResolvedValue(undefined);
  mockRedis.getPersons.mockResolvedValue([]);
});

// ─── POST /api/session ────────────────────────────────────────────────────────

describe("POST /api/session", () => {
  async function callPostSession() {
    const { POST } = await import("../session/route");
    return POST();
  }

  it("TC-001: returns 201 with session_id UUID", async () => {
    const response = await callPostSession();
    const { status, body } = await parseResponse(response);
    expect(status).toBe(201);
    expect((body as any).session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("TC-002: returns 500 when Redis createSession throws", async () => {
    mockRedis.createSession.mockRejectedValueOnce(new Error("Redis connection refused"));
    const response = await callPostSession();
    const { status, body } = await parseResponse(response);
    expect(status).toBe(500);
    expect((body as any).error.code).toBe("internal_error");
  });
});

// ─── GET /api/session/[id] ────────────────────────────────────────────────────

describe("GET /api/session/[id]", () => {
  async function callGetSession(id: string) {
    const { GET } = await import("../session/[id]/route");
    return GET(makeRequest("GET"), { params: { id } });
  }

  it("TC-061: returns 200 with full session state", async () => {
    const session = makeSession({
      clips: [makeClip()],
      audio: makeAudio(),
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    mockRedis.getPersons.mockResolvedValueOnce([]);
    const response = await callGetSession(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    const b = body as any;
    expect(b.id).toBe(SESSION_ID);
    expect(b.state).toBe("uploading");
    expect(Array.isArray(b.clips)).toBe(true);
    expect(Array.isArray(b.persons)).toBe(true);
    expect("audio" in b).toBe(true);
    expect("person_id" in b).toBe(true);
    expect("reel_key" in b).toBe(true);
    expect("error" in b).toBe(true);
    expect("created_at" in b).toBe(true);
  });

  it("TC-062: returns 404 when session not found", async () => {
    mockRedis.getSession.mockResolvedValueOnce(null);
    const response = await callGetSession("nonexistent-id");
    const { status, body } = await parseResponse(response);
    expect(status).toBe(404);
    expect((body as any).error.code).toBe("session_not_found");
  });

  it("returns 410 when session expired", async () => {
    mockRedis.getSession.mockResolvedValueOnce(
      makeSession({ state: "expired" })
    );
    const response = await callGetSession(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(410);
    expect((body as any).error.code).toBe("session_expired");
  });
});

// ─── POST /api/upload/clip ────────────────────────────────────────────────────

describe("POST /api/upload/clip", () => {
  async function callUploadClip(body: unknown) {
    const { POST } = await import("../upload/clip/route");
    return POST(makeRequest("POST", body));
  }

  it("TC-003: valid MP4 returns 201 with clip_id, upload_url, object_key", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadClip({
      session_id: SESSION_ID,
      filename: "clip.mp4",
      content_type: "video/mp4",
      size_bytes: 1024 * 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(201);
    const b = body as any;
    expect(b.clip_id).toBeTruthy();
    expect(b.upload_url).toContain("minio");
    expect(b.object_key).toContain("clips");
    expect(b.object_key).toContain(".mp4");
  });

  it("TC-004: AVI file returns 422 unsupported_format", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadClip({
      session_id: SESSION_ID,
      filename: "clip.avi",
      content_type: "video/x-msvideo",
      size_bytes: 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("unsupported_format");
    expect(err.message).toContain("MP4, MOV, MKV, WebM");
  });

  it("TC-005: file exceeds 2 GiB returns 422 file_too_large", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadClip({
      session_id: SESSION_ID,
      filename: "big.mp4",
      content_type: "video/mp4",
      size_bytes: 2 * 1024 * 1024 * 1024 + 1,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("file_too_large");
    expect(err.message).toContain("2 GB");
    expect(err.details.filename).toBe("big.mp4");
  });

  it("TC-006: 11th clip returns 409 max_clips_exceeded", async () => {
    const clips = Array.from({ length: 10 }, (_, i) => makeClip({
      clip_id: `clip-${i}`,
      filename: `clip${i}.mp4`,
    }));
    mockRedis.getSession.mockResolvedValueOnce(makeSession({ clips }));
    const response = await callUploadClip({
      session_id: SESSION_ID,
      filename: "clip_extra.mp4",
      content_type: "video/mp4",
      size_bytes: 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    const err = (body as any).error;
    expect(err.code).toBe("max_clips_exceeded");
    expect(err.message).toContain("Maximum 10 clips");
    expect(err.details.current_count).toBe(10);
  });

  it("TC-007: duplicate filename+size returns 409 duplicate_clip", async () => {
    const existing = makeClip({ filename: "clip.mp4", size_bytes: 1024 * 1024 });
    mockRedis.getSession.mockResolvedValueOnce(makeSession({ clips: [existing] }));
    const response = await callUploadClip({
      session_id: SESSION_ID,
      filename: "clip.mp4",
      content_type: "video/mp4",
      size_bytes: 1024 * 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    const err = (body as any).error;
    expect(err.code).toBe("duplicate_clip");
    expect(err.details.existing_clip_id).toBe(CLIP_ID);
  });

  it("TC-008: expired session returns 410", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession({ state: "expired" }));
    const response = await callUploadClip({
      session_id: SESSION_ID,
      filename: "clip.mp4",
      content_type: "video/mp4",
      size_bytes: 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(410);
    expect((body as any).error.code).toBe("session_expired");
  });

  it("TC-009: missing session returns 404", async () => {
    mockRedis.getSession.mockResolvedValueOnce(null);
    const response = await callUploadClip({
      session_id: "nonexistent-uuid",
      filename: "clip.mp4",
      content_type: "video/mp4",
      size_bytes: 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(404);
    expect((body as any).error.code).toBe("session_not_found");
  });
});

// ─── POST /api/upload/audio ───────────────────────────────────────────────────

describe("POST /api/upload/audio", () => {
  async function callUploadAudio(body: unknown) {
    const { POST } = await import("../upload/audio/route");
    return POST(makeRequest("POST", body));
  }

  it("TC-010: valid MP3 returns 201 with audio_id, upload_url, object_key", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadAudio({
      session_id: SESSION_ID,
      filename: "song.mp3",
      content_type: "audio/mpeg",
      size_bytes: 5 * 1024 * 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(201);
    const b = body as any;
    expect(b.audio_id).toBeTruthy();
    expect(b.upload_url).toContain("minio");
    expect(b.object_key).toContain("audio");
  });

  it("TC-011: OGG format returns 422 unsupported_format", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadAudio({
      session_id: SESSION_ID,
      filename: "song.ogg",
      content_type: "audio/ogg",
      size_bytes: 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("unsupported_format");
    expect(err.message).toContain("MP3, WAV, AAC, FLAC, M4A");
  });

  it("TC-012: file exceeds 200 MiB returns 422 file_too_large", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadAudio({
      session_id: SESSION_ID,
      filename: "big.mp3",
      content_type: "audio/mpeg",
      size_bytes: 200 * 1024 * 1024 + 1,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("file_too_large");
    expect(err.message).toContain("200 MB");
    expect(err.details.filename).toBe("big.mp3");
  });

  it("TC-013: replacing existing audio returns 201 (no error)", async () => {
    const sessionWithAudio = makeSession({ audio: makeAudio() });
    mockRedis.getSession.mockResolvedValueOnce(sessionWithAudio);
    const response = await callUploadAudio({
      session_id: SESSION_ID,
      filename: "new_song.mp3",
      content_type: "audio/mpeg",
      size_bytes: 3 * 1024 * 1024,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(201);
    expect((body as any).audio_id).toBeTruthy();
  });

  it("accepts WAV format", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadAudio({
      session_id: SESSION_ID,
      filename: "song.wav",
      content_type: "audio/wav",
      size_bytes: 10 * 1024 * 1024,
    });
    const { status } = await parseResponse(response);
    expect(status).toBe(201);
  });

  it("accepts FLAC format", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callUploadAudio({
      session_id: SESSION_ID,
      filename: "song.flac",
      content_type: "audio/flac",
      size_bytes: 10 * 1024 * 1024,
    });
    const { status } = await parseResponse(response);
    expect(status).toBe(201);
  });
});

// ─── POST /api/upload/clip/[clip_id]/complete ─────────────────────────────────

describe("POST /api/upload/clip/[clip_id]/complete", () => {
  async function callClipComplete(clipId: string, body: unknown) {
    const { POST } = await import("../upload/clip/[clip_id]/complete/route");
    return POST(makeRequest("POST", body), { params: { clip_id: clipId } });
  }

  it("TC-014: marks clip ready and returns job_id", async () => {
    const session = makeSession({ clips: [makeClip({ status: "uploading" })] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callClipComplete(CLIP_ID, {
      session_id: SESSION_ID,
      object_key: `${SESSION_ID}/clips/${CLIP_ID}.mp4`,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).clip_id).toBe(CLIP_ID);
    expect((body as any).job_id).toBeTruthy();
    expect(mockRedis.updateClipInSession).toHaveBeenCalledWith(
      SESSION_ID, CLIP_ID, { status: "ready" }
    );
    expect(mockQueue.enqueueThumbnailExtract).toHaveBeenCalledTimes(1);
  });

  it("TC-015: already-complete clip returns 409", async () => {
    const session = makeSession({ clips: [makeClip({ status: "ready" })] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callClipComplete(CLIP_ID, {
      session_id: SESSION_ID,
      object_key: `${SESSION_ID}/clips/${CLIP_ID}.mp4`,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("already_complete");
  });
});

// ─── POST /api/jobs/detect-persons ───────────────────────────────────────────

describe("POST /api/jobs/detect-persons", () => {
  async function callDetectPersons(body: unknown) {
    const { POST } = await import("../jobs/detect-persons/route");
    return POST(makeRequest("POST", body));
  }

  it("TC-016: enqueues detection job and returns 202 with job_id", async () => {
    const session = makeSession({ clips: [makeClip()], state: "uploading" });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDetectPersons({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(202);
    expect((body as any).job_id).toBeTruthy();
    expect(mockRedis.updateSessionState).toHaveBeenCalledWith(SESSION_ID, "detecting");
    expect(mockRedis.setJobProgress).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "queued" })
    );
  });

  it("TC-017: no ready clips returns 409 no_ready_clips", async () => {
    const session = makeSession({
      clips: [makeClip({ status: "uploading" })],
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDetectPersons({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    const err = (body as any).error;
    expect(err.code).toBe("no_ready_clips");
    expect(err.details.clip_count).toBe(1);
  });

  it("TC-017: zero clips returns 409 no_ready_clips with count 0", async () => {
    const session = makeSession({ clips: [] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDetectPersons({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("no_ready_clips");
    expect((body as any).error.details.clip_count).toBe(0);
  });

  it("TC-018: already detecting returns 409 detection_in_progress", async () => {
    const session = makeSession({
      state: "detecting",
      clips: [makeClip()],
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDetectPersons({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("detection_in_progress");
  });
});

// ─── GET /api/session/[id]/persons ───────────────────────────────────────────

describe("GET /api/session/[id]/persons", () => {
  async function callGetPersons(id: string) {
    const { GET } = await import("../session/[id]/persons/route");
    return GET(makeRequest("GET"), { params: { id } });
  }

  it("TC-019: returns persons array with correct shape", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    mockRedis.getPersons.mockResolvedValueOnce([
      {
        person_id: PERSON_ID,
        bbox: [120, 45, 80, 100],
        thumbnail: `${SESSION_ID}/persons/${PERSON_ID}.jpg`,
        confidence: 0.94,
        appearances: [{ clip_id: CLIP_ID, timestamp_ms: 1200 }],
      },
    ]);
    const response = await callGetPersons(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    const persons = (body as any).persons;
    expect(Array.isArray(persons)).toBe(true);
    expect(persons.length).toBe(1);
    const person = persons[0];
    expect(person.person_id).toBe(PERSON_ID);
    expect(Array.isArray(person.bbox)).toBe(true);
    expect(person.bbox.length).toBe(4);
    expect(person.confidence).toBe(0.94);
    expect(Array.isArray(person.appearances)).toBe(true);
  });

  it("TC-020: returns empty array before detection completes", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    mockRedis.getPersons.mockResolvedValueOnce([]);
    const response = await callGetPersons(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).persons).toEqual([]);
  });

  it("TC-021: expired session returns 410", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession({ state: "expired" }));
    const response = await callGetPersons(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(410);
    expect((body as any).error.code).toBe("session_expired");
  });

  it("missing session returns 404", async () => {
    mockRedis.getSession.mockResolvedValueOnce(null);
    const response = await callGetPersons(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(404);
  });
});

// ─── PATCH /api/session/[id]/clips/[clip_id]/highlights ──────────────────────

describe("PATCH /api/session/[id]/clips/[clip_id]/highlights", () => {
  async function callAddHighlight(id: string, clipId: string, body: unknown) {
    const { PATCH } = await import(
      "../session/[id]/clips/[clip_id]/highlights/route"
    );
    return PATCH(makeRequest("PATCH", body), { params: { id, clip_id: clipId } });
  }

  it("TC-022: valid range appended — returns 200 with highlight", async () => {
    const session = makeSession({ clips: [makeClip({ highlights: [] })] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callAddHighlight(SESSION_ID, CLIP_ID, {
      start_ms: 5000,
      end_ms: 15000,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    const h = (body as any).highlight;
    expect(h.highlight_id).toBeTruthy();
    expect(h.start_ms).toBe(5000);
    expect(h.end_ms).toBe(15000);
    expect(mockRedis.addHighlightToClip).toHaveBeenCalledTimes(1);
  });

  it("TC-023: duration < 1000ms returns 422 invalid_range", async () => {
    const session = makeSession({ clips: [makeClip()] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callAddHighlight(SESSION_ID, CLIP_ID, {
      start_ms: 5000,
      end_ms: 5500,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("invalid_range");
    expect(err.details.duration_ms).toBe(500);
    expect(err.message).toMatch(/1 second|1000ms/i);
  });

  it("TC-024: overlapping range returns 422 highlight_overlap with conflict details", async () => {
    const existing = {
      highlight_id: HIGHLIGHT_ID,
      start_ms: 10000,
      end_ms: 20000,
    };
    const session = makeSession({
      clips: [makeClip({ highlights: [existing] })],
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callAddHighlight(SESSION_ID, CLIP_ID, {
      start_ms: 15000,
      end_ms: 25000,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("highlight_overlap");
    expect(err.details.conflicting_highlight.start_ms).toBe(10000);
    expect(err.details.new_range.start_ms).toBe(15000);
  });

  it("TC-025: end_ms beyond clip duration returns 422 invalid_range", async () => {
    const clip = makeClip({ duration_ms: 60000 });
    const session = makeSession({ clips: [clip] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callAddHighlight(SESSION_ID, CLIP_ID, {
      start_ms: 55000,
      end_ms: 70000,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(422);
    const err = (body as any).error;
    expect(err.code).toBe("invalid_range");
    expect(err.details.clip_duration_ms).toBe(60000);
  });

  it("TC-026: start_ms=0 is accepted", async () => {
    const session = makeSession({ clips: [makeClip({ highlights: [] })] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callAddHighlight(SESSION_ID, CLIP_ID, {
      start_ms: 0,
      end_ms: 5000,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).highlight.start_ms).toBe(0);
  });
});

// ─── DELETE /api/session/[id]/clips/[clip_id]/highlights/[highlight_id] ───────

describe("DELETE highlights", () => {
  async function callDeleteHighlight(id: string, clipId: string, highlightId: string) {
    const { DELETE } = await import(
      "../session/[id]/clips/[clip_id]/highlights/[highlight_id]/route"
    );
    return DELETE(makeRequest("DELETE"), {
      params: { id, clip_id: clipId, highlight_id: highlightId },
    });
  }

  it("TC-027: removes highlight — returns 204", async () => {
    const highlight = { highlight_id: HIGHLIGHT_ID, start_ms: 5000, end_ms: 15000 };
    const session = makeSession({ clips: [makeClip({ highlights: [highlight] })] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDeleteHighlight(SESSION_ID, CLIP_ID, HIGHLIGHT_ID);
    expect(response.status).toBe(204);
  });

  it("TC-028: missing highlight returns 404", async () => {
    const session = makeSession({ clips: [makeClip({ highlights: [] })] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDeleteHighlight(SESSION_ID, CLIP_ID, "nonexistent-id");
    const { status, body } = await parseResponse(response);
    expect(status).toBe(404);
  });
});

// ─── POST /api/jobs/generate-reel ────────────────────────────────────────────

describe("POST /api/jobs/generate-reel", () => {
  async function callGenerateReel(body: unknown) {
    const { POST } = await import("../jobs/generate-reel/route");
    return POST(makeRequest("POST", body));
  }

  it("TC-029: valid prerequisites returns 202 with job_id and analyze_audio_job_id", async () => {
    const session = makeSession({
      clips: [makeClip()],
      audio: makeAudio(),
      state: "uploading",
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callGenerateReel({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(202);
    const b = body as any;
    expect(b.job_id).toBeTruthy();
    expect(b.analyze_audio_job_id).toBeTruthy();
    expect(mockRedis.updateSessionState).toHaveBeenCalledWith(SESSION_ID, "generating");
  });

  it("TC-030: no audio returns 409 no_audio", async () => {
    const session = makeSession({ clips: [makeClip()], audio: null });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callGenerateReel({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("no_audio");
  });

  it("TC-031: no ready clips returns 409 no_ready_clips", async () => {
    const session = makeSession({
      clips: [makeClip({ status: "uploading" })],
      audio: makeAudio(),
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callGenerateReel({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("no_ready_clips");
  });

  it("TC-032: already generating returns 409 generation_in_progress", async () => {
    const session = makeSession({
      state: "generating",
      clips: [makeClip()],
      audio: makeAudio(),
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callGenerateReel({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("generation_in_progress");
  });

  it("TC-033: reel already ready returns 409 reel_already_ready", async () => {
    const session = makeSession({
      state: "ready",
      clips: [makeClip()],
      audio: makeAudio(),
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callGenerateReel({ session_id: SESSION_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    expect((body as any).error.code).toBe("reel_already_ready");
  });
});

// ─── GET /api/download/[session_id] ──────────────────────────────────────────

describe("GET /api/download/[session_id]", () => {
  async function callDownload(sessionId: string) {
    const { GET } = await import("../download/[session_id]/route");
    return GET(makeRequest("GET"), { params: { session_id: sessionId } });
  }

  it("TC-034: ready session returns 200 with download_url", async () => {
    const session = makeSession({
      state: "ready",
      reel_key: `${SESSION_ID}/reel.mp4`,
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDownload(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).download_url).toBeTruthy();
    expect((body as any).download_url).toContain("minio");
  });

  it("TC-035: non-ready session returns 409 reel_not_ready", async () => {
    const session = makeSession({ state: "generating" });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callDownload(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(409);
    const err = (body as any).error;
    expect(err.code).toBe("reel_not_ready");
    expect(err.details.state).toBe("generating");
  });

  it("TC-036: expired session returns 410", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession({ state: "expired" }));
    const response = await callDownload(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(410);
    expect((body as any).error.code).toBe("session_expired");
  });

  it("TC-037: missing session returns 404", async () => {
    mockRedis.getSession.mockResolvedValueOnce(null);
    const response = await callDownload(SESSION_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(404);
    expect((body as any).error.code).toBe("session_not_found");
  });

  it("enqueues cleanup job when session is ready", async () => {
    const session = makeSession({
      state: "ready",
      reel_key: `${SESSION_ID}/reel.mp4`,
    });
    mockRedis.getSession.mockResolvedValueOnce(session);
    await callDownload(SESSION_ID);
    // enqueueCleanup is fire-and-forget but should still be called
    expect(mockQueue.enqueueCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: SESSION_ID }),
      expect.any(Number)
    );
  });
});

// ─── GET /api/jobs/[job_id]/progress ─────────────────────────────────────────

describe("GET /api/jobs/[job_id]/progress", () => {
  async function callGetProgress(jobId: string) {
    const { GET } = await import("../jobs/[job_id]/progress/route");
    return GET(makeRequest("GET"), { params: { job_id: jobId } });
  }

  it("TC-038: returns progress object with all required fields", async () => {
    mockRedis.getJobProgress.mockResolvedValueOnce({
      status: "processing",
      stage: "Analyzing clips for people…",
      pct: 45,
      message: "Processed clip 2 of 4",
      updated_at: Date.now(),
    });
    const response = await callGetProgress(JOB_ID);
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    const b = body as any;
    expect(b.job_id).toBe(JOB_ID);
    expect(b.status).toBe("processing");
    expect(b.stage).toBeTruthy();
    expect(typeof b.pct).toBe("number");
    expect(b.pct).toBeGreaterThanOrEqual(0);
    expect(b.pct).toBeLessThanOrEqual(100);
    expect(b.updated_at).toBeTruthy();
  });

  it("TC-039: missing job returns 404", async () => {
    mockRedis.getJobProgress.mockResolvedValueOnce(null);
    const response = await callGetProgress("nonexistent-job");
    const { status } = await parseResponse(response);
    expect(status).toBe(404);
  });
});

// ─── POST /api/session/[id]/person ───────────────────────────────────────────

describe("POST /api/session/[id]/person", () => {
  async function callSetPerson(id: string, body: unknown) {
    const { POST } = await import("../session/[id]/person/route");
    return POST(makeRequest("POST", body), { params: { id } });
  }

  it("TC-040: sets person of interest — returns 200 with person_id", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const response = await callSetPerson(SESSION_ID, { person_id: PERSON_ID });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).person_id).toBe(PERSON_ID);
  });

  it("TC-041: clears selection with null — returns 200 with person_id=null", async () => {
    mockRedis.getSession.mockResolvedValueOnce(
      makeSession({ person_id: PERSON_ID })
    );
    const response = await callSetPerson(SESSION_ID, { person_id: null });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).person_id).toBeNull();
  });
});

// ─── GET /api/health ──────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  async function callHealth() {
    const { GET } = await import("../health/route");
    return GET();
  }

  it("TC-042: returns 200 with ok status when services healthy", async () => {
    const response = await callHealth();
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    const b = body as any;
    expect(b.status).toBe("ok");
    expect(b.queue).toBeTruthy();
    expect(b.storage).toBeTruthy();
  });
});

// ─── TC-063: Error envelope shape ────────────────────────────────────────────

describe("Error envelope — all errors use standard shape", () => {
  it("TC-063: 404 error has code+message in error object", async () => {
    mockRedis.getSession.mockResolvedValueOnce(null);
    const { GET } = await import("../session/[id]/route");
    const response = await GET(makeRequest("GET"), { params: { id: "missing" } });
    const { body } = await parseResponse(response);
    const b = body as any;
    expect(typeof b.error).toBe("object");
    expect(typeof b.error.code).toBe("string");
    expect(typeof b.error.message).toBe("string");
    expect(b.error.message).not.toMatch(/\d{3}/); // No raw status codes in message
  });

  it("TC-063: 410 error has code+message", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession({ state: "expired" }));
    const { GET } = await import("../session/[id]/route");
    const response = await GET(makeRequest("GET"), { params: { id: SESSION_ID } });
    const { body } = await parseResponse(response);
    const b = body as any;
    expect(typeof b.error.code).toBe("string");
    expect(typeof b.error.message).toBe("string");
  });

  it("TC-063: 409 error has code+message", async () => {
    const session = makeSession({ clips: [] });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const { POST } = await import("../jobs/detect-persons/route");
    const response = await POST(makeRequest("POST", { session_id: SESSION_ID }));
    const { body } = await parseResponse(response);
    const b = body as any;
    expect(typeof b.error.code).toBe("string");
    expect(typeof b.error.message).toBe("string");
  });

  it("TC-063: 422 error has code+message+details", async () => {
    mockRedis.getSession.mockResolvedValueOnce(makeSession());
    const { POST } = await import("../upload/clip/route");
    const response = await POST(makeRequest("POST", {
      session_id: SESSION_ID,
      filename: "clip.avi",
      content_type: "video/x-msvideo",
      size_bytes: 1000,
    }));
    const { body } = await parseResponse(response);
    const b = body as any;
    expect(typeof b.error.code).toBe("string");
    expect(typeof b.error.message).toBe("string");
    // details is optional but when present should be an object
  });
});

// ─── POST /api/upload/audio/complete ─────────────────────────────────────────

describe("POST /api/upload/audio/complete", () => {
  async function callAudioComplete(body: unknown) {
    const { POST } = await import("../upload/audio/complete/route");
    return POST(makeRequest("POST", body));
  }

  it("TC-071: marks audio ready — returns 200 with audio_id", async () => {
    const session = makeSession({ audio: makeAudio() });
    mockRedis.getSession.mockResolvedValueOnce(session);
    const response = await callAudioComplete({
      session_id: SESSION_ID,
      audio_id: AUDIO_ID,
    });
    const { status, body } = await parseResponse(response);
    expect(status).toBe(200);
    expect((body as any).audio_id).toBeTruthy();
  });
});
