import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { DownloadPage } from './DownloadPage'
import { useSessionStore } from '@/store'
import * as generationApi from '@/api/generation'

vi.mock('@/api/generation')
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

const completedJob = {
  id: 'job-1',
  sessionId: 'sess-1',
  status: 'complete' as const,
  step: null,
  progressPct: 100,
  downloadUrl: 'https://storage.example.com/presigned/job-1.mp4?X-Amz-Expires=3600',
  durationMs: 60000,
  sizeBytes: 5000000,
  errorMessage: null,
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DownloadPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: 'sess-1',
    generationJob: completedJob,
  })
  vi.clearAllMocks()
  vi.mocked(generationApi.notifyDownloadInitiated).mockResolvedValue(undefined)
  vi.mocked(generationApi.notifyDone).mockResolvedValue(undefined)
})

describe('DownloadPage — confirmation modal', () => {
  it('shows Download CTA on initial render', () => {
    renderPage()
    expect(screen.getByRole('button', { name: /download your hypereel/i })).toBeInTheDocument()
  })

  it('opens confirmation modal on first click (not immediate download)', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/downloading will permanently delete/i)).toBeInTheDocument()
  })

  it('shows "Download and delete" (primary) and "Cancel" (secondary) in modal', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    expect(screen.getByRole('button', { name: /download and delete/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('cancelling the modal returns to ready state', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download your hypereel/i })).toBeInTheDocument()
  })

  it('does NOT expose signed URL anywhere in the DOM', () => {
    renderPage()
    // The signed URL should never appear in visible text or attributes
    const html = document.body.innerHTML
    expect(html).not.toContain('X-Amz-Expires')
    expect(html).not.toContain('presigned')
  })
})

describe('DownloadPage — download + cleanup', () => {
  it('calls notifyDownloadInitiated and notifyDone after confirm', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    fireEvent.click(screen.getByRole('button', { name: /download and delete/i }))

    await waitFor(() => {
      expect(generationApi.notifyDownloadInitiated).toHaveBeenCalledWith('sess-1')
      expect(generationApi.notifyDone).toHaveBeenCalledWith('sess-1')
    })
  })

  it('shows "Your files have been deleted." after successful cleanup', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    fireEvent.click(screen.getByRole('button', { name: /download and delete/i }))

    await waitFor(() => {
      expect(screen.getByText(/your files have been deleted/i)).toBeInTheDocument()
    })
  })

  it('shows error message (not generic) when cleanup fails', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(generationApi.notifyDone).mockRejectedValue(
      new ApiError('Session already expired on server', 410)
    )
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    fireEvent.click(screen.getByRole('button', { name: /download and delete/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/Session already expired on server/i)).toBeInTheDocument()
    })
  })

  it('does NOT repeat confirmation modal on retry after error', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(generationApi.notifyDone)
      .mockRejectedValueOnce(new ApiError('Temporary error', 503))
      .mockResolvedValue(undefined)

    renderPage()
    // First attempt — goes through modal
    fireEvent.click(screen.getByRole('button', { name: /download your hypereel/i }))
    fireEvent.click(screen.getByRole('button', { name: /download and delete/i }))

    // Wait for error state
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    // Retry — should NOT show modal again
    fireEvent.click(screen.getByRole('button', { name: /retry download/i }))
    // Modal should not appear
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText(/your files have been deleted/i)).toBeInTheDocument()
    })
  })
})

describe('DownloadPage — no completed job', () => {
  it('redirects back to generate when no job exists', () => {
    useSessionStore.setState({ generationJob: null })
    renderPage()
    expect(screen.getByText(/no completed hypereel found/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to generate/i })).toBeInTheDocument()
  })
})
