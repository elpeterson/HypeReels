import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Step } from '@/types'

export const STEPS: { id: Step; label: string; shortLabel: string }[] = [
  { id: 'upload-clips', label: 'Upload Clips', shortLabel: 'Clips' },
  { id: 'upload-audio', label: 'Upload Song', shortLabel: 'Song' },
  { id: 'detect-persons', label: 'Select Person', shortLabel: 'Person' },
  { id: 'mark-highlights', label: 'Mark Highlights', shortLabel: 'Highlights' },
  { id: 'review', label: 'Review', shortLabel: 'Review' },
  { id: 'generate', label: 'Generate', shortLabel: 'Generate' },
  { id: 'download', label: 'Download', shortLabel: 'Download' },
]

const STEP_ORDER: Step[] = STEPS.map((s) => s.id)

function stepIndex(step: Step): number {
  return STEP_ORDER.indexOf(step)
}

interface StepProgressBarProps {
  currentStep: Step
  isLocked?: boolean
  onStepClick?: (step: Step) => void
}

export function StepProgressBar({
  currentStep,
  isLocked = false,
  onStepClick,
}: StepProgressBarProps) {
  const currentIdx = stepIndex(currentStep)

  return (
    <>
      {/* Desktop: full step bar */}
      <nav
        aria-label="Progress"
        className="hidden md:flex items-center justify-center gap-0 w-full"
      >
        {STEPS.map((step, idx) => {
          const isCompleted = idx < currentIdx
          const isActive = idx === currentIdx
          const isClickable =
            !isLocked && isCompleted && onStepClick !== undefined

          return (
            <div key={step.id} className="flex items-center">
              <button
                type="button"
                onClick={() => isClickable && onStepClick?.(step.id)}
                disabled={!isClickable}
                aria-current={isActive ? 'step' : undefined}
                aria-label={`${step.label}${isCompleted ? ' (completed)' : ''}${isActive ? ' (current)' : ''}`}
                className={cn(
                  'flex flex-col items-center gap-1.5 px-2 group',
                  isClickable
                    ? 'cursor-pointer'
                    : 'cursor-default'
                )}
              >
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors border-2',
                    isCompleted &&
                      'bg-brand-600 border-brand-600 text-white',
                    isActive &&
                      'bg-white border-brand-600 text-brand-600',
                    !isCompleted &&
                      !isActive &&
                      'bg-white border-gray-300 text-gray-400'
                  )}
                >
                  {isCompleted ? (
                    <Check className="w-4 h-4" aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true">{idx + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    'text-xs font-medium whitespace-nowrap',
                    isActive && 'text-brand-600',
                    isCompleted && 'text-brand-600',
                    !isActive && !isCompleted && 'text-gray-400'
                  )}
                >
                  {step.label}
                </span>
              </button>

              {/* Connector line */}
              {idx < STEPS.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 w-8 lg:w-12 transition-colors',
                    idx < currentIdx ? 'bg-brand-600' : 'bg-gray-200'
                  )}
                  aria-hidden="true"
                />
              )}
            </div>
          )
        })}
      </nav>

      {/* Mobile: compact "Step N of 7" */}
      <div
        className="flex md:hidden items-center justify-between w-full"
        aria-label="Progress"
      >
        <span className="text-sm font-medium text-gray-700">
          Step {currentIdx + 1} of {STEPS.length}
        </span>
        <span className="text-sm font-semibold text-brand-600">
          {STEPS[currentIdx].label}
        </span>
      </div>
    </>
  )
}
