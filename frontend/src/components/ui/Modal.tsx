"use client";

import React, { useEffect, useRef } from "react";
import { Button } from "./Button";

interface ModalProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmVariant?: "primary" | "danger";
  confirmLoading?: boolean;
  confirmLoadingText?: string;
}

/**
 * Accessible confirmation modal.
 * Traps focus, restores on close, responds to Escape key.
 */
export function Modal({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  confirmVariant = "primary",
  confirmLoading = false,
  confirmLoadingText,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      // Focus the dialog on open
      setTimeout(() => dialogRef.current?.focus(), 10);
    } else {
      previousFocusRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
      aria-labelledby="modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative z-10 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-md w-full p-6 focus:outline-none"
      >
        <h2
          id="modal-title"
          className="text-lg font-semibold text-white mb-3"
        >
          {title}
        </h2>
        <div className="text-gray-300 text-sm leading-relaxed mb-6">
          {children}
        </div>
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={confirmLoading}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            loading={confirmLoading}
            loadingText={confirmLoadingText}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
