"use client";

import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import type { AudioTrack, UploadState } from "@/types";
import { formatBytes, formatDuration } from "@/lib/validation";

interface AudioUploadState {
  file: File | null;
  state: UploadState;
  progress: number;
  error?: string;
  confirmed?: AudioTrack;
}

interface AudioItemProps {
  audioState: AudioUploadState;
  onRemove: () => void;
  onRetry: () => void;
}

export function AudioItem({ audioState, onRemove, onRetry }: AudioItemProps) {
  const { file, state, progress, error, confirmed } = audioState;
  const displayFile = file;
  const isError = state === "invalid" || state === "upload_error";
  const isComplete = state === "complete";
  const isUploading = state === "uploading";

  if (!displayFile) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <span className="text-lg">🎵</span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium text-gray-200 truncate"
            title={displayFile.name}
          >
            {displayFile.name}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {formatBytes(displayFile.size)}
            {confirmed?.duration_ms != null &&
              ` · ${formatDuration(confirmed.duration_ms)}`}
          </p>

          <div className="mt-2">
            {isUploading && (
              <ProgressBar
                value={progress}
                ariaLabel={`Uploading ${displayFile.name}`}
                showPercentage
              />
            )}
            {!isUploading && (
              <span
                className={[
                  "text-xs font-medium",
                  isError
                    ? "text-red-400"
                    : isComplete
                      ? "text-green-400"
                      : "text-gray-400",
                ].join(" ")}
                aria-live="polite"
              >
                {isError && <span aria-hidden="true">✕ </span>}
                {isComplete && <span aria-hidden="true">✓ </span>}
                {isComplete ? "Ready" : isError ? "Upload failed" : "Queued"}
              </span>
            )}
            {error && (
              <p className="text-xs text-red-400 mt-1" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 shrink-0">
          {state === "upload_error" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              aria-label={`Retry audio upload for ${displayFile.name}`}
            >
              Retry
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label="Remove audio track"
            disabled={isUploading}
          >
            Replace
          </Button>
        </div>
      </div>
    </div>
  );
}
