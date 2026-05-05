"use client";

import React, { useRef, useState, useCallback, DragEvent } from "react";

interface DropZoneProps {
  id: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  label: string;
  subLabel?: string;
  onFiles: (files: File[]) => void;
  "aria-describedby"?: string;
}

/**
 * Accessible drag-and-drop + file picker zone.
 *
 * - Keyboard accessible via button interaction.
 * - Visible label (not placeholder-only).
 * - Color is not the only indicator of drag state (text changes too).
 */
export function DropZone({
  id,
  accept,
  multiple = false,
  disabled = false,
  label,
  subLabel,
  onFiles,
  "aria-describedby": ariaDescribedBy,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      onFiles(Array.from(files));
    },
    [onFiles]
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Only leave if we're leaving the zone entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  };

  const handleClick = () => {
    if (!disabled) inputRef.current?.click();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
    // Reset input so the same file can be re-selected if needed
    e.target.value = "";
  };

  return (
    <div>
      <label id={`${id}-label`} className="block text-sm font-medium text-gray-300 mb-2">
        {label}
      </label>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-describedby={ariaDescribedBy}
        aria-disabled={disabled}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={[
          "relative border-2 border-dashed rounded-xl p-8 text-center transition-all",
          "focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-950",
          disabled
            ? "border-gray-800 bg-gray-900/30 cursor-not-allowed"
            : isDragging
              ? "border-red-500 bg-red-950/30 cursor-copy"
              : "border-gray-700 hover:border-gray-500 bg-gray-900/50 cursor-pointer",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={handleInputChange}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />

        <div className="pointer-events-none">
          <div
            className={`text-3xl mb-3 ${isDragging ? "text-red-400" : "text-gray-600"}`}
            aria-hidden="true"
          >
            {isDragging ? "↓" : "↑"}
          </div>
          <p
            className={`font-medium text-sm mb-1 ${
              isDragging ? "text-red-300" : disabled ? "text-gray-600" : "text-gray-300"
            }`}
          >
            {isDragging ? "Drop files here" : "Drag files here or click to browse"}
          </p>
          {subLabel && (
            <p className="text-xs text-gray-500 mt-1" id={ariaDescribedBy}>
              {subLabel}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
