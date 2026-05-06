# HypeReels — User Stories

> **Backlog owner:** @product-owner
> **Status:** Sprint 1 — MVP
> **Last updated:** 2026-05-06 (STORY-019 added)

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

### [STORY-016] Fix GPU Block Crashes Mac Docker

**User Story:** As an operator on a machine without an NVIDIA GPU (e.g. a MacBook), I want `docker compose up` to start all services without error so that I am not blocked before the application even runs.

**Acceptance Criteria:**
- [ ] Given a machine with no NVIDIA GPU (e.g. M2 MacBook or any CPU-only host running Docker Desktop on macOS), when the operator runs `docker compose up -d` using only `docker-compose.yml`, then all services start successfully with no error referencing a device driver, NVIDIA, or GPU reservation.
- [ ] Given a machine with an NVIDIA GPU and the NVIDIA Container Toolkit installed (Linux Docker Engine), when the operator runs `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`, then all services start with GPU passthrough active and CUDA-accelerated execution paths are used.
- [ ] Given `docker-compose.yml` contains no `deploy.resources.reservations.devices` block, when an operator on any platform runs `docker compose up -d`, then Docker Desktop on macOS and Docker Engine on Linux both start all services without a device-driver error.
- [ ] Given `docker-compose.gpu.yml` exists as a Compose override file, when the operator merges it with the base file via `-f docker-compose.yml -f docker-compose.gpu.yml`, then the resulting configuration adds the NVIDIA device reservation to the appropriate service(s) and no other service configuration is altered.
- [ ] Given the README and all files under `docs/deployment/` previously documented a single-file `docker compose up` that included GPU passthrough, when the fix is applied, then every user-facing quickstart and deployment guide is updated to document both the CPU-only command (`docker compose up -d`) and the GPU command (`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`), with no occurrence of the old single-file GPU invocation remaining.
- [ ] Given an operator sets `FFMPEG_HWACCEL=nvenc` but runs only the base `docker-compose.yml` (no GPU override), when services start, then the system detects no CUDA device and falls back to x264 without crashing, consistent with the behaviour specified in STORY-008 AC 5.

**Out of Scope:** Changing any runtime AI/ML or FFmpeg execution logic; adding GPU support for AMD ROCm or Apple Metal; Kubernetes or multi-host deployment; creating a shell wrapper script that auto-detects GPU presence.

**Open Questions:** None

**Size:** S  **Priority:** P0  **Sprint:** MVP

---

### [STORY-017] Fix 422 on All Clip and Audio Upload Endpoints

**User Story:** As a user, I want uploading clips and audio to work reliably so that I am not blocked from starting reel generation by silent session errors.

**Acceptance Criteria:**
- [ ] Given the user selects one or more valid clip files, when the frontend initiates a clip upload, then `POST /api/upload/clip` returns a presigned URL (2xx) and does not return 422 with `missing_session_id`.
- [ ] Given a clip upload to S3 has completed, when the frontend confirms the upload, then `POST /api/upload/clip/[clip_id]/complete` returns success (2xx) without requiring `object_key` in the request body.
- [ ] Given the user removes an uploaded clip, when the frontend sends the deletion request, then `DELETE /api/upload/clip/[clip_id]` deletes the correct S3 object and returns success (2xx) without returning 422.
- [ ] Given the user selects a valid audio file, when the frontend initiates an audio upload, then `POST /api/upload/audio` returns a presigned URL (2xx) and does not return 422 with `missing_session_id`.
- [ ] Given an audio upload to S3 has completed, when the frontend confirms the upload, then `POST /api/upload/audio/complete` returns success (2xx) without requiring `audio_id` in the request body.
- [ ] Given the user is on macOS and drags and drops a clip or audio file onto the upload area, when the file is processed, then the upload proceeds with the correct MIME type even if `file.type` is an empty string (extension-based fallback is used).
- [ ] Given any of the five upload routes receive a request, when the session ID is extracted, then it is read from the `X-Session-Id` HTTP header (not the request body), consistent with how `apiFetch` sends it.

**Root Cause (fixed):** All five upload route handlers read `session_id` from the JSON request body; the frontend `apiFetch` helper sends it exclusively as the `X-Session-Id` header. Every upload request therefore received `session_id: undefined` and was rejected with 422. Secondary issues: `confirmClipUpload` sent no body (route needed `object_key`); `confirmAudioUpload` sent no body (route needed `audio_id`); `file.type` could be empty on macOS drag-and-drop.

**Fixes applied:**
- All five backend routes now read `session_id` from `req.headers.get("X-Session-Id")`.
- `object_key` is stored on the `Clip` record in Redis at upload-initiation time; the `/complete` handler looks it up from there.
- `audio_id` is derived from `session.audio.audio_id` in the audio complete handler — no body field required.
- `requestClipUploadUrl` and `requestAudioUploadUrl` accept a `File` object and call `resolveMimeType(file)`, which falls back to extension-based MIME lookup when `file.type` is empty.
- `DELETE /api/upload/clip/[clip_id]` uses `clip.object_key` from the stored record rather than reconstructing it from the filename extension.

**Out of Scope:** Changing the session ID transport mechanism for any other route family; resumable or chunked upload protocols; any change to S3 presigned URL generation logic beyond the MIME-type fix.

**Open Questions:** None

**Size:** M  **Priority:** P0  **Sprint:** MVP

---

### [STORY-018] Fix Cold-Start 500 / Network Error / 409 Cascade on Clip Upload

**User Story:** As a user, I want clip uploads to succeed on the first attempt — including immediately after the server starts — so that I am never blocked from uploading before reel generation can begin.

**Acceptance Criteria:**
- [ ] Given the Docker Compose stack has just started (cold start), when the user uploads a clip within seconds of the app service becoming reachable, then `POST /api/upload/clip` returns a presigned URL (2xx) and does not return a 500 error caused by a Redis connection not yet being ready.
- [ ] Given a presigned PUT URL is returned by the upload route, when the browser on the host machine performs the PUT, then the URL contains a hostname and port reachable from the host (e.g. `http://localhost:9000`) and not an internal Docker hostname (e.g. `http://minio:9000`) that the browser cannot resolve.
- [ ] Given the browser uploads a file to the presigned URL, when the PUT request is made, then it succeeds (2xx) without a network error.
- [ ] Given the user refreshes the page after a failed upload attempt, when they try to upload the same file again, then the upload succeeds (2xx) rather than returning 409 due to an orphaned clip record left in Redis from the previous failed attempt.
- [ ] Given a clip is in `"uploading"` state in Redis (orphaned from a prior failed presigned-URL generation), when the user retries uploading the same clip, then the route issues a fresh presigned URL and returns 2xx rather than 409.
- [ ] Given the MinIO service is running inside Docker Compose, when the app service starts, then port `9000` (S3 API) and port `9001` (MinIO console) are exposed to the host machine.
- [ ] Given `MINIO_PUBLIC_URL` is set in the app service environment (e.g. `http://localhost:9000`), when the backend generates presigned PUT or GET URLs, then those URLs embed the value of `MINIO_PUBLIC_URL` rather than the internal `MINIO_ENDPOINT` hostname.
- [ ] Given `MINIO_PUBLIC_URL` is not set, when the backend generates presigned URLs, then it falls back to `MINIO_ENDPOINT` without crashing.
- [ ] Given the upload route handler is invoked, when it executes, then `createPresignedPutUrl` is called and succeeds before any write to Redis (`addClipToSession`) occurs — a Redis write never happens if URL generation fails.
- [ ] Given the audio upload route handler is invoked, when it executes, then `createPresignedPutUrl` for the audio file is called and succeeds before any write to Redis occurs.

**Root Cause (fixed):** Three bugs cascaded in sequence: (1) Redis client configured with `enableOfflineQueue: false` caused immediate command rejection if the TCP handshake had not completed before the first request; (2) presigned URLs embedded the internal Docker hostname `minio:9000`, which is unreachable from the host browser (port 9000 was also not exposed); (3) the upload route wrote the clip record to Redis before generating the presigned URL — a URL-generation failure left an orphaned `"uploading"` record, causing a 409 on retry.

**Fixes applied:**
- `redis.ts`: Removed `enableOfflineQueue: false`; ioredis default (`true`) queues commands until the connection is ready.
- `config.ts`: Added `minio.publicUrl` sourced from `MINIO_PUBLIC_URL` env var, falling back to `MINIO_ENDPOINT`.
- `storage.ts`: Added `getPresignClient()` using `config.minio.publicUrl`; `createPresignedPutUrl` and `createPresignedGetUrl` now use this client.
- `docker-compose.yml`: Exposed MinIO ports `9000:9000` and `9001:9001`; added `MINIO_PUBLIC_URL: http://localhost:9000` to the app service environment.
- `.env.example`: Added `MINIO_PUBLIC_URL=http://localhost:9000` with explanation.
- `api/upload/clip/route.ts`: Moved `createPresignedPutUrl` before `addClipToSession`; on duplicate clip in `"uploading"` state, re-issues a fresh presigned URL instead of returning 409.
- `api/upload/audio/route.ts`: Same presigned-URL-first ordering fix applied.

**Out of Scope:** Resumable or chunked upload protocols; changing the Redis client library; MinIO TLS or public-internet presigned URL configuration (post-MVP); multi-host or split-network Docker deployments.

**Open Questions:** None

**Size:** M  **Priority:** P0  **Sprint:** MVP

---

### [STORY-019] Fix NS_ERROR_NET_RESET on Presigned PUT — MinIO Bucket Missing CORS Configuration

**User Story:** As a user, I want presigned PUT uploads to MinIO to succeed from the browser so that uploaded clips and audio are actually stored and reel generation can proceed.

**Acceptance Criteria:**
- [ ] Given the Docker Compose stack has started and the app service is healthy, when the browser performs a presigned PUT to `http://localhost:9000`, then the request completes with a 2xx response and does not reset the connection (NS_ERROR_NET_RESET or equivalent).
- [ ] Given a cross-origin presigned PUT is made from the Next.js origin (e.g. `http://localhost:3000`) to MinIO (`http://localhost:9000`), when the browser sends the OPTIONS preflight, then MinIO responds 204, and the subsequent PUT also succeeds rather than being reset.
- [ ] Given the app service starts, when `instrumentation.ts` runs at startup, then `configureBucketCors()` executes and applies an allow-all CORS policy (`AllowedOrigins: ["*"]`, methods GET/PUT/POST/DELETE/HEAD, all headers, `ExposeHeaders: ETag`, `MaxAgeSeconds: 86400`) to the MinIO bucket.
- [ ] Given `configureBucketCors()` fails for any reason (e.g. MinIO not yet reachable, permission error), when the error occurs, then it is logged as an error but does not crash the app — the app continues starting normally.
- [ ] Given CORS is configured at startup via `instrumentation.ts`, when the Docker Compose dependency chain is followed (MinIO starts → `minio-init` creates bucket → app starts), then MinIO is guaranteed to be ready and the bucket guaranteed to exist before `configureBucketCors()` is called.
- [ ] Given CORS is now configured via `instrumentation.ts`, when `docker-compose.yml` is examined, then the `minio-init` entrypoint contains no `mc cors set` call (it was unreliable across mc versions and has been removed in favor of the instrumentation hook).
- [ ] Given CORS is correctly configured, when the user completes a clip or audio upload, then the "Continue to Person Selection" button becomes enabled.

**Root Cause (fixed):** MinIO requires an explicit CORS policy on the bucket for cross-origin browser requests. The `minio-init` container created the bucket but did not configure CORS. Without it, cross-origin PUT/GET requests are rejected with a connection reset even though the OPTIONS preflight returned 204. No CORS was configured anywhere in the stack.

**Fixes applied:**
- `storage.ts`: Added `configureBucketCors()` using `PutBucketCorsCommand` from `@aws-sdk/client-s3`. Applies an allow-all CORS policy on the MinIO bucket.
- `instrumentation.ts`: Calls `configureBucketCors()` at app startup before the BullMQ worker starts. Wrapped in try/catch — failure logs an error but does not crash the app.
- `docker-compose.yml` (`minio-init`): Removed the unreliable `mc cors set` call from the entrypoint; CORS is now handled entirely by the instrumentation hook.

**Out of Scope:** Restricting CORS to specific origins (post-MVP); TLS configuration for MinIO; configuring CORS for a non-MinIO S3 backend; any changes to the presigned URL generation logic.

**Open Questions:** None

**Size:** S  **Priority:** P0  **Sprint:** MVP

---

> **Next step:** Stories ready in docs/user-stories.md. Invoke @architect.
