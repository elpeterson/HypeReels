interface Step {
  label: string;
  href?: string;
}

interface StepNavProps {
  steps: Step[];
  currentStep: number; // 0-indexed
}

export function StepNav({ steps, currentStep }: StepNavProps) {
  return (
    <nav aria-label="Progress steps">
      <ol className="flex items-center gap-0" role="list">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isUpcoming = index > currentStep;

          return (
            <li key={step.label} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={[
                    "w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors",
                    isCompleted
                      ? "bg-red-600 border-red-600 text-white"
                      : isCurrent
                        ? "bg-transparent border-red-500 text-red-400"
                        : "bg-transparent border-gray-700 text-gray-600",
                  ].join(" ")}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {isCompleted ? (
                    <span aria-hidden="true">✓</span>
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span
                  className={[
                    "mt-1.5 text-xs font-medium whitespace-nowrap",
                    isCompleted
                      ? "text-red-400"
                      : isCurrent
                        ? "text-white"
                        : "text-gray-600",
                  ].join(" ")}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {index < steps.length - 1 && (
                <div
                  aria-hidden="true"
                  className={[
                    "flex-1 h-0.5 mx-2 mb-5",
                    isCompleted ? "bg-red-600" : "bg-gray-700",
                  ].join(" ")}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
