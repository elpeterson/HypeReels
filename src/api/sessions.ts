import { apiClient } from './client'
import type { CreateSessionResponse, SessionStateResponse } from '@/types'

/** POST /sessions — create a new anonymous session */
export async function createSession(): Promise<CreateSessionResponse> {
  const { data } = await apiClient.post<CreateSessionResponse>('/sessions')
  return data
}

/** GET /sessions/:id/state — restore session state on page reload */
export async function getSessionState(
  sessionId: string
): Promise<SessionStateResponse> {
  const { data } = await apiClient.get<SessionStateResponse>(
    `/sessions/${sessionId}/state`
  )
  return data
}

/** DELETE /sessions/:id — trigger immediate cleanup (Start Over) */
export async function deleteSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/sessions/${sessionId}`)
}
