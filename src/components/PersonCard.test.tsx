import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PersonCard } from './PersonCard'
import type { PersonGroup } from '@/types'

const highConfidenceGroup: PersonGroup = {
  personRefId: 'ref-A',
  thumbnailUrl: 'https://example.com/person-a.jpg',
  confidence: 0.92,
  clipIds: ['clip-1', 'clip-2'],
  totalAppearances: 5,
}

const lowConfidenceGroup: PersonGroup = {
  personRefId: 'ref-B',
  thumbnailUrl: 'https://example.com/person-b.jpg',
  confidence: 0.55,
  clipIds: ['clip-1'],
  totalAppearances: 2,
}

describe('PersonCard — accessibility', () => {
  it('has aria-pressed reflecting selection state', () => {
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={vi.fn()}
      />
    )
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('has aria-pressed=true when selected', () => {
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={true}
        onSelect={vi.fn()}
      />
    )
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('has accessible aria-label describing the person', () => {
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={vi.fn()}
      />
    )
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-label')
    expect(btn.getAttribute('aria-label')).toMatch(/2 clip/i)
  })

  it('thumbnail image has descriptive alt text', () => {
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={vi.fn()}
      />
    )
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('alt')
    expect(img.getAttribute('alt')).not.toBe('')
  })

  it('shows low confidence badge when confidence < 0.7', () => {
    render(
      <PersonCard
        group={lowConfidenceGroup}
        isSelected={false}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText(/low confidence/i)).toBeInTheDocument()
  })

  it('does not show low confidence badge for high-confidence detection', () => {
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={vi.fn()}
      />
    )
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument()
  })

  it('calls onSelect with personRefId when clicked', () => {
    const onSelect = vi.fn()
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith('ref-A')
  })

  it('does not call onSelect when disabled', () => {
    const onSelect = vi.fn()
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={onSelect}
        isDisabled={true}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('is keyboard-reachable (not disabled prevents focus)', () => {
    render(
      <PersonCard
        group={highConfidenceGroup}
        isSelected={false}
        onSelect={vi.fn()}
      />
    )
    const btn = screen.getByRole('button')
    expect(btn).not.toHaveAttribute('tabindex', '-1')
  })
})
