import { apiClient } from './client'
import type { ApiHighlight } from '@/types'

/**
 * PUT /sessions/:id/clips/:clipId/highlights
 *
 * Replace the full highlight list for a clip. Sends merged, client-side
 * de-duplicated ranges. Returns the persisted array with server-assigned IDs.
 */
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
