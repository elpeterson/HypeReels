import { describe, it, expect } from 'vitest'
import {
  formatMs,
  parseTimestamp,
  formatBytes,
  mergeHighlightRanges,
  clamp,
} from './utils'

describe('formatMs', () => {
  it('formats seconds correctly', () => {
    expect(formatMs(0)).toBe('0:00')
    expect(formatMs(1000)).toBe('0:01')
    expect(formatMs(61000)).toBe('1:01')
    expect(formatMs(3600000)).toBe('60:00')
  })

  it('includes milliseconds when requested', () => {
    expect(formatMs(1500, true)).toBe('0:01.500')
    expect(formatMs(61250, true)).toBe('1:01.250')
  })
})

describe('parseTimestamp', () => {
  it('parses valid timestamps', () => {
    expect(parseTimestamp('0:00')).toBe(0)
    expect(parseTimestamp('0:01')).toBe(1000)
    expect(parseTimestamp('1:01')).toBe(61000)
    expect(parseTimestamp('0:01.500')).toBe(1500)
  })

  it('returns NaN for invalid input', () => {
    expect(parseTimestamp('abc')).toBeNaN()
    expect(parseTimestamp('1:60')).toBeNaN()
    expect(parseTimestamp('')).toBeNaN()
  })
})

describe('formatBytes', () => {
  it('formats byte values', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})

describe('mergeHighlightRanges', () => {
  it('returns empty array for empty input', () => {
    expect(mergeHighlightRanges([])).toEqual([])
  })

  it('keeps non-overlapping ranges separate', () => {
    const ranges = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ]
    expect(mergeHighlightRanges(ranges)).toEqual(ranges)
  })

  it('merges overlapping ranges', () => {
    const ranges = [
      { startMs: 0, endMs: 2000 },
      { startMs: 1000, endMs: 3000 },
    ]
    expect(mergeHighlightRanges(ranges)).toEqual([{ startMs: 0, endMs: 3000 }])
  })

  it('merges adjacent/touching ranges', () => {
    const ranges = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1000, endMs: 2000 },
    ]
    expect(mergeHighlightRanges(ranges)).toEqual([{ startMs: 0, endMs: 2000 }])
  })

  it('sorts before merging', () => {
    const ranges = [
      { startMs: 2000, endMs: 3000 },
      { startMs: 0, endMs: 1000 },
    ]
    expect(mergeHighlightRanges(ranges)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ])
  })
})

describe('clamp', () => {
  it('clamps values within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
  })
})
