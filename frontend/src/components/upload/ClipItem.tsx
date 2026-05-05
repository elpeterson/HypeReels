"use client";

import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import type { FileUploadEntry } from "@/types";
import { formatBytes } from "@/lib/validation";

interface ClipItemProps {
  entry: FileUploadEntry;
  onRemove: () => void;
  onRetry: () => void;
  thumbnailUrl?: string | null;
}

const stateLabel: Record<FileUploadEntry["state"], string> = {
  idle: "Queued",
  validating: "Validating…",
  invalid: "Invalid",
  uploading: "Uploading…",
  upload_error: "Upload failed",
  complete: "Ready",
};

export function ClipItem({ entry, onRemove, onRetry, thumbnailUrl }: ClipItemProps) {
  const { file, state, progress, error } = entry;
  const isTerminal = state === "complete" || state === "invalid" || state === "upload_error";
  const isError = state === "invalid" || state === "upload_error";
  const isComplete = state === "complete";

  return (
    <li className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex gap-4 items-start">
      {/* Thumbnail */}
      <div
        className="w-16 h-10 bg-gray-800 rounded overflow-hidden shrink-0 flex items-center justify-center"
        aria-hidden="true"
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-gray-600 text-xs">🎬</span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-medium text-gray-200 truncate"
          title={file.name}
        >
          {file.name}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">{formatBytes(file.size)}</p>

        {/* State indicator */}
        <div className="mt-2">
          {!isTerminal && state === "uploading" && (
            <ProgressBar
              value={progress}
              ariaLabel={`Uploading ${file.name}`}
              showPercentage
            />
          )}
          {state !== "uploading" && (
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
              {/* Non-color indicator: icon + text */}
              {isError && <span aria-hidden="true">✕ </span>}
              {isComplete && <span aria-hidden="true">✓ </span>}
              {stateLabel[state]}
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
            aria-label={`Retry upload for ${file.name}`}
          >
            Retry
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          disabled={state === "uploading"}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}
