import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { UploadClipsPage } from './UploadClipsPage'
import { useSessionStore } from '@/store'
import * as clipsApi from '@/api/clips'

vi.mock('@/api/clips')
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

function renderPage() {
  return render(
    <MemoryRouter>
      <UploadClipsPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: 'sess-1',
    token: 'tok-1',
    clips: [],
    ephemeralWarningDismissed: false,
  })
  vi.clearAllMocks()
})

describe('UploadClipsPage — validation', () => {
  it('renders the drop zone', () => {
    renderPage()
    expect(screen.getByRole('button', { name: /upload video clips/i })).toBeInTheDocument()
  })

  it('rejects unsupported file formats with named format error', async () => {
    vi.mocked(clipsApi.uploadClip).mockResolvedValue({ clip_id: 'clip-1' } as never)
    renderPage()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'video.mkv', { type: 'video/x-matroska' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => {
      // Named format error required by spec
      expect(screen.getByText(/MKV/i)).toBeInTheDocument()
      expect(screen.getByText(/MP4, MOV, AVI, or WebM/i)).toBeInTheDocument()
    })
  })

  it('accepts .mp4 files', async () => {
    vi.mocked(clipsApi.uploadClip).mockResolvedValue({ clip_id: 'clip-1' } as never)
    renderPage()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'video.mp4', { type: 'video/mp4' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => {
      expect(clipsApi.uploadClip).toHaveBeenCalled()
    })
  })

  it('accepts .avi files (spec-required format)', async () => {
    vi.mocked(clipsApi.uploadClip).mockResolvedValue({ clip_id: 'clip-1' } as never)
    renderPage()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'video.avi', { type: 'video/x-msvideo' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => {
      expect(clipsApi.uploadClip).toHaveBeenCalled()
    })
  })

  it('shows file-size error without hardcoded limits in message', async () => {
    renderPage()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    // Create a file that exceeds the limit
    const bigFile = new File(['x'.repeat(10)], 'huge.mp4', { type: 'video/mp4' })
    Object.defineProperty(bigFile, 'size', { value: 99 * 1024 * 1024 * 1024 })
    Object.defineProperty(input, 'files', { value: [bigFile], configurable: true })
    fireEvent.change(input)

    await waitFor(() => {
      expect(screen.getByText(/File too large/i)).toBeInTheDocument()
    })
  })

  it('shows upload error from API verbatim (not generic)', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(clipsApi.uploadClip).mockRejectedValue(new ApiError('Quota exceeded on server', 429))
    renderPage()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'video.mp4', { type: 'video/mp4' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => {
      expect(screen.getByText(/Quota exceeded on server/i)).toBeInTheDocument()
    })
  })

  it('Continue button is disabled when no valid clips', () => {
    renderPage()
    const continueBtn = screen.getByRole('button', { name: /continue to song upload/i })
    expect(continueBtn).toBeDisabled()
  })
})

describe('UploadClipsPage — ephemeral warning', () => {
  it('shows the ephemeral warning when not dismissed', () => {
    renderPage()
    expect(screen.getByRole('note', { name: /ephemeral/i })).toBeInTheDocument()
  })

  it('does not show warning when already dismissed', () => {
    useSessionStore.setState({ ephemeralWarningDismissed: true })
    renderPage()
    expect(screen.queryByRole('note', { name: /ephemeral/i })).not.toBeInTheDocument()
  })
})
