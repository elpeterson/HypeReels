interface ProgressBarProps {
  /** 0–100 */
  value: number;
  label?: string;
  /** Screen reader label */
  ariaLabel?: string;
  className?: string;
  showPercentage?: boolean;
}

export function ProgressBar({
  value,
  label,
  ariaLabel,
  className = "",
  showPercentage = true,
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className={className}>
      {(label || showPercentage) && (
        <div className="flex justify-between items-center mb-2">
          {label && (
            <span className="text-sm text-gray-300 font-medium">{label}</span>
          )}
          {showPercentage && (
            <span className="text-sm text-gray-400 tabular-nums">{pct}%</span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? label ?? "Progress"}
        className="h-2 bg-gray-800 rounded-full overflow-hidden"
      >
        <div
          className="h-full bg-red-500 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
