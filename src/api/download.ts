import { apiClient } from './client'

export interface ReelDownloadResponse {
  /** Signed R2 URL valid for ~2 hours. Use as <a href=... download> — no blob needed. */
  download_url: string
  duration_ms: number
  size_bytes: number
}

/**
 * GET /sessions/:id/reel
 *
 * Returns a fresh signed download URL for the completed HypeReel.
 * Call this just before triggering the download so the URL is fresh.
 */
export async function getReelDownloadUrl(
  sessionId: string
): Promise<ReelDownloadResponse> {
  const { data } = await apiClient.get<ReelDownloadResponse>(
    `/sessions/${sessionId}/reel`
  )
  return data
}

/**
 * DELETE /sessions/:id
 *
 * Triggers immediate cleanup of all session assets (clips, audio, generated
 * reel, thumbnails). Called explicitly when the user clicks "Start Over".
 * The download flow uses POST /sessions/:id/done instead.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/sessions/${sessionId}`)
}
