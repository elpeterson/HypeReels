/**
 * BullMQ queue definitions.
 * All workers and job producers import from this file.
 */
import { Queue } from 'bullmq';
import { getRedis } from '../lib/redis.js';

const connection = { lazyConnect: false } as const;

function makeQueue<T>(name: string): Queue<T> {
  return new Queue<T>(name, { connection: getRedis() });
}

// ── Queue names ────────────────────────────────────────────
export const QUEUE_VALIDATION = 'validation';
export const QUEUE_CLIP_VALIDATION = 'clip-validation';
export const QUEUE_AUDIO_ANALYSIS = 'audio-analysis';
export const QUEUE_PERSON_DETECTION = 'person-detection';
export const QUEUE_GENERATION = 'generation';
export const QUEUE_CLEANUP = 'cleanup';
export const QUEUE_STALE_SESSIONS = 'stale-sessions';

// ── Typed job data interfaces ──────────────────────────────

export interface ValidationJobData {
  type: 'clip' | 'audio';
  sessionId: string;
  resourceId: string;   // clip_id or audio_track_id
  minioKey: string;
}

export interface AudioAnalysisJobData {
  sessionId: string;
  audioTrackId: string;
  minioKey: string;
}

export interface PersonDetectionJobData {
  sessionId: string;
  clipId: string;
  minioKey: string;
}

export interface ClipValidationJobData {
  sessionId: string;
  clipId: string;
  minioKey: string;
}

export interface GenerationJobData {
  sessionId: string;
  jobId: string;       // generation_jobs.id
}

export interface CleanupJobData {
  sessionId: string;
  reason: 'download-initiated' | 'done' | 'start-over' | 'ttl-expired';
}

// ── Queue instances ────────────────────────────────────────

export const validationQueue = makeQueue<ValidationJobData>(QUEUE_VALIDATION);
export const clipValidationQueue = makeQueue<ClipValidationJobData>(QUEUE_CLIP_VALIDATION);
export const audioAnalysisQueue = makeQueue<AudioAnalysisJobData>(QUEUE_AUDIO_ANALYSIS);
export const personDetectionQueue = makeQueue<PersonDetectionJobData>(QUEUE_PERSON_DETECTION);
export const generationQueue = makeQueue<GenerationJobData>(QUEUE_GENERATION);
export const cleanupQueue = makeQueue<CleanupJobData>(QUEUE_CLEANUP);
export const staleSessionsQueue = makeQueue<Record<string, never>>(QUEUE_STALE_SESSIONS);

// ── Close all queues gracefully ────────────────────────────
export async function closeQueues(): Promise<void> {
  await Promise.all([
    validationQueue.close(),
    clipValidationQueue.close(),
    audioAnalysisQueue.close(),
    personDetectionQueue.close(),
    generationQueue.close(),
    cleanupQueue.close(),
    staleSessionsQueue.close(),
  ]);
}

void connection; // suppress unused-import
