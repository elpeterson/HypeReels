import { apiClient } from './client'
import type { ApiGenerationJob, GenerateResponse } from '@/types'

/** POST /sessions/:id/generate — lock session and submit generation job */
export async function startGeneration(
  sessionId: string
): Promise<GenerateResponse> {
  const { data } = await apiClient.post<GenerateResponse>(
    `/sessions/${sessionId}/generate`
  )
  return data
}

/** GET /sessions/:id/generate/:jobId — poll job status (SSE fallback) */
export async function getJobStatus(
  sessionId: string,
  jobId: string
): Promise<ApiGenerationJob> {
  const { data } = await apiClient.get<ApiGenerationJob>(
    `/sessions/${sessionId}/generate/${jobId}`
  )
  return data
}

/** DELETE /sessions/:id/generate/:jobId — cancel an in-progress job */
export async function cancelJob(
  sessionId: string,
  jobId: string
): Promise<void> {
  await apiClient.delete(`/sessions/${sessionId}/generate/${jobId}`)
}

/** POST /sessions/:id/download-initiated — signals download start; schedules cleanup */
export async function notifyDownloadInitiated(
  sessionId: string
): Promise<void> {
  await apiClient.post(`/sessions/${sessionId}/download-initiated`)
}

/** POST /sessions/:id/done — user clicked Done; triggers immediate cleanup */
export async function notifyDone(sessionId: string): Promise<void> {
  await apiClient.post(`/sessions/${sessionId}/done`)
}
