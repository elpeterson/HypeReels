/**
 * Job producer helpers — convenience wrappers around BullMQ Queue.add().
 */
import {
  validationQueue,
  clipValidationQueue,
  audioAnalysisQueue,
  personDetectionQueue,
  generationQueue,
  cleanupQueue,
  type ValidationJobData,
  type ClipValidationJobData,
  type AudioAnalysisJobData,
  type PersonDetectionJobData,
  type GenerationJobData,
  type CleanupJobData,
} from './queues.js';

// ── Default retry settings ─────────────────────────────────
const defaultAttempts = 3;
const exponentialBackoff = {
  type: 'exponential' as const,
  delay: 5_000,
};

// ─────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────

export async function enqueueClipValidation(
  sessionId: string,
  clipId: string,
  minioKey: string,
): Promise<string> {
  const data: ValidationJobData = {
    type: 'clip',
    sessionId,
    resourceId: clipId,
    minioKey,
  };
  const job = await validationQueue.add(`validate-clip:${clipId}`, data, {
    attempts: defaultAttempts,
    backoff: exponentialBackoff,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  });
  return job.id ?? '';
}

export async function enqueueAudioValidation(
  sessionId: string,
  audioTrackId: string,
  minioKey: string,
): Promise<string> {
  const data: ValidationJobData = {
    type: 'audio',
    sessionId,
    resourceId: audioTrackId,
    minioKey,
  };
  const job = await validationQueue.add(`validate-audio:${audioTrackId}`, data, {
    attempts: defaultAttempts,
    backoff: exponentialBackoff,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  });
  return job.id ?? '';
}

// ─────────────────────────────────────────────────────────
// Clip Validation (dedicated queue — distinct from legacy validation queue)
// ─────────────────────────────────────────────────────────

export async function enqueueClipValidationJob(
  sessionId: string,
  clipId: string,
  minioKey: string,
): Promise<string> {
  const data: ClipValidationJobData = { sessionId, clipId, minioKey };
  const job = await clipValidationQueue.add(`clip-validate:${clipId}`, data, {
    attempts: defaultAttempts,
    backoff: exponentialBackoff,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  });
  return job.id ?? '';
}

// ─────────────────────────────────────────────────────────
// Audio Analysis
// ─────────────────────────────────────────────────────────

export async function enqueueAudioAnalysis(
  sessionId: string,
  audioTrackId: string,
  minioKey: string,
): Promise<string> {
  const data: AudioAnalysisJobData = { sessionId, audioTrackId, minioKey };
  const job = await audioAnalysisQueue.add(
    `audio-analysis:${audioTrackId}`,
    data,
    {
      attempts: defaultAttempts,
      backoff: exponentialBackoff,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  );
  return job.id ?? '';
}

// ─────────────────────────────────────────────────────────
// Person Detection
// ─────────────────────────────────────────────────────────

export async function enqueuePersonDetection(
  sessionId: string,
  clipId: string,
  minioKey: string,
): Promise<string> {
  const data: PersonDetectionJobData = { sessionId, clipId, minioKey };
  const job = await personDetectionQueue.add(
    `person-detection:${clipId}`,
    data,
    {
      attempts: defaultAttempts,
      backoff: exponentialBackoff,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  );
  return job.id ?? '';
}

// ─────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────

export async function enqueueGeneration(
  sessionId: string,
  jobId: string,
): Promise<string> {
  const data: GenerationJobData = { sessionId, jobId };
  const job = await generationQueue.add(`generation:${jobId}`, data, {
    attempts: 2, // generation is expensive — fewer retries
    backoff: exponentialBackoff,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  });
  return job.id ?? '';
}

// ─────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────

export async function enqueueCleanup(
  sessionId: string,
  reason: CleanupJobData['reason'],
  delayMs = 0,
): Promise<string> {
  const data: CleanupJobData = { sessionId, reason };
  const job = await cleanupQueue.add(`cleanup:${sessionId}`, data, {
    delay: delayMs,
    attempts: 3,
    backoff: exponentialBackoff,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
    // Deduplicate: if a cleanup job is already queued for this session,
    // don't add another one
    jobId: `cleanup:${sessionId}`,
  });
  return job.id ?? '';
}
