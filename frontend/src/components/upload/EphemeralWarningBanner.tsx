"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/Banner";

interface EphemeralWarningBannerProps {
  onDismiss?: () => void;
}

/**
 * Shown once on first upload interaction.
 * Per agent spec: "Show ephemeral session warning on first upload."
 */
export function EphemeralWarningBanner({ onDismiss }: EphemeralWarningBannerProps) {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const handleDismiss = () => {
    setVisible(false);
    onDismiss?.();
  };

  return (
    <Banner variant="warning" title="Ephemeral session" onDismiss={handleDismiss}>
      Your files will be permanently deleted after download. There is no
      recovery. Download your reel before your session expires.
    </Banner>
  );
}
