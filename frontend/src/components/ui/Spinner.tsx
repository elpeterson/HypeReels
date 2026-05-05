interface SpinnerProps {
  label?: string;
  size?: "sm" | "md" | "lg";
}

const sizeClasses = {
  sm: "w-4 h-4 border-2",
  md: "w-8 h-8 border-2",
  lg: "w-12 h-12 border-3",
};

export function Spinner({ label = "Loading…", size = "md" }: SpinnerProps) {
  return (
    <div role="status" className="inline-flex flex-col items-center gap-3">
      <div
        aria-hidden="true"
        className={`${sizeClasses[size]} border-red-500 border-t-transparent rounded-full animate-spin`}
      />
      <span className="sr-only">{label}</span>
      {label && (
        <span aria-hidden="true" className="text-sm text-gray-400">
          {label}
        </span>
      )}
    </div>
  );
}
