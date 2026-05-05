/**
 * Tests for client-side file validation.
 */
import { validateVideoFile, validateAudioFile, formatBytes, formatDuration } from "../validation";

// Mock env so we don't depend on process.env in tests
jest.mock("../env", () => ({
  MAX_CLIPS: 10,
  MAX_CLIP_SIZE_BYTES: 2 * 1024 * 1024 * 1024, // 2 GB
  MAX_AUDIO_SIZE_BYTES: 200 * 1024 * 1024, // 200 MB
  ACCEPTED_VIDEO_EXTENSIONS: [".mp4", ".mov", ".mkv", ".webm"],
  ACCEPTED_AUDIO_EXTENSIONS: [".mp3", ".wav", ".aac", ".flac", ".m4a"],
  ACCEPTED_VIDEO_MIME_TYPES: ["video/mp4", "video/quicktime"],
  ACCEPTED_AUDIO_MIME_TYPES: ["audio/mpeg", "audio/wav"],
  API_BASE_URL: "",
  POLL_INTERVAL_MS: 2000,
  STALL_POLL_COUNT: 3,
  STALL_WARNING_MS: 600000,
  LOW_CONFIDENCE_THRESHOLD: 0.7,
  SESSION_STORAGE_KEY: "hypereels_session_id",
}));

function makeFile(name: string, sizeBytes: number): File {
  const content = new Uint8Array(Math.min(sizeBytes, 100)); // don't allocate full size in tests
  return Object.defineProperty(new File([content], name), "size", {
    value: sizeBytes,
  });
}

describe("validateVideoFile", () => {
  it("accepts valid MP4 file", () => {
    const file = makeFile("clip.mp4", 1024);
    expect(validateVideoFile(file, 0).valid).toBe(true);
  });

  it("accepts valid MOV file", () => {
    expect(validateVideoFile(makeFile("clip.mov", 1024), 0).valid).toBe(true);
  });

  it("accepts valid MKV file", () => {
    expect(validateVideoFile(makeFile("clip.mkv", 1024), 0).valid).toBe(true);
  });

  it("accepts valid WebM file", () => {
    expect(validateVideoFile(makeFile("clip.webm", 1024), 0).valid).toBe(true);
  });

  it("rejects AVI with named format error", () => {
    const result = validateVideoFile(makeFile("clip.avi", 1024), 0);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported format");
    expect(result.error).toContain("clip.avi");
    expect(result.error).toContain("MP4, MOV, MKV, WebM");
  });

  it("rejects file exceeding 2GB with specific message", () => {
    const tooBig = 2 * 1024 * 1024 * 1024 + 1;
    const result = validateVideoFile(makeFile("big.mp4", tooBig), 0);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("big.mp4");
    expect(result.error).toContain("2 GB");
  });

  it("rejects when clip count at max", () => {
    const result = validateVideoFile(makeFile("clip.mp4", 1024), 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Maximum 10 clips");
  });

  it("accepts at count 9 (one below max)", () => {
    expect(validateVideoFile(makeFile("clip.mp4", 1024), 9).valid).toBe(true);
  });
});

describe("validateAudioFile", () => {
  it("accepts MP3", () => {
    expect(validateAudioFile(makeFile("song.mp3", 1024)).valid).toBe(true);
  });

  it("accepts WAV", () => {
    expect(validateAudioFile(makeFile("song.wav", 1024)).valid).toBe(true);
  });

  it("accepts FLAC", () => {
    expect(validateAudioFile(makeFile("song.flac", 1024)).valid).toBe(true);
  });

  it("accepts M4A", () => {
    expect(validateAudioFile(makeFile("song.m4a", 1024)).valid).toBe(true);
  });

  it("rejects OGG with named format error", () => {
    const result = validateAudioFile(makeFile("song.ogg", 1024));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("song.ogg");
    expect(result.error).toContain("MP3, WAV, AAC, FLAC, M4A");
  });

  it("rejects file exceeding 200MB", () => {
    const tooBig = 200 * 1024 * 1024 + 1;
    const result = validateAudioFile(makeFile("big.mp3", tooBig));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("big.mp3");
    expect(result.error).toContain("200 MB");
  });
});

describe("formatBytes", () => {
  it("formats GB", () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2 GB");
  });

  it("formats MB", () => {
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
  });

  it("formats KB", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });
});

describe("formatDuration", () => {
  it("formats 1 minute 30 seconds", () => {
    expect(formatDuration(90_000)).toBe("1:30");
  });

  it("formats 0 seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
  });

  it("pads seconds with leading zero", () => {
    expect(formatDuration(9_000)).toBe("0:09");
  });
});
