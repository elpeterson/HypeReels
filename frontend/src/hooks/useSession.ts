"use client";

import { useState, useEffect, useCallback } from "react";
import { createSession, getSession } from "@/lib/api";
import { getStoredSessionId, storeSessionId, clearSessionId } from "@/lib/session";
import type { Session } from "@/types";

export interface UseSessionReturn {
  sessionId: string | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  refreshSession: () => Promise<void>;
  initSession: () => Promise<string>;
  expireSession: () => void;
}

/**
 * Manages the ephemeral session lifecycle.
 *
 * - On mount: reads stored session ID from localStorage.
 * - If session ID exists: fetches current session state.
 * - If session is expired or missing: ready for init.
 * - initSession(): creates a new session and stores the ID.
 */
export function useSession(): UseSessionReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSession = useCallback(async (id: string) => {
    try {
      const data = await getSession(id);
      setSession(data);
      setError(null);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "SessionExpiredError") {
        clearSessionId();
        setSessionId(null);
        setSession(null);
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to load session.");
      }
    }
  }, []);

  useEffect(() => {
    const stored = getStoredSessionId();
    if (stored) {
      setSessionId(stored);
      fetchSession(stored).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [fetchSession]);

  const refreshSession = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    await fetchSession(sessionId);
    setLoading(false);
  }, [sessionId, fetchSession]);

  const initSession = useCallback(async (): Promise<string> => {
    setLoading(true);
    setError(null);
    try {
      const id = await createSession();
      storeSessionId(id);
      setSessionId(id);
      return id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create session.";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const expireSession = useCallback(() => {
    clearSessionId();
    setSessionId(null);
    setSession(null);
    setError(null);
  }, []);

  return {
    sessionId,
    session,
    loading,
    error,
    refreshSession,
    initSession,
    expireSession,
  };
}
