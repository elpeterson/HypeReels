/**
 * Redis client (ioredis) + session CRUD helpers.
 *
 * Session data is stored as a Redis hash: session:{id}
 * Person data: persons:{session_id} (JSON string)
 * Job progress: progress:{job_id} (JSON string)
 */

import Redis from "ioredis";
import { config } from "./config";
import type {
  Session,
  SessionState,
  Clip,
  AudioTrack,
  Highlight,
  JobProgress,
  Person,
} from "../types";

// ─── Singleton client ────────────────────────────────────────────────────────

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      // enableOfflineQueue: true (default) — allows commands to queue while the
      // TCP handshake completes on startup. Setting this to false would cause
      // the very first request after container start to fail with a write error
      // even though depends_on: redis healthy has passed.
      lazyConnect: false,
    });
    _redis.on("error", (err) => {
      console.error("[redis] connection error", err.message);
    });
  }
  return _redis;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

export const sessionKey = (id: string) => `session:${id}`;
export const personsKey = (sessionId: string) => `persons:${sessionId}`;
export const progressKey = (jobId: string) => `progress:${jobId}`;

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export async function createSession(id: string): Promise<Session> {
  const redis = getRedis();
  const now = Date.now();

  const session: Session = {
    id,
    state: "uploading",
    created_at: now,
    clips: [],
    audio: null,
    person_id: null,
    reel_key: null,
    error: null,
  };

  const key = sessionKey(id);
  await redis.hset(key, {
    id,
    state: "uploading",
    created_at: String(now),
    clips: JSON.stringify([]),
    audio: "null",
    person_id: "null",
    reel_key: "null",
    error: "null",
  });

  // TTL: auto-expire session keys after configured TTL
  await redis.expire(key, config.session.ttlSeconds);

  return session;
}

export async function getSession(id: string): Promise<Session | null> {
  const redis = getRedis();
  const data = await redis.hgetall(sessionKey(id));

  if (!data || !data.id) return null;

  return {
    id: data.id,
    state: data.state as SessionState,
    created_at: Number(data.created_at),
    clips: JSON.parse(data.clips ?? "[]") as Clip[],
    audio: JSON.parse(data.audio ?? "null") as AudioTrack | null,
    person_id: JSON.parse(data.person_id ?? "null") as string | null,
    reel_key: JSON.parse(data.reel_key ?? "null") as string | null,
    error: JSON.parse(data.error ?? "null") as string | null,
  };
}

export async function updateSessionState(
  id: string,
  state: SessionState,
  error?: string
): Promise<void> {
  const redis = getRedis();
  const updates: Record<string, string> = { state };
  if (error !== undefined) {
    updates.error = JSON.stringify(error);
  }
  await redis.hset(sessionKey(id), updates);
}

export async function updateSessionClips(
  id: string,
  clips: Clip[]
): Promise<void> {
  const redis = getRedis();
  await redis.hset(sessionKey(id), { clips: JSON.stringify(clips) });
}

export async function updateSessionAudio(
  id: string,
  audio: AudioTrack | null
): Promise<void> {
  const redis = getRedis();
  await redis.hset(sessionKey(id), { audio: JSON.stringify(audio) });
}

export async function updateSessionPerson(
  id: string,
  personId: string | null
): Promise<void> {
  const redis = getRedis();
  await redis.hset(sessionKey(id), { person_id: JSON.stringify(personId) });
}

export async function updateSessionReelKey(
  id: string,
  reelKey: string
): Promise<void> {
  const redis = getRedis();
  await redis.hset(sessionKey(id), { reel_key: JSON.stringify(reelKey) });
}

// ─── Clip helpers ─────────────────────────────────────────────────────────────

export async function addClipToSession(
  sessionId: string,
  clip: Clip
): Promise<Clip[]> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const clips = [...session.clips, clip];
  await updateSessionClips(sessionId, clips);
  return clips;
}

export async function removeClipFromSession(
  sessionId: string,
  clipId: string
): Promise<Clip[]> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const clips = session.clips.filter((c) => c.clip_id !== clipId);
  await updateSessionClips(sessionId, clips);
  return clips;
}

export async function updateClipInSession(
  sessionId: string,
  clipId: string,
  updates: Partial<Clip>
): Promise<Clip[]> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const clips = session.clips.map((c) =>
    c.clip_id === clipId ? { ...c, ...updates } : c
  );
  await updateSessionClips(sessionId, clips);
  return clips;
}

export async function addHighlightToClip(
  sessionId: string,
  clipId: string,
  highlight: Highlight
): Promise<Clip[]> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const clips = session.clips.map((c) => {
    if (c.clip_id !== clipId) return c;
    return { ...c, highlights: [...c.highlights, highlight] };
  });
  await updateSessionClips(sessionId, clips);
  return clips;
}

export async function removeHighlightFromClip(
  sessionId: string,
  clipId: string,
  highlightId: string
): Promise<Clip[]> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const clips = session.clips.map((c) => {
    if (c.clip_id !== clipId) return c;
    return {
      ...c,
      highlights: c.highlights.filter((h) => h.highlight_id !== highlightId),
    };
  });
  await updateSessionClips(sessionId, clips);
  return clips;
}

// ─── Persons ──────────────────────────────────────────────────────────────────

export async function setPersons(
  sessionId: string,
  persons: Person[]
): Promise<void> {
  const redis = getRedis();
  const key = personsKey(sessionId);
  await redis.set(key, JSON.stringify(persons));
  await redis.expire(key, config.session.ttlSeconds);
}

export async function getPersons(sessionId: string): Promise<Person[]> {
  const redis = getRedis();
  const data = await redis.get(personsKey(sessionId));
  if (!data) return [];
  return JSON.parse(data) as Person[];
}

// ─── Job progress ─────────────────────────────────────────────────────────────

export async function setJobProgress(
  jobId: string,
  progress: Omit<JobProgress, "job_id">
): Promise<void> {
  const redis = getRedis();
  const key = progressKey(jobId);
  await redis.set(key, JSON.stringify({ ...progress, job_id: jobId }));
  // Progress keys expire 15 min after last update
  await redis.expire(key, 15 * 60);
}

export async function getJobProgress(
  jobId: string
): Promise<JobProgress | null> {
  const redis = getRedis();
  const data = await redis.get(progressKey(jobId));
  if (!data) return null;
  return JSON.parse(data) as JobProgress;
}

// ─── Session deletion ─────────────────────────────────────────────────────────

export async function deleteSessionKeys(sessionId: string): Promise<void> {
  const redis = getRedis();
  const keys = [
    sessionKey(sessionId),
    personsKey(sessionId),
  ];
  // Also delete progress keys for any jobs associated with this session
  // (these expire on their own TTL, but explicit deletion is cleaner)
  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.del(key);
  }
  await pipeline.exec();
  console.log(`[redis] deleted session keys for ${sessionId}`);
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function pingRedis(): Promise<boolean> {
  try {
    const redis = getRedis();
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
