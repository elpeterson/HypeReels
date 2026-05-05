import React from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingText?: string;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-red-600 hover:bg-red-700 text-white border border-transparent disabled:bg-red-900 disabled:text-red-300",
  secondary:
    "bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-600 disabled:bg-gray-900 disabled:text-gray-500",
  danger:
    "bg-red-800 hover:bg-red-700 text-white border border-red-700 disabled:bg-gray-900 disabled:text-gray-500",
  ghost:
    "bg-transparent hover:bg-gray-800 text-gray-300 border border-transparent disabled:text-gray-600",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-5 py-2.5 text-sm",
  lg: "px-7 py-3 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingText,
  disabled,
  children,
  className = "",
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      {...props}
      disabled={isDisabled}
      aria-busy={loading}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium",
        "transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-950",
        "disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
        />
      )}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}
