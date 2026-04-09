import { cn } from '@/lib/utils'
import type { GenerationStep } from '@/types'

const STEP_LABELS: Record<GenerationStep, string> = {
  analysing: 'Analysing clips',
  selecting: 'Selecting moments',
  sequencing: 'Sequencing cuts',
  rendering: 'Rendering video',
  finalising: 'Finalising',
}

const STEP_ORDER: GenerationStep[] = [
  'analysing',
  'selecting',
  'sequencing',
  'rendering',
  'finalising',
]

interface JobProgressBarProps {
  step: GenerationStep | null
  pct: number
  className?: string
}

export function JobProgressBar({ step, pct, className }: JobProgressBarProps) {
  const currentStepIdx = step ? STEP_ORDER.indexOf(step) : -1

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Numeric progress */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-700">
          {step ? STEP_LABELS[step] : 'Starting…'}
        </span>
        <span className="tabular-nums text-gray-500">{pct}%</span>
      </div>

      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Generation progress: ${pct}%`}
        className="h-3 w-full overflow-hidden rounded-full bg-gray-200"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-700 transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Step indicators */}
      <ol className="flex justify-between" aria-label="Generation steps">
        {STEP_ORDER.map((s, idx) => {
          const isDone = idx < currentStepIdx
          const isCurrent = idx === currentStepIdx
          return (
            <li
              key={s}
              aria-current={isCurrent ? 'step' : undefined}
              className={cn(
                'flex flex-col items-center gap-1',
                'text-[10px] sm:text-xs'
              )}
            >
              <div
                className={cn(
                  'h-2 w-2 rounded-full',
                  isDone && 'bg-brand-600',
                  isCurrent && 'bg-brand-600 ring-4 ring-brand-200',
                  !isDone && !isCurrent && 'bg-gray-300'
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'hidden sm:block',
                  isCurrent && 'font-semibold text-brand-700',
                  isDone && 'text-brand-600',
                  !isDone && !isCurrent && 'text-gray-400'
                )}
              >
                {STEP_LABELS[s]}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
