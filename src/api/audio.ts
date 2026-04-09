import { apiClient, uploadFile } from './client'
import type { ApiAudio, UploadAudioResponse } from '@/types'

/** POST /sessions/:id/audio — upload the audio track */
export function uploadAudio(
  sessionId: string,
  file: File,
  token: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<UploadAudioResponse> {
  return uploadFile(
    `/sessions/${sessionId}/audio`,
    file,
    token,
    onProgress,
    signal
  ) as Promise<UploadAudioResponse>
}

/** GET /sessions/:id/audio — get audio metadata and analysis status */
export async function getAudio(sessionId: string): Promise<ApiAudio | null> {
  try {
    const { data } = await apiClient.get<ApiAudio>(
      `/sessions/${sessionId}/audio`
    )
    return data
  } catch (err: unknown) {
    // 404 means no audio uploaded yet
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      (err as { status: number }).status === 404
    ) {
      return null
    }
    throw err
  }
}

/** DELETE /sessions/:id/audio — delete and clear the current audio track */
export async function deleteAudio(sessionId: string): Promise<void> {
  await apiClient.delete(`/sessions/${sessionId}/audio`)
}
