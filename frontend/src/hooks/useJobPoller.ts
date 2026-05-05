"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getJobProgress } from "@/lib/api";
import { POLL_INTERVAL_MS, STALL_POLL_COUNT, STALL_WARNING_MS } from "@/lib/env";
import type { JobProgress, JobStatus } from "@/types";

export interface UseJobPollerOptions {
  sessionId: string | null;
  jobId: string | null;
  /** Called on each successful poll with latest progress */
  onProgress?: (progress: JobProgress) => void;
  /** Called when job completes */
  onComplete?: (progress: JobProgress) => void;
  /** Called when job fails */
  onFailed?: (progress: JobProgress) => void;
}

export interface UseJobPollerReturn {
  progress: JobProgress | null;
  isStalled: boolean;
  showStallWarning: boolean;
  error: string | null;
  stopPolling: () => void;
}

const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed"];

/**
 * Polls GET /api/jobs/{job_id}/progress every POLL_INTERVAL_MS.
 *
 * Implements exponential backoff when progress_pct is unchanged for
 * STALL_POLL_COUNT consecutive polls (3→6→12→max 15s).
 *
 * After STALL_WARNING_MS with no progress, sets showStallWarning = true.
 */
export function useJobPoller({
  sessionId,
  jobId,
  onProgress,
  onComplete,
  onFailed,
}: UseJobPollerOptions): UseJobPollerReturn {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [isStalled, setIsStalled] = useState(false);
  const [showStallWarning, setShowStallWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRef = useRef(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutiveSamePctRef = useRef(0);
  const lastPctRef = useRef<number | null>(null);
  const stallStartRef = useRef<number | null>(null);
  const currentIntervalRef = useRef(POLL_INTERVAL_MS);

  const stopPolling = useCallback(() => {
    activeRef.current = false;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !jobId) return;

    activeRef.current = true;
    consecutiveSamePctRef.current = 0;
    lastPctRef.current = null;
    stallStartRef.current = null;
    currentIntervalRef.current = POLL_INTERVAL_MS;
    setError(null);
    setIsStalled(false);
    setShowStallWarning(false);

    const poll = async () => {
      if (!activeRef.current) return;

      try {
        const result = await getJobProgress(sessionId, jobId);

        if (!activeRef.current) return;

        setProgress(result);
        onProgress?.(result);

        // Track stall
        if (lastPctRef.current === result.pct && result.status === "processing") {
          consecutiveSamePctRef.current += 1;

          if (consecutiveSamePctRef.current >= STALL_POLL_COUNT) {
            if (!stallStartRef.current) {
              stallStartRef.current = Date.now();
            }
            setIsStalled(true);

            // Exponential backoff: 3→6→12→max 15s
            const backoff = Math.min(
              currentIntervalRef.current * 2,
              15_000
            );
            currentIntervalRef.current = backoff;

            // Check if stall has exceeded warning threshold
            if (
              stallStartRef.current &&
              Date.now() - stallStartRef.current >= STALL_WARNING_MS
            ) {
              setShowStallWarning(true);
            }
          }
        } else {
          consecutiveSamePctRef.current = 0;
          stallStartRef.current = null;
          currentIntervalRef.current = POLL_INTERVAL_MS;
          setIsStalled(false);
          setShowStallWarning(false);
        }

        lastPctRef.current = result.pct;

        if (TERMINAL_STATUSES.includes(result.status)) {
          stopPolling();
          if (result.status === "completed") {
            onComplete?.(result);
          } else if (result.status === "failed") {
            onFailed?.(result);
          }
          return;
        }

        // Schedule next poll
        timeoutRef.current = setTimeout(poll, currentIntervalRef.current);
      } catch (err: unknown) {
        if (!activeRef.current) return;

        const msg = err instanceof Error ? err.message : "Failed to fetch job progress.";
        setError(msg);

        // Retry after a doubled interval on transient errors (max 15s)
        const retryInterval = Math.min(currentIntervalRef.current * 2, 15_000);
        currentIntervalRef.current = retryInterval;
        timeoutRef.current = setTimeout(poll, retryInterval);
      }
    };

    // Start polling immediately
    poll();

    return () => {
      stopPolling();
    };
  }, [sessionId, jobId, onProgress, onComplete, onFailed, stopPolling]);

  return { progress, isStalled, showStallWarning, error, stopPolling };
}
