import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { UploadSongPage } from './UploadSongPage'
import { useSessionStore } from '@/store'
import * as audioApi from '@/api/audio'
import * as sseLib from '@/lib/sse'

vi.mock('@/api/audio')
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
      <UploadSongPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: 'sess-1',
    token: 'tok-1',
    audio: null,
    ephemeralWarningDismissed: false,
  })
  vi.clearAllMocks()
})

describe('UploadSongPage — validation', () => {
  it('renders the drop zone', () => {
    renderPage()
    expect(screen.getByRole('button', { name: /upload audio/i })).toBeInTheDocument()
  })

  it('rejects unsupported audio format with named format error', async () => {
    renderPage()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'song.flac', { type: 'audio/flac' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => {
      // Named format error required by spec
      expect(screen.getByText(/FLAC/i)).toBeInTheDocument()
      expect(screen.getByText(/MP3, WAV, or AAC/i)).toBeInTheDocument()
    })
  })

  it('accepts .mp3 files', async () => {
    vi.mocked(audioApi.uploadAudio).mockResolvedValue({ audio_id: 'audio-1' } as never)
    renderPage()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    await waitFor(() => {
      expect(audioApi.uploadAudio).toHaveBeenCalled()
    })
  })

  it('shows upload API error verbatim', async () => {
    const { ApiError } = await import('@/api/client')
    vi.mocked(audioApi.uploadAudio).mockRejectedValue(new ApiError('Storage limit exceeded', 507))
    renderPage()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    await waitFor(() => {
      expect(screen.getByText(/Storage limit exceeded/i)).toBeInTheDocument()
    })
  })

  it('Continue button is disabled when no valid audio', () => {
    renderPage()
    const continueBtn = screen.getByRole('button', { name: /continue to person selection/i })
    expect(continueBtn).toBeDisabled()
  })
})
