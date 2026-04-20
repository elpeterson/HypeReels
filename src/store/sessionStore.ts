import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setAuthToken } from '@/api/client'
import type {
  Clip,
  AudioTrack,
  Person,
  PersonGroup,
  Highlight,
  GenerationJob,
  SessionStatus,
  Step,
  ApiClip,
  ApiAudio,
  ApiPerson,
  ApiHighlight,
  ApiGenerationJob,
} from '@/types'

// ─── Mappers: snake_case API → camelCase store ────────────────────────────────

export function mapClip(api: ApiClip): Clip {
  return {
    id: api.id,
    sessionId: api.session_id,
    originalFilename: api.original_filename,
    fileSizeBytes: api.file_size_bytes,
    durationMs: api.duration_ms,
    thumbnailUrl: api.thumbnail_url,
    status: api.status,
    validationError: api.validation_error,
    detectionStatus: api.detection_status,
    uploadProgress: 100,
    uploadError: null,
  }
}

export function mapAudio(api: ApiAudio): AudioTrack {
  return {
    id: api.id,
    sessionId: api.session_id,
    originalFilename: api.original_filename,
    fileSizeBytes: api.file_size_bytes,
    durationMs: api.duration_ms,
    status: api.status,
    analysisStatus: api.analysis_status,
    waveformUrl: api.waveform_url,
    envelope: api.envelope,
    bpm: api.bpm,
    uploadProgress: 100,
    uploadError: null,
  }
}

export function mapPerson(api: ApiPerson): Person {
  return {
    id: api.id,
    sessionId: api.session_id,
    clipId: api.clip_id,
    personRefId: api.person_ref_id,
    thumbnailUrl: api.thumbnail_url,
    confidence: api.confidence,
    appearances: api.appearances,
  }
}

export function mapHighlight(api: ApiHighlight): Highlight {
  return {
    id: api.id,
    sessionId: api.session_id,
    clipId: api.clip_id,
    startMs: api.start_ms,
    endMs: api.end_ms,
  }
}

export function mapJob(api: ApiGenerationJob): GenerationJob {
  return {
    id: api.id,
    sessionId: api.session_id,
    status: api.status,
    step: api.step,
    progressPct: api.progress_pct,
    downloadUrl: api.download_url,
    durationMs: api.duration_ms,
    sizeBytes: api.size_bytes,
    errorMessage: api.error_message,
  }
}

/** Group persons by personRefId across clips. */
export function groupPersons(persons: Person[]): PersonGroup[] {
  const map = new Map<string, PersonGroup>()

  for (const p of persons) {
    const existing = map.get(p.personRefId)
    if (existing) {
      existing.clipIds.push(p.clipId)
      existing.totalAppearances += p.appearances.length
      // Keep the highest-confidence thumbnail
      if (p.confidence > existing.confidence) {
        existing.thumbnailUrl = p.thumbnailUrl
        existing.confidence = p.confidence
      }
    } else {
      map.set(p.personRefId, {
        personRefId: p.personRefId,
        thumbnailUrl: p.thumbnailUrl,
        confidence: p.confidence,
        clipIds: [p.clipId],
        totalAppearances: p.appearances.length,
      })
    }
  }

  // Sort by confidence descending
  return [...map.values()].sort((a, b) => b.confidence - a.confidence)
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface SessionStore {
  // Identity
  sessionId: string | null
  token: string | null
  sessionStatus: SessionStatus | null
  currentStep: Step

  // Data
  clips: Clip[]
  audio: AudioTrack | null
  persons: Person[]
  selectedPersonRefId: string | null
  highlights: Highlight[]
  generationJob: GenerationJob | null

  // UI-only state
  isInitialising: boolean
  initError: string | null
  isTabWarningVisible: boolean
  ephemeralWarningDismissed: boolean

  // Actions — session
  initSession: (sessionId: string, token: string) => void
  setSessionStatus: (status: SessionStatus) => void
  setCurrentStep: (step: Step) => void
  clearSession: () => void
  setInitError: (err: string | null) => void
  setIsInitialising: (v: boolean) => void
  setTabWarning: (visible: boolean) => void
  dismissEphemeralWarning: () => void

  // Actions — clips
  addUploadingClip: (tempId: string, filename: string, sizeBytes: number) => void
  updateClipProgress: (tempId: string, pct: number) => void
  finaliseClipUpload: (tempId: string, api: ApiClip) => void
  failClipUpload: (tempId: string, error: string) => void
  updateClipFromSSE: (clipId: string, patch: Partial<Clip>) => void
  removeClip: (clipId: string) => void
  setClips: (clips: ApiClip[]) => void

  // Actions — audio
  setUploadingAudio: (filename: string, sizeBytes: number) => void
  updateAudioProgress: (pct: number) => void
  finaliseAudioUpload: (api: ApiAudio) => void
  failAudioUpload: (error: string) => void
  updateAudioFromSSE: (patch: Partial<AudioTrack>) => void
  clearAudio: () => void
  setAudio: (api: ApiAudio | null) => void

  // Actions — persons
  addPersons: (apiPersons: ApiPerson[]) => void
  setPersons: (apiPersons: ApiPerson[]) => void
  setSelectedPerson: (personRefId: string | null) => void

  // Actions — highlights
  setClipHighlights: (clipId: string, apiHighlights: ApiHighlight[]) => void
  setAllHighlights: (apiHighlights: ApiHighlight[]) => void

  // Actions — generation job
  setGenerationJob: (api: ApiGenerationJob | null) => void
  updateJobProgress: (jobId: string, step: GenerationJob['step'], pct: number) => void
  completeJob: (jobId: string, downloadUrl: string, durationMs: number, sizeBytes: number) => void
  failJob: (jobId: string, error: string) => void

  // Computed helpers (not truly Zustand "computed" but stable selectors)
  personGroups: () => PersonGroup[]
  highlightsForClip: (clipId: string) => Highlight[]
  totalHighlightDurationMs: () => number
}

// ─── Store implementation ─────────────────────────────────────────────────────

const PERSISTED_KEYS = ['sessionId', 'token', 'ephemeralWarningDismissed'] as const

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessionId: null,
      token: null,
      sessionStatus: null,
      currentStep: 'upload-clips',
      clips: [],
      audio: null,
      persons: [],
      selectedPersonRefId: null,
      highlights: [],
      generationJob: null,
      isInitialising: true,
      initError: null,
      isTabWarningVisible: false,
      ephemeralWarningDismissed: false,

      // ── Session ──────────────────────────────────────────────────────────
      initSession: (sessionId, token) => {
        setAuthToken(token)
        set({ sessionId, token, sessionStatus: 'active', initError: null, isInitialising: false })
      },
      setSessionStatus: (status) => set({ sessionStatus: status }),
      setCurrentStep: (step) => set({ currentStep: step }),
      clearSession: () => {
        setAuthToken(null)
        set({
          sessionId: null,
          token: null,
          sessionStatus: null,
          currentStep: 'upload-clips',
          clips: [],
          audio: null,
          persons: [],
          selectedPersonRefId: null,
          highlights: [],
          generationJob: null,
          initError: null,
        })
      },
      setInitError: (err) => set({ initError: err, isInitialising: false }),
      setIsInitialising: (v) => set({ isInitialising: v }),
      setTabWarning: (visible) => set({ isTabWarningVisible: visible }),
      dismissEphemeralWarning: () => set({ ephemeralWarningDismissed: true }),

      // ── Clips ─────────────────────────────────────────────────────────────
      addUploadingClip: (tempId, filename, sizeBytes) =>
        set((s) => ({
          clips: [
            ...s.clips,
            {
              id: tempId,
              sessionId: s.sessionId ?? '',
              originalFilename: filename,
              fileSizeBytes: sizeBytes,
              durationMs: null,
              thumbnailUrl: null,
              status: 'uploading',
              validationError: null,
              detectionStatus: 'pending',
              uploadProgress: 0,
              uploadError: null,
            } satisfies Clip,
          ],
        })),

      updateClipProgress: (tempId, pct) =>
        set((s) => ({
          clips: s.clips.map((c) =>
            c.id === tempId ? { ...c, uploadProgress: pct } : c
          ),
        })),

      finaliseClipUpload: (tempId, api) =>
        set((s) => ({
          clips: s.clips.map((c) =>
            c.id === tempId ? { ...mapClip(api), uploadProgress: 100 } : c
          ),
        })),

      failClipUpload: (tempId, error) =>
        set((s) => ({
          clips: s.clips.map((c) =>
            c.id === tempId
              ? { ...c, status: 'invalid', uploadError: error }
              : c
          ),
        })),

      updateClipFromSSE: (clipId, patch) =>
        set((s) => ({
          clips: s.clips.map((c) =>
            c.id === clipId ? { ...c, ...patch } : c
          ),
        })),

      removeClip: (clipId) =>
        set((s) => ({
          clips: s.clips.filter((c) => c.id !== clipId),
          highlights: s.highlights.filter((h) => h.clipId !== clipId),
          persons: s.persons.filter((p) => p.clipId !== clipId),
          selectedPersonRefId:
            s.persons
              .filter((p) => p.clipId === clipId)
              .some((p) => p.personRefId === s.selectedPersonRefId)
              ? null
              : s.selectedPersonRefId,
        })),

      setClips: (apiClips) =>
        set({ clips: apiClips.map(mapClip) }),

      // ── Audio ─────────────────────────────────────────────────────────────
      setUploadingAudio: (filename, sizeBytes) =>
        set((s) => ({
          audio: {
            id: '',
            sessionId: s.sessionId ?? '',
            originalFilename: filename,
            fileSizeBytes: sizeBytes,
            durationMs: null,
            status: 'uploading',
            analysisStatus: 'pending',
            waveformUrl: null,
            envelope: null,
            bpm: null,
            uploadProgress: 0,
            uploadError: null,
          },
        })),

      updateAudioProgress: (pct) =>
        set((s) => ({
          audio: s.audio ? { ...s.audio, uploadProgress: pct } : s.audio,
        })),

      finaliseAudioUpload: (api) =>
        set({ audio: { ...mapAudio(api), uploadProgress: 100 } }),

      failAudioUpload: (error) =>
        set((s) => ({
          audio: s.audio ? { ...s.audio, uploadError: error } : s.audio,
        })),

      updateAudioFromSSE: (patch) =>
        set((s) => ({
          audio: s.audio ? { ...s.audio, ...patch } : s.audio,
        })),

      clearAudio: () => set({ audio: null }),

      setAudio: (api) => set({ audio: api ? mapAudio(api) : null }),

      // ── Persons ───────────────────────────────────────────────────────────
      addPersons: (apiPersons) =>
        set((s) => {
          const incoming = apiPersons.map(mapPerson)
          const existingIds = new Set(s.persons.map((p) => p.id))
          const novel = incoming.filter((p) => !existingIds.has(p.id))
          return { persons: [...s.persons, ...novel] }
        }),

      setPersons: (apiPersons) =>
        set({ persons: apiPersons.map(mapPerson) }),

      setSelectedPerson: (personRefId) =>
        set({ selectedPersonRefId: personRefId }),

      // ── Highlights ────────────────────────────────────────────────────────
      setClipHighlights: (clipId, apiHighlights) =>
        set((s) => ({
          highlights: [
            ...s.highlights.filter((h) => h.clipId !== clipId),
            ...apiHighlights.map(mapHighlight),
          ],
        })),

      setAllHighlights: (apiHighlights) =>
        set({ highlights: apiHighlights.map(mapHighlight) }),

      // ── Generation job ────────────────────────────────────────────────────
      setGenerationJob: (api) =>
        set({ generationJob: api ? mapJob(api) : null }),

      updateJobProgress: (jobId, step, pct) =>
        set((s) => ({
          generationJob:
            s.generationJob?.id === jobId
              ? { ...s.generationJob, step, progressPct: pct, status: 'processing' }
              : s.generationJob,
        })),

      completeJob: (jobId, downloadUrl, durationMs, sizeBytes) =>
        set((s) => ({
          generationJob:
            s.generationJob?.id === jobId
              ? {
                  ...s.generationJob,
                  status: 'complete',
                  progressPct: 100,
                  downloadUrl,
                  durationMs,
                  sizeBytes,
                }
              : s.generationJob,
          sessionStatus: 'complete',
          currentStep: 'download',
        })),

      failJob: (jobId, error) =>
        set((s) => ({
          generationJob:
            s.generationJob?.id === jobId
              ? { ...s.generationJob, status: 'failed', errorMessage: error }
              : s.generationJob,
        })),

      // ── Computed ──────────────────────────────────────────────────────────
      personGroups: () => groupPersons(get().persons),

      highlightsForClip: (clipId) =>
        get().highlights.filter((h) => h.clipId === clipId),

      totalHighlightDurationMs: () =>
        get().highlights.reduce(
          (acc, h) => acc + (h.endMs - h.startMs),
          0
        ),
    }),
    {
      name: 'hypereels-session',
      partialize: (state) =>
        Object.fromEntries(
          PERSISTED_KEYS.map((k) => [k, state[k]])
        ) as Pick<SessionStore, (typeof PERSISTED_KEYS)[number]>,
    }
  )
)
