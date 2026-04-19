import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore, groupPersons, mapClip, mapAudio, mapHighlight, mapJob } from './sessionStore'
import type { ApiClip, ApiAudio, ApiHighlight, ApiGenerationJob, ApiPerson } from '@/types'

const makeApiClip = (overrides: Partial<ApiClip> = {}): ApiClip => ({
  id: 'clip-1',
  session_id: 'sess-1',
  original_filename: 'test.mp4',
  file_size_bytes: 1024,
  duration_ms: 5000,
  thumbnail_url: null,
  status: 'valid',
  validation_error: null,
  detection_status: 'pending',
  ...overrides,
})

const makeApiAudio = (overrides: Partial<ApiAudio> = {}): ApiAudio => ({
  id: 'audio-1',
  session_id: 'sess-1',
  original_filename: 'song.mp3',
  file_size_bytes: 2048,
  duration_ms: 180000,
  status: 'valid',
  analysis_status: 'complete',
  waveform_url: null,
  bpm: 120,
  envelope: null,
  ...overrides,
})

beforeEach(() => {
  useSessionStore.setState({
    sessionId: null,
    token: null,
    clips: [],
    audio: null,
    persons: [],
    selectedPersonRefId: null,
    highlights: [],
    generationJob: null,
    ephemeralWarningDismissed: false,
  })
})

describe('mapClip', () => {
  it('maps API clip to store clip with default upload fields', () => {
    const clip = mapClip(makeApiClip())
    expect(clip.id).toBe('clip-1')
    expect(clip.uploadProgress).toBe(100)
    expect(clip.uploadError).toBeNull()
    expect(clip.originalFilename).toBe('test.mp4')
  })
})

describe('mapAudio', () => {
  it('maps API audio to store audio with default upload fields', () => {
    const audio = mapAudio(makeApiAudio())
    expect(audio.id).toBe('audio-1')
    expect(audio.uploadProgress).toBe(100)
    expect(audio.uploadError).toBeNull()
    expect(audio.bpm).toBe(120)
  })
})

describe('groupPersons', () => {
  const makePerson = (id: string, refId: string, clipId: string, confidence: number): ApiPerson => ({
    id,
    session_id: 'sess-1',
    clip_id: clipId,
    person_ref_id: refId,
    thumbnail_url: `https://example.com/${id}.jpg`,
    confidence,
    appearances: [{ startMs: 0, endMs: 1000, boundingBox: { left: 0, top: 0, width: 0.5, height: 0.5 } }],
  })

  it('groups persons by personRefId across clips', () => {
    const persons = [
      makePerson('p1', 'ref-A', 'clip-1', 0.9),
      makePerson('p2', 'ref-A', 'clip-2', 0.8),
      makePerson('p3', 'ref-B', 'clip-1', 0.7),
    ]
    const store = useSessionStore.getState()
    store.setPersons(persons)
    const groups = useSessionStore.getState().personGroups()
    expect(groups).toHaveLength(2)
    const groupA = groups.find((g) => g.personRefId === 'ref-A')
    expect(groupA?.clipIds).toHaveLength(2)
    expect(groupA?.confidence).toBe(0.9) // highest confidence thumbnail
  })

  it('sorts groups by confidence descending', () => {
    const persons = [
      makePerson('p3', 'ref-B', 'clip-1', 0.7),
      makePerson('p1', 'ref-A', 'clip-1', 0.9),
    ]
    const store = useSessionStore.getState()
    store.setPersons(persons)
    const groups = useSessionStore.getState().personGroups()
    expect(groups[0].personRefId).toBe('ref-A')
  })
})

describe('addUploadingClip / finaliseClipUpload / failClipUpload', () => {
  it('adds a clip in uploading state', () => {
    const store = useSessionStore.getState()
    store.addUploadingClip('temp-1', 'test.mp4', 5000)
    const clips = useSessionStore.getState().clips
    expect(clips).toHaveLength(1)
    expect(clips[0].status).toBe('uploading')
    expect(clips[0].uploadProgress).toBe(0)
  })

  it('updates progress', () => {
    const store = useSessionStore.getState()
    store.addUploadingClip('temp-1', 'test.mp4', 5000)
    store.updateClipProgress('temp-1', 50)
    expect(useSessionStore.getState().clips[0].uploadProgress).toBe(50)
  })

  it('finalises upload with server data', () => {
    const store = useSessionStore.getState()
    store.addUploadingClip('temp-1', 'test.mp4', 5000)
    store.finaliseClipUpload('temp-1', makeApiClip())
    const clips = useSessionStore.getState().clips
    expect(clips[0].id).toBe('clip-1')
    expect(clips[0].status).toBe('valid')
  })

  it('marks clip as failed with error', () => {
    const store = useSessionStore.getState()
    store.addUploadingClip('temp-1', 'test.mp4', 5000)
    store.failClipUpload('temp-1', 'File too large')
    const clips = useSessionStore.getState().clips
    expect(clips[0].status).toBe('invalid')
    expect(clips[0].uploadError).toBe('File too large')
  })
})

describe('removeClip', () => {
  it('removes clip and its associated highlights and persons', () => {
    const store = useSessionStore.getState()
    store.setClips([makeApiClip({ id: 'clip-1' })])
    store.setAllHighlights([
      { id: 'h1', session_id: 's', clip_id: 'clip-1', start_ms: 0, end_ms: 1000 },
    ])
    store.removeClip('clip-1')
    const state = useSessionStore.getState()
    expect(state.clips).toHaveLength(0)
    expect(state.highlights).toHaveLength(0)
  })
})

describe('dismissEphemeralWarning', () => {
  it('sets ephemeralWarningDismissed to true', () => {
    expect(useSessionStore.getState().ephemeralWarningDismissed).toBe(false)
    useSessionStore.getState().dismissEphemeralWarning()
    expect(useSessionStore.getState().ephemeralWarningDismissed).toBe(true)
  })
})

describe('generation job actions', () => {
  const makeJob = (overrides: Partial<ApiGenerationJob> = {}): ApiGenerationJob => ({
    id: 'job-1',
    session_id: 'sess-1',
    status: 'processing',
    step: 'analysing',
    progress_pct: 25,
    download_url: null,
    duration_ms: null,
    size_bytes: null,
    error_message: null,
    ...overrides,
  })

  it('sets generation job', () => {
    useSessionStore.getState().setGenerationJob(makeJob())
    expect(useSessionStore.getState().generationJob?.id).toBe('job-1')
  })

  it('updates job progress', () => {
    useSessionStore.getState().setGenerationJob(makeJob())
    useSessionStore.getState().updateJobProgress('job-1', 'selecting', 50)
    const job = useSessionStore.getState().generationJob
    expect(job?.progressPct).toBe(50)
    expect(job?.step).toBe('selecting')
  })

  it('completes job and navigates to download step', () => {
    useSessionStore.getState().setGenerationJob(makeJob())
    useSessionStore.getState().completeJob('job-1', 'https://example.com/dl', 60000, 5000000)
    const state = useSessionStore.getState()
    expect(state.generationJob?.status).toBe('complete')
    expect(state.generationJob?.downloadUrl).toBe('https://example.com/dl')
    expect(state.currentStep).toBe('download')
  })

  it('fails job with error message', () => {
    useSessionStore.getState().setGenerationJob(makeJob())
    useSessionStore.getState().failJob('job-1', 'Out of memory')
    const job = useSessionStore.getState().generationJob
    expect(job?.status).toBe('failed')
    expect(job?.errorMessage).toBe('Out of memory')
  })
})
