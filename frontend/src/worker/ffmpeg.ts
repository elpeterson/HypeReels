/**
 * FFmpeg spawn helpers for the BullMQ worker.
 *
 * Encoder selection: FFMPEG_HWACCEL=nvenc → attempt NVENC;
 * if CUDA device absent, log warning and fall back to libx264.
 */

import { spawn } from "child_process";
import { config } from "../lib/config";

export interface FfmpegOptions {
  input: string;
  output: string;
  args?: string[];
  timeout?: number;
}

/**
 * Run FFmpeg with the given args, resolving on exit code 0, rejecting otherwise.
 */
export function runFfmpeg(
  args: string[],
  timeoutMs?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve();
      } else {
        // Do not surface raw stderr to API — log only
        console.error("[ffmpeg] stderr:", stderr.slice(-1000));
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Extract the first frame of a video as a JPEG.
 */
export async function extractThumbnail(
  videoPath: string,
  outputPath: string
): Promise<void> {
  await runFfmpeg([
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath,
  ]);
}

/**
 * Get video duration in milliseconds using ffprobe.
 */
export function getVideoDurationMs(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      videoPath,
    ]);

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const duration = parseFloat(info.format?.duration ?? "0");
        resolve(Math.round(duration * 1000));
      } catch (err) {
        reject(new Error("Failed to parse ffprobe output"));
      }
    });

    proc.on("error", reject);
  });
}

/**
 * Determine the FFmpeg video encoder to use.
 * Attempts NVENC if FFMPEG_HWACCEL=nvenc; falls back to libx264.
 */
export function getVideoEncoder(): string {
  if (config.ffmpeg.hwaccel === "nvenc") {
    // We can't check for GPU at this point without spawning a test encode;
    // the worker will handle NVENC → x264 fallback via error handling.
    return "h264_nvenc";
  }
  return "libx264";
}

export interface EdlEntry {
  clip_id: string;
  start_ms: number;
  end_ms: number;
  transition: "cut";
}

/**
 * Assemble reel from EDL + audio using FFmpeg concat demuxer.
 *
 * Strategy:
 * 1. Build a concat list file with each EDL segment trimmed from its source clip.
 * 2. Run FFmpeg concat + audio mix.
 * 3. If NVENC fails (no GPU), retry with libx264.
 */
export async function assembleReel(options: {
  edl: EdlEntry[];
  clipPaths: Record<string, string>; // clip_id → local file path
  audioPath: string;
  outputPath: string;
  concatListPath: string;
  timeoutMs: number;
}): Promise<void> {
  const { edl, clipPaths, audioPath, outputPath, concatListPath, timeoutMs } =
    options;

  // Build filter_complex for trimming each segment
  // Use FFmpeg concat filter for precise trimming (vs concat demuxer which
  // requires re-encoding segment boundaries)
  const filterParts: string[] = [];
  const inputs: string[] = [];

  for (let i = 0; i < edl.length; i++) {
    const entry = edl[i];
    const clipPath = clipPaths[entry.clip_id];
    if (!clipPath) throw new Error(`No path for clip_id=${entry.clip_id}`);

    inputs.push("-i", clipPath);

    const startSec = entry.start_ms / 1000;
    const durationSec = (entry.end_ms - entry.start_ms) / 1000;

    filterParts.push(
      `[${i}:v]trim=start=${startSec}:duration=${durationSec},setpts=PTS-STARTPTS[v${i}]`
    );
    filterParts.push(
      `[${i}:a]atrim=start=${startSec}:duration=${durationSec},asetpts=PTS-STARTPTS[a${i}]`
    );
  }

  // Concat all segments
  const vInputs = edl.map((_, i) => `[v${i}]`).join("");
  const aInputs = edl.map((_, i) => `[a${i}]`).join("");
  filterParts.push(
    `${vInputs}concat=n=${edl.length}:v=1:a=0[outv]`,
    `${aInputs}concat=n=${edl.length}:v=0:a=1[outa_clips]`
  );

  // Mix with the music audio track
  const audioInputIdx = edl.length;
  const filterComplex = [
    ...filterParts,
    `[outa_clips][${audioInputIdx}:a]amix=inputs=2:duration=shortest[outa]`,
  ].join(";");

  const encoder = getVideoEncoder();
  const encodeArgs = encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "fast"]
    : ["-c:v", "libx264", "-preset", "fast", "-crf", "23"];

  const args = [
    ...inputs,
    "-i", audioPath,
    "-filter_complex", filterComplex,
    "-map", "[outv]",
    "-map", "[outa]",
    ...encodeArgs,
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ];

  try {
    await runFfmpeg(args, timeoutMs);
  } catch (err) {
    if (encoder === "h264_nvenc") {
      // NVENC failed — fall back to libx264
      console.warn(
        "[ffmpeg] NVENC requested but failed — falling back to x264:",
        (err as Error).message
      );

      const fallbackArgs = [
        ...inputs,
        "-i", audioPath,
        "-filter_complex", filterComplex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-shortest",
        outputPath,
      ];

      await runFfmpeg(fallbackArgs, timeoutMs);
    } else {
      throw err;
    }
  }
}
