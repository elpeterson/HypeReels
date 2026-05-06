# HypeReels — User Stories

> **Backlog owner:** @product-owner
> **Status:** Sprint 1 — MVP
> **Last updated:** 2026-05-05 (STORY-013 added)

---

## MVP Stories

---

### [STORY-001] Upload Video Clips

**User Story:** As a user, I want to select and upload one or more video clips so that I have source material for my hype reel.

**Acceptance Criteria:**
- [ ] Given the upload page is open, when the user clicks the clip upload area or drags files onto it, then a native file picker opens (or files are accepted via drag-and-drop) filtered to accepted video formats (MP4, MOV, MKV, WebM).
- [ ] Given the user selects one or more valid clip files, when the upload completes, then each clip appears in the clip list with its filename, duration, and a thumbnail extracted from the first frame.
- [ ] Given the user selects more than 10 clips in a single session, when they attempt to add the 11th, then an error message states "Maximum 10 clips per session" and the excess files are rejected without affecting already-uploaded clips.
- [ ] Given the user selects a clip file exceeding 2 GB, when upload is attempted, then an inline error states the specific file name and "File exceeds the 2 GB limit" before any upload begins.
- [ ] Given the user selects a file with an unsupported format (e.g. AVI, WMV), when upload is attempted, then an inline error states the specific file name and "Unsupported format — accepted: MP4, MOV, MKV, WebM".
- [ ] Given a clip is uploading, when the network connection drops mid-upload, then the clip shows an error state with a "Retry" button; other successfully uploaded clips are unaffected.
- [ ] Given the user has uploaded at least one clip, when they return to the upload area, then they can add additional clips up to the 10-clip limit without losing previously uploaded clips.

**Out of Scope:** Clips stored beyond session TTL; cloud storage integrations; resumable chunked upload protocols (may revisit if >2 GB limit is raised post-MVP).

**Open Questions:**
- What is the maximum acceptable clip duration per file? (Suggested: 10 minutes — needs confirmation to set backend processing timeout.)
- Should the UI allow removing an individual uploaded clip, or is re-starting the session the only recourse?

**Size:** M  **Priority:** P0  **Sprint:** MVP

---

### [STORY-002] Upload Audio Track

**User Story:** As a user, I want to upload an audio file so that the system can analyze its beats and use it as the reel's soundtrack.

**Acceptance Criteria:**
- [ ] Given the upload page is open, when the user clicks the audio upload area or drags a file onto it, then a native file picker opens filtered to accepted audio formats (MP3, WAV, AAC, FLAC, M4A).
- [ ] Given the user selects a valid audio file, when the upload completes, then the audio file appears with its filename and duration, and a simple waveform or duration indicator is shown.
- [ ] Given the user selects an audio file exceeding 200 MB, when upload is attempted, then an inline error states the file name and "File exceeds the 200 MB limit" before any upload begins.
- [ ] Given the user selects a file with an unsupported format (e.g. OGG, OPUS), when upload is attempted, then an inline error states the file name and "Unsupported format — accepted: MP3, WAV, AAC, FLAC, M4A".
- [ ] Given the user has already uploaded an audio file, when they upload a replacement, then the new file replaces the previous one with a confirmation prompt ("Replace existing audio?").
- [ ] Given the audio upload fails mid-transfer, when the error occurs, then the audio slot shows an error state with a "Retry" button, and no other session state is lost.

**Out of Scope:** Spotify or streaming service integration; in-browser audio trimming or editing; multi-track audio mixing.

**Open Questions:**
- Is there a maximum audio duration to enforce? (Suggested: 10 minutes — a reel longer than the song is a no-op, so song length implicitly caps reel length.)

**Size:** S  **Priority:** P0  **Sprint:** MVP

---

### [STORY-003] Detect People in Clips

**User Story:** As a user, I want the system to automatically detect people in my clips so that I can identify my subject.

**Acceptance Criteria:**
- [ ] Given one or more clips have been uploaded, when the user proceeds to the person selection step, then the system begins analyzing all clips for people and shows a loading indicator ("Analyzing clips for people…") with per-clip progress.
- [ ] Given person detection completes, when at least one person is found across any clip, then the system displays a grid of detected person thumbnails, each showing a representative face crop and the clip(s) they appear in.
- [ ] Given person detection completes, when no people are detected in any clip, then the system shows an empty state: "No people detected. You can continue without selecting a person of interest — the reel will use all clip content."
- [ ] Given a detected person's confidence score is below threshold (< 70%), when their thumbnail is shown, then it is visually marked as "Low confidence" and a tooltip explains the user may see less accurate targeting.
- [ ] Given detection is running, when it takes longer than 60 seconds for a given clip, then that clip shows a "Still processing…" indicator and the user is not blocked from reviewing already-completed clips.
- [ ] Given detection fails entirely for a specific clip (e.g. corrupt frame data), when the error occurs, then that clip shows "Detection failed for this clip" without blocking the flow for other clips.

**Out of Scope:** Named person profiles; persistent face recognition across sessions; multi-person selection; manual face annotation; facial recognition used for identity verification.

**Open Questions:**
- Person detection is session-global (thumbnails pooled across all clips). Confirm this is correct — no per-clip isolation of people UI.
- What is the minimum face size / frame count required for a detection to be considered valid? (Needs AI/ML input.)

**Size:** L  **Priority:** P0  **Sprint:** MVP

---

### [STORY-004] Select Person of Interest

**User Story:** As a user, I want to select one person from detected people so that the reel prioritizes their moments.

**Acceptance Criteria:**
- [ ] Given the person detection grid is shown, when the user clicks a person thumbnail, then that thumbnail becomes selected (highlighted border, checkmark), all other thumbnails become deselected, and a "Continue" button becomes active.
- [ ] Given a person is selected, when the user clicks a different thumbnail, then the selection moves to the new person (only one can be selected at a time).
- [ ] Given a person is selected, when the user clicks the already-selected thumbnail, then the selection is cleared and "Continue" becomes inactive until a new selection is made or the user explicitly skips person selection.
- [ ] Given no people were detected, when the person selection step is shown, then a "Skip — no person of interest" option is the only available action, and proceeding without selection is allowed.
- [ ] Given the user has selected a person and proceeds, when the system generates the reel, then moments featuring the selected person are given priority in scene selection (verified by: at minimum, clips containing the person appear in the output when clip content permits).

**Out of Scope:** Selecting more than one person of interest; named person profiles; any cross-session recognition of previously selected persons.

**Open Questions:** None

**Size:** S  **Priority:** P0  **Sprint:** MVP

---

### [STORY-005] Mark Clip Highlights

**User Story:** As a user, I want to mark time ranges in each clip as highlights so that those segments are guaranteed in the reel.

**Acceptance Criteria:**
- [ ] Given a clip is in the clip list, when the user opens the clip detail panel, then a timeline scrubber is shown with the ability to set a start and end time range as a highlight.
- [ ] Given the user sets a highlight range, when they save it, then the range appears as a colored band on the clip timeline and is listed as a guaranteed segment for that clip.
- [ ] Given a clip has no highlights marked, when the reel is generated, then the AI may use any portion of that clip at its discretion.
- [ ] Given the user marks a highlight range shorter than 1 second, when they attempt to save it, then an inline error states "Highlight must be at least 1 second long."
- [ ] Given the user marks multiple highlight ranges on a single clip whose total combined duration exceeds the audio track length, when the user attempts to proceed, then a warning states "Your highlights exceed the audio duration — the reel will include all highlights but may be longer than the song."
- [ ] Given the user marks a highlight range, when they later want to remove it, then a "Remove" action on that highlight deletes it from the clip timeline.
- [ ] Given a clip is shorter than 1 second, when the clip is added to the session, then the highlight marking UI is disabled for that clip with a note "Clip too short to mark highlights."

**Out of Scope:** Highlight ranges spanning multiple clips; frame-accurate highlight trimming at sub-second precision (MVP uses 1-second minimum granularity); preview playback of highlights before generation.

**Open Questions:**
- Is there a maximum number of highlights per clip? (Suggested: 10 per clip — needs confirmation to bound storage and processing complexity.)
- Should highlight time ranges be required for at least one clip, or is it fully optional across all clips?

**Size:** M  **Priority:** P1  **Sprint:** MVP

---

### [STORY-006] Generate Beat-Synced Reel

**User Story:** As a user, I want the system to generate my hype reel so that my clips are cut and sequenced to the beat of my song.

**Acceptance Criteria:**
- [ ] Given all required inputs are present (at least one clip, one audio file, and optionally a person of interest and highlights), when the user clicks "Generate Reel", then a job is submitted and the UI transitions to a progress screen showing generation status.
- [ ] Given the generation job is running, when the UI is displaying the progress screen, then it shows meaningful stage labels (e.g. "Analyzing audio…", "Selecting scenes…", "Assembling reel…") and a progress indicator that advances as stages complete.
- [ ] Given the generation job completes successfully, when the reel is ready, then the UI transitions to a download screen with a "Download Reel" button and a warning that the file will be permanently deleted after download or after the session expires.
- [ ] Given the generation job fails (e.g. FFmpeg error, insufficient clip content), when the failure occurs, then the UI shows a specific error message (not a generic "Something went wrong") and offers the user the option to retry generation or return to the input step.
- [ ] Given the user closes or refreshes the browser tab during generation, when they return within the session TTL, then the session resumes at the same generation state (in progress or completed) without restarting.
- [ ] Given all clip highlights combined are shorter than 4 beats of the audio, when generation runs, then the system fills remaining reel time with non-highlight clip content rather than producing a reel shorter than 4 beats.
- [ ] Given the audio track has no detectable beats (e.g. ambient recording with no rhythm), when generation runs, then the reel is assembled using time-based cuts at fixed intervals and the user is informed "Beat sync unavailable — cuts made at regular intervals."

**Out of Scope:** User-controlled cut timing; preview before download; custom transition effects; multi-track audio; generation queued across users (single-session only).

**Open Questions:**
- What is the maximum generation time before the job is considered failed? (Suggested: 10 minutes — needs AI/ML and DevOps input.)
- What is the minimum reel length? (Suggested: 4 beats or 8 seconds — needs product confirmation.)

**Size:** L  **Priority:** P0  **Sprint:** MVP

---

### [STORY-007] Download and Destroy Reel

**User Story:** As a user, I want to download my completed reel so that I have the file locally before all assets are deleted.

**Acceptance Criteria:**
- [ ] Given the reel is ready, when the download screen is shown, then a clear warning is displayed before the download button: "After downloading, all your files — clips, audio, and the reel — will be permanently deleted. This is your only opportunity to save the reel."
- [ ] Given the user clicks "Download Reel", when the file transfer begins, then the download starts immediately as an MP4 file and the session is flagged for destruction.
- [ ] Given the download completes, when the file is saved to the user's device, then all session assets (uploaded clips, audio, generated reel, intermediate files) are deleted from the server within 60 seconds.
- [ ] Given the download fails mid-transfer (e.g. network drop), when the failure occurs, then the download screen remains active with a "Try Download Again" button, and no assets have been deleted yet.
- [ ] Given the user does not download within the session TTL (suggested: 1 hour after generation), when the TTL expires, then all assets are automatically deleted and the user sees an expiry message: "Your session has expired. All files have been deleted."
- [ ] Given the user attempts to access the download link after TTL expiry, when the request is made, then the server returns a clear expiry response (not a generic 404) and the UI shows the session-expired message.

**Out of Scope:** Multiple download attempts after destruction; persistent reel storage; sharing the reel URL with others; server-side re-generation after expiry.

**Open Questions:**
- What is the session TTL after reel generation? (Suggested: 1 hour — needs confirmation from DevOps for storage budget planning.)
- Should the download be triggered automatically on the "Download" click, or should the user see a confirmation step first?

**Size:** M  **Priority:** P0  **Sprint:** MVP

---

### [STORY-008] Run via Docker on Any Hardware

**User Story:** As an operator, I want to run HypeReels via Docker Compose on any machine so that it works regardless of whether a GPU is available.

**Acceptance Criteria:**
- [ ] Given a machine with no GPU (CPU-only, e.g. M2 MacBook or AMD-GPU laptop without CUDA), when `docker compose up` is run, then all services start successfully and reel generation completes using CPU-only execution paths (InsightFace CPUExecutionProvider, FFmpeg x264).
- [ ] Given a machine with an NVIDIA GPU and the NVIDIA Container Toolkit installed, when `docker compose up` is run with GPU passthrough configured, then all services start with CUDA-accelerated execution paths (InsightFace CUDAExecutionProvider, FFmpeg NVENC if `FFMPEG_HWACCEL=nvenc` is set) and fall back to CPU automatically if the GPU is unavailable at runtime.
- [ ] Given a machine with an AMD GPU, when `docker compose up` is run, then services start using CPU-only execution paths (AMD ROCm is not required; AMD GPU passthrough is not supported in MVP).
- [ ] Given any valid hardware profile, when the operator runs the provided health-check command, then all required services report healthy within 60 seconds of startup.
- [ ] Given an operator sets `FFMPEG_HWACCEL=nvenc` on a machine without an NVIDIA GPU, when services start, then the system detects the missing CUDA device and falls back to x264 without crashing, logging a warning: "NVENC requested but no CUDA device found — falling back to x264."

**Out of Scope:** Split-system or multi-host deployment; cloud hosting at hypereels.elpeterson.com (Future); AMD ROCm GPU acceleration; Kubernetes or orchestration platforms.

**Open Questions:**
- Should a single `docker-compose.yml` handle all profiles via environment variables, or should there be profile-specific override files (e.g. `docker-compose.nvidia.yml`)? (Needs DevOps input.)
- Is Proxmox LXC deployment (Profile 1, non-Docker path) in scope for this story, or a separate story? (See STORY-009.)

**Size:** L  **Priority:** P0  **Sprint:** MVP

---

### [STORY-009] CPU-Only Fallback for All Workloads

**User Story:** As an operator, I want all AI and video workloads to automatically fall back to CPU so that the system is fully functional on hardware without a supported GPU.

**Acceptance Criteria:**
- [ ] Given the system starts with no NVIDIA GPU present, when person detection runs, then InsightFace uses CPUExecutionProvider and completes without error (performance degradation is acceptable; functional output is required).
- [ ] Given the system starts with no NVIDIA GPU present, when reel generation runs, then FFmpeg uses the x264 software encoder and produces a valid MP4 output.
- [ ] Given the system starts with an NVIDIA GPU available but CUDA initialization fails at runtime, when a workload is dispatched, then the system logs the CUDA error and retries the workload using CPUExecutionProvider/x264 without surfacing a failure to the user.
- [ ] Given the CPU-only path is active, when any workload completes, then the output format and quality meet the same functional acceptance criteria as GPU-accelerated output (resolution, codec, container format).
- [ ] Given a CPU-only machine where processing takes longer than GPU baseline, when the generation progress screen is shown, then there is no hardcoded timeout shorter than 10 minutes that would cause a false failure on slow hardware.

**Out of Scope:** AMD ROCm GPU acceleration; Apple Silicon Metal/ANE acceleration (CPU path is sufficient for MVP on M2); performance benchmarking or SLA guarantees for CPU-only mode.

**Open Questions:**
- Is Apple Silicon Neural Engine (ANE) or Metal GPU acceleration in scope for a future story, or permanently deferred? (No action needed for MVP — CPU path covers M2.)

**Size:** M  **Priority:** P0  **Sprint:** MVP

---

### [STORY-010] Fix Docker Compose Start Command

**User Story:** As an operator, I want the quickstart command to work on any supported Docker installation so that I can start HypeReels without hitting an error before the system even runs.

**Acceptance Criteria:**
- [ ] Given an operator with Docker Compose v1 (standalone plugin) installed, when they follow the quickstart instructions exactly as written, then every command succeeds without "unknown flag" or other CLI errors.
- [ ] Given an operator with Docker Compose v2 (bundled with Docker Desktop or the docker-compose-plugin package) installed, when they follow the quickstart instructions exactly as written, then every command succeeds without errors.
- [ ] Given the updated quickstart uses the two-step form (`docker compose build` followed by `docker compose up -d`), when an operator runs both commands in sequence, then all services start and report healthy within 60 seconds, identical to the previous single-command behavior.
- [ ] Given an operator runs `docker compose build` and one or more images fail to build, when the build step exits with an error, then no containers are started and the error output is visible in the terminal without ambiguity (not silently swallowed by a combined command).
- [ ] Given the README.md and all files under docs/deployment/ contained the old single-command form (`docker compose up --build -d`), when the fix is applied, then no occurrence of `--build` as a flag to `docker compose up` remains in any user-facing documentation or quickstart guide in the repository.

**Out of Scope:** Changing the Docker or Docker Compose version requirements; adding a compatibility wrapper script; modifying docker-compose.yml service definitions; any runtime behavior change to the services themselves.

**Open Questions:** None

**Size:** XS  **Priority:** P1  **Sprint:** MVP

---

### [STORY-011] Verify Docker Compose Is Installed

**User Story:** As an operator, I want the setup documentation to tell me how to verify and install Docker Compose so that I am not blocked by a missing prerequisite before the system even starts.

**Acceptance Criteria:**
- [ ] Given an operator who has Docker Engine installed but has never installed the Compose plugin, when they follow the README prerequisites section, then explicit instructions (or a link to official Docker docs) tell them how to install Docker Compose v2 for their platform (Linux package manager, Docker Desktop, or manual plugin install).
- [ ] Given an operator who reads the prerequisites section before running any commands, when they execute the documented verification step (e.g. `docker compose version`), then the output confirms Compose is available and meets the minimum version requirement (v2.20+).
- [ ] Given an operator on a system where only the v1 standalone binary (`docker-compose`) is present, when they read the prerequisites section, then the documentation explicitly states that v1 is not supported and directs them to upgrade to v2.
- [ ] Given an operator whose `docker compose version` output shows a version below v2.20, when they read the prerequisites section, then the documentation states the minimum required version and links to upgrade instructions.
- [ ] Given the README currently lists "Docker Compose v2.20+ (bundled with Docker Desktop)" as a prerequisite without install guidance, when the fix is applied, then that line is replaced or augmented with a verification command and a link or inline steps covering at least two installation paths (Docker Desktop and the standalone Compose plugin for Linux).

**Out of Scope:** Automating prerequisite checks via a shell script; supporting Docker Compose v1; modifying docker-compose.yml or any application code; runtime behavior changes.

**Open Questions:** None

**Size:** XS  **Priority:** P1  **Sprint:** MVP

---

## Rejected Input

| Input | Reason | Alternative |
|-------|--------|-------------|
| Web hosting at hypereels.elpeterson.com | Explicitly tagged Future in CLAUDE.md. Cloud deployment is out of MVP scope. | No in-scope alternative — this is a post-MVP infrastructure concern. |

---

### [STORY-012] Fix Next.js Config Extension

**User Story:** As an operator, I want the frontend Docker build to complete without errors so that the application can be deployed.

**Acceptance Criteria:**
- [ ] Given the frontend service is built via `docker compose build` (or `npm run build` directly), when the build runs, then it completes without the error "Configuring Next.js via 'next.config.ts' is not supported."
- [ ] Given `frontend/next.config.mjs` exists and `frontend/next.config.ts` does not, when `npm run build` runs with Next.js 14, then Next.js loads the configuration successfully and the build proceeds past the config-loading step.
- [ ] Given the renamed config file uses ESM JavaScript syntax (no TypeScript type annotations), when the build runs in any Node.js environment required by Next.js 14, then no syntax or module-type errors are reported.
- [ ] Given the repository no longer contains `frontend/next.config.ts`, when any CI pipeline runs `npm run build`, then the build succeeds end-to-end and produces a `.next` output directory.

**Out of Scope:** Upgrading Next.js to version 15 or later; changing any runtime behavior of the Next.js configuration; modifying other frontend build tooling.

**Open Questions:** None

**Size:** XS  **Priority:** P0  **Sprint:** MVP

---

### [STORY-013] Fix Download State Type

**User Story:** As a developer, I want the download page TypeScript type to include all valid states so that the build succeeds and the loading indicator works correctly.

**Acceptance Criteria:**
- [ ] Given the frontend is built via `npm run build` or `docker compose build`, when the build runs, then no TypeScript error is reported for the comparison `downloadState === "downloading"` on the download page.
- [ ] Given the reel download is in progress, when the download page renders, then the "Download Reel" button shows its loading state (spinner or disabled indicator) while the download is active.
- [ ] Given the download has not started or has completed, when the download page renders, then the button does not show a loading state.
- [ ] Given the `DownloadState` type did not previously include `"downloading"`, when the fix is applied, then no other references to `DownloadState` in the codebase produce new TypeScript errors as a result of the type change.

**Out of Scope:** Changing download UX behavior beyond the loading indicator; modifying the download flow logic; adding new download states beyond those already needed.

**Open Questions:** None

**Size:** XS  **Priority:** P0  **Sprint:** MVP

---

### [STORY-014] Fix BullMQ Job Options Type

**User Story:** As a developer, I want the queue configuration to use only valid BullMQ `JobsOptions` fields so that the TypeScript build succeeds and jobs are enqueued without type errors.

**Acceptance Criteria:**
- [ ] Given the frontend or backend is built via `npm run build`, when the build runs, then no TypeScript error is reported for an unknown `timeout` property on any `JobsOptions` object in `src/lib/queue.ts`.
- [ ] Given the `timeout` field has been removed from all `JobsOptions` objects in `src/lib/queue.ts`, when jobs are enqueued, then they are accepted by BullMQ without runtime errors and worker-level `lockDuration` continues to enforce the intended timeout behaviour.
- [ ] Given a new `JobsOptions` object is added to `src/lib/queue.ts` in the future, when `npm run build` runs, then the TypeScript compiler rejects any field not present in BullMQ's `JobsOptions` type, preventing regression.

**Out of Scope:** Changing BullMQ worker configuration; altering job retry or backoff settings; adding per-job timeout support via a different mechanism (post-MVP).

**Open Questions:** None

**Size:** XS  **Priority:** P0  **Sprint:** MVP

---

### [STORY-015] Catch TypeScript Errors Before Docker Build

**User Story:** As a developer, I want the CI pipeline to run the Next.js production build before the Docker build step so that TypeScript errors are caught in seconds rather than after a full Docker build.

**Acceptance Criteria:**
- [ ] Given a pull request or push to a tracked branch, when the CI `test` job runs, then `npm run build` (which executes `tsc` + lint) is executed as a step before the `docker buildx build` step, and a TypeScript error in any frontend source file causes the `test` job to fail immediately.
- [ ] Given `npm run build` fails due to a TypeScript error, when CI reports the failure, then the Docker build step is skipped entirely and the error output from `tsc` is visible in the CI log without requiring the operator to inspect a Docker build log.
- [ ] Given `npm run build` succeeds with no type errors, when CI continues, then the `docker buildx build` step runs as before and the overall pipeline behaviour is unchanged.
- [ ] Given three prior Docker build failures caused by TypeScript errors that `npm test` did not catch, when the fix is applied, then the same class of error (e.g. unknown property on a typed object) is caught by the `npm run build` step in under 60 seconds of CI time.

**Out of Scope:** Replacing Docker build with a build-only step; running `tsc --noEmit` as a separate step (redundant — `next build` already invokes the compiler); changing the Docker build configuration; enforcing stricter `tsconfig` settings beyond what already exists.

**Open Questions:** None

**Size:** XS  **Priority:** P1  **Sprint:** MVP

---

> **Next step:** Stories ready in docs/user-stories.md. Invoke @architect.
