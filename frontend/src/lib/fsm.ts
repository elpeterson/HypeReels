/**
 * Session FSM (Finite State Machine) helpers.
 *
 * Valid state transitions:
 *   uploading → detecting
 *   uploading → failed
 *   detecting → analyzing   (via generate-reel which chains analyze-audio)
 *   detecting → uploading   (after detection completes user can still upload)
 *   uploading → generating  (via generate-reel directly if person detection skipped)
 *   analyzing → generating
 *   generating → ready
 *   generating → failed
 *   any → expired           (TTL expiry — applied by cleanup job)
 *
 * Terminal states: ready, failed, expired
 */

import type { SessionState } from "../types";

// Terminal states — no transitions allowed from these
const TERMINAL_STATES: SessionState[] = ["ready", "failed", "expired"];

/**
 * Valid transitions: Map<from, Set<to>>
 */
const VALID_TRANSITIONS = new Map<SessionState, SessionState[]>([
  ["uploading", ["detecting", "generating", "failed", "expired"]],
  ["detecting", ["uploading", "analyzing", "generating", "failed", "expired"]],
  ["analyzing", ["generating", "failed", "expired"]],
  ["generating", ["ready", "failed", "expired"]],
  ["ready", ["expired"]],
  ["failed", []],
  ["expired", []],
]);

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (TERMINAL_STATES.includes(from) && from !== "ready") return false;
  const allowed = VALID_TRANSITIONS.get(from) ?? [];
  return allowed.includes(to);
}

export function assertTransition(
  from: SessionState,
  to: SessionState
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} → ${to}`
    );
  }
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isExpired(createdAt: number, ttlSeconds: number): boolean {
  return Date.now() > createdAt + ttlSeconds * 1000;
}
