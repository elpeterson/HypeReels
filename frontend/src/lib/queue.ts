/**
 * BullMQ queue definitions and job enqueue helpers.
 *
 * All queues share the same Redis connection.
 * Note: BullMQ does not support per-job timeouts via JobsOptions.
 * Timeouts are enforced at the Worker level via lockDuration.
 */

import { Queue } from "bullmq";
import { config } from "./config";

// ─── Connection options ───────────────────────────────────────────────────────

const connection = {
  host: new URL(config.redis.url.replace(/^redis:\/\//, "http://")).hostname,
  port: Number(
    new URL(config.redis.url.replace(/^redis:\/\//, "http://")).port || 6379
  ),
};

// ─── Queue names ──────────────────────────────────────────────────────────────

export const QUEUE_THUMBNAIL = "thumbnail-extract";
export const QUEUE_DETECT_PERSONS = "detect-persons";
export const QUEUE_ANALYZE_AUDIO = "analyze-audio";
export const QUEUE_GENERATE_REEL = "generate-reel";
export const QUEUE_CLEANUP = "cleanup-session";

// ─── Queue singletons ─────────────────────────────────────────────────────────

const _queues: Map<string, Queue> = new Map();

function getQueue(name: string): Queue {
  if (!_queues.has(name)) {
    _queues.set(name, new Queue(name, { connection }));
  }
  return _queues.get(name)!;
}

// ─── Job payload types ────────────────────────────────────────────────────────

export interface ThumbnailExtractJobData {
  session_id: string;
  clip_id: string;
  object_key: string;
}

export interface DetectPersonsJobData {
  session_id: string;
  clip_ids: string[];
}

export interface AnalyzeAudioJobData {
  session_id: string;
  audio_id: string;
  object_key: string;
}

export interface GenerateReelJobData {
  session_id: string;
  analyze_audio_job_id: string;
}

export interface CleanupSessionJobData {
  session_id: string;
  trigger: "download" | "ttl_expiry" | "manual_delete";
}

// ─── Enqueue helpers ──────────────────────────────────────────────────────────

export async function enqueueThumbnailExtract(
  data: ThumbnailExtractJobData
): Promise<string> {
  const queue = getQueue(QUEUE_THUMBNAIL);
  const job = await queue.add("thumbnail-extract", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return job.id!;
}

export async function enqueueDetectPersons(
  data: DetectPersonsJobData
): Promise<string> {
  const queue = getQueue(QUEUE_DETECT_PERSONS);
  const job = await queue.add("detect-persons", data, {
    attempts: 2,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return job.id!;
}

export async function enqueueAnalyzeAudio(
  data: AnalyzeAudioJobData
): Promise<string> {
  const queue = getQueue(QUEUE_ANALYZE_AUDIO);
  const job = await queue.add("analyze-audio", data, {
    attempts: 2,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return job.id!;
}

export async function enqueueGenerateReel(
  data: GenerateReelJobData,
  dependsOnJobId?: string
): Promise<string> {
  const queue = getQueue(QUEUE_GENERATE_REEL);
  const job = await queue.add("generate-reel", data, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 50,
    ...(dependsOnJobId && { depends_on: [dependsOnJobId] }),
  });
  return job.id!;
}

export async function enqueueCleanup(
  data: CleanupSessionJobData,
  delayMs?: number
): Promise<string> {
  const queue = getQueue(QUEUE_CLEANUP);
  const job = await queue.add("cleanup-session", data, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return job.id!;
}
