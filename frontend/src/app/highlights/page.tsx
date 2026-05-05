"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ClipHighlighter } from "@/components/highlights/ClipHighlighter";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { StepNav } from "@/components/ui/StepNav";
import { getSession } from "@/lib/api";
import { getStoredSessionId } from "@/lib/session";
import type { Clip, Highlight } from "@/types";

const STEPS = [
  { label: "Upload" },
  { label: "People" },
  { label: "Highlights" },
  { label: "Generate" },
  { label: "Download" },
];

export default function HighlightsPage() {
  const router = useRouter();
  const sessionId = getStoredSessionId();

  const [clips, setClips] = useState<Clip[]>([]);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      router.push("/upload");
      return;
    }

    let cancelled = false;

    getSession(sessionId)
      .then((session) => {
        if (cancelled) return;
        const readyClips = session.clips.filter((c) => c.status === "ready");
        setClips(readyClips);
        setAudioDurationMs(session.audio?.duration_ms ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load session.";
        setLoadError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHighlightsChanged = useCallback(
    (clipId: string, highlights: Highlight[]) => {
      setClips((prev) =>
        prev.map((c) => (c.clip_id === clipId ? { ...c, highlights } : c))
      );
    },
    []
  );

  const totalHighlightMs = clips.reduce(
    (sum, clip) =>
      sum +
      clip.highlights.reduce((s, h) => s + (h.end_ms - h.start_ms), 0),
    0
  );
  const exceedsAudioOverall =
    audioDurationMs != null && totalHighlightMs > audioDurationMs;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size="lg" label="Loading clips…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <Banner variant="error" title="Failed to load clips">
          {loadError}
        </Banner>
        <Button variant="secondary" onClick={() => router.push("/upload")}>
          ← Back to upload
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <StepNav steps={STEPS} currentStep={2} />

      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Mark Highlights</h1>
        <p className="text-gray-400 text-sm">
          Optionally mark time ranges in each clip that must appear in your reel.
          Unmarked clips let the AI choose the best moments.
        </p>
      </div>

      {exceedsAudioOverall && (
        <Banner variant="warning">
          Your highlights exceed the audio duration — the reel will include all
          highlights but may be longer than the song.
        </Banner>
      )}

      {clips.length === 0 && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center">
          <p className="text-gray-400">No ready clips found. Go back and ensure your clips have uploaded successfully.</p>
          <Button
            variant="secondary"
            onClick={() => router.push("/upload")}
            className="mt-4"
          >
            ← Back to upload
          </Button>
        </div>
      )}

      {!sessionId && clips.length > 0 && (
        <Banner variant="error">Session not found. Please go back to upload.</Banner>
      )}

      {sessionId && clips.length > 0 && (
        <div className="space-y-3">
          {clips.map((clip) => (
            <ClipHighlighter
              key={clip.clip_id}
              clip={clip}
              sessionId={sessionId}
              audioDurationMs={audioDurationMs}
              onHighlightsChanged={handleHighlightsChanged}
            />
          ))}
        </div>
      )}

      <div className="flex justify-between items-center pt-4 border-t border-gray-800">
        <Button
          variant="secondary"
          onClick={() => router.push("/person-selection")}
        >
          ← Back
        </Button>
        <Button
          size="lg"
          onClick={() => router.push("/generating")}
          disabled={clips.length === 0}
        >
          Generate Reel →
        </Button>
      </div>
    </div>
  );
}
