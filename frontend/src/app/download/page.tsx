"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StepNav } from "@/components/ui/StepNav";
import { getDownloadUrl } from "@/lib/api";
import { getStoredSessionId, clearSessionId } from "@/lib/session";
import { SessionExpiredError } from "@/lib/api";

const STEPS = [
  { label: "Upload" },
  { label: "People" },
  { label: "Highlights" },
  { label: "Generate" },
  { label: "Download" },
];

type DownloadState =
  | "ready"       // waiting for user to click Download
  | "confirming"  // confirmation modal open
  | "downloading" // download in progress
  | "success"     // download complete, assets deleted
  | "error"       // download failed (assets NOT yet deleted)
  | "expired";    // session has expired

export default function DownloadPage() {
  const router = useRouter();
  const sessionId = getStoredSessionId();

  const [downloadState, setDownloadState] = useState<DownloadState>("ready");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  if (!sessionId) {
    return (
      <div className="space-y-8">
        <StepNav steps={STEPS} currentStep={4} />
        <Banner variant="error">
          No active session found. Please start a new reel.
        </Banner>
        <Button onClick={() => router.push("/upload")}>Start over</Button>
      </div>
    );
  }

  /**
   * Triggers the browser download via an invisible anchor element.
   * The signed URL is NEVER shown to the user.
   */
  const triggerBrowserDownload = useCallback((signedUrl: string) => {
    const a = document.createElement("a");
    a.href = signedUrl;
    a.download = "hypereels-reel.mp4";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke any object URL if it was a blob (it won't be here, but good hygiene)
  }, []);

  const performDownload = useCallback(async () => {
    setShowConfirmModal(false);
    setDownloadState("downloading");
    setDownloadError(null);

    try {
      const { download_url } = await getDownloadUrl(sessionId);

      // The signed URL must never appear in the UI — trigger download silently
      triggerBrowserDownload(download_url);

      setDownloadState("success");
      clearSessionId();
    } catch (err: unknown) {
      if (err instanceof SessionExpiredError) {
        setDownloadState("expired");
        clearSessionId();
        return;
      }
      const msg = err instanceof Error ? err.message : "Download failed. Please try again.";
      setDownloadError(msg);
      setDownloadState("error");
    }
  }, [sessionId, triggerBrowserDownload]);

  const handleDownloadClick = useCallback(() => {
    // First attempt or re-confirmation after error: show modal
    setShowConfirmModal(true);
    setDownloadState("confirming");
  }, []);

  const handleRetry = useCallback(async () => {
    // On retry: do NOT show the deletion confirmation again per spec
    setRetryCount((c) => c + 1);
    setDownloadState("downloading");
    setDownloadError(null);

    try {
      const { download_url } = await getDownloadUrl(sessionId);
      triggerBrowserDownload(download_url);
      setDownloadState("success");
      clearSessionId();
    } catch (err: unknown) {
      if (err instanceof SessionExpiredError) {
        setDownloadState("expired");
        clearSessionId();
        return;
      }
      const msg = err instanceof Error ? err.message : "Download failed. Please try again.";
      setDownloadError(msg);
      setDownloadState("error");
    }
  }, [sessionId, triggerBrowserDownload]);

  // ─── Session expired state ───
  if (downloadState === "expired") {
    return (
      <div className="space-y-8">
        <StepNav steps={STEPS} currentStep={4} />
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center space-y-4">
          <div className="text-4xl" aria-hidden="true">⏰</div>
          <h2 className="text-xl font-bold text-white">Session expired</h2>
          <p className="text-gray-400 text-sm max-w-md mx-auto">
            Your session has expired. All files have been deleted.
          </p>
          <Button onClick={() => router.push("/upload")} className="mt-4">
            Create a new reel
          </Button>
        </div>
      </div>
    );
  }

  // ─── Success state ───
  if (downloadState === "success") {
    return (
      <div className="space-y-8">
        <StepNav steps={STEPS} currentStep={4} />
        <div className="bg-green-950 border border-green-800 rounded-xl p-8 text-center space-y-4">
          <div className="text-4xl" aria-hidden="true">✓</div>
          <h2 className="text-xl font-bold text-green-300">Download complete</h2>
          <p className="text-green-400 text-sm">
            Your files have been permanently deleted from the server.
          </p>
        </div>
        <div className="text-center">
          <Button
            variant="secondary"
            onClick={() => router.push("/upload")}
          >
            Create another reel
          </Button>
        </div>
      </div>
    );
  }

  // ─── Main download screen ───
  return (
    <div className="space-y-8">
      <StepNav steps={STEPS} currentStep={4} />

      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Your Reel is Ready</h1>
        <p className="text-gray-400 text-sm">
          Download your beat-synced hype reel before your session expires.
        </p>
      </div>

      {/* Ephemeral warning — persistent, required by spec */}
      <Banner variant="warning" title="One-time download">
        After downloading, all your files — clips, audio, and the reel — will
        be permanently deleted. This is your only opportunity to save the reel.
      </Banner>

      {/* Error state */}
      {downloadState === "error" && downloadError && (
        <Banner variant="error" title="Download failed">
          {downloadError}
          {retryCount >= 2 && (
            <p className="mt-2 text-sm">
              Your files are still available. Session ID for support:{" "}
              <span className="font-mono text-xs break-all">{sessionId}</span>
            </p>
          )}
        </Banner>
      )}

      {/* Download CTA */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 flex flex-col items-center gap-6">
        <div className="text-6xl" aria-hidden="true">🎬</div>

        <div className="text-center">
          <h2 className="text-lg font-semibold text-white mb-1">
            hypereels-reel.mp4
          </h2>
          <p className="text-sm text-gray-500">
            Your beat-synced highlight reel
          </p>
        </div>

        {downloadState === "error" ? (
          <Button
            size="lg"
            onClick={handleRetry}
            loading={downloadState === "downloading"}
          >
            Try Download Again
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={handleDownloadClick}
            loading={downloadState === "downloading"}
            loadingText="Preparing download…"
            disabled={downloadState === "downloading" || downloadState === "confirming"}
          >
            Download Reel
          </Button>
        )}

        <p className="text-xs text-gray-600 text-center max-w-xs">
          Clicking download will permanently delete all source files after the
          download begins.
        </p>
      </div>

      {/* Confirmation modal — shown before first download only */}
      <Modal
        open={showConfirmModal}
        title="Download and delete all files?"
        confirmLabel="Download and delete"
        cancelLabel="Cancel"
        confirmVariant="danger"
        onConfirm={performDownload}
        onCancel={() => {
          setShowConfirmModal(false);
          setDownloadState("ready");
        }}
      >
        <p>
          Downloading will permanently delete all your files — clips, audio, and
          the reel — from the server. This cannot be undone.
        </p>
        <p className="mt-3 font-semibold text-yellow-300">
          Make sure your download completes before closing this page.
        </p>
      </Modal>
    </div>
  );
}
