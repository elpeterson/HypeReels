/**
 * BullMQ worker — runs inside the Next.js process at app startup.
 *
 * Job queues:
 *   thumbnail-extract  — FFmpeg first-frame JPEG extraction
 *   detect-persons     — Python InsightFace person detection
 *   analyze-audio      — Python librosa audio analysis
 *   generate-reel      — Scene selection + FFmpeg assembly
 *   cleanup-session    — MinIO + Redis deletion
 */

import { Worker, Job } from "bullmq";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

import { config } from "../lib/config";
import {
  getSession,
  updateSessionState,
  updateClipInSession,
  updateSessionReelKey,
  getPersons,
  setPersons,
  setJobProgress,
  deleteSessionKeys,
} from "../lib/redis";
import {
  getObjectBuffer,
  putObject,
  deleteSessionObjects,
  objectKeys,
} from "../lib/storage";
import { extractThumbnail, getVideoDurationMs, assembleReel } from "./ffmpeg";
import { runDetectPersons, runAnalyzeAudio } from "./python";
import { buildEdl } from "./scene-selection";
import type {
  ThumbnailExtractJobData,
  DetectPersonsJobData,
  AnalyzeAudioJobData,
  GenerateReelJobData,
  CleanupSessionJobData,
} from "../lib/queue";
import {
  QUEUE_THUMBNAIL,
  QUEUE_DETECT_PERSONS,
  QUEUE_ANALYZE_AUDIO,
  QUEUE_GENERATE_REEL,
  QUEUE_CLEANUP,
} from "../lib/queue";

// ─── Connection options ───────────────────────────────────────────────────────

const connection = {
  host: new URL(config.redis.url.replace(/^redis:\/\//, "http://")).hostname,
  port: Number(
    new URL(config.redis.url.replace(/^redis:\/\//, "http://")).port || 6379
  ),
};

// ─── Temp directory ───────────────────────────────────────────────────────────

async function ensureTempDir(): Promise<string> {
  await fs.mkdir(config.worker.tempDir, { recursive: true });
  return config.worker.tempDir;
}

async function createJobTempDir(jobId: string): Promise<string> {
  const dir = path.join(config.worker.tempDir, `job-${jobId}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupJobTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of temp files
  }
}

// ─── Job: thumbnail-extract ───────────────────────────────────────────────────

async function handleThumbnailExtract(job: Job<ThumbnailExtractJobData>): Promise<void> {
  const { session_id, clip_id, object_key } = job.data;
  const tempDir = await createJobTempDir(job.id!);

  try {
    await job.updateProgress(10);

    // Download clip from MinIO
    const clipBuffer = await getObjectBuffer(object_key);
    const clipPath = path.join(tempDir, `clip.${object_key.split(".").pop()}`);
    await fs.writeFile(clipPath, clipBuffer);

    await job.updateProgress(40);

    // Extract first frame as JPEG
    const thumbPath = path.join(tempDir, "thumbnail.jpg");
    await extractThumbnail(clipPath, thumbPath);

    await job.updateProgress(70);

    // Get clip duration while we have the file
    let durationMs = 0;
    try {
      durationMs = await getVideoDurationMs(clipPath);
    } catch {
      console.warn(`[thumbnail-extract] Could not get duration for clip ${clip_id}`);
    }

    // Upload thumbnail to MinIO
    const thumbBuffer = await fs.readFile(thumbPath);
    const thumbKey = objectKeys.thumbnail(session_id, clip_id);
    await putObject(thumbKey, thumbBuffer, "image/jpeg");

    await job.updateProgress(90);

    // Update session clip record
    await updateClipInSession(session_id, clip_id, {
      thumbnail_key: thumbKey,
      duration_ms: durationMs,
    });

    await job.updateProgress(100);
    console.log(`[thumbnail-extract] done session=${session_id} clip=${clip_id}`);
  } finally {
    await cleanupJobTempDir(tempDir);
  }
}

// ─── Job: detect-persons ──────────────────────────────────────────────────────

async function handleDetectPersons(job: Job<DetectPersonsJobData>): Promise<void> {
  const { session_id, clip_ids } = job.data;
  const tempDir = await createJobTempDir(job.id!);

  const progressPerClip = Math.floor(80 / clip_ids.length);

  try {
    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Analyzing clips for people…",
      pct: 5,
      message: `Starting person detection for ${clip_ids.length} clip(s)`,
      updated_at: Date.now(),
    });

    const session = await getSession(session_id);
    if (!session) throw new Error(`Session ${session_id} not found`);

    const allPersons: Record<string, import("./python").DetectedPerson> = {};
    let clipProgress = 5;

    for (const clipId of clip_ids) {
      const clip = session.clips.find((c) => c.clip_id === clipId);
      if (!clip) continue;

      const ext = clip.filename.split(".").pop()?.toLowerCase() ?? "mp4";
      const objectKey = objectKeys.clip(session_id, clipId, ext);

      // Download clip
      const clipBuffer = await getObjectBuffer(objectKey);
      const clipPath = path.join(tempDir, `${clipId}.${ext}`);
      await fs.writeFile(clipPath, clipBuffer);

      // Run detect_persons.py
      try {
        const detected = await runDetectPersons(
          clipPath,
          session_id,
          clipId,
          tempDir,
          config.worker.timeouts.detectPersonsMs
        );

        // Upload person thumbnails to MinIO and merge into global list
        for (const person of detected) {
          const cropPath = path.join(tempDir, `${person.person_id}.jpg`);
          try {
            const cropBuffer = await fs.readFile(cropPath);
            const personKey = objectKeys.person(session_id, person.person_id);
            await putObject(personKey, cropBuffer, "image/jpeg");
            person.thumbnail = personKey;
          } catch {
            console.warn(
              `[detect-persons] Could not upload thumbnail for person ${person.person_id}`
            );
          }

          if (allPersons[person.person_id]) {
            // Merge appearances
            allPersons[person.person_id].appearances.push(
              ...person.appearances
            );
          } else {
            allPersons[person.person_id] = person;
          }
        }
      } catch (err) {
        console.error(
          `[detect-persons] Detection failed for clip ${clipId}:`,
          err
        );
        // Mark clip as detection_failed but continue with other clips
        await updateClipInSession(session_id, clipId, {
          status: "detection_failed",
        });
      }

      clipProgress += progressPerClip;
      await setJobProgress(job.id!, {
        status: "processing",
        stage: "Analyzing clips for people…",
        pct: Math.min(85, clipProgress),
        message: `Processed clip ${clip_ids.indexOf(clipId) + 1} of ${clip_ids.length}`,
        updated_at: Date.now(),
      });
    }

    // Write merged persons to Redis
    // DetectedPerson and Person share the same shape — cast is safe
    await setPersons(session_id, Object.values(allPersons) as import("../types").Person[]);

    // Update session state back to uploading (detection done, user can continue)
    await updateSessionState(session_id, "uploading");

    await setJobProgress(job.id!, {
      status: "completed",
      stage: "Detection complete",
      pct: 100,
      message: `Found ${Object.keys(allPersons).length} person(s)`,
      updated_at: Date.now(),
    });

    console.log(
      `[detect-persons] done session=${session_id}, persons=${Object.keys(allPersons).length}`
    );
  } finally {
    await cleanupJobTempDir(tempDir);
  }
}

// ─── Job: analyze-audio ───────────────────────────────────────────────────────

async function handleAnalyzeAudio(job: Job<AnalyzeAudioJobData>): Promise<void> {
  const { session_id, audio_id, object_key } = job.data;
  const tempDir = await createJobTempDir(job.id!);

  try {
    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Analyzing audio…",
      pct: 10,
      message: "Downloading audio track",
      updated_at: Date.now(),
    });

    // Download audio from MinIO
    const audioBuffer = await getObjectBuffer(object_key);
    const ext = object_key.split(".").pop()?.toLowerCase() ?? "mp3";
    const audioPath = path.join(tempDir, `audio.${ext}`);
    await fs.writeFile(audioPath, audioBuffer);

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Analyzing audio…",
      pct: 30,
      message: "Running beat analysis",
      updated_at: Date.now(),
    });

    // Run analyze_audio.py
    const analysis = await runAnalyzeAudio(
      audioPath,
      config.worker.timeouts.analyzeAudioMs
    );

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Analyzing audio…",
      pct: 80,
      message: "Saving analysis",
      updated_at: Date.now(),
    });

    // Write analysis JSON to MinIO
    const analysisKey = objectKeys.analysis(session_id);
    await putObject(
      analysisKey,
      Buffer.from(JSON.stringify(analysis)),
      "application/json"
    );

    await setJobProgress(job.id!, {
      status: "completed",
      stage: "Audio analysis complete",
      pct: 100,
      message: `BPM: ${analysis.bpm.toFixed(1)}, beats: ${analysis.beats.length}`,
      updated_at: Date.now(),
    });

    console.log(
      `[analyze-audio] done session=${session_id} bpm=${analysis.bpm}`
    );
  } finally {
    await cleanupJobTempDir(tempDir);
  }
}

// ─── Job: generate-reel ───────────────────────────────────────────────────────

async function handleGenerateReel(job: Job<GenerateReelJobData>): Promise<void> {
  const { session_id } = job.data;
  const tempDir = await createJobTempDir(job.id!);

  try {
    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Preparing reel generation…",
      pct: 5,
      message: "Reading session data",
      updated_at: Date.now(),
    });

    const session = await getSession(session_id);
    if (!session) throw new Error(`Session ${session_id} not found`);

    const readyClips = session.clips.filter((c) => c.status === "ready");
    if (readyClips.length === 0) {
      throw new Error("No ready clips for reel generation");
    }
    if (!session.audio) {
      throw new Error("No audio track for reel generation");
    }

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Loading audio analysis…",
      pct: 10,
      message: "Reading audio analysis",
      updated_at: Date.now(),
    });

    // Load analysis.json from MinIO
    const analysisBuffer = await getObjectBuffer(objectKeys.analysis(session_id));
    const analysis = JSON.parse(analysisBuffer.toString()) as import("./python").AudioAnalysis;

    // Load persons
    const persons = await getPersons(session_id);

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Selecting scenes…",
      pct: 20,
      message: "Running scene selection",
      updated_at: Date.now(),
    });

    // Run scene selection → EDL
    const edl = buildEdl({
      clips: readyClips,
      persons,
      selectedPersonId: session.person_id,
      analysis,
    });

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Downloading clips…",
      pct: 30,
      message: `Downloading ${readyClips.length} clip(s)`,
      updated_at: Date.now(),
    });

    // Download all needed clips
    const clipPaths: Record<string, string> = {};
    for (const clip of readyClips) {
      const ext = clip.filename.split(".").pop()?.toLowerCase() ?? "mp4";
      const clipKey = objectKeys.clip(session_id, clip.clip_id, ext);
      const clipBuffer = await getObjectBuffer(clipKey);
      const clipPath = path.join(tempDir, `${clip.clip_id}.${ext}`);
      await fs.writeFile(clipPath, clipBuffer);
      clipPaths[clip.clip_id] = clipPath;
    }

    // Download audio
    const audioExt = session.audio.object_key.split(".").pop()?.toLowerCase() ?? "mp3";
    const audioBuffer = await getObjectBuffer(session.audio.object_key);
    const audioPath = path.join(tempDir, `audio.${audioExt}`);
    await fs.writeFile(audioPath, audioBuffer);

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Assembling reel…",
      pct: 50,
      message: `Assembling ${edl.length} scene(s)`,
      updated_at: Date.now(),
    });

    // Check if audio had no beats → notify user
    if (analysis.beats.length === 0) {
      console.log(
        "[generate-reel] Beat sync unavailable — cuts made at regular intervals"
      );
      await updateSessionState(
        session_id,
        "generating",
        "Beat sync unavailable — cuts made at regular intervals"
      );
    }

    // Assemble reel with FFmpeg
    const outputPath = path.join(tempDir, "reel.mp4");
    const concatListPath = path.join(tempDir, "concat.txt");

    await assembleReel({
      edl,
      clipPaths,
      audioPath,
      outputPath,
      concatListPath,
      timeoutMs: config.worker.timeouts.generateReelMs,
    });

    await setJobProgress(job.id!, {
      status: "processing",
      stage: "Uploading reel…",
      pct: 85,
      message: "Uploading finished reel",
      updated_at: Date.now(),
    });

    // Upload reel.mp4 to MinIO
    const reelKey = objectKeys.reel(session_id);
    const reelBuffer = await fs.readFile(outputPath);
    await putObject(reelKey, reelBuffer, "video/mp4");

    // Update session state to ready
    await updateSessionReelKey(session_id, reelKey);
    await updateSessionState(session_id, "ready");

    await setJobProgress(job.id!, {
      status: "completed",
      stage: "Reel ready",
      pct: 100,
      message: "Your hype reel is ready to download!",
      updated_at: Date.now(),
    });

    console.log(`[generate-reel] done session=${session_id} key=${reelKey}`);
  } catch (err) {
    // Mark session as failed with actionable message
    const message =
      err instanceof Error ? err.message : "Reel generation failed";
    await updateSessionState(session_id, "failed", message).catch(() => {});
    await setJobProgress(job.id!, {
      status: "failed",
      stage: "Generation failed",
      pct: 0,
      message,
      error: message,
      updated_at: Date.now(),
    }).catch(() => {});
    throw err; // Let BullMQ mark job as failed
  } finally {
    await cleanupJobTempDir(tempDir);
  }
}

// ─── Job: cleanup-session ─────────────────────────────────────────────────────

async function handleCleanupSession(job: Job<CleanupSessionJobData>): Promise<void> {
  const { session_id, trigger } = job.data;

  console.log(
    `[cleanup-session] start session=${session_id} trigger=${trigger}`
  );

  try {
    // Delete all MinIO objects under {session_id}/
    const { deleted, errors } = await deleteSessionObjects(session_id);

    // Delete Redis keys
    await deleteSessionKeys(session_id);

    console.log(
      `[cleanup-session] done session=${session_id} deleted=${deleted} errors=${errors.length} trigger=${trigger}`
    );

    if (errors.length > 0) {
      // Partial failure — log but don't retry (MinIO lifecycle policy is the safety net)
      console.error(
        `[cleanup-session] ${errors.length} deletion error(s) for session=${session_id}:`,
        errors
      );
    }
  } catch (err) {
    console.error(
      `[cleanup-session] fatal error for session=${session_id}:`,
      err
    );
    throw err; // BullMQ will retry with backoff
  }
}

// ─── Worker initialization ────────────────────────────────────────────────────

const workerOptions = {
  connection,
  concurrency: 1,
};

export function startWorker(): void {
  ensureTempDir().catch(console.error);

  const thumbnailWorker = new Worker(
    QUEUE_THUMBNAIL,
    async (job) => handleThumbnailExtract(job as Job<ThumbnailExtractJobData>),
    {
      ...workerOptions,
      concurrency: 5, // Thumbnails are fast, allow parallelism
    }
  );

  const detectPersonsWorker = new Worker(
    QUEUE_DETECT_PERSONS,
    async (job) => handleDetectPersons(job as Job<DetectPersonsJobData>),
    workerOptions
  );

  const analyzeAudioWorker = new Worker(
    QUEUE_ANALYZE_AUDIO,
    async (job) => handleAnalyzeAudio(job as Job<AnalyzeAudioJobData>),
    workerOptions
  );

  const generateReelWorker = new Worker(
    QUEUE_GENERATE_REEL,
    async (job) => handleGenerateReel(job as Job<GenerateReelJobData>),
    workerOptions
  );

  const cleanupWorker = new Worker(
    QUEUE_CLEANUP,
    async (job) => handleCleanupSession(job as Job<CleanupSessionJobData>),
    {
      ...workerOptions,
      concurrency: 3,
    }
  );

  // Error logging — never crash the process on job failure
  for (const worker of [
    thumbnailWorker,
    detectPersonsWorker,
    analyzeAudioWorker,
    generateReelWorker,
    cleanupWorker,
  ]) {
    worker.on("failed", (job, err) => {
      console.error(
        `[worker] job failed queue=${worker.name} job_id=${job?.id}:`,
        err.message
      );
    });
    worker.on("error", (err) => {
      console.error(`[worker] worker error queue=${worker.name}:`, err.message);
    });
  }

  console.log("[worker] BullMQ workers started");
}
