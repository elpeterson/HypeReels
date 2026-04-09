import { Check, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PersonGroup } from '@/types'

const LOW_CONFIDENCE_THRESHOLD = 0.7

interface PersonCardProps {
  group: PersonGroup
  isSelected: boolean
  onSelect: (personRefId: string) => void
  isDisabled?: boolean
}

export function PersonCard({
  group,
  isSelected,
  onSelect,
  isDisabled = false,
}: PersonCardProps) {
  const isLowConfidence = group.confidence < LOW_CONFIDENCE_THRESHOLD
  const confidencePct = Math.round(group.confidence * 100)

  return (
    <button
      type="button"
      onClick={() => !isDisabled && onSelect(group.personRefId)}
      disabled={isDisabled}
      aria-pressed={isSelected}
      aria-label={`Select person appearing in ${group.clipIds.length} clip${group.clipIds.length !== 1 ? 's' : ''}${isLowConfidence ? ' (low confidence detection)' : ''}`}
      className={cn(
        'relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 text-left transition-all',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        isSelected
          ? 'border-brand-600 bg-brand-50 shadow-md'
          : 'border-gray-200 bg-white hover:border-brand-300 hover:shadow-sm',
        isDisabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      {/* Selected checkmark */}
      {isSelected && (
        <div
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600"
          aria-hidden="true"
        >
          <Check className="h-3 w-3 text-white" />
        </div>
      )}

      {/* Thumbnail */}
      <div className="relative h-24 w-24 overflow-hidden rounded-full bg-gray-100 ring-2 ring-offset-2 transition-all"
           style={{ ringColor: isSelected ? 'var(--brand-600)' : 'transparent' }}>
        <img
          src={group.thumbnailUrl}
          alt="Detected person"
          className="h-full w-full object-cover"
          onError={(e) => {
            const el = e.target as HTMLImageElement
            el.style.display = 'none'
          }}
        />
      </div>

      {/* Clip count */}
      <p className="text-xs font-medium text-gray-700 text-center">
        Appears in {group.clipIds.length}{' '}
        {group.clipIds.length === 1 ? 'clip' : 'clips'}
      </p>

      {/* Low confidence badge */}
      {isLowConfidence && (
        <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          Low confidence ({confidencePct}%)
        </span>
      )}
    </button>
  )
}
