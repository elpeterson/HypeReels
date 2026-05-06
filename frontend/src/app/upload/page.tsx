"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { DropZone } from "@/components/upload/DropZone";
import { ClipItem } from "@/components/upload/ClipItem";
import { AudioItem } from "@/components/upload/AudioItem";
import { EphemeralWarningBanner } from "@/components/upload/EphemeralWarningBanner";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { StepNav } from "@/components/ui/StepNav";
import {
  requestClipUploadUrl,
  confirmClipUpload,
  deleteClip,
  requestAudioUploadUrl,
  confirmAudioUpload,
  uploadFileToStorage,
  createSession,
  getSession,
  ApiError,
} from "@/lib/api";
import { getStoredSessionId, storeSessionId, clearSessionId } from "@/lib/session";
import { validateVideoFile, validateAudioFile } from "@/lib/validation";
import { MAX_CLIPS, ACCEPTED_VIDEO_EXTENSIONS, ACCEPTED_AUDIO_EXTENSIONS } from "@/lib/env";
import type { FileUploadEntry, UploadState, AudioTrack } from "@/types";

const STEPS = [
  { label: "Upload" },
  { label: "People" },
  { label: "Highlights" },
  { label: "Generate" },
  { label: "Download" },
];

interface AudioUploadState {
  file: File | null;
  state: UploadState;
  progress: number;
  error?: string;
  confirmed?: AudioTrack;
}

interface ClipEntry extends FileUploadEntry {
  localId: string;
  thumbnailUrl?: string | null;
}

export default function UploadPage() {
  const router = useRouter();
  const sessionIdRef = useRef<string | null>(null);

  const [clips, setClips] = useState<ClipEntry[]>([]);
  const [audio, setAudio] = useState<AudioUploadState>({
    file: null,
    state: "idle",
    progress: 0,
  });
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [showReplaceAudioModal, setShowReplaceAudioModal] = useState(false);
  const [pendingAudioFile, setPendingAudioFile] = useState<File | null>(null);

  // Initialize or retrieve session, validating that the stored ID still exists.
  // After a container restart Redis is wiped — the stale ID causes 404s on every
  // upload. When validation returns 404/410 we clear localStorage and start fresh.
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const stored = getStoredSessionId();
    if (stored) {
      try {
        await getSession(stored);
        // Session still alive in the backend.
        sessionIdRef.current = stored;
        return stored;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
          // Session is gone (backend restart / Redis wipe / TTL expiry).
          // Clear the stale ID so we create a fresh session below.
          clearSessionId();
        } else {
          // Network error or unexpected server error — use stored ID optimistically
          // so the upload attempt surfaces the real error to the user.
          sessionIdRef.current = stored;
          return stored;
        }
      }
    }
    const id = await createSession();
    storeSessionId(id);
    sessionIdRef.current = id;
    return id;
  }, []);

  // ─── Clip upload ───

  const uploadClip = useCallback(
    async (localId: string, file: File, sessionId: string) => {
      setClips((prev) =>
        prev.map((c) =>
          c.localId === localId ? { ...c, state: "uploading" as UploadState } : c
        )
      );

      try {
        const { clip_id, upload_url } = await requestClipUploadUrl(
          sessionId,
          file.name,
          file.size,
          file
        );

        if (!clip_id) {
          throw new Error("Server did not return a clip ID.");
        }

        // Stash clip_id in entry
        setClips((prev) =>
          prev.map((c) => (c.localId === localId ? { ...c, clip_id } : c))
        );

        await uploadFileToStorage(upload_url, file, (pct) => {
          setClips((prev) =>
            prev.map((c) =>
              c.localId === localId ? { ...c, progress: pct } : c
            )
          );
        });

        await confirmClipUpload(sessionId, clip_id);

        setClips((prev) =>
          prev.map((c) =>
            c.localId === localId
              ? { ...c, state: "complete" as UploadState, progress: 100 }
              : c
          )
        );
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Upload failed. Please retry.";
        setClips((prev) =>
          prev.map((c) =>
            c.localId === localId
              ? { ...c, state: "upload_error" as UploadState, error: msg }
              : c
          )
        );
      }
    },
    []
  );

  const handleClipFiles = useCallback(
    async (files: File[]) => {
      setGlobalError(null);
      const validatedEntries: ClipEntry[] = [];
      const errors: string[] = [];

      let currentCount = clips.length;

      for (const file of files) {
        const validation = validateVideoFile(file, currentCount);
        if (!validation.valid) {
          errors.push(validation.error ?? "Invalid file");
          continue;
        }
        currentCount += 1;
        const entry: ClipEntry = {
          localId: uuidv4(),
          file,
          state: "idle",
          progress: 0,
        };
        validatedEntries.push(entry);
      }

      if (errors.length > 0) {
        setGlobalError(errors.join("\n"));
      }

      if (validatedEntries.length === 0) return;

      setClips((prev) => [...prev, ...validatedEntries]);

      try {
        const sessionId = await ensureSession();
        for (const entry of validatedEntries) {
          uploadClip(entry.localId, entry.file, sessionId);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to start session.";
        setGlobalError(msg);
        // Mark entries as errored
        setClips((prev) =>
          prev.map((c) =>
            validatedEntries.some((e) => e.localId === c.localId)
              ? { ...c, state: "upload_error" as UploadState, error: msg }
              : c
          )
        );
      }
    },
    [clips.length, ensureSession, uploadClip]
  );

  const handleRetryClip = useCallback(
    (localId: string) => {
      const entry = clips.find((c) => c.localId === localId);
      if (!entry || !sessionIdRef.current) return;
      uploadClip(localId, entry.file, sessionIdRef.current);
    },
    [clips, uploadClip]
  );

  const handleRemoveClip = useCallback(
    async (localId: string) => {
      const entry = clips.find((c) => c.localId === localId);
      setClips((prev) => prev.filter((c) => c.localId !== localId));

      if (entry?.clip_id && sessionIdRef.current) {
        try {
          await deleteClip(sessionIdRef.current, entry.clip_id);
        } catch {
          // Non-blocking — clip is already removed from UI
        }
      }
    },
    [clips]
  );

  // ─── Audio upload ───

  const uploadAudio = useCallback(
    async (file: File, sessionId: string) => {
      setAudio({ file, state: "uploading", progress: 0 });

      try {
        const { upload_url } = await requestAudioUploadUrl(
          sessionId,
          file.name,
          file.size,
          file
        );

        await uploadFileToStorage(upload_url, file, (pct) => {
          setAudio((prev) => ({ ...prev, progress: pct }));
        });

        await confirmAudioUpload(sessionId);

        setAudio((prev) => ({
          ...prev,
          state: "complete",
          progress: 100,
        }));
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Audio upload failed. Please retry.";
        setAudio((prev) => ({
          ...prev,
          state: "upload_error",
          error: msg,
        }));
      }
    },
    []
  );

  const doUploadAudio = useCallback(
    async (file: File) => {
      setGlobalError(null);
      const validation = validateAudioFile(file);
      if (!validation.valid) {
        setAudio({
          file,
          state: "invalid",
          progress: 0,
          error: validation.error,
        });
        return;
      }

      try {
        const sessionId = await ensureSession();
        await uploadAudio(file, sessionId);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to start session.";
        setGlobalError(msg);
      }
    },
    [ensureSession, uploadAudio]
  );

  const handleAudioFiles = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;

      // Show replace confirmation if audio already exists
      if (audio.file && audio.state !== "invalid") {
        setPendingAudioFile(file);
        setShowReplaceAudioModal(true);
        return;
      }

      doUploadAudio(file);
    },
    [audio.file, audio.state, doUploadAudio]
  );

  const handleConfirmReplaceAudio = useCallback(() => {
    setShowReplaceAudioModal(false);
    if (pendingAudioFile) {
      doUploadAudio(pendingAudioFile);
      setPendingAudioFile(null);
    }
  }, [pendingAudioFile, doUploadAudio]);

  const handleRemoveAudio = useCallback(() => {
    setAudio({ file: null, state: "idle", progress: 0 });
  }, []);

  const handleRetryAudio = useCallback(() => {
    if (audio.file) {
      doUploadAudio(audio.file);
    }
  }, [audio.file, doUploadAudio]);

  // ─── Navigation ───

  const canProceed =
    clips.some((c) => c.state === "complete") && audio.state === "complete";

  const handleProceed = useCallback(() => {
    router.push("/person-selection");
  }, [router]);

  const uploadingCount = clips.filter((c) => c.state === "uploading").length;
  const totalProgress =
    clips.length > 0
      ? Math.round(
          clips.reduce((sum, c) => sum + c.progress, 0) / clips.length
        )
      : 0;

  return (
    <div className="space-y-8">
      {/* Step navigation */}
      <StepNav steps={STEPS} currentStep={0} />

      {/* Ephemeral session warning — shown once */}
      {!warningDismissed && (
        <EphemeralWarningBanner onDismiss={() => setWarningDismissed(true)} />
      )}

      {/* Global errors */}
      {globalError && (
        <Banner variant="error" onDismiss={() => setGlobalError(null)}>
          {globalError.split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </Banner>
      )}

      {/* Overall progress while uploading */}
      {uploadingCount > 0 && (
        <div aria-live="polite" className="text-sm text-gray-400">
          Uploading {uploadingCount} clip{uploadingCount !== 1 ? "s" : ""}…{" "}
          {totalProgress}% complete
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        {/* ── Video Clips ── */}
        <section aria-labelledby="clips-heading">
          <h2 id="clips-heading" className="text-lg font-semibold text-white mb-4">
            Video Clips
            <span className="ml-2 text-sm font-normal text-gray-500">
              {clips.length}/{MAX_CLIPS}
            </span>
          </h2>

          <DropZone
            id="clip-upload"
            accept={ACCEPTED_VIDEO_EXTENSIONS.join(",")}
            multiple
            disabled={clips.length >= MAX_CLIPS}
            label="Add video clips"
            subLabel={`MP4, MOV, MKV, WebM · Up to ${MAX_CLIPS} clips`}
            onFiles={handleClipFiles}
            aria-describedby="clip-upload-hint"
          />

          {clips.length > 0 && (
            <ul
              className="mt-4 space-y-3"
              aria-label="Uploaded clips"
              aria-live="polite"
            >
              {clips.map((entry) => (
                <ClipItem
                  key={entry.localId}
                  entry={entry}
                  thumbnailUrl={entry.thumbnailUrl}
                  onRemove={() => handleRemoveClip(entry.localId)}
                  onRetry={() => handleRetryClip(entry.localId)}
                />
              ))}
            </ul>
          )}

          {clips.length === 0 && (
            <p className="text-sm text-gray-500 mt-3">
              No clips added yet. You can add up to {MAX_CLIPS} clips.
            </p>
          )}
        </section>

        {/* ── Audio Track ── */}
        <section aria-labelledby="audio-heading">
          <h2 id="audio-heading" className="text-lg font-semibold text-white mb-4">
            Audio Track
          </h2>

          {audio.file === null ? (
            <DropZone
              id="audio-upload"
              accept={ACCEPTED_AUDIO_EXTENSIONS.join(",")}
              multiple={false}
              label="Add your song"
              subLabel="MP3, WAV, AAC, FLAC, M4A · Max 200 MB"
              onFiles={handleAudioFiles}
              aria-describedby="audio-upload-hint"
            />
          ) : (
            <AudioItem
              audioState={audio}
              onRemove={handleRemoveAudio}
              onRetry={handleRetryAudio}
            />
          )}
        </section>
      </div>

      {/* Continue button */}
      <div className="flex justify-end pt-4 border-t border-gray-800">
        <Button
          size="lg"
          disabled={!canProceed}
          onClick={handleProceed}
          aria-describedby={!canProceed ? "proceed-hint" : undefined}
        >
          Continue to Person Selection →
        </Button>
        {!canProceed && (
          <p id="proceed-hint" className="sr-only">
            Upload at least one clip and an audio track to continue.
          </p>
        )}
      </div>

      {/* Replace audio confirmation modal */}
      <Modal
        open={showReplaceAudioModal}
        title="Replace existing audio?"
        confirmLabel="Replace audio"
        cancelLabel="Keep current"
        onConfirm={handleConfirmReplaceAudio}
        onCancel={() => {
          setShowReplaceAudioModal(false);
          setPendingAudioFile(null);
        }}
      >
        <p>
          You already have an audio track uploaded. Replacing it will discard
          the current track.
        </p>
      </Modal>
    </div>
  );
}
