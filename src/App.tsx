import { useEffect, type ReactNode } from 'react'
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { StepProgressBar } from '@/components/StepProgressBar'
import { useSessionStore } from '@/store'
import { createSession, getSessionState } from '@/api/sessions'
import { setAuthToken, ApiError } from '@/api/client'
import type { Step } from '@/types'
import {
  UploadClipsPage,
  UploadSongPage,
  PersonSelectionPage,
  HighlightSelectionPage,
  ReviewPage,
  GeneratePage,
  DownloadPage,
} from '@/pages'

// ─── BroadcastChannel for duplicate-tab detection ─────────────────────────────
const TAB_CHANNEL = 'hypereels-tab'

// ─── Session bootstrapper — runs once inside the router ───────────────────────

function SessionBootstrapper({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const {
    sessionId,
    token,
    isInitialising,
    initError,
    isTabWarningVisible,
    initSession,
    setInitError,
    setIsInitialising,
    setTabWarning,
    setCurrentStep,
    setClips,
    setAudio,
    setPersons,
    setSelectedPerson,
    setAllHighlights,
    setGenerationJob,
    setSessionStatus,
    clearSession,
  } = useSessionStore()

  // Duplicate-tab detection
  useEffect(() => {
    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel(TAB_CHANNEL)

      bc.onmessage = (e) => {
        if (e.data === 'takeover') {
          setTabWarning(true)
        }
      }

      // Announce ourselves
      bc.postMessage('takeover')
    } catch {
      // BroadcastChannel not supported — silently skip
    }

    return () => {
      bc?.close()
    }
  }, [setTabWarning])

  // Session init
  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (sessionId && token) {
        // Resume existing session
        setAuthToken(token)
        try {
          const state = await getSessionState(sessionId)

          if (cancelled) return

          // Hydrate store from server state
          setSessionStatus(state.status)
          setCurrentStep(state.current_step)
          setClips(state.clips)
          setAudio(state.audio)
          setPersons(state.persons)
          setSelectedPerson(state.selected_person_ref_id)
          setAllHighlights(state.highlights)
          setGenerationJob(state.generation_job)
          initSession(sessionId, token)

          // Navigate to the current server-side step
          navigate(stepToPath(state.current_step), { replace: true })
        } catch (err: unknown) {
          if (cancelled) return

          if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
            // Session expired or not found — start fresh
            clearSession()
            await startNewSession()
          } else {
            const message =
              err instanceof Error ? err.message : 'Failed to connect to server'
            setInitError(message)
          }
        }
      } else {
        // Brand new visitor
        await startNewSession()
      }
    }

    async function startNewSession() {
      try {
        const { session_id, token: newToken } = await createSession()
        if (!cancelled) {
          initSession(session_id, newToken)
          navigate('/upload-clips', { replace: true })
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Failed to create session'
          setInitError(message)
        }
      }
    }

    setIsInitialising(true)
    bootstrap()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (isInitialising) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-4 text-gray-500">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
          <p className="text-sm font-medium">Starting your session…</p>
        </div>
      </div>
    )
  }

  if (initError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-50 p-6 text-center">
        <div className="max-w-md space-y-2">
          <h1 className="text-2xl font-bold text-gray-900">
            Could not start session
          </h1>
          <p className="text-gray-600">{initError}</p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Try Again
        </button>
      </div>
    )
  }

  return (
    <>
      {isTabWarningVisible && (
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-4 bg-amber-500 px-4 py-3 text-sm font-medium text-white shadow-lg"
        >
          <span>
            HypeReels is already open in another tab. Using this tab may cause
            conflicts — please close the other tab.
          </span>
          <button
            type="button"
            onClick={() => setTabWarning(false)}
            className="flex-shrink-0 rounded px-3 py-1 text-xs font-semibold underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {children}
    </>
  )
}

// ─── Shell with step progress bar ────────────────────────────────────────────

function AppShell({ children }: { children: ReactNode }) {
  const currentStep = useSessionStore((s) => s.currentStep)
  const sessionStatus = useSessionStore((s) => s.sessionStatus)
  const isLocked = sessionStatus === 'locked' || sessionStatus === 'complete'

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-3">
          <div className="flex flex-col gap-3 sm:gap-4">
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold tracking-tight text-brand-700">
                HypeReels
              </span>
            </div>
            <StepProgressBar currentStep={currentStep} isLocked={isLocked} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  )
}

// ─── Step → route path mapping ────────────────────────────────────────────────

function stepToPath(step: Step): string {
  const map: Record<Step, string> = {
    'upload-clips': '/upload-clips',
    'upload-audio': '/upload-song',
    'detect-persons': '/person-selection',
    'mark-highlights': '/highlights',
    'review': '/review',
    'generate': '/generate',
    'download': '/download',
  }
  return map[step]
}

// ─── Root App ────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <SessionBootstrapper>
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/upload-clips" replace />} />
              <Route path="/upload-clips" element={<UploadClipsPage />} />
              <Route path="/upload-song" element={<UploadSongPage />} />
              <Route path="/person-selection" element={<PersonSelectionPage />} />
              <Route path="/highlights" element={<HighlightSelectionPage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/generate" element={<GeneratePage />} />
              <Route path="/download" element={<DownloadPage />} />
              <Route path="*" element={<Navigate to="/upload-clips" replace />} />
            </Routes>
          </AppShell>
        </SessionBootstrapper>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
