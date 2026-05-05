/**
 * Python subprocess helpers for the BullMQ worker.
 *
 * Invokes Python scripts via child_process.spawn.
 * Parses stdout as JSON; stderr is logged but not surfaced.
 * Exit code 0 = success, non-zero = failure.
 */

import { spawn } from "child_process";
import * as path from "path";
import { config } from "../lib/config";

export interface DetectedPerson {
  person_id: string;
  bbox: [number, number, number, number];
  thumbnail: string;
  confidence: number;
  appearances: Array<{ clip_id: string; timestamp_ms: number }>;
}

export interface AudioAnalysis {
  bpm: number;
  beats: number[];
  onsets: number[];
  phrases: Array<{ start_ms: number; end_ms: number }>;
}

/**
 * Run a Python script and parse its stdout as JSON.
 * @param scriptName  Filename under config.worker.scriptsDir
 * @param args        CLI arguments passed to the script
 * @param timeoutMs   Maximum execution time
 */
export function runPythonScript<T>(
  scriptName: string,
  args: string[],
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.worker.scriptsDir, scriptName);

    const proc = spawn(config.worker.pythonPath, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        INSIGHTFACE_PROVIDERS: config.insightface.providers,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      reject(new Error(`Python script ${scriptName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      // Log stderr for debugging (never surface to API)
      if (stderr) {
        console.log(`[python:${scriptName}] stderr:`, stderr.slice(-2000));
      }

      if (code !== 0) {
        reject(
          new Error(
            `Python script ${scriptName} exited with code ${code}. Check worker logs for details.`
          )
        );
        return;
      }

      try {
        const result = JSON.parse(stdout) as T;
        resolve(result);
      } catch {
        reject(
          new Error(`Python script ${scriptName} produced invalid JSON output`)
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run detect_persons.py for a single clip.
 *
 * Args: <video_path> <session_id> <clip_id> <output_dir>
 * Stdout: JSON array of DetectedPerson
 */
export async function runDetectPersons(
  videoPath: string,
  sessionId: string,
  clipId: string,
  outputDir: string,
  timeoutMs: number
): Promise<DetectedPerson[]> {
  const result = await runPythonScript<DetectedPerson[]>(
    "detect_persons.py",
    [videoPath, sessionId, clipId, outputDir],
    timeoutMs
  );
  return result;
}

/**
 * Run analyze_audio.py.
 *
 * Args: <audio_path>
 * Stdout: JSON AudioAnalysis object
 */
export async function runAnalyzeAudio(
  audioPath: string,
  timeoutMs: number
): Promise<AudioAnalysis> {
  return runPythonScript<AudioAnalysis>(
    "analyze_audio.py",
    [audioPath],
    timeoutMs
  );
}
