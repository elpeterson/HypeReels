/**
 * Tests for the API client module.
 * Covers: fetch wrapper, error handling, session expiry, upload flow.
 */

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock XMLHttpRequest for uploadFileToStorage
class MockXHR {
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  open = jest.fn();
  send = jest.fn();
  setRequestHeader = jest.fn();
  _triggerLoad() {
    this.onload?.();
  }
  _triggerError() {
    this.onerror?.();
  }
}

let mockXhr: MockXHR;
global.XMLHttpRequest = jest.fn(() => {
  mockXhr = new MockXHR();
  return mockXhr;
}) as unknown as typeof XMLHttpRequest;

// Mock localStorage
const localStorageMock: Record<string, string> = {};
Object.defineProperty(global, "localStorage", {
  value: {
    getItem: (key: string) => localStorageMock[key] ?? null,
    setItem: (key: string, val: string) => { localStorageMock[key] = val; },
    removeItem: (key: string) => { delete localStorageMock[key]; },
    clear: () => { Object.keys(localStorageMock).forEach(k => delete localStorageMock[k]); },
  },
  writable: true,
});

import {
  createSession,
  getSession,
  requestClipUploadUrl,
  uploadFileToStorage,
  ApiError,
  SessionExpiredError,
} from "../api";

describe("API client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    jest.clearAllMocks();
  });

  // ─── createSession ───

  describe("createSession", () => {
    it("returns session_id on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ session_id: "test-uuid-123" }),
      });

      const id = await createSession();
      expect(id).toBe("test-uuid-123");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/session"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("throws ApiError on 500", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal server error" }),
      });

      await expect(createSession()).rejects.toThrow(ApiError);
    });

    it("throws ApiError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(createSession()).rejects.toThrow(ApiError);
    });
  });

  // ─── getSession ───

  describe("getSession", () => {
    it("fetches session successfully", async () => {
      const mockSession = {
        id: "sess-1",
        state: "uploading",
        clips: [],
        audio: null,
        person_id: null,
        reel_key: null,
        error: null,
        created_at: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockSession,
      });

      const session = await getSession("sess-1");
      expect(session.id).toBe("sess-1");
    });

    it("throws SessionExpiredError on 410", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: async () => ({ error: "session_expired" }),
      });

      await expect(getSession("sess-1")).rejects.toThrow(SessionExpiredError);
    });

    it("sets X-Session-Id header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "sess-1", state: "uploading", clips: [], audio: null, person_id: null, reel_key: null, error: null, created_at: 0 }),
      });

      await getSession("my-session-id");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Session-Id": "my-session-id" }),
        })
      );
    });

    it("uses verbatim API error message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Session not found" }),
      });

      await expect(getSession("missing")).rejects.toThrow("Session not found");
    });
  });

  // ─── requestClipUploadUrl ───

  describe("requestClipUploadUrl", () => {
    it("returns presigned URL and clip_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          clip_id: "clip-abc",
          upload_url: "https://minio.local/presigned-url",
          object_key: "session-1/clips/clip-abc.mp4",
        }),
      });

      const result = await requestClipUploadUrl(
        "sess-1",
        "test.mp4",
        1024,
        "video/mp4"
      );

      expect(result.clip_id).toBe("clip-abc");
      expect(result.upload_url).toContain("presigned-url");
    });
  });

  // ─── uploadFileToStorage ───

  describe("uploadFileToStorage", () => {
    it("resolves on successful XHR upload", async () => {
      const file = new File(["content"], "test.mp4", { type: "video/mp4" });
      const onProgress = jest.fn();

      const promise = uploadFileToStorage(
        "https://minio.local/presigned",
        file,
        onProgress
      );

      // Simulate successful XHR response
      mockXhr.status = 200;
      mockXhr._triggerLoad();

      await expect(promise).resolves.toBeUndefined();
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it("rejects on XHR error status", async () => {
      const file = new File(["content"], "test.mp4", { type: "video/mp4" });

      const promise = uploadFileToStorage(
        "https://minio.local/presigned",
        file
      );

      mockXhr.status = 403;
      mockXhr._triggerLoad();

      await expect(promise).rejects.toThrow(ApiError);
    });

    it("rejects on network error", async () => {
      const file = new File(["content"], "test.mp4", { type: "video/mp4" });

      const promise = uploadFileToStorage(
        "https://minio.local/presigned",
        file
      );

      mockXhr._triggerError();

      await expect(promise).rejects.toThrow(ApiError);
    });
  });

  // ─── Error surface rules ───

  describe("error surface", () => {
    it("never exposes raw status codes — uses API error message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error: "Clip file type not supported" }),
      });

      try {
        await requestClipUploadUrl("sess-1", "file.avi", 100, "video/x-msvideo");
      } catch (err) {
        if (err instanceof ApiError) {
          // Message should be the API's message, not "Request failed (422)"
          expect(err.message).toBe("Clip file type not supported");
          expect(err.message).not.toMatch(/422/);
        }
      }
    });
  });
});
