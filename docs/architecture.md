# HypeReels Architecture

> This file is owned by the Architect agent.
> Last updated: 2026-04-19 (revised: ADR-017 corrected systemd paths; ADR-003/ADR-006 blocker notes added for workers/main.py Rekognition stale code and missing minio_client module; status trailer updated to reflect MVP implementation complete)

---

## System Overview

HypeReels is a stateless, session-scoped web application that accepts user-uploaded video clips and an audio track, runs an async AI pipeline to detect people (via InsightFace CPU-only to avoid GPU contention with Frigate), analyse the beat structure of the song, and assemble a beat-synced highlight reel, then delivers a single downloadable MP4 and immediately destroys all uploaded and generated assets. There are no user accounts; a UUID session token ties a browser session to all associated server-side state. The entire stack runs on two on-premises servers — Case (Proxmox, 192.168.1.122) and Quorra (Unraid, 192.168.1.100) — connected over a 192.168.1.0/24 LAN, exposed externally via an existing Cloudflare Zero Trust tunnel on Quorra, with no dependency on any managed cloud service.

---

## Component Diagram

```
Internet
    │
    │ HTTPS — Cloudflare Zero Trust Tunnel (existing, on Quorra)
    │         routes hypereel.yourdomain.com → Case API via tunnel
    ▼
Browser (React SPA)
    │
    │ HTTPS — via Nginx Proxy Manager (CT 100, existing, 192.168.1.123:80/443)
    ▼
┌──────────────────────────────────────────────────────────────┐
│  CASE — Proxmox LXC Containers (192.168.1.122)               │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Nginx Proxy Manager (CT 100, existing, shared)      │   │
│  │  192.168.1.123 | Web UI: :81                         │   │
│  │  Proxy: hypereels.thesquids.ink → 192.168.1.136:3001 │   │
│  │  TLS: Cloudflare-managed (tunnel) or NPM Let's Enc.  │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                    │
│            ┌────────────▼─────────────┐                     │
│            │  API Server (CT 113)     │                     │
│            │  Node.js / Fastify       │                     │
│            │  192.168.1.136:3001      │                     │
│            └────────────┬─────────────┘                     │
│                         │                                    │
│            ┌────────────▼─────────────┐                     │
│            │  Redis (CT 114)          │                     │
│            │  BullMQ queues + pub/sub │                     │
│            │  192.168.1.137:6379      │                     │
│            └────────────┬─────────────┘                     │
│                         │                                    │
│            ┌────────────▼─────────────┐                     │
│            │  MinIO (CT 115)          │                     │
│            │  192.168.1.138:9000 (API)│                     │
│            │  192.168.1.138:9001 (UI) │                     │
│            └──────────────────────────┘                     │
│                                                              │
│  Storage: storage_1tb pool (ZFS, 899 GB) → MinIO bind mount  │
└──────────────────────────────────────────────────────────────┘
             │
             │ LAN (192.168.1.0/24) — BullMQ + MinIO S3 API
             ▼
┌──────────────────────────────────────────────────────────────┐
│  QUORRA — Unraid Docker Containers (192.168.1.100)           │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  hypereels-postgres        │  postgres:18                 │
│  │  host port 7432 → 5432     │  /mnt/user/appdata/         │
│  │  192.168.1.100:7432        │  hypereels-postgres          │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  Python Worker Container   │                             │
│  │  • InsightFace (buffalo_l) │  CPU-only (no GPU)          │
│  │  • ADR-013: GPU reserved   │  ~30–60s per clip-minute    │
│  │    for Frigate, FileFlows, │                             │
│  │    and HypeReels itself    │                             │
│  │  port 8000 (health/admin)  │                             │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  Python Worker Container   │                             │
│  │  • librosa audio analysis  │                             │
│  │  • CPU-only                │                             │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  Python Worker Container   │                             │
│  │  • FFmpeg video assembly   │                             │
│  │  • CPU-only (x264 encode)  │                             │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐  ← existing infrastructure  │
│  │  Frigate NVR               │  NVIDIA GTX 1080 Ti (excl.) │
│  │  (home security, running)  │  autoStart=false             │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐  ← existing infrastructure  │
│  │  Cloudflare-Tron tunnel    │  routes HypeReels external  │
│  │  (figro/unraid-cloudflared)│  hostname via Zero Trust    │
│  └────────────────────────────┘                             │
│                                                              │
│  All HypeReels workers: receive HTTP POST calls from         │
│                         Node.js BullMQ workers on Case (CT 113) │
│                         read/write files from MinIO on Case  │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React 18 + TypeScript + Vite | React's component model suits a multi-step wizard; Vite gives fast local dev; TypeScript catches contract mismatches early |
| UI Library | Tailwind CSS + shadcn/ui | Utility-first CSS; shadcn/ui provides accessible primitives (sliders, progress bars) for the highlight scrubber |
| Frontend State | Zustand | Lightweight global store for session token, step state, and upload progress |
| Backend API | Node.js 20 LTS + Fastify | Schema-validated routes; native streaming for upload forwarding; fast start; runs in Proxmox LXC on Case |
| Job Queue | BullMQ + Redis (self-hosted) | BullMQ provides retry, delay, and priority; Redis pub/sub doubles as SSE notification bus; Redis runs in LXC on Case |
| Audio Analysis | Python 3.12 + librosa 0.10 | Standard library for beat tracking and onset detection; runs in Docker on Quorra |
| Person Detection | Python 3.12 + InsightFace (buffalo_l) | CPU-only face detection and embedding (GPU reserved for Frigate NVR, per ADR-013); runs on Quorra Docker; no per-API-call cost |
| Video Processing | Python 3.12 + FFmpeg 6 (subprocess) | FFmpeg handles all video ops; Python wraps EDL-driven assembly; runs in Docker on Quorra |
| Relational DB | PostgreSQL 18 (self-hosted, Docker) | ACID transactions for session/job state; FK cascades make cleanup correct; runs as Docker container on Quorra (hypereels-postgres, port 7432), co-located with nextcloud-postgres and homeassistant-postgres but in a dedicated container |
| Object Storage | MinIO (self-hosted, single-node) | S3-compatible API; presigned URLs; lifecycle policies for auto-deletion; runs in LXC on Case (CT 115, storage_1tb ZFS pool, 899 GB) |
| Cache / Pub-Sub | Redis 7 (self-hosted) | BullMQ job queues + SSE fan-out; runs in LXC on Case (CT 114) |
| Real-time Updates | Server-Sent Events (SSE) | One-directional server→client push for job progress; simpler than WebSockets; reconnects automatically |
| Reverse Proxy | Nginx Proxy Manager (CT 100, existing, shared) | Pre-existing NPM instance on Case handles TLS termination and proxy host for HypeReels; no new Nginx LXC needed |
| External Access | Cloudflare Zero Trust Tunnel (existing, on Quorra) | Cloudflare-Tron container already running; add HypeReels hostname to tunnel config — no firewall port forwarding, no self-signed certs |
| Containerisation | Proxmox LXC (Case) + Docker (Quorra) | LXC for API/data services (low overhead, no GPU needed); Docker for Python workers on Quorra |
| Error Monitoring | Sentry (self-hosted or cloud) | Captures exceptions from Node.js and Python workers; session ID as tag for cross-service correlation |
| Logging | Pino (Node.js) + structlog (Python) | Structured JSON logs; aggregated to stdout/stderr per container |
| Metrics | prometheus-client (Fastify /metrics endpoint) | Integrates with existing Prometheus + Grafana stack on Quorra; no new monitoring infrastructure |

---

## Service-to-Host Allocation

### Case — Proxmox LXC Containers

All stateful and API-layer services run on Case as Proxmox LXC containers on a bridge network (vmbr0) with static IPs in the 192.168.1.122 subnet. LXC is chosen over full VMs because it provides sufficient isolation with near-bare-metal performance, faster startup, and lower memory overhead — important when running multiple concurrent services on the same host.

| Service | CT ID | LXC Static IP | CPU Limit | RAM Limit | Disk | Port(s) |
|---------|-------|--------------|-----------|-----------|------|---------|
| Nginx Proxy Manager | CT 100 | 192.168.1.123 | 2 cores | 4 GB | local-zfs (OS volume) | 80, 443, 81 (Web UI) — **existing, shared** |
| API Server (Fastify) | CT 113 | 192.168.1.136 | 4 cores | 4 GB | vm_storage (OS volume) | 3001 |
| Redis 7 | CT 114 | 192.168.1.137 | 2 cores | 2 GB | vm_storage (OS volume, AOF) | 6379 |
| MinIO | CT 115 | 192.168.1.138 | 4 cores | 8 GB | storage_1tb ZFS pool (899 GB bind mount) | 9000, 9001 |

NPM (CT 100) is a pre-existing shared container at 192.168.1.123 (admin UI at :81). HypeReels is added as a new proxy host in the NPM web UI: `hypereels.thesquids.ink` → forward to CT 113 at `192.168.1.136:3001`. CT 108 is RESERVED for ntfy (planned push notification server, IP 192.168.1.131) — it is not available for HypeReels. All HypeReels LXC containers (CT 113–115) have static IPs in the 192.168.1.0/24 LAN subnet on the vmbr0 bridge.

### Quorra — Unraid Docker Containers

All Python ML/media workloads run on Quorra as Docker containers managed by Unraid's Docker subsystem. Docker is used rather than LXC because Unraid's Docker integration is the native workload management model, and GPU passthrough (via NVIDIA Container Runtime `--gpus all`) is possible if needed in a future sprint. For MVP, all HypeReels workers on Quorra run CPU-only — the GTX 1080 Ti is shared between Frigate NVR, FileFlows (NVENC media transcoding), and HypeReels InsightFace; CPU-only is the safe default (see ADR-013).

| Service | GPU Access | Port(s) | Temp Storage |
|---------|-----------|---------|--------------|
| hypereels-postgres (Docker) | No | 7432:5432 | `/mnt/user/appdata/hypereels-postgres` |
| worker-detection (InsightFace) | **No** — CPU-only (GTX 1080 Ti shared by Frigate, FileFlows, and HypeReels; CPU-only per ADR-013) | 8000 (health) | NVMe cache (`/mnt/cache`) |
| worker-audio (librosa) | No | — | NVMe cache (`/mnt/cache`) |
| worker-assembly (FFmpeg) | No | — | SATA SSD transfer (`/mnt/disk-transfer`) |

Python workers on Quorra are FastAPI HTTP services. They do NOT connect to BullMQ or Redis directly. Instead, Node.js BullMQ workers running in CT 113 on Case pick up jobs from Redis and call the Python FastAPI workers via HTTP POST. The Python workers communicate with Case over the LAN for:
- **Object storage:** MinIO S3 API at `http://192.168.1.138:9000` (direct access using provided credentials)
- **PostgreSQL:** `postgresql://hypereels:<PASSWORD>@192.168.1.100:7432/hypereels` (same host — Quorra Docker)
- **Invoked by:** Node.js BullMQ workers on Case (CT 113) via HTTP POST to `http://192.168.1.100:8000`

---

## Storage Layout on Proxmox (Case)

### Proxmox Storage Pool Assignments

The following storage pools are the actual Proxmox pool names as queried from the live system. Disk device names (`sdc`, `sdd`, etc.) are not referenced — pools are addressed by their configured Proxmox pool names.

| Proxmox Pool | Type | Size | Assigned To | Rationale |
|-------------|------|------|------------|-----------|
| `local-zfs` | ZFS pool | 126.53 GB | Proxmox OS + LXC root volumes (CT 113, 114 OS disks) | System and container root filesystems; low % used |
| `vm_storage` | ZFS pool | 430.68 GB | API LXC (CT 113), Redis LXC (CT 114) | Previously used for PostgreSQL LXC; PostgreSQL now runs as Docker on Quorra. 2.2% currently used. |
| `ISO_Storage` | dir | 898.68 GB | ISO images only — do NOT use for MinIO or databases | Directory pool type, not suitable for MinIO or PostgreSQL data; reserved for ISO images only |
| `storage_1tb` | ZFS pool | 899.25 GB | MinIO LXC (CT 115) — data directory bind-mounted into container | 899 GB ZFS pool supports many concurrent sessions of large video files; 0.1% used. CORRECT pool for MinIO. |
| `utility_146` | ZFS pool | 131.78 GB | Small services scratch / future use | 0.0% used; available for MinIO CT 115 OS disk if needed |

### MinIO Bucket Structure (on storage_1tb pool, 899 GB)

```
MinIO endpoint: http://192.168.1.138:9000
MinIO Console:  http://192.168.1.138:9001

Bucket: hypereel
  uploads/{session_id}/clips/{clip_id}.mp4     — raw uploaded video clips
  uploads/{session_id}/audio.{ext}             — uploaded audio track
  generated/{session_id}/hypereel_{short_id}.mp4 — completed HypeReel
  thumbnails/{session_id}/{clip_id}.jpg        — first-frame thumbnails
  thumbnails/{session_id}/waveform.svg         — audio waveform for frontend
  thumbnails/{session_id}/persons/{person_ref_id}.jpg — face crop thumbnails
```

**Lifecycle policy:** A MinIO ILM (Information Lifecycle Management) rule applies to all objects tagged `session_ttl=true`. Objects with this tag are expired and deleted after 48 hours. This is the safety net; the Cleanup Worker performs primary deletion. The 48-hour window (24h session TTL + 24h grace) guarantees no orphaned objects accumulate indefinitely.

**Presigned URL TTLs:**
- Upload URLs (PUT): 15 minutes (tight window prevents URL reuse)
- Thumbnail/waveform GET URLs: 1 hour
- Final download GET URL: 2 hours (sufficient for slow downloads of large files)

---

## Components

### Nginx Proxy Manager — CT 100 (existing, shared)

- **Purpose:** TLS termination, HTTP→HTTPS redirect, and proxying to the Fastify API. NPM is an existing shared container on Case; HypeReels adds one proxy host entry.
- **Technology:** Nginx Proxy Manager (CT 100) — already running at 192.168.1.123:80/443 with web UI at :81 (admin: http://192.168.1.123:81). No new LXC created. Proxmox host is 192.168.1.122; NPM container IP is 192.168.1.123.
- **Responsibilities (HypeReels proxy host):**
  - Add a proxy host in the NPM web UI: domain `hypereels.thesquids.ink` → forward hostname `192.168.1.136`, port `3001` (CT 113)
  - TLS: either (a) NPM-managed Let's Encrypt certificate (Request new certificate, Force SSL enabled), or (b) pass-through from Cloudflare tunnel (Cloudflare handles TLS termination externally; NPM sees plain HTTP on the LAN — acceptable because traffic is on the trusted 192.168.1.0/24 LAN)
  - Set custom Nginx directive: `proxy_read_timeout 300s` on the HypeReels proxy host to support SSE keep-alives and slow uploads
  - Set custom header: `add_header Strict-Transport-Security "max-age=31536000"` on the proxy host
  - Rate limiting: handled at the Fastify API layer (`@fastify/rate-limit`), since NPM's shared Nginx config cannot easily scope `limit_req_zone` per proxy host without advanced config
- **Interfaces:**
  - Exposes: `:443` / `:80` on 192.168.1.123 (shared with other NPM proxy hosts for thesquids.ink)
  - Proxies HypeReels traffic to: CT 113 Fastify at `192.168.1.136:3001`

### Cloudflare Zero Trust Tunnel (existing, on Quorra)

- **Purpose:** Secure external access to HypeReels without firewall port forwarding or self-signed certificates.
- **Technology:** Cloudflare-Tron container (`figro/unraid-cloudflared-tunnel`) — already running on Quorra, providing a Cloudflare Zero Trust tunnel that is active and connected.
- **Responsibilities (HypeReels addition):**
  - Add a new public hostname in the Cloudflare Zero Trust dashboard: `hypereels.thesquids.ink` → service `http://192.168.1.123` (CT 100, NPM on Case handles the rest)
  - Cloudflare handles TLS for external clients (full end-to-end TLS via Cloudflare origin certificate, or flexible mode for LAN-internal leg)
  - No router/firewall changes needed; the tunnel is outbound from Quorra to Cloudflare's edge
- **Interfaces:**
  - External: `https://hypereels.thesquids.ink` → Cloudflare edge → tunnel → 192.168.1.123 (NPM) → CT 113
  - LAN users can also access directly via `http://192.168.1.123` (NPM) if preferred

### API Server (Case LXC)

- **Purpose:** Single HTTP entry point for the browser. Handles session lifecycle, file upload ingestion, job dispatch, status delivery, and download proxying.
- **Technology:** Node.js 20 + Fastify 4 in an LXC container on Case.
- **Responsibilities:**
  - Create, resume, and invalidate sessions
  - Receive multipart file uploads and stream directly to MinIO (never buffer entire files in memory); use MinIO SDK (`@aws-sdk/client-s3` with custom endpoint) to PUT objects with presigned URLs or direct streaming
  - Validate file extensions, MIME types, and size limits on receipt (pre-queue check)
  - Enqueue jobs in BullMQ (validation, audio analysis, person detection, generation, cleanup)
  - Subscribe to Redis pub/sub channel for job status updates and push to browser via SSE
  - Serve MinIO presigned download URLs for the completed HypeReel
  - Expose `GET /sessions/:id/state` for session restoration on page reload (STORY-014)
  - Enforce session token on every request; return 404/410 on expired sessions
- **Interfaces:**
  - Exposes: REST API on `:3001` (see API Surface section)
  - Consumes: MinIO via AWS SDK v3 (S3-compatible), PostgreSQL via `pg`, Redis via `ioredis`, BullMQ

### Validation Worker (Case LXC or Quorra Docker)

- **Purpose:** Post-upload validation that cannot be done client-side (MIME sniffing, duration check, thumbnail extraction).
- **Technology:** Node.js 20 + `file-type` + `fluent-ffmpeg`.
- **Deployment:** Runs as a process inside the API Server LXC container on Case (same container, separate process), or as a lightweight LXC container. Does not need GPU or Python.
- **Responsibilities:**
  - Download the first 4 KB of the uploaded file from MinIO to detect true MIME type
  - Run `ffprobe` to extract video duration, codec, and stream metadata
  - Reject and delete clips exceeding 10 minutes or 2 GB; reject audio exceeding 10 minutes or 500 MB
  - Extract a first-frame JPEG thumbnail, upload to `thumbnails/{session_id}/{clip_id}.jpg` in MinIO
  - Update `clips.status` to `valid` or `invalid` with an error reason
  - Publish job result to Redis pub/sub
- **Interfaces:**
  - Consumes: BullMQ `validation` queue (Redis at `192.168.1.137:6379`), MinIO at `192.168.1.138:9000`, PostgreSQL at `192.168.1.100:7432`
  - Publishes: Redis `session:{id}:events` channel

### Audio Analysis Worker (Quorra Docker)

- **Purpose:** Extract musical structure from the uploaded audio track.
- **Technology:** Python 3.12 + librosa 0.10 + soundfile in a Docker container on Quorra.
- **Deployment:** Quorra Docker, CPU-only, no GPU required. Co-located on Quorra to avoid adding a Python container on Case; the CPU resources on Quorra (14 cores available alongside the GPU) are sufficient.
- **Responsibilities:**
  - Download audio file from MinIO (`192.168.1.138:9000`) to local `/tmp` on Quorra's NVMe cache (`/mnt/cache/hypereel-tmp`)
  - Decode to mono 22 050 Hz WAV using `soundfile` / `librosa.load`
  - Extract: BPM (via `librosa.beat.beat_track`), beat timestamps array, onset timestamps array, musical phrase boundaries (4-bar groups inferred from beat positions), amplitude envelope (RMS per 50 ms frame, downsampled to ~200 points for waveform visualisation)
  - Serialize results as JSON and persist to `audio_tracks.analysis_json`
  - Upload waveform SVG (precomputed path data) to `thumbnails/{session_id}/waveform.svg` in MinIO
  - Publish completion event to Redis
- **Interfaces:**
  - Receives: HTTP POST from the Node.js `audioAnalysisWorker` (BullMQ consumer in CT 113) at `POST /analyse-audio`
  - Reads: MinIO at `192.168.1.138:9000` (presigned URL provided in the HTTP request)
  - Returns: JSON result synchronously to the calling Node.js worker

### Person Detection Worker (Quorra Docker — CPU-only)

- **Purpose:** Detect all people in each video clip, generate face embeddings, and cluster cross-clip appearances.
- **Technology:** Python 3.12 + InsightFace (`buffalo_l` model) + OpenCV in a Docker container on Quorra. CPU-only mode; no `--gpus` flag (see ADR-013 for GPU contention rationale).
- **Deployment:** Quorra Docker, CPU-only. The GTX 1080 Ti is reserved exclusively for Frigate (home security NVR). InsightFace CPU inference on Quorra's host CPU yields ~30–60 seconds per clip-minute — acceptable for async batch processing.
- **InsightFace Model: buffalo_l**
  - Selected over `buffalo_s` because `buffalo_l` provides significantly better face recognition accuracy (RetinaFace + ArcFace backbone), which is critical for reliable cross-clip person clustering. The GTX 1080 Ti has ample VRAM; inference speed is not the bottleneck at 2fps frame sampling.
- **Frame Sampling Strategy:**
  - Sample one frame every 500 ms (2fps) using `cv2.VideoCapture` from a file downloaded to NVMe cache
  - This yields ~120 frames per minute of video — a reasonable balance between detection coverage and CPU utilisation
  - CPU-only mode: no GPU utilisation; concurrency limited to 1 detection job at a time to avoid saturating Quorra's CPU alongside other running services
- **Cross-Clip Person Clustering:**
  - InsightFace `buffalo_l` outputs a 512-dimensional ArcFace embedding per detected face
  - Within a clip: cluster nearby bounding boxes by IoU overlap across consecutive frames into per-frame "person tracks"
  - Across clips: store all unique face embeddings in a session-scoped in-memory embedding store (list of `{embedding, person_ref_id}`)
  - New face: compute cosine similarity against all stored embeddings; if max similarity >= **0.45** (ArcFace cosine threshold — faces from the same person cluster above this), assign existing `person_ref_id`; otherwise assign new UUID
  - A threshold of 0.45 is chosen because ArcFace cosine similarity for same-person pairs typically falls in 0.4–0.7; this minimises false merges (two different people treated as one) while tolerating lighting and angle variation
- **Responsibilities:**
  - Download clip from MinIO to `/mnt/cache/hypereel-tmp/{session_id}/{clip_id}.mp4`
  - Sample frames at 2fps; run `app.get` (InsightFace analysis) on each frame
  - Cluster faces within clip; deduplicate across clips using cosine similarity
  - For each unique person: select best-confidence frame crop, upload thumbnail to MinIO
  - Persist detection results to `person_detections` table: `person_ref_id`, `clip_id`, `thumbnail_url`, `confidence`, `appearances[]`
  - Delete local temp files in `finally` block
  - Publish `{type: 'detection-complete', clip_id, persons: [...]}` to Redis
- **Interfaces:**
  - Receives: HTTP POST from the Node.js `personDetectionWorker` (BullMQ consumer in CT 113) at `POST /detect-persons`
  - Reads: MinIO at `192.168.1.138:9000` (presigned clip URL provided in the HTTP request)
  - Returns: JSON result synchronously to the calling Node.js worker
- **Output contract (unchanged from previous Rekognition design):**
  ```json
  {
    "person_ref_id": "uuid",
    "clip_id": "uuid",
    "thumbnail_url": "https://case.local/thumbnails/{session_id}/persons/{person_ref_id}.jpg",
    "confidence": 0.92,
    "appearances": [
      { "start_ms": 1200, "end_ms": 4800, "bounding_box": { "left": 0.21, "top": 0.08, "width": 0.18, "height": 0.32 } }
    ]
  }
  ```

### HypeReel Assembly Worker (Quorra Docker)

- **Purpose:** Generate the final beat-synced HypeReel MP4 from clips, audio, person selection, and highlights.
- **Technology:** Python 3.12 + FFmpeg 6 (via `subprocess`) in a Docker container on Quorra.
- **Deployment:** Quorra Docker, CPU-only (FFmpeg x264 encode on Quorra's CPU). Co-located on Quorra with the detection worker to share the NVMe scratch cache for clip temp files, reducing redundant MinIO downloads when clips were already fetched for detection.
- **Responsibilities:**
  - Load session context from PostgreSQL: clips, highlights, selected person, audio analysis JSON
  - Run the moment selector algorithm:
    1. Build a scored moment list: person-of-interest appearances → score 1.0; highlight-marked segments → score 1.5; unconstrained clip segments → score 0.5
    2. Fill the song's duration with moments, prioritising by score, snapping cut points to the nearest beat timestamp from the analysis JSON
    3. Guarantee all highlight segments appear (trim to fit song duration if combined highlights exceed it)
  - Construct an Edit Decision List (EDL): `[{ clip_id, minio_key, start_ms, end_ms, transition: "cut" | "dissolve_200ms" }]`
  - Execute FFmpeg assembly pipeline (see Data Flow for detail)
  - Upload final MP4 to `generated/{session_id}/hypereel_{short_id}.mp4` in MinIO
  - Generate MinIO presigned GET URL (2-hour TTL)
  - Update `generation_jobs.status = 'complete'`, store `output_url`
  - Publish `{type: 'generation-complete', download_url}` to Redis
- **Interfaces:**
  - Receives: HTTP POST from the Node.js `assemblyWorker` (BullMQ consumer in CT 113) at `POST /assemble-reel`
  - Reads/Writes: MinIO at `192.168.1.138:9000` directly (credentials provided in the HTTP request payload)
  - Returns: JSON result (output key + metadata) synchronously to the calling Node.js worker

### Cleanup Worker (Case — API Server process)

- **Purpose:** Permanently delete all session assets and invalidate the session.
- **Technology:** Node.js 20 + AWS SDK v3 (S3-compatible MinIO client) in the API Server LXC container on Case.
- **Responsibilities:**
  - Accept a cleanup job (triggered by: download confirmation, "Done" click, 5-minute grace period expiry, 24-hour idle TTL, or "Start Over")
  - List all MinIO objects under `uploads/{session_id}/`, `generated/{session_id}/`, `thumbnails/{session_id}/`
  - Delete all MinIO objects in batches of 1 000 (S3 bulk delete API)
  - Hard-delete all PostgreSQL rows for the session (cascades via FK: session → clips, audio_tracks, person_detections, highlights, generation_jobs)
  - Mark session as `status = 'deleted'` last (so concurrent requests receive 410 Gone)
  - Retry failed deletions up to 3 times with exponential backoff; if all retries fail, write to `cleanup_failures` table and emit an error log alert
  - Write audit log entry: `{ session_id_hash: sha256(session_id), deleted_at, file_count }` — no PII
- **Interfaces:**
  - Consumes: BullMQ `cleanup` queue, MinIO at `192.168.1.138:9000`, PostgreSQL at `192.168.1.100:7432`
  - Publishes: nothing (terminal state)

### Frontend SPA

- **Purpose:** The seven-step user-facing wizard: Upload Clips → Upload Song → Select Person → Mark Highlights → Review → Generate → Download.
- **Technology:** React 18 + TypeScript + Vite + Zustand + Tailwind CSS + shadcn/ui.
- **Responsibilities:**
  - Bootstrap: on first load, call `POST /sessions`; store token in `localStorage`; on subsequent loads, call `GET /sessions/:id/state`
  - Detect duplicate tabs via `BroadcastChannel` API; display takeover warning (STORY-018)
  - Multi-file upload with per-file `XMLHttpRequest` progress events
  - Highlight scrubber: custom range-slider component; M:SS.SSS display; overlap merge logic client-side
  - Waveform display: render precomputed amplitude envelope as inline SVG `<polyline>`
  - SSE connection: `EventSource` to `GET /sessions/:id/events`; handle all event types
  - Step navigation: Zustand `stepStore`; collapses to "Step N of 7" below 768 px
  - Error boundary: React `ErrorBoundary` at root
  - Download: trigger via `<a href="{presigned_url}" download>` — streaming, no blob in memory
- **Interfaces:**
  - Consumes: REST API, SSE endpoint
  - Uses: `BroadcastChannel` for cross-tab coordination

---

## Data Flow

### Happy Path: Upload → Detect → Highlight → Generate → Download → Cleanup

```
1.  BROWSER lands on app
      → GET /  (SPA served by Vite build via Nginx on Case)
      → POST /sessions
         API creates session row (status='active'), returns { session_id, token }
         Browser stores token in localStorage

2.  USER selects video clips
      → POST /sessions/:id/clips  (multipart, one file per request)
         API streams bytes directly to MinIO: uploads/{session_id}/clips/{clip_id}.mp4
         API inserts clip row (status='uploading')
         API returns { clip_id }
         API enqueues BullMQ job: validation:{clip_id}

3.  VALIDATION WORKER picks up job (Case — Node.js process)
      → Downloads first 4 KB from MinIO; MIME-sniffs
      → Runs ffprobe: duration, codec check
      → On failure: updates clip.status='invalid', publishes error event
      → On success:
           Extracts first-frame JPEG → uploads to thumbnails/{session_id}/{clip_id}.jpg in MinIO
           Updates clip.status='valid', clip.thumbnail_url, clip.duration_ms
           Publishes {type:'clip-validated', clip_id} to Redis session channel

4.  BROWSER receives SSE clip-validated events
      → Updates clip list UI with thumbnail, duration, file size

5.  USER uploads audio track
      → POST /sessions/:id/audio  (multipart)
         API streams to MinIO: uploads/{session_id}/audio.{ext}
         API inserts audio_track row
         API enqueues BullMQ jobs: validation:{audio_id} AND audio-analysis:{audio_id}

6.  VALIDATION WORKER (audio)
      → MIME-sniff, duration check
      → On success: updates audio_track.status='valid'
      → Publishes audio-validated event

7.  AUDIO ANALYSIS WORKER picks up job (Quorra Docker — Python)
      → Downloads audio from MinIO to /mnt/cache/hypereel-tmp/{session_id}/audio.*
      → Runs librosa: BPM, beats[], onsets[], phrase_boundaries[], envelope[]
      → Stores JSON in audio_track.analysis_json
      → Uploads waveform SVG to MinIO thumbnails/{session_id}/waveform.svg
      → Updates audio_track.analysis_status='complete'
      → Publishes {type:'audio-analysed', bpm, waveform_url}
      → Cleans up /tmp files

8.  BROWSER receives audio-analysed event
      → Renders waveform SVG inline
      → Records audio duration for highlight constraint checks

9.  USER proceeds to person detection step
      → POST /sessions/:id/detect
         API enqueues person-detection job for each valid clip not yet detected

10. PERSON DETECTION WORKER picks up jobs (Quorra Docker — CPU-only)
      → Downloads clip from MinIO to /mnt/cache/hypereel-tmp/{session_id}/{clip_id}.mp4
      → Samples frames at 2fps using cv2.VideoCapture
      → Runs InsightFace buffalo_l on each frame batch
      → Clusters faces within clip (IoU dedup); clusters across clips (cosine sim >= 0.45)
      → Crops best-confidence face thumbnail per unique person
      → Uploads thumbnails to MinIO: thumbnails/{session_id}/persons/{person_ref_id}.jpg
      → Inserts person_detection rows into PostgreSQL
      → Updates clip.detection_status='complete'
      → Publishes {type:'detection-complete', clip_id, persons:[...]}
      → Cleans up /tmp files

11. BROWSER receives detection-complete events per clip
      → Renders person thumbnails as selectable cards
      → Groups same-person appearances across clips into merged card

12. USER selects person of interest (or skips)
      → PUT /sessions/:id/person-of-interest  { person_ref_id }
         API updates session.person_of_interest_id
         Returns 200

13. USER marks highlights per clip
      → PUT /sessions/:id/clips/:clip_id/highlights  { highlights: [{start_ms, end_ms}] }
         API upserts highlight rows
         Client-side: warns if total highlight duration > song duration

14. USER reviews and clicks "Generate HypeReel"
      → POST /sessions/:id/generate
         API validates: at least 1 clip valid, audio analysis complete
         API updates session.status='locked'
         API inserts generation_job row (status='queued')
         API enqueues BullMQ job: generation:{job_id}
         Returns { job_id }

15. ASSEMBLY WORKER picks up generation job (Quorra Docker — Python + FFmpeg)
      → Loads session: clips, highlights, person_of_interest, audio analysis JSON from PostgreSQL
      → Runs moment selector: scores moments, snaps to beats, constructs EDL
      → Downloads clips from MinIO to /mnt/disk-transfer/hypereel-tmp/{session_id}/
      → Runs FFmpeg pipeline:
           a. Trim each segment: ffmpeg -ss {start} -to {end} -i {input} -c copy /tmp/seg_{n}.mp4
           b. Write concat list file
           c. Concat all segments → /tmp/concat_{job_id}.mp4
           d. Mix audio + final encode:
              ffmpeg -i concat_{job_id}.mp4 -i audio.* \
                -map 0:v -map 1:a \
                -c:v libx264 -crf 20 -preset medium \
                -c:a aac -b:a 192k \
                -pix_fmt yuv420p -movflags +faststart \
                -vf "scale='min(1920,iw)':-2" \
                hypereel_{short_id}.mp4
      → Uploads output to MinIO: generated/{session_id}/hypereel_{short_id}.mp4
      → Generates MinIO presigned GET URL (2-hour TTL)
      → Updates generation_job.status='complete', output_url
      → Updates session.status='complete'
      → Publishes {type:'generation-complete', download_url}
      → Cleans up all /tmp files

16. BROWSER receives generation-complete SSE event
      → Navigates to Download step
      → Shows "Download HypeReel" button linked to MinIO presigned URL

17. USER clicks "Download HypeReel"
      → Browser follows MinIO presigned URL directly (no API proxy for large file)
      → MinIO streams MP4 directly to browser from storage_1tb pool on Case
      → API receives POST /sessions/:id/download-initiated
         Enqueues cleanup job with 5-minute delay in BullMQ

18. USER clicks "Done" (or 5-minute grace period elapses)
      → If "Done": POST /sessions/:id/done → enqueues immediate cleanup job
      → Cleanup worker runs

19. CLEANUP WORKER completes
      → All MinIO objects deleted (batched S3 DeleteObjects)
      → All DB rows deleted (FK cascade)
      → Session.status='deleted'
      → Any subsequent request with this token → 410 Gone
      → Browser shows "Your HypeReel has been deleted. Create a new one."
```

### Failure Recovery Flows

**Validation failure:** Worker publishes error event → SSE delivers to browser → clip marked failed with error label + Retry button → user can retry upload.

**Audio analysis failure:** Worker publishes failure → SSE delivers → user sees "couldn't analyse" banner → audio record deleted → user must re-upload audio.

**Generation failure:** Worker catches exception, sets `job.status='failed'`, publishes failure event → browser shows "Generation failed. Try again." with Start Over button → Start Over calls `DELETE /sessions/:id` → immediate cleanup enqueued.

**Session restoration (STORY-014):** Browser opens with stored token → `GET /sessions/:id/state` returns `{ status, current_step, ... }` → frontend Zustand store hydrates → user is routed to correct step.

**24-hour TTL cleanup:** A BullMQ repeatable job runs every hour on the API Server, queries PostgreSQL for `sessions WHERE status != 'deleted' AND last_activity_at < NOW() - INTERVAL '24 hours'`, and enqueues a cleanup job for each.

---

## Data Models

### `sessions`
```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
token         UUID UNIQUE NOT NULL DEFAULT gen_random_uuid()   -- presented to client
status        TEXT NOT NULL DEFAULT 'active'
              -- values: active | locked | complete | deleted
current_step  TEXT NOT NULL DEFAULT 'upload-clips'
              -- values: upload-clips | upload-audio | detect-persons |
              --         mark-highlights | review | generate | download
person_of_interest_id  UUID REFERENCES person_detections(id) ON DELETE SET NULL
created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
deleted_at    TIMESTAMPTZ
```

### `clips`
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
original_filename  TEXT NOT NULL
minio_key       TEXT NOT NULL   -- e.g. uploads/{session_id}/clips/{clip_id}.mp4
file_size_bytes BIGINT NOT NULL
duration_ms     INTEGER         -- null until validation complete
thumbnail_url   TEXT            -- presigned MinIO URL to thumbnails/ object
status          TEXT NOT NULL DEFAULT 'uploading'
                -- values: uploading | validating | valid | invalid
validation_error  TEXT
detection_status  TEXT NOT NULL DEFAULT 'pending'
                  -- values: pending | processing | complete | failed
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `audio_tracks`
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
original_filename  TEXT NOT NULL
minio_key       TEXT NOT NULL
file_size_bytes BIGINT NOT NULL
duration_ms     INTEGER
status          TEXT NOT NULL DEFAULT 'uploading'
                -- values: uploading | validating | valid | invalid
analysis_status TEXT NOT NULL DEFAULT 'pending'
                -- values: pending | processing | complete | failed
analysis_json   JSONB
                -- { bpm: float, beats: [ms,...], onsets: [ms,...],
                --   phrase_boundaries: [ms,...], envelope: [float,...] }
waveform_url    TEXT            -- presigned MinIO URL
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `person_detections`
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
clip_id         UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE
person_ref_id   UUID NOT NULL   -- stable cross-clip identity within session
thumbnail_url   TEXT NOT NULL   -- presigned MinIO URL to face crop
confidence      REAL NOT NULL   -- 0.0–1.0, from InsightFace det_score
appearances     JSONB NOT NULL
                -- [{ start_ms: int, end_ms: int,
                --    bounding_box: {left,top,width,height} }, ...]
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `highlights`
```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid()
session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
clip_id      UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE
start_ms     INTEGER NOT NULL
end_ms       INTEGER NOT NULL
CONSTRAINT highlights_duration CHECK (end_ms - start_ms >= 1000)
created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `generation_jobs`
```sql
id             UUID PRIMARY KEY DEFAULT gen_random_uuid()
session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
status         TEXT NOT NULL DEFAULT 'queued'
               -- values: queued | processing | rendering | complete | failed | cancelled
bullmq_job_id  TEXT
edl_json       JSONB   -- the final Edit Decision List used for assembly
output_minio_key  TEXT    -- generated/{session_id}/hypereel_{short_id}.mp4
output_url     TEXT    -- MinIO presigned download URL (2h TTL)
output_duration_ms  INTEGER
output_size_bytes   BIGINT
error_message  TEXT
started_at     TIMESTAMPTZ
completed_at   TIMESTAMPTZ
created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### `cleanup_failures`
```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid()
session_id   TEXT NOT NULL   -- stored as-is even after session row is deleted
minio_key    TEXT            -- the object that failed to delete
error        TEXT NOT NULL
attempt_count  INTEGER NOT NULL DEFAULT 1
created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
resolved_at  TIMESTAMPTZ
```

### EDL JSON Schema (internal contract between Assembly Worker and FFmpeg)
```json
{
  "session_id": "uuid",
  "audio_minio_key": "uploads/{session_id}/audio.mp3",
  "target_duration_ms": 214000,
  "segments": [
    {
      "clip_id": "uuid",
      "clip_minio_key": "uploads/{session_id}/clips/{clip_id}.mp4",
      "start_ms": 12300,
      "end_ms": 16100,
      "beat_aligned": true,
      "source": "highlight | person | filler",
      "transition": "cut"
    }
  ]
}
```

---

## API Surface

> Full OpenAPI specification is in `docs/api-spec.md`. Summary below.

### Sessions
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create anonymous session; returns `{session_id, token}` |
| GET | `/sessions/:id/state` | Get full session state for page-reload restoration |
| DELETE | `/sessions/:id` | Trigger immediate cleanup (Start Over) |
| GET | `/sessions/:id/events` | SSE stream for real-time job updates |

### Clips
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/clips` | Upload a clip (multipart); returns `{clip_id}` |
| GET | `/sessions/:id/clips` | List all clips with status, thumbnail, metadata |
| DELETE | `/sessions/:id/clips/:clip_id` | Delete a clip and its highlights |
| PUT | `/sessions/:id/clips/:clip_id/highlights` | Replace highlight list for a clip |

### Audio
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/audio` | Upload audio track; returns `{audio_id}` |
| DELETE | `/sessions/:id/audio` | Delete and replace (clears prior audio) |
| GET | `/sessions/:id/audio` | Get audio metadata + analysis status |

### Person Detection
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/detect` | Trigger detection jobs for all un-detected clips |
| GET | `/sessions/:id/persons` | Get all detected persons (grouped by `person_ref_id`) |
| PUT | `/sessions/:id/person-of-interest` | Set or clear person of interest `{person_ref_id\|null}` |

### Generation
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/generate` | Lock session and submit generation job |
| GET | `/sessions/:id/generate/:job_id` | Poll job status (fallback if SSE is unavailable) |
| DELETE | `/sessions/:id/generate/:job_id` | Cancel in-progress generation job |

### Download & Cleanup
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/download-initiated` | Signal download start; schedules 5-min cleanup |
| POST | `/sessions/:id/done` | User clicked Done; triggers immediate cleanup |

### SSE Event Types (on `GET /sessions/:id/events`)
```
clip-validated         { clip_id, thumbnail_url, duration_ms }
clip-validation-failed { clip_id, error }
audio-validated        { audio_id, duration_ms }
audio-analysed         { audio_id, bpm, waveform_url }
audio-analysis-failed  { audio_id, error }
detection-complete     { clip_id, persons: [{person_ref_id, thumbnail_url, confidence, appearances}] }
detection-failed       { clip_id, error }
generation-progress    { job_id, step: "analysing"|"selecting"|"sequencing"|"rendering"|"finalising", pct: 0-100 }
generation-complete    { job_id, download_url, duration_ms, size_bytes }
generation-failed      { job_id, error }
```

---

## Infrastructure & Deployment

### Network Topology

```
Internet
    │ Cloudflare Zero Trust Tunnel (existing Cloudflare-Tron on Quorra)
    ▼ routes hypereels.thesquids.ink → 192.168.1.123 (NPM) → 192.168.1.136:3001 (API)
192.168.1.0/24 LAN
├── 192.168.1.122  Case (Proxmox host, 9.1.5)
│   ├── CT 100  Nginx Proxy Manager — 192.168.1.123 :80/:443 (shared); web UI :81
│   │           HypeReels proxy host: hypereels.thesquids.ink → 192.168.1.136:3001
│   │           (CT 108 at 192.168.1.131 is RESERVED for ntfy — not available for HypeReels)
│   ├── CT 113  API LXC          — 192.168.1.136:3001
│   ├── CT 114  Redis LXC        — 192.168.1.137:6379
│   └── CT 115  MinIO LXC        — 192.168.1.138:9000,9001  (storage_1tb ZFS, 899 GB)
│
└── 192.168.1.100  Quorra (Unraid host)
    ├── Cloudflare-Tron           — outbound tunnel to Cloudflare edge (existing)
    ├── Frigate NVR               — GTX 1080 Ti GPU (home security; not shared with HypeReels)
    ├── FileFlows                 — GTX 1080 Ti NVENC (media transcoding; not shared with HypeReels)
    ├── hypereels-postgres Docker — postgres:18; host port 7432:5432; /mnt/user/appdata/hypereels-postgres
    ├── worker-detection Docker   — CPU-only; connects to 192.168.1.137:6379, 192.168.1.138:9000, 192.168.1.100:7432
    ├── worker-audio Docker       — connects to 192.168.1.137:6379, 192.168.1.138:9000
    └── worker-assembly Docker    — connects to 192.168.1.137:6379, 192.168.1.138:9000, 192.168.1.100:7432
```

LXC containers on Case each have direct static IPs on the 192.168.1.0/24 LAN (vmbr0 bridge). No NAT is required — Quorra workers connect directly to 192.168.1.137:6379 (Redis), 192.168.1.138:9000 (MinIO), and 192.168.1.100:7432 (PostgreSQL, same host). Redis uses password authentication (`requirepass` in redis.conf); MinIO uses access key + secret key credentials. PostgreSQL access is controlled by password authentication; Docker's bridge network binding on `0.0.0.0:7432` allows LAN connections without `pg_hba.conf` customisation.

### Environments

| Environment | API | Workers | DB | Redis | Storage |
|-------------|-----|---------|-----|-------|---------|
| Local dev | Docker Compose | Docker Compose | Postgres container | Redis container | MinIO container (local) |
| Production | Case LXC (Proxmox) | Quorra Docker | Quorra Docker PostgreSQL (hypereels-postgres, port 7432) | Case LXC Redis (CT 114, 192.168.1.137) | Case LXC MinIO (CT 115, storage_1tb) |

There is no staging environment for MVP. A developer laptop running Docker Compose with local MinIO, Redis, and Postgres containers serves as the full dev environment.

### Service Boundaries on Case (Proxmox LXC)

```
Case Proxmox 9.1.5 (192.168.1.122) — domain: thesquids.ink, public IP: 70.22.248.227
├── nginxproxymanager  (CT 100, 192.168.1.123, 2 cores, 4 GB, EXISTING shared — HypeReels adds one proxy host)
│   CT 108 at 192.168.1.131 RESERVED for ntfy (planned push notifications) — NOT available for HypeReels
├── lxc-api            (CT 113, 192.168.1.136:3001, 4 cores, 4 GB, Debian 12)
│   └── also runs: worker-validation, worker-cleanup (BullMQ consumers in same Node.js process)
├── lxc-redis          (CT 114, 192.168.1.137, 2 cores, 2 GB, Debian 12, vm_storage)
└── lxc-minio          (CT 115, 192.168.1.138, 4 cores, 8 GB, Debian 12, storage_1tb ZFS pool → /mnt/minio-data)
```

### Service Boundaries on Quorra (Unraid Docker)

```
Quorra Unraid (192.168.1.100)
├── hypereels-postgres (postgres:18, host port 7432:5432, data: /mnt/user/appdata/hypereels-postgres)
├── worker-detection   (Python 3.12 + InsightFace, CPU-only [no --gpus; GPU reserved for Frigate, FileFlows, and HypeReels per ADR-013], tmpfs: /mnt/cache/hypereel-tmp)
├── worker-audio       (Python 3.12 + librosa, CPU-only, tmpfs: /mnt/cache/hypereel-tmp)
└── worker-assembly    (Python 3.12 + FFmpeg, CPU-only, tmpfs: /mnt/disk-transfer/hypereel-tmp)
```

All Docker containers on Quorra have `restart: unless-stopped`. All LXC containers on Case have Proxmox autostart enabled.

### MinIO Lifecycle Policy (ILM Rule)

```
Rule name: session-ttl-safety-net
Filter: tag session_ttl = true
Action: Expiry after 2 days (48 hours)
Scope: bucket hypereel, all prefixes
```

Objects are tagged `session_ttl=true` at upload time by the API Server. This is the safety net; the Cleanup Worker performs primary deletion via S3 DeleteObjects calls immediately after the session ends.

### Scheduled Jobs

- **Stale session purge:** BullMQ repeatable job, every 60 minutes, queries for sessions idle > 24 hours, enqueues cleanup job for each
- **Cleanup failure alert:** BullMQ repeatable job, every 6 hours, queries `cleanup_failures` table for unresolved entries older than 1 hour, writes error log (operator to review)

---

## Performance Expectations

### InsightFace Person Detection (Quorra CPU — no GPU)

- Frame sampling: 2fps → ~120 frames/minute of source video
- `buffalo_l` CPU inference throughput: ~200–500ms per frame depending on Quorra's CPU
- **Expected latency:** 30–60 seconds per minute of source video (e.g., a 5-minute clip: 2.5–5 minutes detection time)
- This is acceptable because detection is an async background job and does not block the user (SSE progress events keep the user informed)
- GPU mode (via `--gpus all`) can be enabled in a future sprint if Frigate is migrated to a dedicated inference host or hardware — no application code changes required, only the Docker run flags (see ADR-013)

### Audio Analysis (librosa on Quorra CPU)

- librosa `beat_track` on a 3-minute audio file at 22 050 Hz: typically 8–15 seconds on a modern CPU
- Quorra's host CPU is sufficient for audio analysis; expected latency 10–20 seconds per audio track

### FFmpeg HypeReel Render (Quorra CPU)

- Input: several 1080p H.264 clips totalling 5–10 minutes of source material; output: 3-minute reel at CRF 20
- FFmpeg x264 `medium` preset on Quorra CPU (~14 available cores): approximately 2–4× realtime on 1080p
- **Expected render time:** 45–90 seconds for a typical 3-minute reel at 1080p

### Concurrent Session Capacity

- Case (Proxmox): API server + validation + cleanup are I/O-bound; can handle 10–20 concurrent sessions without saturation. PostgreSQL and Redis on 144 GB RAM / 24 threads: easily supports 20+ concurrent sessions.
- Quorra (CPU-only for HypeReels): InsightFace detection is CPU-bound (GTX 1080 Ti is reserved for Frigate and FileFlows per ADR-013); BullMQ `person-detection` concurrency is limited to 1. Assembly is also CPU-bound; 1–2 concurrent FFmpeg renders are feasible.
- **Practical limit for MVP:** 1–2 concurrent HypeReel generation jobs (bottleneck: CPU detection queue on Quorra). Upload, validation, and audio analysis can proceed concurrently for many more sessions. BullMQ queue depths handle burst traffic; jobs wait their turn without dropping.

---

## Security & Privacy

### Session Token Design

- Session token is a random UUIDv4 (128 bits of entropy), presented as a Bearer token in `Authorization: Bearer {token}` on all API requests
- Not a JWT — no decodeable payload; the server always validates against the `sessions` table
- Stored in `localStorage` (not a cookie, to avoid CSRF surface)
- Token is invalidated on download completion, "Done" action, or TTL expiry

### Signed URLs (MinIO Presigned)

- All MinIO object access from the browser goes through MinIO presigned URLs with short TTL:
  - Upload PUT URLs: 15-minute TTL (generated per upload request)
  - Thumbnails and waveform GET URLs: 1-hour TTL
  - Final download GET URL: 2-hour TTL
- The API never exposes raw MinIO bucket paths, access keys, or endpoint credentials to the browser
- Workers access MinIO directly using a dedicated MinIO service account (`access_key` / `secret_key`) stored as environment variables, never in code

### Upload Security

- File extension + MIME type validation at API layer before accepting the upload stream
- True MIME detection (magic bytes) in the Validation Worker as a second pass; files that pass the first check but fail the second are deleted from MinIO
- Maximum file sizes enforced at both API (`bodyLimit` in Fastify) and in the Validation Worker
- Filenames are never used as MinIO keys; all keys are generated from UUIDs — no path traversal risk

### Ephemeral Content Guarantees

- No user-uploaded data is written to persistent disk on any server outside of MinIO on the `storage_1tb` pool; all API and worker filesystem writes go to MinIO or ephemeral `/tmp` on the worker
- Worker `/tmp` dirs are explicitly cleaned in `finally` blocks after each job
- PostgreSQL rows are hard-deleted (not soft-deleted) by the Cleanup Worker; only `sessions.status = 'deleted'` remains briefly before the session row itself is deleted
- Audit log entries contain only a SHA-256 hash of the session ID — no filenames, no user-identifiable content
- No face embeddings or face collections are persisted beyond the scope of a single person-detection job; embeddings are held in process memory only and discarded when the worker process handles the next job

### Cross-Tab Protection (STORY-018)

- On page load, the SPA broadcasts `{type: 'session-check', token}` on `BroadcastChannel('hypereel')`
- Any other tab receiving this message and holding the same token replies with `{type: 'session-active'}`
- If a reply is received within 200 ms, the new tab shows the takeover warning
- Takeover recorded via `POST /sessions/:id/tab-takeover` (updates `last_activity_at`; otherwise a no-op)

### Transport Security

- External traffic: Cloudflare Zero Trust tunnel terminates TLS at Cloudflare's edge; traffic from edge → Case is proxied via the tunnel (encrypted in transit by the tunnel itself). No self-signed certificates required.
- LAN traffic: Nginx Proxy Manager (CT 100) handles HTTP→HTTPS redirect for any direct LAN access. NPM can issue a Let's Encrypt certificate for the HypeReels subdomain if needed for direct LAN HTTPS.
- HSTS: `Strict-Transport-Security: max-age=31536000` — set as a custom NPM response header on the HypeReels proxy host
- CORS: API allows only the SPA's origin (set via `CORS_ORIGIN` environment variable)
- Rate limiting: Fastify `@fastify/rate-limit` on the API layer: `POST /sessions` limited to 5/min per IP; upload endpoints limited to 20/min per session (NPM's shared Nginx config is not used for per-app rate limiting)
- Redis and PostgreSQL are not exposed beyond Case's internal vmbr0 network except for the specific LAN NAT rules required by Quorra workers; both services require authentication

### Data Residency

- All data (uploads, generated files, metadata) resides exclusively on on-premises hardware (Case and Quorra) in the operator's physical control. No data transits through any third-party cloud service.

---

## Monitoring & Observability

HypeReels integrates with the existing monitoring stack already running on Quorra rather than deploying new monitoring infrastructure.

### Existing Stack (Quorra — Unraid Docker)

Grafana, Prometheus, InfluxDB, Telegraf, cAdvisor, and pve-exporter are all currently running on Quorra and actively scraping Proxmox and Docker metrics. HypeReels is added to this existing stack.

### HypeReels Integration

**1. Prometheus metrics endpoint on the Fastify API (CT 113)**

The API Server exposes a `GET /metrics` endpoint using `prom-client` (the standard Node.js Prometheus client library):

```javascript
import { register, collectDefaultMetrics } from 'prom-client'
collectDefaultMetrics()
fastify.get('/metrics', async (req, reply) => {
  reply.type(register.contentType)
  return register.metrics()
})
```

Custom metrics to instrument:
- `hypereel_sessions_active` (gauge) — current active session count
- `hypereel_jobs_queued_total` (counter, label: `queue`) — jobs enqueued per queue
- `hypereel_jobs_completed_total` (counter, labels: `queue`, `status`) — completed/failed per queue
- `hypereel_job_duration_seconds` (histogram, label: `queue`) — processing latency per job type
- `hypereel_upload_bytes_total` (counter) — total bytes ingested
- `hypereel_minio_objects_total` (gauge) — current object count in MinIO (from MinIO healthcheck)

**2. Prometheus scrape config addition**

Add a new scrape job to the existing Prometheus config on Quorra:

```yaml
# prometheus.yml — add to scrape_configs:
- job_name: 'hypereel-api'
  static_configs:
    - targets: ['192.168.1.136:3001']
  metrics_path: '/metrics'
  scrape_interval: 30s
```

The `/metrics` endpoint is LAN-accessible (CT 113 via NAT or NPM) without authentication (acceptable for LAN-internal scraping; endpoint can be restricted to Quorra's IP via Fastify route guard if needed).

**3. Grafana dashboard**

Add a new "HypeReels" dashboard to the existing Grafana instance on Quorra with panels for:
- Active sessions over time
- Job queue depths (detection, audio, assembly, cleanup)
- Job success/failure rates per queue
- P50/P95 job duration per queue type
- Upload throughput (bytes/minute)
- MinIO storage utilisation (from MinIO's own metrics endpoint at CT 115 `192.168.1.138:9000/minio/health/live`)

**4. No new monitoring infrastructure**

Do NOT spin up new Grafana, Prometheus, or InfluxDB instances. All HypeReels observability is integrated into the existing Quorra monitoring stack.

---

## Architecture Decision Records (ADRs)

### ADR-001: MinIO over Cloudflare R2 for Object Storage

- **Status:** Accepted (supersedes previous ADR-001 for R2)
- **Context:** The MVP is constrained to self-hosted, on-premises infrastructure (STORY-020). Cloudflare R2 is a managed cloud service and is explicitly excluded. An S3-compatible self-hosted object store is needed to preserve the existing API patterns (presigned URLs, lifecycle policies, S3 SDK).
- **Decision:** Use MinIO in single-node mode on Case (CT 115, `storage_1tb` ZFS pool, 899 GB bind-mounted into the container). MinIO provides full S3-compatible API so the existing AWS SDK v3 integration in the API Server and workers requires only an endpoint URL change. Runs as an LXC container on Case. Presigned URLs and ILM lifecycle policies work identically to R2's equivalents. Note: `ISO_Storage` is a dir-type pool reserved for ISO images only and must NOT be used for MinIO or PostgreSQL data.
- **Consequences:** No egress fees (all traffic on LAN). No per-GB storage pricing. Operator is responsible for disk health monitoring on the underlying `storage_1tb` ZFS pool. Single-node MinIO has no redundancy; storage failure would lose in-flight session objects. Acceptable for MVP — sessions are ephemeral and short-lived.

---

### ADR-002: Server-Sent Events (SSE) instead of WebSockets

- **Status:** Accepted (unchanged from previous architecture)
- **Context:** The browser needs real-time updates on job progress. All progress communication is one-directional (server pushes job status to browser).
- **Decision:** Use SSE (`EventSource`). Simpler than WebSockets; no upgrade handshake; reconnects automatically; works through HTTP/1.1 and HTTP/2. Redis pub/sub feeds the SSE endpoint so the API Server can push events for any session without requiring sticky sessions.
- **Consequences:** Must handle SSE keep-alive pings every 30 seconds to prevent Nginx proxy timeouts (set `proxy_read_timeout 300s` in Nginx). SSE connections hold one open HTTP connection per active browser tab; Case's API Server LXC has sufficient file descriptor headroom.

---

### ADR-003: InsightFace (buffalo_l) over AWS Rekognition for Person Detection

- **Status:** Accepted (supersedes previous ADR-003 for Rekognition; updated for CPU-only mode per ADR-013)
- **Known issue:** The `workers/main.py` FastAPI `/detect-persons` HTTP endpoint (called by Node.js BullMQ workers via HTTP RPC) still references `_rek_client`, `_ensure_collection`, `search_face_in_collection`, and `index_face_in_collection` from the old Rekognition implementation. These functions do NOT exist in `workers/person_detection/person_detection_worker.py` (which uses InsightFace). The real worker logic is in `person_detection_worker.py`'s `detect_persons()` function. The HTTP entrypoint in `main.py` must be updated to call `detect_persons()` from `person_detection_worker.py` instead of the Rekognition functions. This is a **pre-production blocker** — person detection HTTP calls will fail at runtime.
- **Context:** AWS Rekognition is a managed cloud service and is explicitly excluded. A self-hosted face detection and recognition solution is required. Quorra has an NVIDIA GTX 1080 Ti but it is shared between Frigate, FileFlows, and HypeReels; CPU-only mode is required (see ADR-013).
- **Decision:** Use InsightFace with the `buffalo_l` model pack (RetinaFace detection + ArcFace recognition backbone) running in **CPU-only mode** on Quorra. `buffalo_l` is selected over `buffalo_s` because accuracy is more important than throughput at 2fps sampling — better ArcFace embeddings mean more reliable cross-clip person clustering with fewer false merges. Frame sampling at 2fps (one frame every 500 ms) is sufficient to detect all persons present in a clip.
- **Consequences:** No per-API-call cost. Full control over model and data. Face embeddings never leave the on-premises network. Detection latency (~30–60 seconds per clip-minute) is higher than GPU mode but fully acceptable given async job processing. Moving to GPU mode in a future sprint requires only adding `--gpus all` to the Docker run config — no application code changes.

---

### ADR-004: BullMQ + Redis for the Job Queue (self-hosted Redis)

- **Status:** Accepted (updated: Redis is now self-hosted on Case, not Upstash)
- **Context:** Async job processing is mandatory. The queue library (BullMQ) is unchanged; only the Redis backend changes from Upstash to self-hosted.
- **Decision:** Self-hosted Redis 7 in an LXC container on Case (CT 114, 192.168.1.137). Redis AOF persistence enabled for durability of queued jobs across restarts. BullMQ workers on Quorra connect to Redis at `192.168.1.137:6379` over the LAN with password authentication.
- **Consequences:** Operator must monitor Redis memory usage; with 2 GB RAM allocated to the Redis LXC and ephemeral queue depths (jobs complete in seconds to minutes), there is no risk of OOM under normal load. Redis is a single point of failure for the queue; Quorra workers will retry connection on disconnect. AOF ensures queued jobs survive a Case restart.

---

### ADR-005: PostgreSQL for Session/Job State (self-hosted on Quorra Docker)

- **Status:** Accepted (updated: PostgreSQL now runs as a Docker container on Quorra at host port 7432, not as a Case LXC)
- **Context:** Neon (managed PostgreSQL) is excluded. The relational data model (sessions → clips → highlights → jobs) is unchanged. Quorra already runs `homeassistant-postgres` (port 5432) and `nextcloud-postgres` (port 6432) using `postgres:18` Docker containers. HypeReels PostgreSQL is moved to Quorra to keep the three-LXC-on-Case model simpler and consistent with Quorra's existing Docker PostgreSQL pattern.
- **Decision:** Self-hosted PostgreSQL 18 as Docker container `hypereels-postgres` on Quorra (192.168.1.100), host port 7432 → container port 5432, data at `/mnt/user/appdata/hypereels-postgres`. The container is defined in `workers/docker-compose.workers.yml` alongside the Python workers. Connection string: `postgresql://hypereels:<PASSWORD>@192.168.1.100:7432/hypereels`. No `pg_hba.conf` customisation is needed — Docker bridge with `0.0.0.0:7432` binding accepts LAN connections; password auth is the access control. Connection pooling via `pg-pool` (max 10 for API, max 3 per worker type).
- **Consequences:** Operator manages schema migrations (idempotent SQL on first boot). Nightly `pg_dump` backup runs on Quorra (not via `pct exec`), storing to MinIO CT 115. The `hypereels-postgres` instance is isolated from `nextcloud-postgres` and `homeassistant-postgres` — separate container, separate data path, separate port. The Case `vm_storage` pool is no longer used for PostgreSQL data.

---

### ADR-006: Python Workers for AI/Media Processing (not Node.js)

- **Status:** Accepted (unchanged)
- **Context:** Audio analysis requires `librosa`; person detection requires InsightFace + OpenCV; video assembly requires FFmpeg subprocess calls. All are more natural in Python.
- **Decision:** Four worker types run as Python 3.12 Docker containers on Quorra: audio analysis, person detection, assembly. The validation and cleanup workers run in Node.js alongside the API Server on Case (no Python dependencies needed for those two).
- **Consequences:** Two runtimes (Node.js on Case, Python on Quorra). Python workers are FastAPI HTTP services — they do NOT consume BullMQ queues directly. Node.js BullMQ workers in CT 113 pick up jobs from Redis and call the Python FastAPI workers via HTTP POST (e.g. `POST /analyse-audio`, `POST /detect-persons`, `POST /assemble-reel`). This avoids the need for `python-bullmq` entirely and keeps the Python containers stateless HTTP services.
- **Known issue (pre-production blocker):** `workers/common/r2_client.py` is named for the old Cloudflare R2 storage and must be renamed to `workers/common/minio_client.py` (or re-exported as an alias). `workers/person_detection/person_detection_worker.py` already imports from `common.minio_client` (the correct future name), but the file itself is `r2_client.py`. This import will fail at runtime. Additionally, the env vars it reads (`R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) must map to the MinIO equivalents provided in `.env.workers`. The fix is: rename `r2_client.py` to `minio_client.py` (or add `minio_client.py` as a re-export shim) and update all remaining `r2_client` imports in `workers/main.py`, `workers/audio_analysis/audio_analysis_worker.py`, and `workers/assembly/assembly_worker.py`.

---

### ADR-007: Proxmox LXC over KVM VMs for API/Data Services on Case

- **Status:** Accepted
- **Context:** Case runs Proxmox VE. Services could be deployed as KVM VMs or LXC containers. Case has no GPU; all services are CPU/memory-bound.
- **Decision:** Use Proxmox LXC containers for all Case services (Nginx, API, Redis, PostgreSQL, MinIO). LXC containers share the host kernel, eliminating VM overhead (no hypervisor emulation, no guest OS boot). This reduces memory footprint per container by ~200–500 MB, leaves more RAM for PostgreSQL and MinIO buffers, and starts containers in seconds rather than tens of seconds. Isolation is sufficient for a trusted on-premises network.
- **Consequences:** LXC containers share the host kernel — a kernel panic on the host affects all containers simultaneously. Acceptable for single-operator MVP. No GPU passthrough is possible with LXC on Proxmox without significant configuration complexity; GPU workloads are all on Quorra anyway.

---

### ADR-008: Python Workers on Quorra, Not Case

- **Status:** Accepted (updated: InsightFace runs CPU-only per ADR-013; rationale for Quorra placement unchanged)
- **Context:** Case (Proxmox) has no compute GPU. Quorra (Unraid) has an NVIDIA GTX 1080 Ti, but it is reserved for Frigate (see ADR-013). Python workers can still run on Quorra in CPU-only mode to co-locate workloads and reduce LAN data movement.
- **Decision:** All Python ML/media workers (InsightFace detection, librosa audio analysis, FFmpeg assembly) run as Docker containers on Quorra. InsightFace runs CPU-only (no `--gpus` flag). Co-location on Quorra is still preferred over Case because (a) Case's Xeon is shared with Proxmox LXC overhead and DB workloads, and (b) worker temp files for clips already fetched for detection do not need to be re-downloaded for assembly. An alternative considered: running workers as Proxmox LXC containers on Case's Xeon (which has 24 threads free). This would give more predictable CPU allocation but would require cross-host MinIO downloads for every job. Quorra is retained as the worker host for MVP.
- **Consequences:** Quorra workers must connect to Case over the LAN for Redis (job queue) and MinIO (object storage). LAN latency (~0.1–0.3 ms) is negligible compared to job processing times. Large video files are transferred from MinIO on Case to Quorra worker `/tmp` once per job; at GbE speeds (~100 MB/s), a 1 GB clip transfers in ~10 seconds — acceptable for async processing.

---

### ADR-009: Single-Node MinIO over Distributed MinIO

- **Status:** Accepted
- **Context:** MinIO supports distributed (erasure-coded) mode across multiple nodes or drives. Case has six drives available.
- **Decision:** Single-node, single-pool MinIO (`storage_1tb` ZFS pool, 899 GB) for MVP. Distributed MinIO requires a minimum of 4 drives/nodes and adds configuration complexity (distributed startup, quorum requirements). For MVP with ephemeral, short-lived session files, the cost of a single-pool failure (loss of in-flight sessions only — no permanent user data) is acceptable. The 48-hour ILM safety-net deletion policy means the only risk is sessions that happen to be in-flight during a storage failure.
- **Consequences:** No data redundancy for MinIO objects. Operator should monitor underlying storage health of the `storage_1tb` ZFS pool. Expanding to erasure-coded multi-drive MinIO in a future sprint requires only remounting the data path and re-running `mc admin config` — no application code changes.

---

### ADR-010: UUID Session Tokens in localStorage (not HTTP-only Cookies)

- **Status:** Accepted (unchanged from previous architecture)
- **Context:** Sessions must persist across page refreshes and tab navigations. `sessionStorage` is ruled out because STORY-014 requires session restoration after tab close/reopen.
- **Decision:** `localStorage` with a UUID Bearer token sent in the `Authorization` header. HTTP-only cookies would work but introduce CSRF considerations. The SPA is a single origin; `localStorage` with a Bearer header is the pragmatic choice. XSS risk mitigated by React DOM escaping and a strict CSP.
- **Consequences:** CSP must be set: `default-src 'self'; script-src 'self'; connect-src 'self'`. The on-premises deployment has no CDN to configure CSP at the edge; Nginx sets the header directly.

---

### ADR-011: Fastify over Express for the API Server

- **Status:** Accepted (unchanged)
- **Context:** Node.js HTTP framework choice.
- **Decision:** Fastify. Schema validation on route definitions; native streaming for multipart upload forwarding to MinIO; ~2× faster than Express. NestJS is over-engineered for this use case.
- **Consequences:** Fastify's plugin/encapsulation model differs from Express middleware; engineers must learn it. `@fastify/multipart` handles file uploads; `@fastify/rate-limit` handles rate limiting.

---

### ADR-012: No Preview Before Download (MVP Constraint)

- **Status:** Accepted (unchanged)
- **Context:** In-browser preview is explicitly deferred (STORY-021).
- **Decision:** The generated MP4 is encoded with `-movflags +faststart` (moov atom at the front), which enables progressive streaming from MinIO if a future sprint adds an HTML5 `<video>` player using the presigned URL as the `src`. No architecture changes required for preview — frontend-only addition.
- **Consequences:** No HLS transcoding, no adaptive bitrate, no thumbnail strips for MVP.

---

### ADR-013: InsightFace CPU-Only Mode to Avoid GPU Contention with Frigate

- **Status:** Accepted
- **Context:** Quorra (Unraid, 192.168.1.100) hosts a NVIDIA GTX 1080 Ti (11 GB VRAM). Three workloads compete for this single GPU:
  1. **Frigate NVR** (`ghcr.io/blakeblackshear/frigate:stable`) — continuously-running home security application using the GPU for real-time object/person detection on security camera streams. Critical always-on service; missed detections = missed security events.
  2. **FileFlows** — media transcoding pipeline that uses NVENC (`--runtime=nvidia`). `autoStart=false` in Unraid but active whenever encoding jobs are running.
  3. **HypeReels InsightFace** — batch face detection and embedding inference for person detection worker.

  Giving any one service exclusive GPU access risks degrading the others. Frigate's `autoStart=false` in Unraid means it does not start automatically with the system, but it is actively running in the live environment.

  Four options were evaluated:
  - **Option A — InsightFace CPU-only:** InsightFace runs without GPU acceleration. Detection time increases from ~4–6s/clip-minute to ~30–60s/clip-minute. No GPU conflict possible.
  - **Option B — GPU time-slicing (NVIDIA MPS):** Frigate and InsightFace share the GPU using NVIDIA Multi-Process Service. Reduces both workloads' GPU throughput; complex to configure on Unraid; risk of MPS instability affecting the always-on Frigate security system.
  - **Option C — Job scheduling / GPU arbitration:** InsightFace jobs check GPU availability and wait if Frigate holds it. Requires a custom GPU lock daemon. Frigate's GPU usage is not idle between camera frames — it runs a continuous inference loop with near-100% GPU time during active periods.
  - **Option D — Use Frigate's existing detection results:** Frigate already detects persons in camera streams. However, Frigate only processes camera feeds (fixed RTSP streams), not arbitrary user-uploaded video files. HypeReels clips are unrelated to camera footage. Not viable.

  A fifth consideration: run InsightFace on Case's Proxmox Xeon CPU (in an LXC container) instead of Quorra. Case has 136 GB free RAM and a Xeon with 24 threads — adequate for CPU inference. However, this would require deploying Python worker LXC containers on Case in addition to the existing Node.js LXC stack, adding operational complexity for MVP. Quorra already runs Docker containers for all Python workers; keeping workers co-located on Quorra is simpler.

- **Decision:** **Option A — InsightFace CPU-only on Quorra.** Three services compete for the single GTX 1080 Ti: Frigate (home security NVR, always-on critical service), FileFlows (NVENC media transcoding), and HypeReels InsightFace. Frigate and FileFlows are critical infrastructure services; any architecture that risks degrading Frigate's real-time detection capability creates unacceptable operational risk (missed security events). CPU-only InsightFace on Quorra's host CPU yields ~30–60 seconds per clip-minute, which is fully acceptable for an async batch job where the user sees SSE progress updates. The GTX 1080 Ti remains available for Frigate and FileFlows.

- **Consequences:**
  - HypeReels person detection is slower than GPU mode but well within acceptable async latency bounds.
  - A 5-minute clip takes approximately 2.5–5 minutes of detection time — still shorter than the FFmpeg assembly step in most cases.
  - **Upgrade path:** If Frigate is migrated to a dedicated inference device (e.g., a Coral TPU, or a dedicated GPU in a future hardware addition) in a later sprint, enabling GPU mode for InsightFace requires only adding `--gpus all` to the `worker-detection` Docker run config. No application code changes are required. This upgrade can be done without any architecture revision.
  - Quorra's CPU specification is not fully documented here (unknown beyond being capable enough to run Plex transcoding, Palworld, Frigate, and a large Docker stack simultaneously). If CPU bottlenecks emerge under concurrent HypeReels sessions, the mitigation is to limit BullMQ `person-detection` queue concurrency to 1 (already the default) or move workers to Case's Xeon LXC as a future sprint item.

---

### ADR-014: Nginx Proxy Manager (CT 100) as Reverse Proxy — No New Nginx LXC

- **Status:** Accepted
- **Context:** The original architecture specified a new Nginx LXC for TLS termination. The live infrastructure shows Nginx Proxy Manager (CT 100, `nginxproxymanager`) already running on Case with 2 cores and 4 GB RAM, with a web UI at port 81. NPM is a shared service also used by other Case workloads.
- **Decision:** HypeReels does not create a new Nginx LXC. Instead, a new proxy host is added in the existing NPM web UI: domain `hypereels.thesquids.ink` → forward hostname `192.168.1.136` (CT 113), port `3001`, with HTTPS enabled. NPM handles TLS via its built-in Let's Encrypt integration or Cloudflare DNS challenge. Custom Nginx directives (`proxy_read_timeout 300s`, HSTS header) are applied at the proxy host level.
- **Consequences:** Saves a LXC container slot and eliminates duplicate Nginx configuration. NPM is a shared dependency — changes to CT 100 affect all proxy hosts. Operators must treat CT 100 as a shared infrastructure component and not modify it in ways that break other services. NPM's web UI (port 81) should be access-controlled (NPM has built-in authentication).

---

### ADR-015: Cloudflare Zero Trust Tunnel for External Access

- **Status:** Accepted
- **Context:** The original architecture specified self-signed certificates for a LAN-only MVP. The live infrastructure shows Cloudflare-Tron (`figro/unraid-cloudflared-tunnel`) already running on Quorra, providing an active Cloudflare Zero Trust tunnel used by other homelab services. External access to HypeReels can be added by registering a new hostname in the existing tunnel configuration.
- **Decision:** HypeReels external access is provided by adding `hypereels.thesquids.ink` as a public hostname in the existing Cloudflare Zero Trust tunnel, pointing to `http://192.168.1.123` (NPM on Case, CT 100). Cloudflare terminates TLS at the edge with a valid certificate; no firewall port forwarding is required; no self-signed certificate warning in the browser. This is strictly better than the self-signed cert approach at no additional infrastructure cost.
- **Consequences:** HypeReels has a dependency on the Cloudflare-Tron container on Quorra remaining running. If Quorra is offline, external access to HypeReels is unavailable (LAN access via direct IP remains functional). Cloudflare's free tier includes Zero Trust tunnels; no additional cost. All external traffic transits Cloudflare's network — consistent with the on-premises data residency policy because Cloudflare only proxies HTTP traffic in transit; all stored data remains on Case and Quorra.

---

### ADR-016: Static File Serving via @fastify/static

- **Status:** Accepted
- **Context:** No static file serving existed in any deployment profile. The README said "serve with any static file server" but provided no working path. Issue #9 blocked a real deployer who could not determine how to co-locate the SPA and API.
- **Decision:** `@fastify/static` serves the pre-built React SPA from `server/client-dist/` directly from the API process. `VITE_API_URL=""` is set at build time so the SPA uses relative URLs (same-origin). The static plugin is registered after all API routes so API routes take precedence. A SPA fallback `setNotFoundHandler` sends `index.html` for `GET` requests that include `text/html` in `Accept`, enabling React Router client-side routing. The `CLIENT_DIST_PATH` env var allows the dist path to be overridden per deployment. All three deployment profiles use this approach.
- **Consequences:** The SPA must be built and copied to `server/client-dist/` before production start (`VITE_API_URL="" npm run build && cp -r dist/ server/client-dist/`). The API process carries static assets (~50–150 MB) in memory-mapped files. No separate Nginx/Caddy is required solely for static serving (NPM on CT 100 still handles TLS termination and reverse-proxy to port 3001).

---

### ADR-017: systemd over PM2 for Process Management

- **Status:** Accepted
- **Context:** PM2's `env_file` option is silently ignored in `ecosystem.config.cjs` (issues #4, #7). The only working alternative in PM2 is to inline all environment variables directly in the config file, which is a security and maintenance regression — secrets visible in a checked-in or world-readable file.
- **Decision:** Native systemd unit (`server/hypereels-api.service`) with `EnvironmentFile=/opt/hypereels/app/.env` and `WorkingDirectory=/opt/hypereels/app/server` is the recommended production process manager for all bare-metal/LXC profiles (Profile 1: single Proxmox host, Profile 3: Production Case+Quorra). `systemctl enable --now hypereels-api` replaces `pm2 start`. Profile 2 (Unraid Docker Compose) uses Docker's native `env_file` directive. `ecosystem.config.cjs` is retained as a development convenience only with a prominent warning comment.
- **Consequences:** `systemctl start|stop|restart|status hypereels-api` replaces `pm2` commands. `journalctl -u hypereels-api -f` replaces `pm2 logs`. Logs are appended to `/var/log/hypereels/api.log` and `/var/log/hypereels/api-error.log` (the log directory must exist before service start). `LimitNOFILE=65536` prevents open-file exhaustion under load.

---

### ADR-018: Database Placement Per Deployment Profile

- **Status:** Accepted
- **Context:** Profile 3 (Production) has PostgreSQL running in a Docker container on Quorra (port 7432). Profile 1 (single Proxmox host, no Quorra) has no Quorra to target. Profile 2 (Unraid-only Docker Compose) needs a local DB. Each profile needs a clear, operable `DATABASE_URL`.
- **Decision:** Profile 1 (Proxmox LXC only): Install PostgreSQL natively via `apt` inside the API LXC (CT 113). Connection is loopback (`localhost:5432`), eliminating network latency and the Quorra dependency for a single-host deployment. Profile 2 (Docker Compose on Unraid): PostgreSQL as a `postgres:18` Docker Compose service on the same stack; `DATABASE_URL` uses the Docker service name. Profile 3 (Production — Case + Quorra): Docker container on Quorra at `192.168.1.100:7432` (unchanged).
- **Consequences:** `DATABASE_URL` differs per profile but all profiles use the same `.env` template (`.env.example`). Profile 1 requires `pg_createcluster` / `createuser` / `createdb` steps during initial provisioning. Profile 3 retains the existing Quorra container. The `waitForDatabase()` backoff (ADR-016 companion change, Fix 1 in the backend PR) handles transient connectivity failures at startup across all profiles.

---

> **Status (as of 2026-04-19):** All MVP implementation complete. All 5 PRs merged to main, all 8 GitHub issues closed.
> Frontend (React SPA), backend (Fastify API + BullMQ workers), and Python workers (librosa, InsightFace, FFmpeg) are fully implemented.
> Deployment docs: `docs/infrastructure.md` (Production/Profile 3), `docs/deployment/profile-1-cpu.md`, `docs/deployment/profile-2-gpu.md`.
