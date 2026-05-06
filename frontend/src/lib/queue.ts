/**
 * BullMQ queue definitions and job enqueue helpers.
 *
 * All queues share the same Redis connection.
 * Note: BullMQ does not support per-job timeouts via JobsOptions.
 * Timeouts are enforced at the Worker level via lockDuration.
 */

import { Queue, FlowProducer } from "bullmq";
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

let _flow: FlowProducer | null = null;

function getFlowProducer(): FlowProducer {
  if (!_flow) {
    _flow = new FlowProducer({ connection });
  }
  return _flow;
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

/**
 * Enqueue the analyze-audio → generate-reel flow using BullMQ FlowProducer.
 *
 * FlowProducer creates a parent→child dependency: the parent (generate-reel)
 * remains in "waiting-children" state until all children (analyze-audio)
 * complete successfully. This replaces the previous `depends_on` option which
 * is NOT a valid BullMQ API and was silently ignored, causing generate-reel to
 * start in parallel with analyze-audio and fail because analysis.json didn't
 * exist yet.
 *
 * Returns both job IDs. The caller returns `generateJobId` to the frontend
 * for progress polling.
 */
export async function enqueueReelGenerationFlow(
  analyzeData: AnalyzeAudioJobData,
  generateData: GenerateReelJobData
): Promise<{ analyzeJobId: string; generateJobId: string }> {
  const flow = getFlowProducer();

  const added = await flow.add({
    name: "generate-reel",
    queueName: QUEUE_GENERATE_REEL,
    data: generateData,
    opts: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 50,
    },
    children: [
      {
        name: "analyze-audio",
        queueName: QUEUE_ANALYZE_AUDIO,
        data: analyzeData,
        opts: {
          attempts: 2,
          backoff: { type: "exponential", delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      },
    ],
  });

  const generateJobId = added.job.id!;
  const analyzeJobId = added.children![0].job.id!;

  return { analyzeJobId, generateJobId };
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
