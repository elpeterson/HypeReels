# User Stories

> This file is owned by the Product Owner agent.
> Run `@product-owner` with a feature request to populate this backlog.

---

## Infrastructure Constraints

> **Self-Hosted Only — No Managed Cloud Services**
> The MVP runs entirely on on-premises hardware. No AWS, Cloudflare, Railway, Neon, Upstash, or any other managed SaaS infrastructure is permitted. All services must be open-source and self-hosted.

### Available Hardware

#### Case — Proxmox Host (192.168.1.122)
- **CPU:** Dual Intel Xeon X5650 — 24 logical threads @ 2.67 GHz (Westmere-EP)
- **RAM:** 144 GiB installed; 5.59 GB used / 141.62 GB free (live)
- **Storage pools (actual names):**
  - `ISO_Storage`: 898.68 GB, 0.0% used — ISO images only; do NOT use for MinIO or databases (dir-type pool)
  - `vm_storage`: 430.68 GB ZFS, 2.2% used — API LXC (CT 113) and Redis LXC (CT 114) OS volumes
  - `storage_1tb`: 899.25 GB ZFS, 0.1% used — MinIO LXC (CT 115) data directory (CORRECT pool for MinIO)
  - `utility_146`: 131.78 GB, 0.0% used
  - `local-zfs`: 126.53 GB ZFS, 1.1% used — OS root
- **Network:** 4× GbE NICs
- **GPU:** None (management GPU only — no compute GPU)
- **Virtualisation:** VT-x enabled; suitable for LXC containers and KVM VMs
- **Running LXC containers:** CT 100 (Nginx Proxy Manager — ALREADY RUNNING), CT 101–112 (see live Proxmox map). Available IDs: 113+. HypeReels LXC containers start at CT 113 (CT 111 = Zigbee2MQTT, CT 112 = Mosquitto MQTT — already taken).

#### Quorra — Unraid NAS (192.168.1.100)
- **GPU:** NVIDIA GTX 1080 Ti (Pascal architecture, 11 GB VRAM) — primary ML compute asset
  - **GPU Conflict (Known Constraint):** Frigate (home security NVR) uses this GPU 24/7 for real-time person/object detection. InsightFace also requires the GPU for batch person detection. This is a direct resource conflict. See STORY-021 for the required mitigation. Until STORY-021 is resolved, InsightFace must not assume exclusive GPU access.
- **Storage:** 48.42 TB raw array, ~14.30 TB free; 1 TB NVMe cache (~192 GB free); 1 TB SATA SSD transfer cache (nearly empty); 1 TB SATA SSD virtual machine pool (42.6 GB used)
- **OS:** Unraid 7.2.2 with Docker container support
- **Existing relevant containers:** Frigate (GPU, security NVR), Cloudflare-Tron (active Cloudflare tunnel — available for external HypeReels access), Grafana + Prometheus + InfluxDB + Telegraf (full monitoring stack — HypeReels observability must integrate here, not spin up new monitoring infra)

### Pre-Existing Infrastructure to Leverage (Do Not Recreate)

| Existing Asset | Location | HypeReels Integration |
|---------------|----------|-----------------------|
| Nginx Proxy Manager (CT 100) | Case (Proxmox) | Add a new proxy host entry for HypeReels — do NOT create a new Nginx LXC |
| Cloudflare-Tron tunnel | Quorra (Docker) | Configure a tunnel endpoint for external HypeReels access (optional but free) |
| Grafana + Prometheus stack | Quorra (Docker) | Scrape HypeReels metrics endpoint; add dashboards — do NOT deploy new monitoring infra |

### Workload Allocation

| Workload | Host | Rationale |
|----------|------|-----------|
| REST API server | Case (Proxmox LXC CT 113) | CPU-bound, no GPU requirement |
| PostgreSQL database | Quorra (Docker — hypereels-postgres, port 7432) | Co-located with other Postgres containers on Quorra; not on Case (see ADR-005) |
| Redis (job queue + session cache) | Case (Proxmox LXC CT 114) | In-memory, low resource footprint |
| MinIO object storage | Case (Proxmox LXC CT 115, storage_1tb pool) | Serves from local storage array |
| InsightFace person detection worker | Quorra (Docker) | CPU-only per ADR-013; GTX 1080 Ti reserved for Frigate and FileFlows |
| librosa audio analysis worker | Quorra (Docker) | Co-located with other Python workers; CPU-only |
| FFmpeg video rendering worker | Quorra (Docker) | CPU encode (x264) on same host as ML workers |

### Open-Source Service Replacements

| Previously Assumed (Cloud) | Self-Hosted Replacement | Notes |
|---------------------------|------------------------|-------|
| AWS Rekognition (person detection) | **InsightFace** (self-hosted, CPU-only on Quorra per ADR-013) | Same output contract: thumbnails, confidence scores, appearance timestamps |
| Cloudflare R2 (object storage) | **MinIO** (self-hosted on Case CT 115, storage_1tb ZFS pool) | S3-compatible API; presigned URLs replace R2 signed URLs |
| Neon (managed PostgreSQL) | **PostgreSQL** (self-hosted on Quorra Docker, port 7432) | Standard Postgres; runs as hypereels-postgres Docker container on Quorra |
| Upstash (managed Redis) | **Redis** (self-hosted on Case LXC CT 114) | Standard Redis; no Upstash-specific features used |
| Railway.app (container hosting) | **Proxmox LXC (Case) + Docker (Quorra)** | API/data services on Case; Python workers + DB on Quorra |

---

## MVP Sprint Backlog

### Epic Overview

| Epic | Stories | Description |
|------|---------|-------------|
| E1: Session Management | STORY-001 | Anonymous session creation and lifecycle |
| E2: Clip Upload | STORY-002, STORY-003, STORY-004 | Video clip upload, validation, and management |
| E3: Audio Upload | STORY-005, STORY-006 | Song upload and waveform analysis |
| E4: Person Detection | STORY-007, STORY-008, STORY-009 | AI-driven person detection and selection UX |
| E5: Highlight Selection | STORY-010, STORY-011, STORY-012 | Per-clip highlight marking and management |
| E6: HypeReel Generation | STORY-013, STORY-014 | Job submission and async generation |
| E7: Download & Cleanup | STORY-015, STORY-016 | One-shot download and permanent deletion |
| E8: Error Handling & Edge Cases | STORY-017, STORY-018, STORY-019 | Global error surfaces and recovery paths |
| E9: On-Premises Deployment | STORY-020, STORY-021 | Deploy full stack to self-hosted infrastructure; resolve GPU contention |

---

## E1: Session Management

### [STORY-001] Create an Anonymous Session on First Visit

**User Story**
As a first-time visitor, I want the application to automatically create an anonymous session for me when I land on the page so that my uploaded clips, audio, and settings are associated together without requiring an account.

**Acceptance Criteria**
- [ ] Given a user visits the application URL for the first time, when the page loads, then a new anonymous session is created on the backend and a session token (e.g., UUID) is stored in the browser (cookie or localStorage).
- [ ] Given a session token exists in the browser, when the user refreshes the page or navigates between steps, then the same session is resumed without prompting the user to log in.
- [ ] Given a session token is present, when the user reaches the "Download & Destroy" step and the download completes, then the session and all associated files are permanently deleted and the session token is invalidated.
- [ ] Given a session token is present, when the session has been idle for more than 24 hours without a completed download, then the session and all associated assets are automatically purged and the token is invalidated.
- [ ] Given an invalidated or expired session token is presented to the backend, when any API request is made, then the backend returns HTTP 404 or 410 and the frontend redirects the user to the start page with a clear message ("Your session has expired. Please start over.").
- [ ] Given the session creation request fails (network error, server error), when the page loads, then the user sees a clear error banner and a "Try Again" button — no partially initialised session is left hanging.

**Out of Scope**
- User accounts, login, or persistent identity
- Session sharing between users or devices
- Session recovery after expiry (no "resume" flow)

**Open Questions**
- Should the 24-hour TTL be configurable via environment variable? (Likely yes — engineering call.)
- Should session expiry be triggered by a cron job or lazy on next access?

**Size:** S
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E2: Clip Upload

### [STORY-002] Upload One or More Video Clips

**User Story**
As a user, I want to upload one or more video clips to my session so that the AI has footage to work with when assembling my HypeReel.

**Acceptance Criteria**
- [ ] Given the upload page is shown, when the user selects one or more video files via a file picker or drag-and-drop zone, then each file is uploaded to the backend and associated with the current session.
- [ ] Given a file is uploading, when the upload is in progress, then a per-file progress indicator (percentage or progress bar) is shown.
- [ ] Given all files have uploaded successfully, when the upload step completes, then each clip appears in a clip list with its filename, duration, and a thumbnail extracted from the first frame.
- [ ] Given the user wants to add more clips after the initial upload, when the user selects additional files, then the new clips are appended to the existing clip list (not replacing prior clips).
- [ ] Given the clip list contains at least one clip, when the user attempts to proceed to the next step, then the "Continue" button is enabled.
- [ ] Given the clip list is empty, when the user attempts to proceed, then the "Continue" button remains disabled and an inline message reads "Upload at least one video clip to continue."
- [ ] Given a clip is in the list, when the user clicks the remove (X) button on that clip, then the clip is deleted from the backend and removed from the UI list; if the removed clip had highlights or a selected person, those are also cleared.
- [ ] Given a network interruption occurs during upload, when the upload fails mid-transfer, then the file is marked as failed with an error label and a "Retry" button; other clips in the same batch continue uploading normally.
- [ ] Given a server-side error occurs (5xx), when the upload fails, then the user sees the failed clip with an error state and is not blocked from retrying or uploading other clips.

**Out of Scope**
- Resumable uploads (chunked upload with resume token) — Future
- Cloud storage import (Google Drive, Dropbox) — Future
- Clip reordering at this step (order is managed by the AI at generation time)

**Open Questions**
- What is the maximum number of clips allowed per session? Suggested cap: 10.
- Is the total combined duration of all clips capped? (e.g., 30 minutes total) — engineering / infra to confirm.

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-003] Validate Video Clip Format and Size on Upload

**User Story**
As a user, I want clear, immediate feedback when I upload an unsupported or oversized video file so that I don't waste time waiting for a doomed upload to fail silently.

**Acceptance Criteria**
- [ ] Given the user selects a file, when the file extension and MIME type are not in the accepted list (MP4, MOV, MKV, WebM), then the file is rejected before upload begins and an inline error reads "Unsupported format. Please upload MP4, MOV, MKV, or WebM."
- [ ] Given the user selects a supported file, when the file size exceeds the maximum allowed size (e.g., 2 GB per file), then the file is rejected before upload begins and an inline error reads "File too large. Maximum size is 2 GB per clip."
- [ ] Given the user selects a supported file within size limits, when the backend decodes the file and determines it contains no valid video stream, then the file is marked as failed after upload with the error "Invalid video file. Please check the file and try again."
- [ ] Given the user selects a file with a video duration exceeding the per-clip maximum (e.g., 10 minutes), when the backend validates duration, then the file is rejected and an error reads "Clip too long. Maximum clip duration is 10 minutes."
- [ ] Given the user uploads a clip that passes all validation, when processing begins, then no validation error is shown.
- [ ] Given a MIME type is spoofed (extension says .mp4 but content is not video), when the backend performs content-based validation, then the file is rejected with the "Invalid video file" error.

**Out of Scope**
- Automatic transcoding of unsupported formats — Future
- Audio-only files
- Image files

**Open Questions**
- Exact per-file size limit to confirm with DevOps (storage and bandwidth cost implications). Suggested: 2 GB.
- Exact per-clip duration limit. Suggested: 10 minutes.
- Should we enforce a maximum total number of clips (e.g., 10)? Where does that error surface?

**Size:** S
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-004] View Uploaded Clip List with Thumbnails and Metadata

**User Story**
As a user, I want to see all my uploaded clips in a list with a thumbnail and basic metadata so that I can confirm the right files were uploaded before proceeding.

**Acceptance Criteria**
- [ ] Given one or more clips have been successfully uploaded, when the clip list is rendered, then each clip shows: a thumbnail (first frame), the filename, the video duration formatted as M:SS, and the file size in human-readable format (e.g., "45.2 MB").
- [ ] Given a clip thumbnail cannot be generated (corrupt first frame), when the clip is listed, then a neutral placeholder image is shown instead of a broken image element.
- [ ] Given the user hovers over or taps a clip in the list, when focus is applied, then the clip row highlights to indicate it is interactive.
- [ ] Given the clip list has more clips than fit in the viewport, when the user scrolls, then all clips are reachable without horizontal scrolling.
- [ ] Given the clips are listed, when the user proceeds to the person detection step, then the clip list remains accessible as context (e.g., as a sidebar or collapsible panel) so users can reference which clip is which.

**Out of Scope**
- Video preview/playback in the clip list
- Clip reordering by drag-and-drop
- Editing clip metadata (rename)

**Open Questions**
- Should thumbnails be generated on the backend and served as images, or extracted client-side using a `<video>` element? Architecture decision.

**Size:** S
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E3: Audio Upload

### [STORY-005] Upload an Audio Track (Song)

**User Story**
As a user, I want to upload a song that will be used as the audio track for my HypeReel so that the video cuts and pacing are synchronised to the music I choose.

**Acceptance Criteria**
- [ ] Given the audio upload step is shown, when the user selects an audio file via file picker or drag-and-drop, then the file is uploaded to the backend and associated with the current session.
- [ ] Given a file is uploading, when the upload is in progress, then a progress indicator is shown.
- [ ] Given the audio file uploads successfully, when the upload completes, then the UI shows the filename, duration, and a static waveform visualisation (amplitude envelope).
- [ ] Given an audio file is already uploaded for the session, when the user uploads a replacement file, then the previous file is deleted and replaced with the new one; a confirmation prompt ("Replace current song?") is shown before deletion.
- [ ] Given a network interruption during upload, when the upload fails, then an error message and a "Retry" button are shown; the previous audio file (if any) is not deleted.
- [ ] Given a server-side error (5xx) occurs, when the upload fails, then the user sees an error state and is not blocked from retrying.
- [ ] Given only one audio file is permitted per session, when the UI shows the audio step, then it is clear that exactly one song must be uploaded (no multi-file selection for audio).

**Out of Scope**
- Spotify or streaming service integration — Future
- Recording audio in-browser — Future
- Multiple audio tracks or mixing

**Open Questions**
- Should the waveform visualisation be generated on the backend (as an image/SVG) or rendered client-side from raw audio data?
- Maximum audio duration — should there be a cap (e.g., 10 minutes)? Suggested: same as longest clip, or 10 minutes.

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-006] Validate Audio File Format and Trigger Waveform Analysis

**User Story**
As a user, I want unsupported or invalid audio files to be rejected immediately and valid files to be automatically analysed for beat data so that the HypeReel generation can sync cuts to the music.

**Acceptance Criteria**
- [ ] Given the user selects an audio file, when the format is not in the accepted list (MP3, AAC, WAV, FLAC, OGG), then the file is rejected before upload and an inline error reads "Unsupported format. Please upload MP3, AAC, WAV, FLAC, or OGG."
- [ ] Given the user selects a supported format, when the file size exceeds the maximum (e.g., 500 MB), then the file is rejected before upload and an inline error reads "File too large. Maximum audio size is 500 MB."
- [ ] Given a valid audio file is uploaded, when the upload completes, then the backend automatically triggers a waveform analysis job (BPM extraction, beat timestamps, phrase boundaries, amplitude envelope) executed by the self-hosted **librosa** Python worker running on Quorra.
- [ ] Given the waveform analysis job is running, when the user is on the audio step, then a status indicator reads "Analysing song…" with a spinner; the user can continue to the next step (highlights) while analysis runs in the background.
- [ ] Given the waveform analysis job completes successfully, when the user reaches the generation step, then the beat data is available and generation proceeds without re-analysis.
- [ ] Given the waveform analysis job fails (e.g., no detectable beat, corrupt audio), when the failure is detected, then the user is notified with an error banner: "We couldn't analyse this song. Please try a different audio file." The audio file is removed and the user must re-upload.
- [ ] Given a MIME type mismatch (spoofed extension), when the backend validates file contents, then the file is rejected with "Invalid audio file. Please check the file and try again."

**Out of Scope**
- Manual BPM override or beat grid editor — Future
- Lyrics analysis or vocal detection
- Any managed cloud audio analysis service (e.g., third-party BPM APIs) — all analysis runs locally via librosa

**Open Questions**
- Should waveform analysis be synchronous or fully async with a polling/webhook mechanism? (Architecture decision — async with polling preferred given latency.)
- Maximum song duration limit. Suggested: 10 minutes.

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E4: Person Detection

### [STORY-007] Trigger AI Person Detection Across All Uploaded Clips

**User Story**
As a user, I want the application to automatically detect all people visible in my uploaded clips so that I can identify the subject I want the reel to focus on.

**Acceptance Criteria**
- [ ] Given all clips are uploaded, when the user proceeds to the person detection step, then the backend automatically submits a person detection job for each clip that does not yet have detection results; the job is dispatched to the **InsightFace** worker running on Quorra in **CPU-only mode** per ADR-013 (`CPUExecutionProvider`, `ctx_id=-1`), with a processing time target of ≤ 60 seconds per clip-minute and no GPU dependency for this story.
- [ ] Given person detection jobs are running, when the user is on the detection step, then a loading state is shown per clip with a progress indicator and a label reading "Detecting people…".
- [ ] Given person detection completes for a clip, when results are returned from the InsightFace worker, then detected persons for that clip are shown as thumbnail images (representative face/body crop) with a confidence indicator or no confidence indicator (MVP simplicity); the output contract is: thumbnail image, confidence score (0–1), and list of timestamps/clip offsets where the person appears.
- [ ] Given person detection completes for all clips, when all results are available, then the user is prompted to select one person of interest.
- [ ] Given clips finish detection at different times, when partial results arrive, when the UI updates per-clip as each completes rather than waiting for all clips.
- [ ] Given the detection job fails for a specific clip (e.g., corrupt video segment), when the failure is returned, then that clip is marked "Detection failed" and the user can still proceed and select a person from other clips.
- [ ] Given person detection is already complete for a clip (e.g., the user navigates back and forward), when the step is re-entered, then cached results are displayed immediately without re-running the job.
- [ ] Given the InsightFace worker on Quorra is unavailable (service down, OOM), when a detection job is submitted, then the job enters a retry queue; after 3 failed attempts the clip is marked "Detection failed" and the user is notified per the failure criterion above.

**Out of Scope**
- AWS Rekognition or any managed cloud vision API — detection runs exclusively on self-hosted InsightFace (Quorra GTX 1080 Ti)
- Detecting non-human subjects (animals, objects)
- Named person profiles or persistent face recognition — Future
- Multi-person selection — Future

**Open Questions**
- What is the expected latency for InsightFace person detection per clip on the GTX 1080 Ti? This determines whether a polling interval or WebSocket push is more appropriate.
- Are detection results keyed per session-clip pair and stored until session expiry?

**Size:** L
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-008] Select One Person of Interest from Detected Results

**User Story**
As a user, I want to select exactly one person of interest from the detected people so that the HypeReel prioritises moments featuring that person.

**Acceptance Criteria**
- [ ] Given person detection results are shown, when the user clicks on a person thumbnail, then that thumbnail is visually selected (highlighted border, checkmark) and all other thumbnails are deselected.
- [ ] Given a person is selected, when the user clicks the same thumbnail again, then the selection is cleared (toggle off) — no person of interest is selected.
- [ ] Given a person is selected, when the user proceeds to the highlight selection step, then the selection is persisted to the session and used during generation.
- [ ] Given the user has not selected a person, when attempting to proceed, then a tooltip or inline notice reads "Select a person to focus the reel, or skip to let the AI choose." with a visible "Skip" option.
- [ ] Given the user chooses to skip person selection, when generation runs, then no person-of-interest constraint is applied and the AI freely selects moments.
- [ ] Given the same person appears in multiple clips, when the detection results are shown, when the person's thumbnails from each clip are grouped together under a single selectable card labelled "Appears in X clips."
- [ ] Given detection returned very low-confidence results (below threshold), when those results are displayed, then they are shown with a visual indicator ("Low confidence") but are still selectable.

**Out of Scope**
- Selecting more than one person per reel — Future
- Creating or naming a person profile — Future
- Correcting misidentified persons by manual annotation — Future

**Open Questions**
- What is the confidence threshold below which a detection should be flagged "Low confidence"? Engineering / ML to define.
- How are "same person across clips" determined? By facial embedding clustering? ML engineer to confirm feasibility for MVP.

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-009] Handle No Persons Detected in Clips

**User Story**
As a user, I want a clear explanation when no people are detected in my clips so that I understand why the person selection step is empty and can decide how to proceed.

**Acceptance Criteria**
- [ ] Given person detection has completed for all clips, when no persons are found in any clip, then the person selection panel displays an empty state message: "No people were detected in your clips. The AI will select the best moments automatically."
- [ ] Given the empty detection state is shown, when the user views the screen, then a "Continue Without Person Selection" button is prominently displayed and enabled.
- [ ] Given a clip has no detected persons but other clips do, when results are displayed, when the clips with no detections are clearly labelled "No people detected in this clip" so the user understands which clips contribute to the person gallery.
- [ ] Given the user continues without selecting a person, when generation runs, then the reel is generated without a person-of-interest constraint and the generation step does not error on missing selection.

**Out of Scope**
- Prompting the user to re-upload clips when detection fails
- Manual person bounding-box annotation

**Open Questions**
- None at this time.

**Size:** S
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E5: Highlight Selection

### [STORY-010] Mark Highlight Segments on a Clip Using a Scrubber

**User Story**
As a user, I want to mark specific time ranges within a clip as highlights so that those moments are guaranteed to appear in my HypeReel regardless of what the AI decides.

**Acceptance Criteria**
- [ ] Given the highlight selection step is shown, when the user selects a clip to edit, then a video scrubber is displayed with the clip's full timeline.
- [ ] Given the scrubber is shown, when the user drags a start handle and an end handle on the timeline, then a highlighted range region is drawn between the two handles.
- [ ] Given a range is drawn, when the user releases the handles, then the highlight is added to the clip's highlight list with its start and end timestamps formatted as M:SS.SSS.
- [ ] Given a highlight is in the list, when the user wants to be precise, then they can manually type or adjust timestamp values in numeric inputs adjacent to the scrubber.
- [ ] Given multiple highlights are added to one clip, when they are displayed, then they are shown as a list of rows, each with start time, end time, and a delete button.
- [ ] Given the user clicks the delete button on a highlight, when confirmed (no confirmation modal needed — single click), then the highlight is removed from the list and the scrubber range is cleared.
- [ ] Given two highlight ranges on the same clip overlap, when the second range is added, then the UI merges the overlapping ranges into a single contiguous range and notifies the user: "Overlapping highlights have been merged."
- [ ] Given the user adds a zero-duration highlight (start equals end), when the range is committed, then it is rejected with the message "Highlight must be at least 1 second long."
- [ ] Given a highlight's end time exceeds the clip's duration, when the range is set, then the end time is clamped to the clip's last frame and the user is notified.
- [ ] Given the clip has no highlights (all optional), when the user proceeds to generation, then the generation step succeeds — highlights are always optional.

**Out of Scope**
- Frame-accurate highlight selection (sub-millisecond precision) — not required for MVP
- Video playback within the highlight editor — Future (MVP uses static scrubber)
- Highlight preview playback

**Open Questions**
- Should the highlight scrubber include a static waveform / audio visualisation from the clip's audio channel to help users identify moments? Nice-to-have for MVP — scope risk if complex.
- Is 1-second the right minimum highlight duration, or should it match the minimum beat interval derived from song BPM?

**Size:** L
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-011] Enforce Highlight Duration Constraints Relative to Song Length

**User Story**
As a user, I want the application to warn me if my selected highlights exceed the song's duration so that I can adjust my selections before generation fails unexpectedly.

**Acceptance Criteria**
- [ ] Given highlights are defined across all clips and the song duration is known, when the total combined duration of all highlights exceeds the song duration, then a warning banner is shown: "Your highlights total [X]s, which exceeds the song length of [Y]s. The AI will shorten clips to fit."
- [ ] Given the warning is shown, when the user proceeds anyway, then generation is not blocked — the AI is permitted to trim highlights to fit within the song duration, starting from the end of each highlight segment.
- [ ] Given the total highlight duration equals or is less than the song duration, when no warning is shown, then the generation step proceeds normally.
- [ ] Given the song analysis has not yet completed, when the highlight selection step is shown, then the duration constraint check is deferred until analysis completes; a status note reads "Song analysis in progress — constraint check pending."

**Out of Scope**
- Automatic highlight trimming in the UI before submission
- Hard blocking of generation when highlights exceed song duration

**Open Questions**
- Should the AI be permitted to cut highlights at all, or should highlights always play in full? If full playback is guaranteed, generation must be blocked (not just warned) when highlights exceed song length. **This is a product decision that must be resolved before implementation.**

**Size:** S
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-012] Review and Edit All Highlights Before Generating

**User Story**
As a user, I want a summary view of all my highlights across all clips so that I can review, edit, or remove any of them before submitting for generation.

**Acceptance Criteria**
- [ ] Given the user has defined highlights across multiple clips, when they reach the review/summary screen, then all clips are listed with their respective highlight ranges.
- [ ] Given a clip has no highlights, when it is shown in the summary, then it is labelled "No highlights — AI will choose best moments."
- [ ] Given the user wants to edit a highlight, when they click "Edit" next to a highlight range, then the scrubber for that clip is opened directly at that highlight's position.
- [ ] Given the user wants to remove all highlights from a clip, when they click "Clear All" for that clip, then all highlights for that clip are deleted without a confirmation modal.
- [ ] Given all highlights are reviewed, when the user clicks "Generate HypeReel", then the session is locked (uploads and highlights are frozen) and the generation job is submitted.
- [ ] Given the session is locked, when the user navigates back to the highlight or upload steps, then a read-only mode is shown with the message "Generation in progress. Editing is disabled."

**Out of Scope**
- Reordering highlights across clips to influence final cut sequence
- Assigning weights or priority levels to individual highlights

**Open Questions**
- Should the review screen show the total estimated reel duration based on highlights + inferred AI padding?

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E6: HypeReel Generation

### [STORY-013] Submit HypeReel Generation Job and Show Progress

**User Story**
As a user, I want to submit my clips, audio, person selection, and highlights for generation and see real-time progress so that I know the system is working and can anticipate when my reel will be ready.

**Acceptance Criteria**
- [ ] Given the user clicks "Generate HypeReel" on the review screen, when the request is submitted, then a generation job is created on the backend and a job ID is returned; the UI transitions to a "Generating…" screen.
- [ ] Given the generation job is running, when the UI polls or receives updates, then a progress bar or step-by-step status is shown: e.g., "Analysing clips", "Selecting moments", "Sequencing cuts", "Rendering video", "Finalising".
- [ ] Given the generation job completes successfully, when the final video is ready, then the UI automatically transitions to the download screen without requiring a page refresh.
- [ ] Given the generation job fails (e.g., rendering error, ML pipeline exception), when the failure is detected, then the user sees an error screen: "Generation failed. Please try again." with a "Start Over" button that clears the session and returns to step 1.
- [ ] Given the user closes the browser tab during generation, when they return (session token still valid), then the UI reconnects to the in-progress job and shows the current status.
- [ ] Given the generation job is in progress, when the user attempts to navigate back to edit steps, then a modal prompt warns "Generation is in progress. Going back will cancel the current job." with "Stay" and "Cancel Job & Go Back" options.
- [ ] Given the user confirms "Cancel Job & Go Back", when cancellation is sent, then the job is stopped, partial output is discarded, and the session is unlocked for editing.
- [ ] Given a timeout occurs (job runs longer than e.g., 15 minutes), when the timeout threshold is reached, then the job is marked as failed and the user sees the generation failure screen.

**Out of Scope**
- Preview of the reel before finalising — Future
- Regeneration with different settings without re-uploading — Future
- Partial output / progress video preview

**Open Questions**
- What is the estimated generation time range? This determines whether polling intervals or WebSockets are more appropriate. (Engineering to confirm.)
- What is the job timeout threshold? Suggested: 15 minutes.
- Should cancelled jobs clean up immediately or be deferred to the nightly purge?

**Size:** L
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-014] Display Generation Status to Users Who Return After Closing Tab

**User Story**
As a user who closed my browser during generation, I want the app to restore my generation status when I return with my session token so that I don't assume my reel was lost.

**Acceptance Criteria**
- [ ] Given a valid session token is stored in the browser, when the user reopens the application, then the backend is queried for the session's current state (uploading, detecting, pending generation, generating, complete, failed).
- [ ] Given the session is in "generating" state on return, when the page loads, then the user is taken directly to the generation progress screen showing current job status.
- [ ] Given the session is in "complete" state on return, when the page loads, then the user is taken directly to the download screen.
- [ ] Given the session is in "failed" state on return, when the page loads, then the user is taken to the generation failure screen with a "Start Over" option.
- [ ] Given the session has expired (token invalidated), when the page loads, then the user is shown: "Your session has expired. All files have been deleted." with a "Start New HypeReel" button.
- [ ] Given the session is in a mid-upload or highlight-selection state on return, when the page loads, then the user is returned to the step they were on with their prior inputs intact.

**Out of Scope**
- Email or push notifications when generation completes — Future
- Shareable links to a generation result

**Open Questions**
- Should session state be stored server-side only, or mirrored in localStorage for faster initial render before API response?

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E7: Download & Cleanup

### [STORY-015] Download the Completed HypeReel

**User Story**
As a user, I want to download my completed HypeReel as a video file so that I can save it locally and share it on social platforms.

**Acceptance Criteria**
- [ ] Given generation is complete, when the user is on the download screen, then a prominent "Download HypeReel" button is displayed along with a preview thumbnail (first frame of the generated video).
- [ ] Given the user clicks "Download HypeReel", when the browser initiates the download, then the file is served as a video file (MP4, H.264) with a meaningful filename (e.g., `hypereel-[session-short-id].mp4`); the download URL is a **MinIO presigned URL** (short-lived, single-use) generated by the API — user-facing behaviour is identical to a signed URL from any object store.
- [ ] Given the download initiates, when the download begins, then the backend simultaneously starts a cleanup timer or deferred job to delete all session assets after a grace period (e.g., 5 minutes) or upon explicit "Done" click — whichever comes first.
- [ ] Given the download fails (network drop, browser cancels), when the failure is detected, then the user is still on the download screen and can click "Download HypeReel" again — the file is not deleted until the grace period or "Done" action.
- [ ] Given the user has not yet clicked "Done" and the grace period has not elapsed, when the user refreshes the page, then the download screen is still shown and the file remains available.
- [ ] Given the user clicks "Done" (or the grace period elapses), when cleanup runs, then all assets (clips, audio, generated video, detection results, job data) are permanently deleted and the session is invalidated.
- [ ] Given the session is invalidated after cleanup, when the user attempts to re-download via a bookmarked URL, then they receive: "This HypeReel has been deleted. Start a new one." with a "Create New HypeReel" button.
- [ ] Given the generated video file exceeds a size where browser download is reliable, when the download is triggered, then a streaming download (not a full blob in memory) is used.

**Out of Scope**
- In-browser video preview before download — Future
- Direct sharing to social platforms (Instagram Reels, TikTok) — Future
- Cloud storage export (Google Drive, Dropbox) — Future
- Re-generation or editing after download

**Open Questions**
- What is the grace period between download initiation and forced cleanup? Suggested: 5 minutes. Should be configurable.
- What output resolution and bitrate targets are required? (e.g., 1080p H.264 at 8 Mbps) — ML / DevOps to confirm.
- Should the download screen show the reel duration and file size before download?

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-016] Permanently Delete All Session Assets After Download

**User Story**
As a system operator, I want all user-uploaded and generated files to be permanently deleted immediately after the download is complete so that we do not retain user data beyond its necessary lifetime and minimise storage costs.

**Acceptance Criteria**
- [ ] Given a user has clicked "Done" on the download screen, when the cleanup job runs, then all of the following are deleted: all uploaded video clips, the uploaded audio file, all AI-generated intermediary files, the final HypeReel video, all person detection result data, all highlight metadata, and the session record itself.
- [ ] Given the grace period (e.g., 5 minutes) elapses without a "Done" click, when the TTL expires, then the same full cleanup is triggered automatically.
- [ ] Given a session has been idle for 24 hours without reaching the download step, when the nightly or scheduled purge runs, then the session and all its assets are cleaned up.
- [ ] Given cleanup completes, when an audit log entry is written, then it records: session ID (hashed), timestamp of deletion, and count of files deleted — no PII or file content is logged.
- [ ] Given a cleanup job fails partway through (e.g., a file deletion returns an error), when the partial failure is detected, then the cleanup job retries the failed deletions up to 3 times and alerts the operator via an error log if all retries fail.
- [ ] Given all retries fail for a file, when the final retry fails, then the session is still invalidated (token rejected) even if one or more files could not be deleted — the user cannot access the session, but an operator alert is raised for manual cleanup.
- [ ] Given all session objects reside in MinIO (self-hosted on Case), when the cleanup job runs, then file deletion is performed via the MinIO S3-compatible API (DELETE object calls); **MinIO object lifecycle policies** are configured as a safety net to expire any orphaned objects after 48 hours, in addition to application-level deletion — this replaces any previously assumed Cloudflare R2 lifecycle rules.

**Out of Scope**
- Cloudflare R2 or any managed object storage lifecycle rules — all storage and lifecycle management runs on self-hosted MinIO
- Legal hold / data retention policies — not applicable for MVP (no accounts, no PII stored intentionally)
- User-initiated deletion before download (covered implicitly by session expiry and "Start Over" flows in other stories)

**Open Questions**
- Should cleanup be a synchronous post-download call or an async background job? Async with retry is preferred for reliability.
- Is there a compliance requirement (GDPR, CCPA) that mandates a deletion confirmation receipt?

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

## E8: Error Handling & Edge Cases

### [STORY-017] Show a Global Error Boundary for Unhandled Application Failures

**User Story**
As a user, I want any unexpected application crash or unhandled error to show a friendly error screen rather than a blank page or raw stack trace so that I know what happened and what to do next.

**Acceptance Criteria**
- [ ] Given any unhandled JavaScript exception in the frontend, when the error boundary catches it, then the user sees a full-page error screen with: a brief friendly message ("Something went wrong"), a "Start Over" button that clears the session and reloads the app, and no raw error or stack trace visible to the user.
- [ ] Given a server returns an unexpected 500 error, when the frontend receives the response, then the user is shown the same error screen — not a blank page or loading spinner that never resolves.
- [ ] Given a 404 on any API call during a valid session, when the response is received, then the frontend interprets this as a session-not-found and shows: "Your session could not be found. It may have expired." with a "Start New HypeReel" button.
- [ ] Given a network connectivity loss (browser is offline), when the user attempts any action, then a non-blocking banner reads "You appear to be offline. Please check your connection." and pending actions are queued or blocked gracefully without data loss.
- [ ] Given connectivity is restored, when the browser comes back online, then the offline banner is dismissed and the user can retry their last action.
- [ ] Given any error screen is shown, when the "Start Over" action is taken, then any existing session token in storage is cleared and a new session is created from scratch.

**Out of Scope**
- Error reporting to a user-facing error ID or support ticket system — Future
- Automatic retry of failed actions without user intervention

**Open Questions**
- Should unhandled errors be reported to an error monitoring service (e.g., Sentry)? Recommended yes — DevOps / engineering to configure.

**Size:** M
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-018] Prevent Simultaneous Sessions from the Same Browser

**User Story**
As a user who accidentally opens the application in two tabs, I want the application to prevent data conflicts between tabs so that my session is not corrupted by competing actions.

**Acceptance Criteria**
- [ ] Given the application is open in Tab A, when the user opens the same URL in Tab B within the same browser, then Tab B detects an existing session token and displays a warning: "You have an active HypeReel session in another tab. Continue there to avoid conflicts."
- [ ] Given the warning is shown in Tab B, when the user clicks "Continue in This Tab", then Tab B takes over the session (Tab A, if still open, shows "This session was taken over by another tab. Please close this tab.").
- [ ] Given the user has already downloaded their reel and the session has been destroyed, when Tab B opens and finds an invalidated token, then Tab B starts a fresh session silently.
- [ ] Given only one tab is open, when no conflict is detected, then no warning is shown and the session proceeds normally.

**Out of Scope**
- Multi-device synchronisation — Future
- Preventing the user from opening a second incognito window (different storage context)

**Open Questions**
- Browser tab coordination can be implemented via `BroadcastChannel` API or `localStorage` events — architecture team to confirm approach.

**Size:** S
**Priority:** P1 (should-have)
**Sprint:** MVP

---

### [STORY-019] Display Step-by-Step Navigation and Progress Indicator

**User Story**
As a user, I want a clear visual indicator of where I am in the HypeReels workflow so that I always know what step I'm on, what I've completed, and what's coming next.

**Acceptance Criteria**
- [ ] Given any step in the workflow, when the page renders, then a step progress indicator is visible showing all steps: Upload Clips → Upload Song → Select Person → Mark Highlights → Review → Generate → Download.
- [ ] Given a step has been completed, when the user is on a later step, then the completed step is visually marked (e.g., checkmark icon, filled circle).
- [ ] Given the user is on a step, when the current step is rendered, then it is visually highlighted as active (e.g., bold label, accent colour).
- [ ] Given a step is locked (session is in generation), when the user views the progress indicator, then locked steps are visually disabled and are not clickable.
- [ ] Given a step is completed and not locked, when the user clicks on it in the progress indicator, then the user is navigated back to that step to review or edit their inputs.
- [ ] Given the user is on a mobile viewport (< 768px width), when the progress indicator is rendered, then it collapses to a compact form (e.g., "Step 3 of 7" text label) without overflowing the screen.

**Out of Scope**
- Saving progress and resuming on a different device — Future
- Animated step transitions (acceptable to implement if low effort, but not required)

**Open Questions**
- Should back-navigation prompt a confirmation when it would discard in-progress work (e.g., partially drawn highlight)?

**Size:** S
**Priority:** P1 (should-have)
**Sprint:** MVP

---

## E9: On-Premises Deployment

### [STORY-020] Deploy Full Stack to On-Premises Infrastructure

**User Story**
As a system operator, I want the complete HypeReels application deployed and running on our two on-premises servers so that the product is accessible to end users without relying on any managed cloud services.

**Acceptance Criteria**
- [ ] Given the Case Proxmox host (192.168.1.122), when the deployment is complete, then the following services each run in their own LXC container (IDs starting at CT 113 / 192.168.1.136, since CT 108 / 192.168.1.131 is reserved for a future ntfy push notification server): the REST API server (CT 113, listening on port 3001), Redis (CT 114, self-hosted, 192.168.1.137:6379), and MinIO (CT 115, self-hosted object storage, data directory on the `storage_1tb` ZFS pool, 899.25 GB, 192.168.1.138:9000).
- [ ] Given the Quorra Unraid host (192.168.1.100), when the deployment is complete, then the following Docker containers are running and healthy: `hypereels-postgres` (postgres:18, host port 7432, data at `/mnt/user/appdata/hypereels-postgres`), the InsightFace person detection worker (CPU-only per ADR-013), the librosa audio analysis worker, and the FFmpeg video rendering worker.
- [ ] Given both hosts are on the same LAN (192.168.1.x), when the Quorra GPU workers need to read/write files or enqueue/dequeue jobs, then they communicate with the Case-hosted MinIO and Redis instances over the internal network; no internet egress is required for worker-to-storage or worker-to-queue traffic.
- [ ] Given the application is deployed, when an end user accesses the app via a browser on the local network, then all seven workflow steps (upload → person detection → highlights → generation → download) complete successfully end-to-end.
- [ ] Given a clip is uploaded, when upload completes, then the `clip-validation` BullMQ queue is active and clips transition from `status='uploading'` → `status='valid'` (or `status='invalid'` with a `validation_error` message) within 60 seconds of upload completing.
- [ ] Given the cleanup worker is deployed, when it runs on its repeatable hourly schedule, then sessions with `status='complete'` older than 24 hours and abandoned `status='active'` sessions older than 48 hours are automatically purged from PostgreSQL and MinIO.
- [ ] Given the existing Nginx Proxy Manager already runs on Case (CT 100), when HypeReels is deployed, then a new proxy host entry is added to the existing NPM instance pointing to the HypeReels API/frontend — no new Nginx LXC is created.
- [ ] Given the existing Cloudflare-Tron tunnel is active on Quorra, when external access is required, then a new tunnel endpoint is configured in Cloudflare-Tron to route external traffic to the HypeReels NPM proxy host — no firewall ports are opened.
- [ ] Given the Case LXC containers are defined, when the infrastructure is provisioned, then each container has resource limits configured (CPU cores, RAM ceiling) to prevent any single service from starving others on the host.
- [ ] Given the GTX 1080 Ti on Quorra is shared with Frigate (security NVR) and FileFlows (NVENC transcoding), when the InsightFace worker container starts, then per ADR-013 it is launched **without** `--gpus all` and **without** the NVIDIA runtime, runs CPU-only inference, and Frigate and FileFlows retain exclusive GPU access.
- [ ] Given a planned or unplanned restart of either host, when services come back up, then all LXC containers on Case and all Docker containers on Quorra restart automatically (restart policy: `unless-stopped` for Docker; Proxmox LXC autostart enabled).
- [ ] Given the deployment is running, when an operator needs to perform a startup or shutdown, then a documented runbook exists covering: starting/stopping individual services, draining in-flight jobs before shutdown, verifying health after restart.
- [ ] Given MinIO is running on Case (data on the `storage_1tb` ZFS pool, 899.25 GB), when it is configured, then at least one bucket is created for session assets, and a lifecycle policy is applied to expire objects older than 48 hours as a safety net for orphaned files.
- [ ] Given PostgreSQL is running as a Docker container on Quorra (192.168.1.100:7432), when it is configured, then the database schema is applied via a migration tool (e.g., Alembic or Flyway) on first boot, and the migration is idempotent (safe to re-run).
- [ ] Given Redis is running on Case, when it is configured, then it is accessible only on the internal network interface (not exposed externally) and uses a password for authentication.
- [ ] Given the existing Grafana + Prometheus stack is running on Quorra, when HypeReels is deployed, then the HypeReels API exposes a `/metrics` endpoint and the existing Prometheus instance on Quorra is configured to scrape it; HypeReels-specific dashboards are added to the existing Grafana instance — no new monitoring infrastructure is deployed.
- [ ] Given both hosts are operational, when a developer runs a smoke test script, then all inter-service connections (API → PostgreSQL, API → Redis, API → MinIO, API → GPU workers via job queue) are verified healthy and the script exits 0.

**Out of Scope**
- Deploying a new Nginx or Caddy LXC — the existing NPM (CT 100) handles reverse proxying
- Deploying new monitoring infrastructure — integrate with the existing Grafana/Prometheus/InfluxDB stack on Quorra
- High availability / failover clustering across hosts (single-node per service for MVP)
- Kubernetes or container orchestration beyond Docker and LXC

**Open Questions**
- What inter-host authentication mechanism is used for GPU workers on Quorra reaching Redis/MinIO on Case — network ACL only, or per-service credentials?
- Should NPM terminate TLS for HypeReels, and is a Let's Encrypt cert needed for the LAN hostname?
- Is per-container stdout/stderr logging sufficient for MVP, or does the operator want log forwarding into the existing InfluxDB/Telegraf pipeline?

**Size:** L
**Priority:** P0 (must-have)
**Sprint:** MVP

---

### [STORY-021] Monitor InsightFace CPU Inference Performance and Establish GPU Upgrade Path

**User Story**
As a system operator, I want visibility into InsightFace CPU inference duration per clip, so that I can identify when it becomes a bottleneck and make an informed decision to enable GPU mode.

**Acceptance Criteria**
- [ ] Given the InsightFace Python worker is processing clips, when a clip completes inference, then the worker emits an `insightface_inference_duration_seconds` Prometheus metric (histogram) labeled per clip processed.
- [ ] Given the Grafana dashboard imported from `docs/grafana-dashboard.json`, when an operator views it, then a panel shows InsightFace inference duration over time with a warning threshold drawn at 60 seconds per clip-minute.
- [ ] Given an operator wants to enable GPU mode in the future, when they consult the architecture documentation, then a clear GPU upgrade path is documented: set `providers=['CUDAExecutionProvider', 'CPUExecutionProvider']` and `ctx_id=0` in `person_detection_worker.py`, and add `--gpus all` (or `runtime: nvidia`) to the Docker Compose service — only safe to do when Frigate and FileFlows are confirmed stopped.
- [ ] Given the CPU inference performance baseline, when measured on Quorra's CPU (AMD Ryzen or equivalent), then inference completes in ≤ 60 seconds per clip-minute.
- [ ] Given a Prometheus alert rule is configured, when any single InsightFace job exceeds 120 seconds (configurable via the `INSIGHTFACE_TIMEOUT_MS` environment variable), then the alert fires.

**Out of Scope**
- Enabling GPU inference in MVP — explicitly forbidden by ADR-013 due to Frigate and FileFlows GPU contention
- Automated GPU/CPU mode switching — out of MVP; documented manual upgrade path only
- Purchasing or provisioning an additional GPU — not in MVP budget

**Open Questions**
- What sampling rate / histogram bucket boundaries best capture the expected 30–60 s/clip-minute range?
- Should the alert escalate to ntfy (CT 108) once that service is online?

**Size:** M
**Priority:** P1
**Sprint:** MVP

> **Note:** Supersedes the original GPU scheduling/arbitration approach. ADR-013 documents the full decision rationale.

---

## Future Sprint Stories (Out of MVP Scope)

The following story titles are placeholders for future sprints. They are listed here to capture intent and ensure they do not creep into the MVP.

| Story ID | Title | Reason Deferred |
|----------|-------|-----------------|
| STORY-022 | Preview HypeReel before download | Requires low-latency streaming or re-render; significant infra complexity |
| STORY-023 | Multi-person selection in a single reel | ML complexity; requires weighted moment selection across persons |
| STORY-024 | Manual person annotation and named profiles | Requires persistent storage and face recognition across sessions |
| STORY-025 | Spotify integration for song selection | Third-party OAuth + streaming licensing considerations |
| STORY-026 | User authentication and persistent project storage | Full auth system; changes fundamental no-account architecture |
| STORY-027 | Mobile application (iOS / Android) | Separate platform engineering effort |
| STORY-028 | Custom transition effects library | Visual design + rendering pipeline extension |
| STORY-029 | Direct social platform export (Instagram, TikTok) | Third-party API integrations; platform policy compliance |
| STORY-030 | Resumable / chunked video uploads | Infra and client-side complexity; revisit when large file support is needed |

---

## Story Size Reference

| Size | Story Points (approx.) | Description |
|------|----------------------|-------------|
| XS | 1 | Trivial change, under 2 hours |
| S | 2–3 | Small, well-understood, under 1 day |
| M | 5 | Moderate complexity, 1–2 days |
| L | 8 | Complex, multiple components, 3–5 days |
| XL | 13+ | Needs breakdown before sprint commitment |

## Priority Definitions

| Priority | Meaning |
|----------|---------|
| P0 | Must ship for MVP to be functional. Blocking. |
| P1 | Should ship in MVP sprint; high value, not strictly blocking. |
| P2 | Nice-to-have; defer if sprint capacity is exceeded. |
