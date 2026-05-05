import React from "react";

type BannerVariant = "warning" | "error" | "info" | "success";

interface BannerProps {
  variant: BannerVariant;
  title?: string;
  children: React.ReactNode;
  onDismiss?: () => void;
  role?: "alert" | "status";
}

const variantStyles: Record<
  BannerVariant,
  { container: string; icon: string }
> = {
  warning: {
    container: "bg-yellow-950 border border-yellow-700 text-yellow-200",
    icon: "⚠",
  },
  error: {
    container: "bg-red-950 border border-red-700 text-red-200",
    icon: "✕",
  },
  info: {
    container: "bg-blue-950 border border-blue-700 text-blue-200",
    icon: "ℹ",
  },
  success: {
    container: "bg-green-950 border border-green-700 text-green-200",
    icon: "✓",
  },
};

export function Banner({
  variant,
  title,
  children,
  onDismiss,
  role = "alert",
}: BannerProps) {
  const styles = variantStyles[variant];

  return (
    <div
      role={role}
      className={`rounded-lg p-4 ${styles.container}`}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-lg leading-none mt-0.5 shrink-0">
          {styles.icon}
        </span>
        <div className="flex-1 min-w-0">
          {title && (
            <p className="font-semibold text-sm mb-1">{title}</p>
          )}
          <div className="text-sm leading-relaxed">{children}</div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="shrink-0 text-current opacity-60 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-current rounded"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
    </div>
  );
}
