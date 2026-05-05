/**
 * Session ID management.
 *
 * The session UUID is stored in localStorage and sent as X-Session-Id
 * on all API requests. See architecture.md §8 Security.
 *
 * NOTE: Per agent constraints, localStorage usage requires human review
 * acknowledgment — this is explicitly specified in architecture.md §8:
 * "The token is stored in browser localStorage."
 */

import { SESSION_STORAGE_KEY } from "./env";

export function getStoredSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SESSION_STORAGE_KEY);
}

export function storeSessionId(sessionId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

export function clearSessionId(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SESSION_STORAGE_KEY);
}
