import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { PersonSelectionPage } from './PersonSelectionPage'
import { useSessionStore } from '@/store'
import * as personsApi from '@/api/persons'
import * as sseLib from '@/lib/sse'

vi.mock('@/api/persons')
vi.mock('@/lib/sse', () => ({
  connectSSE: vi.fn(() => ({ disconnect: vi.fn() })),
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

function renderPage() {
  return render(
    <MemoryRouter>
      <PersonSelectionPage />
    </MemoryRouter>
  )
}

const validClip = {
  id: 'clip-1',
  sessionId: 'sess-1',
  originalFilename: 'test.mp4',
  fileSizeBytes: 1024,
  durationMs: 5000,
  thumbnailUrl: null,
  status: 'valid' as const,
  validationError: null,
  detectionStatus: 'pending' as const,
  uploadProgress: 100,
  uploadError: null,
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: 'sess-1',
    token: 'tok-1',
    clips: [validClip],
    persons: [],
    selectedPersonRefId: null,
  })
  vi.clearAllMocks()
})

describe('PersonSelectionPage — detection flow', () => {
  it('triggers detection on mount and shows loading state', async () => {
    vi.mocked(personsApi.triggerDetection).mockResolvedValue(undefined)
    renderPage()
    // Should show detecting state
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText(/detecting people/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(personsApi.triggerDetection).toHaveBeenCalledWith('sess-1')
    })
  })

  it('shows detection error verbatim from API (not generic)', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(personsApi.triggerDetection).mockRejectedValue(
      new ApiError('Detection service unavailable', 503)
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/Detection service unavailable/i)).toBeInTheDocument()
    })
  })

  it('shows empty state with both options when no persons detected', async () => {
    vi.mocked(personsApi.triggerDetection).mockResolvedValue(undefined)
    // Simulate all clips already complete with no persons
    useSessionStore.setState({
      clips: [{ ...validClip, detectionStatus: 'complete' }],
      persons: [],
    })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/no people detected/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /continue without selecting/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /upload different clips/i })).toBeInTheDocument()
    })
  })

  it('polls getPersons every 3s as fallback while waiting', async () => {
    vi.useFakeTimers()
    vi.mocked(personsApi.triggerDetection).mockResolvedValue(undefined)
    vi.mocked(personsApi.getPersons).mockResolvedValue([])
    renderPage()

    await act(async () => {
      await vi.runAllTicks()
    })

    // Fast-forward 3 seconds — one poll cycle
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await vi.runAllTicks()
    })

    expect(personsApi.getPersons).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
