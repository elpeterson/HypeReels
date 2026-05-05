"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PersonCard } from "@/components/person/PersonCard";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { StepNav } from "@/components/ui/StepNav";
import { useJobPoller } from "@/hooks/useJobPoller";
import {
  startPersonDetection,
  getSessionPersons,
  setPersonOfInterest,
} from "@/lib/api";
import { getStoredSessionId } from "@/lib/session";
import type { Person, JobProgress } from "@/types";

const STEPS = [
  { label: "Upload" },
  { label: "People" },
  { label: "Highlights" },
  { label: "Generate" },
  { label: "Download" },
];

type PageState =
  | "loading"       // starting detection or awaiting job
  | "processing"    // job running
  | "none_detected" // completed, no persons
  | "ready"         // persons available for selection
  | "error";        // job failed or API error

export default function PersonSelectionPage() {
  const router = useRouter();
  const sessionId = getStoredSessionId();

  const [pageState, setPageState] = useState<PageState>("loading");
  const [jobId, setJobId] = useState<string | null>(null);
  const [persons, setPersons] = useState<Person[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState("Analyzing clips for people…");

  // Start detection job on mount
  useEffect(() => {
    if (!sessionId) {
      router.push("/upload");
      return;
    }

    let cancelled = false;

    const start = async () => {
      try {
        const { job_id } = await startPersonDetection(sessionId);
        if (!cancelled) {
          setJobId(job_id);
          setPageState("processing");
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to start detection.";
        setJobError(msg);
        setPageState("error");
      }
    };

    start();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProgress = useCallback((p: JobProgress) => {
    if (p.stage) setProgressLabel(p.stage);
  }, []);

  const handleComplete = useCallback(
    async (p: JobProgress) => {
      if (!sessionId) return;
      try {
        const data = await getSessionPersons(sessionId);
        if (data.length === 0) {
          setPageState("none_detected");
        } else {
          setPersons(data);
          setPageState("ready");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load detected persons.";
        setJobError(msg);
        setPageState("error");
      }
    },
    [sessionId]
  );

  const handleFailed = useCallback((p: JobProgress) => {
    // Show the verbatim error from the job response — never generic
    setJobError(p.error ?? p.message ?? "Person detection failed.");
    setPageState("error");
  }, []);

  const { progress: jobProgress } = useJobPoller({
    sessionId,
    jobId,
    onProgress: handleProgress,
    onComplete: handleComplete,
    onFailed: handleFailed,
  });

  // ─── Selection ───

  const handleSelect = useCallback((personId: string) => {
    setSelectedPersonId((prev) => (prev === personId ? null : personId));
  }, []);

  const handleContinue = useCallback(
    async (skipPerson = false) => {
      if (!sessionId) return;
      setSaving(true);
      setSaveError(null);

      try {
        await setPersonOfInterest(sessionId, skipPerson ? null : selectedPersonId);
        router.push("/highlights");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to save selection.";
        setSaveError(msg);
        setSaving(false);
      }
    },
    [sessionId, selectedPersonId, router]
  );

  // ─── Render ───

  return (
    <div className="space-y-8">
      <StepNav steps={STEPS} currentStep={1} />

      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Select Person of Interest</h1>
        <p className="text-gray-400 text-sm">
          Choose one person to prioritize in your reel. The AI will favor moments
          featuring this person.
        </p>
      </div>

      {/* Loading / processing */}
      {(pageState === "loading" || pageState === "processing") && (
        <div className="flex flex-col items-center gap-6 py-16">
          <Spinner size="lg" label={progressLabel} />
          {jobProgress && (
            <div className="text-center">
              <p className="text-sm text-gray-400">{jobProgress.stage}</p>
              <p className="text-xs text-gray-600 mt-1">{jobProgress.pct}% complete</p>
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {pageState === "error" && jobError && (
        <div className="space-y-4">
          <Banner variant="error" title="Detection failed">
            {jobError}
          </Banner>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => router.push("/upload")}>
              ← Back to upload
            </Button>
            <Button
              onClick={() => {
                setPageState("loading");
                setJobError(null);
                setJobId(null);
                if (sessionId) {
                  startPersonDetection(sessionId)
                    .then(({ job_id }) => {
                      setJobId(job_id);
                      setPageState("processing");
                    })
                    .catch((err: unknown) => {
                      const msg =
                        err instanceof Error ? err.message : "Failed to retry.";
                      setJobError(msg);
                      setPageState("error");
                    });
                }
              }}
            >
              Retry detection
            </Button>
          </div>
        </div>
      )}

      {/* No persons detected — named empty state */}
      {pageState === "none_detected" && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center space-y-4">
          <div className="text-4xl" aria-hidden="true">👤</div>
          <h2 className="text-lg font-semibold text-white">No people detected</h2>
          <p className="text-gray-400 text-sm max-w-md mx-auto">
            No people were found in your clips. You can continue without selecting
            a person of interest — the reel will use all clip content based on
            motion and energy.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Button
              variant="secondary"
              onClick={() => router.push("/upload")}
            >
              Upload different clips
            </Button>
            <Button onClick={() => handleContinue(true)} loading={saving} loadingText="Continuing…">
              Continue without a person →
            </Button>
          </div>
        </div>
      )}

      {/* Person grid */}
      {pageState === "ready" && (
        <div className="space-y-6">
          <div
            role="radiogroup"
            aria-label="Detected persons"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4"
          >
            {persons.map((person, index) => (
              <PersonCard
                key={person.person_id}
                person={person}
                selected={selectedPersonId === person.person_id}
                onSelect={handleSelect}
                index={index}
              />
            ))}
          </div>

          {saveError && (
            <Banner variant="error">
              {saveError}
            </Banner>
          )}

          <div className="flex justify-between items-center pt-4 border-t border-gray-800">
            <Button
              variant="ghost"
              onClick={() => handleContinue(true)}
              disabled={saving}
            >
              Skip — no person of interest
            </Button>
            <Button
              size="lg"
              disabled={!selectedPersonId || saving}
              onClick={() => handleContinue(false)}
              loading={saving}
              loadingText="Saving…"
            >
              Continue with selected person →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
