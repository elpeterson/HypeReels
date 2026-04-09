import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format milliseconds as M:SS or M:SS.mmm
 */
export function formatMs(ms: number, includeMs = false): string {
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const milliseconds = Math.floor(ms % 1000)

  const mm = String(minutes)
  const ss = String(seconds).padStart(2, '0')

  if (includeMs) {
    const mmm = String(milliseconds).padStart(3, '0')
    return `${mm}:${ss}.${mmm}`
  }
  return `${mm}:${ss}`
}

/**
 * Parse a "M:SS.mmm" string back to milliseconds.
 * Returns NaN if invalid.
 */
export function parseTimestamp(value: string): number {
  const match = value.match(/^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/)
  if (!match) return NaN
  const minutes = parseInt(match[1], 10)
  const seconds = parseInt(match[2], 10)
  const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0
  return (minutes * 60 + seconds) * 1000 + ms
}

/**
 * Format bytes as a human-readable string (e.g., "45.2 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * Merge overlapping highlight ranges. Assumes ranges are objects with startMs/endMs.
 */
export function mergeHighlightRanges(
  ranges: Array<{ startMs: number; endMs: number }>
): Array<{ startMs: number; endMs: number }> {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs)
  const merged: Array<{ startMs: number; endMs: number }> = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    const last = merged[merged.length - 1]
    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs)
    } else {
      merged.push({ ...current })
    }
  }
  return merged
}

/**
 * Sum total duration of an array of {startMs, endMs} ranges in ms.
 */
export function totalRangeDurationMs(
  ranges: Array<{ startMs: number; endMs: number }>
): number {
  return ranges.reduce((acc, r) => acc + (r.endMs - r.startMs), 0)
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Debounce a function.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}
