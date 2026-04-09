# HypeReels

HypeReels is a web application that automatically generates high-energy "hype reel" videos by intelligently combining user-uploaded video clips with a chosen song. Upload your clips, pick who to feature, mark the moments that matter, and HypeReels assembles a beat-synced highlight reel and delivers it as a downloadable MP4 — then permanently deletes everything. No accounts required.

The entire stack runs on two on-premises servers with no dependency on any managed cloud service.

---

## Table of Contents

1. [What is HypeReels](#1-what-is-hypereels)
2. [Architecture Overview](#2-architecture-overview)
3. [Prerequisites](#3-prerequisites)
4. [First-Time Setup](#4-first-time-setup)
5. [Environment Variables](#5-environment-variables)
6. [Running End-to-End (Verification)](#6-running-end-to-end-verification)
7. [Running Tests](#7-running-tests)
8. [Monitoring and Ops](#8-monitoring-and-ops)
9. [The Engineering Agent Pipeline](#9-the-engineering-agent-pipeline)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. What is HypeReels

HypeReels follows a six-step MVP flow:

1. **Upload** — Drop in one or more video clips (up to 2 GB each, 10 min max) and one audio track.
2. **Person Detection** — AI scans every clip with InsightFace (CPU-only on Quorra; see GPU contention note below) and surfaces detected people as thumbnail cards. The user selects one person of interest; the reel will prioritise moments featuring them.
3. **Highlight Selection** — Optionally scrub each clip's timeline and mark segments that *must* appear in the final reel. Everything outside a highlight is available for the AI to use or discard.
4. **Song Analysis** — The backend extracts BPM, beat timestamps, and a waveform envelope from the audio track using Python + librosa.
5. **HypeReel Generation** — An assembly worker scores moments, snaps cuts to beats, builds an FFmpeg edit-decision list (EDL), and renders the final H.264/AAC MP4.
6. **Download and Destroy** — The user downloads the completed HypeReel via a MinIO presigned URL. All uploaded assets and generated files are permanently deleted within five minutes of download confirmation.

There are no user accounts. A UUID session token (stored in `localStorage`) ties the browser to all server-side state for the duration of a single session.

---

## 2. Architecture Overview

Two physical servers communicate over a 192.168.1.0/24 LAN. All stateful services run as Proxmox LXC containers on Case. All Python ML workloads run as Docker containers on Quorra. All workers run CPU-only — the GTX 1080 Ti is shared between Frigate (home security NVR), FileFlows (NVENC media transcoding), and HypeReels InsightFace; see ADR-013 in `docs/architecture.md`.

```
Browser (React 18 SPA)
        |
        | HTTPS — Cloudflare Zero Trust Tunnel (existing, on Quorra)
        |         routes hypereels.thesquids.ink → 192.168.1.123 (NPM) → 192.168.1.136:3001 (API)
        v
+------------------------------------------------------------------+
|  CASE — Proxmox 9.1.5 (192.168.1.122)                           |
|                                                                  |
|  +------------------------------------+                          |
|  | Nginx Proxy Manager (CT 100)       |                          |
|  | 192.168.1.123 :80/:443 (shared)    |                          |
|  | Web UI: 192.168.1.123:81           |                          |
|  | HypeReels proxy host:              |                          |
|  |   hypereels.thesquids.ink          |                          |
|  |   → 192.168.1.136:3001             |                          |
|  |   Websockets: on, Force SSL: on    |                          |
|  | EXISTING shared container —        |                          |
|  | do NOT recreate                    |                          |
|  +------------------+-----------------+                          |
|                     |                                            |
|       +-------------v--------------+                             |
|       | API Server (CT 113)        |                             |
|       | Fastify / Node.js 20       |                             |
|       | 192.168.1.136:3001         |                             |
|       +-------------+--------------+                             |
|                     |                                            |
|       +-------------v--------------+                             |
|       | Redis (CT 114)             |                             |
|       | 192.168.1.137:6379         |                             |
|       | BullMQ queues + pub/sub    |                             |
|       +-------------+--------------+                             |
|                     |                                            |
|       +-------------v--------------+                             |
|       | MinIO (CT 115)             |                             |
|       | 192.168.1.138:9000 (S3)    |                             |
|       | 192.168.1.138:9001 (UI)    |                             |
|       | storage_1tb ZFS, 899 GB    |                             |
|       +-----------------------------+                            |
|                                                                  |
|  CT 108 at 192.168.1.131 is RESERVED for ntfy (planned push     |
|  notification server) — NOT available for HypeReels. This is    |
|  why HypeReels LXC containers start at CT 113.                  |
+------------------------------------------------------------------+
        |
        | LAN (192.168.1.0/24)
        | Workers connect to Redis, MinIO, and PostgreSQL on Case
        v
+------------------------------------------------------------------+
|  QUORRA — Unraid (192.168.1.100)                                 |
|                                                                  |
|  +---------------------------+   GPU: NVIDIA GTX 1080 Ti        |
|  | worker-detection          |   CPU-ONLY (no --gpus all)       |
|  | InsightFace buffalo_l     |   ADR-013: Three-way GPU         |
|  | port 8000 (health)        |   contention — Frigate NVR,      |
|  +---------------------------+   FileFlows NVENC, InsightFace   |
|                                  All run CPU-only (~30-60s/min) |
|  +---------------------------+                                  |
|  | worker-audio              |   CPU-only                      |
|  | librosa beat analysis     |   BullMQ consumer               |
|  +---------------------------+                                  |
|                                                                  |
|  +---------------------------+                                  |
|  | worker-assembly           |   CPU-only                      |
|  | FFmpeg video render       |   BullMQ consumer               |
|  +---------------------------+                                  |
|                                                                  |
|  +---------------------------+                                  |
|  | hypereels-postgres        |   postgres:18, port 7432:5432   |
|  | 192.168.1.100:7432        |   /mnt/user/appdata/            |
|  +---------------------------+   hypereels-postgres             |
|                                                                  |
|  All workers: pull jobs from Redis at 192.168.1.137:6379        |
|               read/write files from MinIO at 192.168.1.138:9000 |
|               read metadata from PostgreSQL 192.168.1.100:7432  |
+------------------------------------------------------------------+
```

### Service-to-IP Reference

| Service | Host | CT/Container | IP:Port | Notes |
|---------|------|-------------|---------|-------|
| Nginx Proxy Manager | Case (LXC) | CT 100 | 192.168.1.123:80/443, :81 | EXISTING shared — HypeReels adds one proxy host |
| Fastify API | Case (LXC) | CT 113 | 192.168.1.136:3001 | LAN only |
| Redis 7 | Case (LXC) | CT 114 | 192.168.1.137:6379 | LAN only |
| MinIO S3 API | Case (LXC) | CT 115 | 192.168.1.138:9000 | LAN only; storage_1tb ZFS, 899 GB |
| MinIO Console | Case (LXC) | CT 115 | 192.168.1.138:9001 | LAN ops access |
| PostgreSQL 18 | Quorra (Docker) | hypereels-postgres | 192.168.1.100:7432 | LAN only; /mnt/user/appdata/hypereels-postgres |
| Python Workers | Quorra (Docker) | — | 192.168.1.100:8000 | Health/admin endpoint; CPU-only |
| (Reserved) ntfy | Case (LXC) | CT 108 | 192.168.1.131 (planned) | NOT available for HypeReels |

---

## 3. Prerequisites

### On Case (Proxmox 192.168.1.122)

- Proxmox VE 9.1.5 installed and reachable at `https://192.168.1.122:8006`
- LXC template downloaded: `debian-12-standard` or `ubuntu-24.04-standard`
  - Download via Proxmox UI: Datacenter > case > local > CT Templates > Templates
- Bridge `vmbr0` configured (default Proxmox bridge is fine)
- Storage pools confirmed in Proxmox UI:
  - `storage_1tb` — ZFS, 899.25 GB (for MinIO CT 115 data bind mount)
  - `vm_storage` — ZFS, 431.26 GB (for API and Redis LXC root volumes)
  - `local` — LVM, 100 GB (OS boot only — do not use for data)
  - Do NOT use `ISO_Storage` (dir type, ISO images only) for MinIO or any data workload
- CT IDs 113–115 available for HypeReels (CT 108 is reserved for ntfy; PostgreSQL runs on Quorra Docker)

### On Quorra (Unraid 192.168.1.100)

- Unraid 7.2.2 with Docker support enabled
- NVIDIA GTX 1080 Ti present — verify it is accessible to host:

```bash
nvidia-smi
```

Expected output includes `GTX 1080 Ti`. Note: HypeReels workers run **CPU-only** and do NOT use the GPU. The GPU is shared between Frigate (home security NVR), FileFlows (NVENC media transcoding), and is not available to HypeReels InsightFace (ADR-013). Do NOT add `--gpus all` to the worker container.

- Existing Docker containers that must remain running: Frigate, FileFlows, Cloudflare-Tron tunnel

### On Your Developer Machine (Mac or Linux)

- Node.js 20+ (`node --version` should print `v20.x.x` or higher)
- Python 3.12+ (for local worker development only; not needed if running workers on Quorra)
- Git
- `ssh` access to both Case and Quorra

---

## 4. First-Time Setup

Work through these steps in order. Steps 1 and 2 are one-time provisioning. Steps 3 onward are repeatable.

### Step 1 — Clone the repo (developer machine)

```bash
git clone <repo-url> hypereels
cd hypereels
cp .env.example .env
```

Open `.env` and fill in the values described in [Section 5](#5-environment-variables) before proceeding.

---

### Step 2 — Create LXC containers on Case (Proxmox)

SSH into Case:

```bash
ssh root@192.168.1.122
```

**Important:** CT 108 (192.168.1.131) is RESERVED for ntfy (planned push notification server). Do not use CT 108 for HypeReels. HypeReels LXC containers start at CT 113.

No internal NAT subnet is required. All LXC containers get direct static IPs on the 192.168.1.0/24 LAN via vmbr0.

#### Container 113 — Fastify API

```bash
pct create 113 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname lxc-api \
  --cores 4 \
  --memory 4096 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.136/24,gw=192.168.1.1 \
  --rootfs vm_storage:8 \
  --unprivileged 1 \
  --start 1
```

#### Container 114 — Redis

```bash
pct create 114 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname lxc-redis \
  --cores 2 \
  --memory 2048 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.137/24,gw=192.168.1.1 \
  --rootfs vm_storage:4 \
  --unprivileged 1 \
  --start 1
```

#### Container 115 — MinIO

```bash
pct create 115 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname lxc-minio \
  --cores 4 \
  --memory 8192 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.138/24,gw=192.168.1.1 \
  --rootfs storage_1tb:8 \
  --unprivileged 1 \
  --start 1
```

Add the `storage_1tb` ZFS pool as a bind mount for MinIO object data:

```bash
# Create a ZFS dataset on storage_1tb for MinIO data
zfs create storage_1tb/minio-data

# Bind mount into the MinIO LXC
pct set 115 --mp0 /storage_1tb/minio-data,mp=/data
```

**Note:** Do NOT use `ISO_Storage` for MinIO data. `ISO_Storage` is a dir-type pool reserved for ISO images only and is not suitable for MinIO data workloads. Use `storage_1tb` (ZFS, 899 GB) for MinIO.

#### PostgreSQL — Quorra Docker (`hypereels-postgres`)

PostgreSQL does NOT run as an LXC on Case. It runs as a Docker container on Quorra, consistent with `homeassistant-postgres` and `nextcloud-postgres` already running there. See Step 4 for setup.

DATABASE_URL for all clients: `postgresql://hypereels:CHANGE_ME_PG_PASSWORD@192.168.1.100:7432/hypereels`

---

### Step 3 — Install and configure each service on Case

#### Redis (CT 114)

```bash
pct exec 114 -- bash -c "
  apt-get update && apt-get install -y redis-server &&
  sed -i 's/^bind 127.0.0.1.*/bind 192.168.1.137/' /etc/redis/redis.conf &&
  echo 'requirepass CHANGE_ME_REDIS_PASSWORD' >> /etc/redis/redis.conf &&
  systemctl enable redis-server &&
  systemctl start redis-server
"
```

Verify:

```bash
pct exec 114 -- redis-cli -h 192.168.1.137 -a CHANGE_ME_REDIS_PASSWORD ping
# PONG
```

#### MinIO (CT 115)

```bash
# Download the MinIO binary
pct exec 115 -- bash -c "
  apt-get update && apt-get install -y curl &&
  curl -fsSL https://dl.min.io/server/minio/release/linux-amd64/minio \
    -o /usr/local/bin/minio &&
  chmod +x /usr/local/bin/minio &&
  mkdir -p /data
"
```

Create a systemd unit for MinIO:

```bash
pct exec 115 -- bash -c "cat > /etc/systemd/system/minio.service << 'EOF'
[Unit]
Description=MinIO Object Storage
After=network.target

[Service]
User=root
Environment=MINIO_ROOT_USER=CHANGE_ME_MINIO_USER
Environment=MINIO_ROOT_PASSWORD=CHANGE_ME_MINIO_PASSWORD
ExecStart=/usr/local/bin/minio server /data --console-address :9001 --address 192.168.1.138:9000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload &&
systemctl enable minio &&
systemctl start minio"
```

Create the `hypereel` bucket and set a lifecycle policy (TTL safety net):

```bash
# Install the MinIO client (mc) on CT 115
pct exec 115 -- bash -c "
  curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc &&
  chmod +x /usr/local/bin/mc &&
  mc alias set local http://192.168.1.138:9000 CHANGE_ME_MINIO_USER CHANGE_ME_MINIO_PASSWORD &&
  mc mb --ignore-existing local/hypereel
"

# Apply a 48-hour ILM expiry to objects tagged session_ttl=true
pct exec 115 -- bash -c "
mc ilm rule add \
  --expiry-days 2 \
  --tags 'session_ttl=true' \
  local/hypereel
"
```

MinIO Console (port 9001) is directly accessible at `http://192.168.1.138:9001` — no NAT or port forwarding required since CT 115 has a direct LAN IP.

#### Fastify API (CT 113)

Copy the server source to the API LXC:

```bash
# From the repo root on your developer machine:
scp -r server/ root@192.168.1.122:/tmp/hypereels-server

# On Case, push into the LXC:
pct exec 113 -- mkdir -p /opt/hypereels
# Copy from Case host into the container filesystem
cp -r /tmp/hypereels-server/* /var/lib/lxc/113/rootfs/opt/hypereels/
```

Install Node.js 20 and dependencies inside CT 113:

```bash
pct exec 113 -- bash -c "
  apt-get update &&
  apt-get install -y curl ca-certificates &&
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &&
  apt-get install -y nodejs &&
  cd /opt/hypereels &&
  npm install --omit=dev
"
```

Create `/opt/hypereels/.env` inside CT 113 with the production values (see [Section 5](#5-environment-variables)).

Install PM2 and start the API:

```bash
pct exec 113 -- bash -c "
  npm install -g pm2 &&
  cd /opt/hypereels &&
  pm2 start dist/index.js --name hypereels-api &&
  pm2 save &&
  pm2 startup systemd
"
```

Alternatively, use the production Docker image from the `server/Dockerfile` prod stage:

```bash
# Build on developer machine, push to a registry or copy tarball to Case
docker build -t hypereels-api:latest --target prod ./server
```

#### Nginx Proxy Manager (CT 100) — existing shared container

CT 100 (Nginx Proxy Manager) is already running at 192.168.1.123. Do NOT create a new Nginx LXC. Instead, add a single proxy host entry in the NPM web UI.

Open `http://192.168.1.123:81` in your browser and log in to the NPM admin UI. Then add a new Proxy Host:

```
# Nginx Proxy Manager Setup (http://192.168.1.123:81)
# Add a new Proxy Host:
#   Domain Names:        hypereels.thesquids.ink
#   Forward Hostname/IP: 192.168.1.136
#   Forward Port:        3001
#   Cache Assets:        off
#   Block Common Exploits: on
#   Websockets Support:  on  (required for SSE)
#   SSL Tab: Request new Let's Encrypt certificate
#   Force SSL: enabled
#   HTTP/2 Support: enabled
```

After saving, add the following custom Nginx configuration to the proxy host (Advanced tab):

```nginx
proxy_read_timeout 300s;
proxy_send_timeout 300s;
client_max_body_size 2048m;
add_header Strict-Transport-Security "max-age=31536000" always;
```

This is the only change required to CT 100. Do not modify any other NPM proxy hosts or the NPM container itself.

---

### Step 4 — Set up PostgreSQL and Python workers on Quorra

SSH into Quorra:

```bash
ssh root@192.168.1.100
```

#### PostgreSQL Docker (`hypereels-postgres`)

PostgreSQL runs as a Docker container on Quorra alongside the Python workers. The compose definition is in `workers/docker-compose.workers.yml`.

```bash
# Create the data directory
mkdir -p /mnt/user/appdata/hypereels-postgres
```

Start it after deploying the compose file (see below):

```bash
docker-compose -f docker-compose.workers.yml --env-file .env.workers up -d hypereels-postgres
sleep 10
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels
# /var/run/postgresql:5432 - accepting connections
```

Apply the schema (run from CT 113 or developer machine with psql access):

```bash
psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/server/src/db/schema.sql
```

Copy the workers directory to Quorra from your developer machine:

```bash
scp -r workers/ root@192.168.1.100:/mnt/user/appdata/hypereels-workers/
```

Build the workers Docker image:

```bash
ssh root@192.168.1.100 "
  cd /mnt/user/appdata/hypereels-workers &&
  docker build -t hypereels-workers:latest .
"
```

Run the workers container (CPU-only — do NOT add --gpus all):

```bash
# CPU-only per ADR-013: GTX 1080 Ti is shared by Frigate (NVR), FileFlows (NVENC
# transcoding), and HypeReels InsightFace. Running --gpus all would degrade
# Frigate and FileFlows. InsightFace CPU-only yields ~30-60s/clip-minute,
# acceptable for async batch processing.
docker run -d \
  --name hypereels-workers \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /mnt/cache/hypereel-tmp:/tmp/hypereels \
  -e DATABASE_URL="postgresql://hypereels:CHANGE_ME_PG_PASSWORD@192.168.1.100:7432/hypereels?sslmode=disable" \
  -e DATABASE_SSL="false" \
  -e REDIS_URL="redis://:CHANGE_ME_REDIS_PASSWORD@192.168.1.137:6379" \
  -e R2_ENDPOINT="http://192.168.1.138:9000" \
  -e R2_ACCESS_KEY_ID="CHANGE_ME_MINIO_USER" \
  -e R2_SECRET_ACCESS_KEY="CHANGE_ME_MINIO_PASSWORD" \
  -e R2_BUCKET="hypereel" \
  -e R2_ACCOUNT_ID="local" \
  -e R2_PUBLIC_URL="http://192.168.1.138:9000/hypereel" \
  -e PYTHON_WORKER_URL="http://192.168.1.100:8000" \
  -e PORT="8000" \
  -e FFMPEG_PATH="/usr/bin/ffmpeg" \
  hypereels-workers:latest
```

Verify the worker is healthy:

```bash
curl http://192.168.1.100:8000/health
# {"status":"ok","service":"hypereels-python-worker"}
```

> **InsightFace model download:** On first run, the worker downloads the `buffalo_l` model pack (~500 MB) from the InsightFace CDN to `~/.insightface/models/buffalo_l/`. This requires internet access from Quorra. If Quorra cannot reach the internet, see [Troubleshooting](#10-troubleshooting).

---

### Step 5 — Frontend (developer machine)

Install dependencies and start the Vite dev server:

```bash
# From the repo root
npm install
npm run dev
# Vite dev server starts at http://localhost:5173
```

The frontend expects the API at `https://hypereels.thesquids.ink` (or the direct LAN IP for dev). Confirm this is set in your `.env`:

```
VITE_API_URL=https://hypereels.thesquids.ink
```

For direct LAN access (bypassing NPM/Cloudflare tunnel):

```
VITE_API_URL=http://192.168.1.136:3001
```

If you access the UI from a browser on a different machine, replace `localhost:5173` with the developer machine's LAN IP.

To build the frontend for production and serve it via the API (or a separate static host):

```bash
npm run build
# Output in dist/ — serve with any static file server or copy into the Nginx LXC
```

---

### Step 6 — Run database migrations

From the `server/` directory on your developer machine, pointing at Quorra (PostgreSQL Docker):

```bash
cd server
DATABASE_URL="postgresql://hypereels:CHANGE_ME_PG_PASSWORD@192.168.1.100:7432/hypereels?sslmode=disable" \
  npm run db:migrate
```

This applies `server/src/db/schema.sql` to the PostgreSQL instance on Case. The command is idempotent — safe to re-run after schema changes.

---

### Step 7 — Smoke test

After all services are running, verify each layer:

```bash
# 1. API health (direct LAN)
curl http://192.168.1.136:3001/health
# {"status":"ok"}

# 2. API health (via NPM + domain)
curl https://hypereels.thesquids.ink/health
# {"status":"ok"}

# 3. Python workers health (from within the LAN)
curl http://192.168.1.100:8000/health
# {"status":"ok","service":"hypereels-python-worker"}

# 4. Redis connectivity (from developer machine on LAN)
redis-cli -h 192.168.1.137 -a CHANGE_ME_REDIS_PASSWORD ping
# PONG

# 5. PostgreSQL connectivity (Quorra Docker, port 7432)
psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels -c "SELECT NOW();"

# 6. MinIO Console
# Open http://192.168.1.138:9001 in your browser
# Log in with your MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# Confirm the "hypereel" bucket exists

# 7. UI
# Open http://localhost:5173 in your browser (dev server) or https://hypereels.thesquids.ink
# The HypeReels upload wizard should load
```

---

## 5. Environment Variables

Copy `.env.example` to `.env` and fill in every value before running locally or deploying.

Values marked **SET BY OPERATOR** have no safe default — you must choose and store these securely (e.g., a password manager or Ansible Vault).

### Database

| Variable | On-Prem Value | Notes |
|----------|--------------|-------|
| `DATABASE_URL` | `postgresql://hypereels:YOUR_PG_PASSWORD@192.168.1.100:7432/hypereels?sslmode=disable` | SET BY OPERATOR (password); Quorra Docker hypereels-postgres, port 7432 |
| `DATABASE_SSL` | `false` | LAN-only; no TLS needed between LXC containers |

### Redis

| Variable | On-Prem Value | Notes |
|----------|--------------|-------|
| `REDIS_URL` | `redis://:YOUR_REDIS_PASSWORD@192.168.1.137:6379` | SET BY OPERATOR (password); CT 114 direct LAN IP |

### Object Storage (MinIO)

The project uses the `R2_*` variable names from the original design — these point at MinIO, which provides a fully S3-compatible API. No Cloudflare account is needed.

| Variable | On-Prem Value | Notes |
|----------|--------------|-------|
| `R2_ACCOUNT_ID` | `local` | Static string for self-hosted MinIO |
| `R2_ENDPOINT` | `http://192.168.1.138:9000` | MinIO S3 API; CT 115 direct LAN IP (storage_1tb ZFS pool) |
| `R2_ACCESS_KEY_ID` | `CHANGE_ME_MINIO_USER` | SET BY OPERATOR — MinIO root user |
| `R2_SECRET_ACCESS_KEY` | `CHANGE_ME_MINIO_PASSWORD` | SET BY OPERATOR — MinIO root password |
| `R2_BUCKET` | `hypereel` | Bucket name (created in Step 3) |
| `R2_PUBLIC_URL` | `http://192.168.1.138:9000/hypereel` | Used for thumbnail/waveform browser URLs |

### App Config

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3001` | Fastify listen port inside LXC |
| `HOST` | `0.0.0.0` | Bind all interfaces inside LXC |
| `NODE_ENV` | `production` | Set to `development` for verbose logs + pretty print |
| `LOG_LEVEL` | `info` | Pino log level: `trace` `debug` `info` `warn` `error` `fatal` |
| `CORS_ORIGIN` | `http://localhost:5173` | Set to the LAN IP of the developer machine when testing from another device |
| `SESSION_TTL_HOURS` | `24` | Hours before an idle session is auto-purged |
| `CLEANUP_GRACE_PERIOD_MINUTES` | `5` | Minutes after download before cleanup fires |

### Service URLs

| Variable | On-Prem Value | Notes |
|----------|--------------|-------|
| `PYTHON_WORKER_URL` | `http://192.168.1.100:8000` | Python worker FastAPI service on Quorra |
| `PYTHON_TIMEOUT_MS` | `300000` | 5 minutes; assembly jobs may take longer — overridden in code |

### Frontend (Vite)

| Variable | On-Prem Value | Notes |
|----------|--------------|-------|
| `VITE_API_URL` | `https://hypereels.thesquids.ink` | Base URL the browser uses to reach the API (via NPM + Cloudflare tunnel); use `http://192.168.1.136:3001` for direct LAN dev access |

---

## 6. Running End-to-End (Verification)

This walkthrough exercises the full MVP flow to confirm all six steps work correctly.

### Generate test media

Create a synthetic 10-second colour-bar test video:

```bash
ffmpeg -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:duration=10 \
  -c:v libx264 -c:a aac \
  /tmp/test-clip.mp4
```

Create a synthetic 30-second sine-wave audio track:

```bash
ffmpeg -f lavfi -i sine=frequency=120:duration=30 \
  -c:a libmp3lame -q:a 2 \
  /tmp/test-audio.mp3
```

### Walkthrough

1. Open `http://localhost:5173` in your browser.

2. **Upload Clips** — Click "Add clips", select `/tmp/test-clip.mp4`. Watch the progress bar reach 100%. The clip thumbnail should appear.

3. **Upload Song** — Select `/tmp/test-audio.mp3`. The waveform SVG should render once the audio analysis job completes (a few seconds).

4. **Person Detection** — The worker on Quorra processes the clip at 2fps. Because the test clip is a colour-bar pattern with no faces, you will see "No people detected" — this is correct. In a real clip with faces, thumbnail cards for each detected person appear here. Select one.

5. **Highlight Selection** — Drag the scrubber handles on the test clip to mark a highlight range. Click "Confirm highlights".

6. **Review and Generate** — Review the summary screen. Click "Generate HypeReel". The SSE progress bar shows `queued → processing → complete`.

7. **Download** — Click "Download". The browser downloads the MP4 via the MinIO presigned URL.

8. **Verify cleanup** — Open `http://192.168.1.138:9001` (MinIO Console, CT 115). Log in with your MinIO credentials. Navigate to the `hypereel` bucket. Confirm that all objects for the session's `session_id` prefix have been deleted within a minute of the download completing.

---

## 7. Running Tests

### Frontend (Vitest + Testing Library)

```bash
# From the repo root
npm test                  # run all tests once
npm run test:ui           # Vitest interactive browser UI
npm run test:coverage     # coverage report (uses @vitest/coverage-v8)
```

### Backend API (Vitest)

```bash
cd server
npm test                  # vitest run (single pass)
npm run test:watch        # watch mode
npm run typecheck         # tsc --noEmit (type check without compiling)
```

### Python Workers (pytest)

```bash
cd workers
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest tests/ -v
```

To run Python tests against the live services on Case (integration mode), set the environment variables before running pytest:

```bash
DATABASE_URL="postgresql://hypereels:YOUR_PG_PASSWORD@192.168.1.100:7432/hypereels?sslmode=disable" \
  REDIS_URL="redis://:YOUR_REDIS_PASSWORD@192.168.1.137:6379" \
  R2_ENDPOINT="http://192.168.1.138:9000" \
  R2_ACCESS_KEY_ID="YOUR_MINIO_USER" \
  R2_SECRET_ACCESS_KEY="YOUR_MINIO_PASSWORD" \
  pytest tests/ -v -m integration
```

### Integration Smoke Test

After all services are running, a quick end-to-end check:

```bash
# Create a session
curl -X POST https://hypereels.thesquids.ink/sessions | jq .
# Or direct LAN:
curl -X POST http://192.168.1.136:3001/sessions | jq .

# Health checks
curl https://hypereels.thesquids.ink/health
curl http://192.168.1.100:8000/health
```

---

## 8. Monitoring and Ops

### MinIO Console

```
URL:  http://192.168.1.138:9001
User: <MINIO_ROOT_USER>
Pass: <MINIO_ROOT_PASSWORD>
```

Browse the `hypereel` bucket, inspect lifecycle rules, and monitor storage usage. After a completed session, all objects under `uploads/{session_id}/`, `generated/{session_id}/`, and `thumbnails/{session_id}/` should be absent.

### PostgreSQL

Connect directly from any machine on the LAN:

```bash
psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels
```

Useful queries:

```sql
-- Active sessions
SELECT id, status, created_at FROM sessions WHERE status = 'active';

-- Stuck jobs
SELECT id, queue, status, attempts, failed_reason
  FROM generation_jobs WHERE status NOT IN ('complete', 'cleanup') ORDER BY created_at;

-- Cleanup audit log
SELECT * FROM cleanup_audit ORDER BY deleted_at DESC LIMIT 20;
```

### Redis

```bash
# Ping
redis-cli -h 192.168.1.137 -a YOUR_REDIS_PASSWORD ping

# Inspect BullMQ queues
redis-cli -h 192.168.1.137 -a YOUR_REDIS_PASSWORD
> KEYS bull:*
> LLEN bull:person-detection:wait
> LLEN bull:audio-analysis:wait
> LLEN bull:generation:wait
```

To inspect stuck or failed jobs in detail, use [Bull Board](https://github.com/felixmosh/bull-board) — a BullMQ UI — which can be added as a route in the Fastify API.

### GPU Utilisation on Quorra

HypeReels workers run CPU-only (ADR-013). The GPU is used exclusively by Frigate and FileFlows. Monitor the GPU to ensure no HypeReels container is unexpectedly claiming it:

```bash
ssh root@192.168.1.100

# Live GPU utilisation — should show Frigate/FileFlows but NOT hypereels-workers
nvidia-smi dmon -s u

# Full status
nvidia-smi

# Verify hypereels-workers container has no GPU access
docker inspect hypereels-workers | grep -i gpu
# Should return empty — no DeviceRequests for GPU

# Container CPU/memory usage
docker stats hypereels-workers
```

### API Logs

```bash
# If running with PM2 inside CT 113
pct exec 113 -- pm2 logs hypereels-api --lines 100

# If running as a Docker container on Case
docker logs hypereels-api -f
```

### Worker Logs (Quorra)

```bash
ssh root@192.168.1.100
docker logs hypereels-workers -f --tail 100
```

---

## 9. The Engineering Agent Pipeline

HypeReels development uses seven specialised Claude Code agents that collaborate in a sequential pipeline. The architecture is entirely self-hosted — no cloud service accounts are required to develop or extend the application.

| Step | Agent | When to Invoke | Primary Output |
|------|-------|---------------|----------------|
| 1 | `@product-owner` | New feature request or sprint kickoff | `docs/user-stories.md` |
| 2 | `@architect` | After user stories are finalised | `docs/architecture.md` |
| 3 | `@frontend-engineer` | After architecture is ready | UI components + pages |
| 4 | `@backend-engineer` | After architecture is ready | APIs + business logic |
| 5 | `@ai-ml-engineer` | After architecture is ready | ML pipelines + processing jobs |
| 6 | `@qa-engineer` | After implementation is complete | `docs/test-plan.md` + tests |
| 7 | `@devops-engineer` | After QA sign-off | `docs/infrastructure.md` + CI/CD |

Steps 3, 4, and 5 can run in parallel once the architecture is ready.

To kick off a full sprint from a feature description, use the `/sprint` command in Claude Code:

```
/sprint Add multi-clip highlight scrubbing with time-range validation
```

Each agent's persona and instructions live in `.claude/agents/`. The artifact files in `docs/` are the canonical source of truth for design decisions.

| File | Owner Agent |
|------|-------------|
| `docs/user-stories.md` | `@product-owner` |
| `docs/architecture.md` | `@architect` |
| `docs/api-spec.md` | `@backend-engineer` |
| `docs/test-plan.md` | `@qa-engineer` |
| `docs/infrastructure.md` | `@devops-engineer` |

---

## 10. Troubleshooting

### Quorra workers cannot reach Case services

**Symptom:** Worker logs show `Connection refused` or timeout errors when connecting to `192.168.1.137:6379` (Redis), `192.168.1.138:9000` (MinIO), or `192.168.1.100:7432` (PostgreSQL).

**Cause:** LXC containers on Case use direct static IPs on the 192.168.1.0/24 LAN (vmbr0 bridge). No NAT is involved. If Quorra workers cannot reach these IPs, the likely causes are:
1. The target LXC container is not running — check Proxmox UI.
2. A firewall rule on Case or Quorra is blocking the port.
3. The LXC container is listening on the wrong IP (check `redis.conf`, `postgresql.conf`, MinIO systemd unit).

**Fix:**

```bash
# From Quorra — test connectivity
nc -zv 192.168.1.137 6379   # Redis (Case CT 114)
nc -zv 192.168.1.138 9000   # MinIO (Case CT 115)
nc -zv 192.168.1.100 7432   # PostgreSQL (Quorra Docker)

# Check LXC containers are running on Case
ssh root@192.168.1.122 "pct list"

# Verify Redis is listening on correct IP (inside CT 114)
pct exec 114 -- redis-cli -h 192.168.1.137 -a YOUR_REDIS_PASSWORD ping

# Verify PostgreSQL Docker is running on Quorra
docker ps --filter name=hypereels-postgres
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels
```

Also verify no firewall on Quorra is blocking outbound connections to the 192.168.1.0/24 subnet.

---

### InsightFace model download fails

**Symptom:** Worker container exits with `InsightFaceError: model download failed` or hangs indefinitely on first start.

**Cause:** Quorra cannot reach the InsightFace CDN (`github.com` or `huggingface.co`) — common when Unraid's outbound internet access is blocked or the docker container has no DNS.

**Fix — download the model manually and mount it:**

```bash
# On a machine with internet access
pip install insightface
python -c "import insightface; app = insightface.app.FaceAnalysis(name='buffalo_l'); app.prepare(ctx_id=0)"
# Model is saved to ~/.insightface/models/buffalo_l/

# Copy to Quorra
scp -r ~/.insightface/models/buffalo_l/ root@192.168.1.100:/mnt/user/appdata/insightface-models/

# Add bind mount to the docker run command:
# -v /mnt/user/appdata/insightface-models:/root/.insightface/models
```

---

### MinIO bucket not found on startup

**Symptom:** API or worker logs show `NoSuchBucket: The specified bucket does not exist` for bucket `hypereel`.

**Cause:** The MinIO LXC restarted and the bucket was not re-created, or the `/data` bind mount from `sdc` was not re-attached.

**Fix:**

```bash
# Verify the storage_1tb ZFS dataset bind mount is active inside CT 114
pct exec 114 -- df -h /data

# If not mounted, check the ZFS dataset exists and re-attach
zfs list storage_1tb/minio-data
pct set 114 --mp0 /storage_1tb/minio-data,mp=/data
pct reboot 114

# Re-create the bucket if missing
pct exec 114 -- mc alias set local http://192.168.1.137:9000 MINIO_USER MINIO_PASSWORD
pct exec 114 -- mc mb --ignore-existing local/hypereel
```

---

### GPU not detected in Docker container on Quorra

**Symptom:** `docker run --gpus all ...` fails with `Error response from daemon: could not select device driver "" with capabilities: [[gpu]]`.

**Cause:** The NVIDIA Container Toolkit is not installed or the Docker daemon is not configured to use it.

**Fix:**

1. In Unraid, go to Apps and search for "NVIDIA Driver". Install the NVIDIA Driver plugin.
2. After installation, reboot Quorra.
3. Verify the runtime appears:

```bash
docker info | grep -i runtime
# Runtimes: io.containerd.runc.v2 nvidia runc
```

4. If still missing, install the toolkit manually:

```bash
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list \
  | tee /etc/apt/sources.list.d/nvidia-docker.list
apt-get update && apt-get install -y nvidia-container-toolkit
systemctl restart docker
```

---

### LXC container cannot reach the internet for package installation

**Symptom:** `apt-get update` inside an LXC container fails with `Temporary failure resolving 'deb.debian.org'`.

**Cause:** The `vmbr0` bridge does not have NAT/masquerade configured, so outbound traffic from LXC containers cannot reach the internet. HypeReels LXC containers have direct 192.168.1.0/24 IPs, but they still need masquerade for internet access (package installs, MinIO binary download, etc.).

**Fix on Case host:**

```bash
# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf

# Add masquerade rule for LXC containers going out through Case's default NIC
# Replace eth0 with Case's actual WAN-facing interface if different
iptables -t nat -A POSTROUTING -s 192.168.1.0/24 ! -d 192.168.1.0/24 -j MASQUERADE

# Persist
netfilter-persistent save
```

Also ensure the LXC container has the correct nameserver:

```bash
pct exec <CT_ID> -- bash -c "echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
```

---

### API returns 404 or 410 for all requests after restart

**Symptom:** Every API call returns `{"statusCode":404,"error":"Session not found"}` or `410 Gone` immediately after services restart.

**Cause:** Redis was restarted and lost in-memory session keys (if persistence was not enabled), or PostgreSQL data was not persisted.

**Fix:**

1. Verify the PostgreSQL ZFS bind mount is still active inside CT 114:
   ```bash
   pct exec 114 -- df -h /var/lib/postgresql
   # Should show /vm_storage/pgsql-data or similar
   ```

2. Check Redis persistence is configured (`appendonly yes` or `save 60 1` in `redis.conf`). If Redis was started without persistence, session keys may be lost and users must start new sessions.

3. Ensure session rows still exist in PostgreSQL:
   ```bash
   psql -h 192.168.1.137 -U hypereels -d hypereels -c "SELECT COUNT(*) FROM sessions;"
   ```

---

## Project Structure

```
hypereels/
├── index.html                  # Vite HTML entry point
├── vite.config.ts              # Vite config — dev server port 5173, /api proxy
├── tsconfig.json               # Frontend TypeScript config
├── package.json                # Frontend dependencies (React 18, Zustand, Radix UI, Tailwind)
├── tailwind.config.ts          # Tailwind CSS config
├── postcss.config.js
├── docker-compose.yml          # Local dev stack (all services in Docker — not for production)
├── .env.example                # All environment variable definitions with descriptions
│
├── src/                        # React SPA (frontend)
│   ├── main.tsx
│   ├── App.tsx
│   ├── types.ts
│   ├── pages/                  # One page per wizard step
│   ├── components/             # Reusable UI components
│   ├── api/                    # Axios API client functions
│   ├── hooks/                  # Custom React hooks (SSE, upload, etc.)
│   ├── store/                  # Zustand global state
│   └── lib/                    # Shared utilities
│
├── server/                     # Node.js Fastify API
│   ├── Dockerfile              # Multi-stage: dev (tsx watch) / build / prod
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── routes/             # Sessions, clips, audio, persons, highlights, generation, download
│       ├── workers/            # BullMQ worker processes
│       ├── jobs/               # BullMQ queue definitions
│       ├── middleware/
│       ├── lib/                # redis.ts, sse.ts, minio.ts
│       └── db/                 # schema.sql, migrate.ts, client.ts
│
├── workers/                    # Python FastAPI workers
│   ├── Dockerfile              # python:3.12-slim-bookworm + FFmpeg 6
│   ├── requirements.txt
│   ├── main.py                 # FastAPI app — HTTP endpoints + BullMQ job consumers
│   ├── audio_analysis/         # librosa BPM/beat/onset extraction
│   ├── assembly/               # EDL construction + FFmpeg render pipeline
│   ├── person_detection/       # Frame sampling + InsightFace inference
│   ├── common/                 # Shared utilities (MinIO client, structured logging)
│   └── tests/                  # pytest test suite
│
└── docs/                       # Agent-owned architecture artifacts
    ├── user-stories.md
    ├── architecture.md
    ├── api-spec.md
    ├── test-plan.md
    └── infrastructure.md
```

> **Note on `docker-compose.yml`:** The compose file is retained for local development convenience (runs all services on a single developer machine). It is not used in production — production runs LXC containers on Case and Docker containers on Quorra as described in this README.
