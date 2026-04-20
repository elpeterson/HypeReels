import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { GeneratePage } from './GeneratePage'
import { useSessionStore } from '@/store'
import * as generationApi from '@/api/generation'
import * as sseLib from '@/lib/sse'

vi.mock('@/api/generation')
vi.mock('@/lib/sse', () => ({
  connectSSE: vi.fn(() => ({ disconnect: vi.fn() })),
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

const makeApiJob = (overrides = {}) => ({
  id: 'job-1',
  session_id: 'sess-1',
  status: 'queued',
  step: null,
  progress_pct: 0,
  download_url: null,
  duration_ms: null,
  size_bytes: null,
  error_message: null,
  ...overrides,
})

function renderPage() {
  return render(
    <MemoryRouter>
      <GeneratePage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: 'sess-1',
    token: 'tok-1',
    generationJob: null,
  })
  vi.clearAllMocks()
  vi.mocked(sseLib.connectSSE).mockReturnValue({ disconnect: vi.fn() })
})

describe('GeneratePage — bootstrap', () => {
  it('starts generation on mount and shows submitting state', async () => {
    vi.mocked(generationApi.startGeneration).mockResolvedValue({ job_id: 'job-1' })
    vi.mocked(generationApi.getJobStatus).mockResolvedValue(makeApiJob() as never)
    renderPage()
    expect(screen.getByText(/submitting job/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(generationApi.startGeneration).toHaveBeenCalledWith('sess-1')
    })
  })

  it('shows generation failed state with verbatim error from API', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(generationApi.startGeneration).mockRejectedValue(
      new ApiError('Insufficient credits on account', 402)
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/Insufficient credits on account/i)).toBeInTheDocument()
    })
  })

  it('shows retry button on failure', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(generationApi.startGeneration).mockRejectedValue(
      new ApiError('Server error', 500)
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    })
  })

  it('reconnects to existing running job without starting a new one', async () => {
    useSessionStore.setState({
      generationJob: {
        id: 'job-existing',
        sessionId: 'sess-1',
        status: 'processing',
        step: 'analysing',
        progressPct: 30,
        downloadUrl: null,
        durationMs: null,
        sizeBytes: null,
        errorMessage: null,
      },
    })
    renderPage()
    // Should NOT call startGeneration
    expect(generationApi.startGeneration).not.toHaveBeenCalled()
    // SSE should be set up
    await waitFor(() => {
      expect(sseLib.connectSSE).toHaveBeenCalled()
    })
  })
})

describe('GeneratePage — exponential backoff', () => {
  it('uses 3s initial poll interval', async () => {
    vi.useFakeTimers()
    vi.mocked(generationApi.startGeneration).mockResolvedValue({ job_id: 'job-1' })
    vi.mocked(generationApi.getJobStatus).mockResolvedValue(makeApiJob() as never)
    renderPage()

    await act(async () => { await vi.runAllTicks() })

    // After bootstrap, first poll should be scheduled at 3s
    const getJobStatusCallCount = vi.mocked(generationApi.getJobStatus).mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await vi.runAllTicks()
    })
    expect(vi.mocked(generationApi.getJobStatus).mock.calls.length).toBeGreaterThan(getJobStatusCallCount)
    vi.useRealTimers()
  })
})

describe('GeneratePage — stall dialog', () => {
  it('shows stall dialog after 10 minutes with keep-waiting and cancel options', async () => {
    vi.useFakeTimers()
    vi.mocked(generationApi.startGeneration).mockResolvedValue({ job_id: 'job-1' })
    vi.mocked(generationApi.getJobStatus).mockResolvedValue(makeApiJob({ status: 'processing' }) as never)
    renderPage()

    await act(async () => { await vi.runAllTicks() })

    // Advance 10 minutes
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000)
      await vi.runAllTicks()
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /keep waiting/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel generation/i })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('dismisses stall dialog when "Keep waiting" is clicked', async () => {
    vi.useFakeTimers()
    vi.mocked(generationApi.startGeneration).mockResolvedValue({ job_id: 'job-1' })
    vi.mocked(generationApi.getJobStatus).mockResolvedValue(makeApiJob({ status: 'processing' }) as never)
    renderPage()

    await act(async () => { await vi.runAllTicks() })
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000)
      await vi.runAllTicks()
    })

    fireEvent.click(screen.getByRole('button', { name: /keep waiting/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
