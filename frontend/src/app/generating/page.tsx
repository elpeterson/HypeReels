"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { StepNav } from "@/components/ui/StepNav";
import { useJobPoller } from "@/hooks/useJobPoller";
import { startReelGeneration, getSession } from "@/lib/api";
import { getStoredSessionId } from "@/lib/session";
import type { JobProgress } from "@/types";

const STEPS = [
  { label: "Upload" },
  { label: "People" },
  { label: "Highlights" },
  { label: "Generate" },
  { label: "Download" },
];

type PageState = "preflight" | "starting" | "queued" | "processing" | "completed" | "failed" | "error";

/**
 * Pre-flight checks:
 * - At least one clip uploaded (ready state)
 * - Audio uploaded
 * - POI selected or user opted out (person_id may be null by choice)
 */
export default function GeneratingPage() {
  const router = useRouter();
  const sessionId = getStoredSessionId();

  const [pageState, setPageState] = useState<PageState>("preflight");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [prefightError, setPrefightError] = useState<string | null>(null);

  // Preflight check then start generation
  useEffect(() => {
    if (!sessionId) {
      router.push("/upload");
      return;
    }

    let cancelled = false;

    const preflight = async () => {
      try {
        const session = await getSession(sessionId);

        if (cancelled) return;

        const readyClips = session.clips.filter((c) => c.status === "ready");
        if (readyClips.length === 0) {
          setPrefightError("No uploaded clips found. Please go back and upload at least one clip.");
          setPageState("error");
          return;
        }
        if (!session.audio) {
          setPrefightError("No audio track found. Please go back and upload a song.");
          setPageState("error");
          return;
        }

        setPageState("starting");

        const { job_id } = await startReelGeneration(sessionId);
        if (!cancelled) {
          setJobId(job_id);
          setPageState("queued");
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to start reel generation.";
        setJobError(msg);
        setPageState("failed");
      }
    };

    preflight();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProgress = useCallback((p: JobProgress) => {
    setJobProgress(p);
    if (p.status === "processing") setPageState("processing");
    if (p.status === "queued") setPageState("queued");
  }, []);

  const handleComplete = useCallback((p: JobProgress) => {
    setJobProgress(p);
    setPageState("completed");
    // Transition to download screen
    setTimeout(() => router.push("/download"), 1000);
  }, [router]);

  const handleFailed = useCallback((p: JobProgress) => {
    // Show verbatim error from job — never generic
    setJobError(p.error ?? p.message ?? "Reel generation failed.");
    setPageState("failed");
  }, []);

  const { isStalled, showStallWarning } = useJobPoller({
    sessionId,
    jobId,
    onProgress: handleProgress,
    onComplete: handleComplete,
    onFailed: handleFailed,
  });

  const handleRetry = useCallback(() => {
    if (!sessionId) return;
    setJobError(null);
    setJobId(null);
    setJobProgress(null);
    setPageState("starting");

    startReelGeneration(sessionId)
      .then(({ job_id }) => {
        setJobId(job_id);
        setPageState("queued");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to retry generation.";
        setJobError(msg);
        setPageState("failed");
      });
  }, [sessionId]);

  // ─── Stage label display ───
  const stageLabel = jobProgress?.stage ?? (
    pageState === "queued" ? "Waiting in queue…" :
    pageState === "starting" ? "Preparing…" :
    pageState === "preflight" ? "Checking session…" :
    "Generating…"
  );

  const pct = jobProgress?.pct ?? 0;

  return (
    <div className="space-y-8">
      <StepNav steps={STEPS} currentStep={3} />

      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Generating Your Reel</h1>
        <p className="text-gray-400 text-sm">
          Sit tight while we analyze your audio and assemble your beat-synced reel.
          This can take up to 10 minutes.
        </p>
      </div>

      {/* Preflight / config error */}
      {pageState === "error" && prefightError && (
        <div className="space-y-4">
          <Banner variant="error" title="Cannot start generation">
            {prefightError}
          </Banner>
          <Button variant="secondary" onClick={() => router.push("/upload")}>
            ← Back to upload
          </Button>
        </div>
      )}

      {/* Generation in progress */}
      {(pageState === "preflight" || pageState === "starting" || pageState === "queued" || pageState === "processing") && (
        <div className="space-y-8">
          {/* Stall warning */}
          {showStallWarning && (
            <Banner variant="warning" title="Generation is taking longer than expected">
              <p>
                Your reel is still being assembled. This sometimes happens with
                long clips or complex highlights.
              </p>
              <div className="flex gap-3 mt-3">
                <Button size="sm" variant="secondary" onClick={() => {}}>
                  Keep waiting
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => router.push("/upload")}
                >
                  Cancel and start over
                </Button>
              </div>
            </Banner>
          )}

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center space-y-6">
            <Spinner size="lg" label="" />

            <div className="space-y-2">
              <p
                className="text-lg font-semibold text-white"
                aria-live="polite"
                aria-atomic="true"
              >
                {stageLabel}
              </p>
              {jobProgress?.message && jobProgress.message !== stageLabel && (
                <p className="text-sm text-gray-400">{jobProgress.message}</p>
              )}
            </div>

            {(pageState === "processing" || pct > 0) && (
              <ProgressBar
                value={pct}
                ariaLabel="Reel generation progress"
                showPercentage
                className="max-w-sm mx-auto"
              />
            )}

            {isStalled && !showStallWarning && (
              <p className="text-xs text-yellow-500" role="status">
                Processing is taking longer than usual — still working…
              </p>
            )}
          </div>

          {/* Stage breakdown guide */}
          <div className="grid grid-cols-3 gap-4 text-center text-xs text-gray-500">
            {["Analyzing audio…", "Selecting scenes…", "Assembling reel…"].map(
              (stage, i) => (
                <div
                  key={stage}
                  className={[
                    "rounded-lg p-3 border",
                    pct >= (i + 1) * 33
                      ? "border-red-800 text-red-400 bg-red-950/30"
                      : "border-gray-800 bg-gray-900",
                  ].join(" ")}
                  aria-hidden="true"
                >
                  {stage}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* Completed */}
      {pageState === "completed" && (
        <div className="bg-green-950 border border-green-800 rounded-xl p-8 text-center space-y-4">
          <div className="text-4xl" aria-hidden="true">🎬</div>
          <h2 className="text-xl font-bold text-green-300">Reel ready!</h2>
          <p className="text-green-400 text-sm">Taking you to the download screen…</p>
          <Spinner size="sm" label="Redirecting…" />
        </div>
      )}

      {/* Failed */}
      {pageState === "failed" && jobError && (
        <div className="space-y-4">
          <Banner variant="error" title="Generation failed">
            {jobError}
          </Banner>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => router.push("/highlights")}>
              ← Back to highlights
            </Button>
            <Button onClick={handleRetry}>
              Retry generation
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
