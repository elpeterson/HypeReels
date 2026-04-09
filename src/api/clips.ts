import { apiClient, uploadFile } from './client'
import type { ApiClip, ApiHighlight, UploadClipResponse } from '@/types'

/** POST /sessions/:id/clips — upload one video clip */
export function uploadClip(
  sessionId: string,
  file: File,
  token: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<UploadClipResponse> {
  return uploadFile(
    `/sessions/${sessionId}/clips`,
    file,
    token,
    onProgress,
    signal
  ) as Promise<UploadClipResponse>
}

/** GET /sessions/:id/clips — list all clips */
export async function listClips(sessionId: string): Promise<ApiClip[]> {
  const { data } = await apiClient.get<ApiClip[]>(
    `/sessions/${sessionId}/clips`
  )
  return data
}

/** DELETE /sessions/:id/clips/:clipId */
export async function deleteClip(
  sessionId: string,
  clipId: string
): Promise<void> {
  await apiClient.delete(`/sessions/${sessionId}/clips/${clipId}`)
}

/** PUT /sessions/:id/clips/:clipId/highlights — replace the highlight list */
export async function putHighlights(
  sessionId: string,
  clipId: string,
  highlights: Array<{ start_ms: number; end_ms: number }>
): Promise<ApiHighlight[]> {
  const { data } = await apiClient.put<ApiHighlight[]>(
    `/sessions/${sessionId}/clips/${clipId}/highlights`,
    { highlights }
  )
  return data
}
