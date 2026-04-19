import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { EphemeralWarningBanner } from './EphemeralWarningBanner'
import { useSessionStore } from '@/store'

// Reset store before each test
beforeEach(() => {
  useSessionStore.setState({ ephemeralWarningDismissed: false })
})

describe('EphemeralWarningBanner', () => {
  it('renders the ephemeral warning when not dismissed', () => {
    render(<EphemeralWarningBanner />)
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.getByText(/permanently deleted/i)).toBeInTheDocument()
    expect(screen.getByText(/no recovery/i)).toBeInTheDocument()
  })

  it('renders nothing when already dismissed', () => {
    useSessionStore.setState({ ephemeralWarningDismissed: true })
    const { container } = render(<EphemeralWarningBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('dismisses when the X button is clicked', () => {
    render(<EphemeralWarningBanner />)
    const dismissBtn = screen.getByRole('button', { name: /dismiss/i })
    fireEvent.click(dismissBtn)
    expect(useSessionStore.getState().ephemeralWarningDismissed).toBe(true)
  })

  it('disappears from DOM after dismissal', () => {
    const { rerender } = render(<EphemeralWarningBanner />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    rerender(<EphemeralWarningBanner />)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})
