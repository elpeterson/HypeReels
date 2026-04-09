interface WaveformDisplayProps {
  /** Array of ~200 amplitude floats (0–1). If null, shows placeholder. */
  envelope: number[] | null
  /** Whether to show a loading animation */
  isLoading?: boolean
  className?: string
  height?: number
}

export function WaveformDisplay({
  envelope,
  isLoading = false,
  className = '',
  height = 64,
}: WaveformDisplayProps) {
  const width = 600
  const midY = height / 2
  const paddingY = 4

  const toPoints = (values: number[]): string => {
    if (values.length === 0) return ''
    const step = width / (values.length - 1)
    return values
      .map((v, i) => {
        const amplitude = (v * (height / 2 - paddingY))
        return `${i * step},${midY - amplitude} `
      })
      .join('')
  }

  const mirroredPoints = (values: number[]): string => {
    if (values.length === 0) return ''
    const step = width / (values.length - 1)
    // Top half
    const top = values.map((v, i) => {
      const amplitude = v * (midY - paddingY)
      return `${i * step},${midY - amplitude}`
    })
    // Bottom half (mirrored, reversed)
    const bottom = [...values].reverse().map((v, i) => {
      const amplitude = v * (midY - paddingY)
      const x = (values.length - 1 - i) * step
      return `${x},${midY + amplitude}`
    })
    return [...top, ...bottom].join(' ')
  }

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Analysing waveform"
        className={`flex items-center justify-center rounded bg-gray-50 ${className}`}
        style={{ height }}
      >
        <div className="flex gap-1">
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-brand-300 animate-pulse"
              style={{
                height: `${20 + Math.random() * 40}px`,
                animationDelay: `${i * 50}ms`,
              }}
              aria-hidden="true"
            />
          ))}
        </div>
        <span className="sr-only">Analysing waveform…</span>
      </div>
    )
  }

  if (!envelope || envelope.length === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded bg-gray-50 text-gray-400 text-sm ${className}`}
        style={{ height }}
        aria-label="No waveform available"
      >
        No waveform data
      </div>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`w-full ${className}`}
      style={{ height }}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <polygon
        points={mirroredPoints(envelope)}
        fill="currentColor"
        className="text-brand-400"
        opacity={0.7}
      />
      <polyline
        points={toPoints(envelope)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-brand-600"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
