import { apiClient } from './client'
import type { ApiPerson } from '@/types'

/** POST /sessions/:id/detect — trigger person detection for all un-detected clips */
export async function triggerDetection(sessionId: string): Promise<void> {
  await apiClient.post(`/sessions/${sessionId}/detect`)
}

/** GET /sessions/:id/persons — get all detected persons, grouped by person_ref_id */
export async function getPersons(sessionId: string): Promise<ApiPerson[]> {
  const { data } = await apiClient.get<ApiPerson[]>(
    `/sessions/${sessionId}/persons`
  )
  return data
}

/** PUT /sessions/:id/person-of-interest — set or clear the person of interest */
export async function setPersonOfInterest(
  sessionId: string,
  personRefId: string | null
): Promise<void> {
  await apiClient.put(`/sessions/${sessionId}/person-of-interest`, {
    person_ref_id: personRefId,
  })
}
