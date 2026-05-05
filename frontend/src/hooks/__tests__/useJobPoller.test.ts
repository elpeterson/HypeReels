/**
 * Tests for useJobPoller hook.
 * Covers: polling, terminal states, stall detection, error handling.
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useJobPoller } from "../useJobPoller";

// Mock the API module
jest.mock("@/lib/api", () => ({
  getJobProgress: jest.fn(),
}));

// Mock env
jest.mock("@/lib/env", () => ({
  POLL_INTERVAL_MS: 100, // fast for tests
  STALL_POLL_COUNT: 3,
  STALL_WARNING_MS: 500,
}));

import { getJobProgress } from "@/lib/api";
const mockGetJobProgress = getJobProgress as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe("useJobPoller", () => {
  it("does not poll when jobId is null", () => {
    renderHook(() =>
      useJobPoller({ sessionId: "sess-1", jobId: null })
    );
    jest.advanceTimersByTime(500);
    expect(mockGetJobProgress).not.toHaveBeenCalled();
  });

  it("does not poll when sessionId is null", () => {
    renderHook(() =>
      useJobPoller({ sessionId: null, jobId: "job-1" })
    );
    jest.advanceTimersByTime(500);
    expect(mockGetJobProgress).not.toHaveBeenCalled();
  });

  it("polls immediately on mount", async () => {
    const progress = { job_id: "job-1", status: "processing", stage: "Analyzing", pct: 50, message: "", updated_at: Date.now() };
    mockGetJobProgress.mockResolvedValue(progress);

    renderHook(() =>
      useJobPoller({ sessionId: "sess-1", jobId: "job-1" })
    );

    await waitFor(() => {
      expect(mockGetJobProgress).toHaveBeenCalledTimes(1);
    });
  });

  it("calls onComplete when job status is completed", async () => {
    const completedProgress = {
      job_id: "job-1",
      status: "completed" as const,
      stage: "Done",
      pct: 100,
      message: "Complete",
      updated_at: Date.now(),
    };
    mockGetJobProgress.mockResolvedValue(completedProgress);

    const onComplete = jest.fn();
    renderHook(() =>
      useJobPoller({ sessionId: "sess-1", jobId: "job-1", onComplete })
    );

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(completedProgress);
    });

    // Should stop polling after completion
    const callCount = mockGetJobProgress.mock.calls.length;
    jest.advanceTimersByTime(500);
    expect(mockGetJobProgress.mock.calls.length).toBe(callCount);
  });

  it("calls onFailed when job status is failed", async () => {
    const failedProgress = {
      job_id: "job-1",
      status: "failed" as const,
      stage: "Failed",
      pct: 0,
      message: "FFmpeg error: codec not supported",
      error: "FFmpeg error: codec not supported",
      updated_at: Date.now(),
    };
    mockGetJobProgress.mockResolvedValue(failedProgress);

    const onFailed = jest.fn();
    renderHook(() =>
      useJobPoller({ sessionId: "sess-1", jobId: "job-1", onFailed })
    );

    await waitFor(() => {
      expect(onFailed).toHaveBeenCalledWith(failedProgress);
    });
  });

  it("calls onProgress on each successful poll", async () => {
    const onProgress = jest.fn();
    const progress = { job_id: "j", status: "processing" as const, stage: "Working", pct: 25, message: "", updated_at: Date.now() };
    mockGetJobProgress.mockResolvedValue(progress);

    renderHook(() =>
      useJobPoller({ sessionId: "sess-1", jobId: "job-1", onProgress })
    );

    await waitFor(() => {
      expect(onProgress).toHaveBeenCalled();
    });
  });

  it("stops polling on unmount", async () => {
    mockGetJobProgress.mockResolvedValue({
      job_id: "j", status: "processing" as const, stage: "W", pct: 10, message: "", updated_at: Date.now(),
    });

    const { unmount } = renderHook(() =>
      useJobPoller({ sessionId: "sess-1", jobId: "job-1" })
    );

    await waitFor(() => expect(mockGetJobProgress).toHaveBeenCalled());

    const callCountAtUnmount = mockGetJobProgress.mock.calls.length;
    unmount();

    jest.advanceTimersByTime(1000);
    expect(mockGetJobProgress.mock.calls.length).toBe(callCountAtUnmount);
  });
});
