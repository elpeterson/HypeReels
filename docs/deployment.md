# HypeReels — Deployment Guide

> Supported profiles: **CPU-only** (default) and **NVIDIA GPU** (opt-in).
> One machine, one `docker-compose.yml`, two `.env` configurations.

---

## Prerequisites

### All hosts

- [Docker Engine](https://docs.docker.com/engine/install/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20+ (bundled with Docker Desktop)

### NVIDIA GPU hosts only

- NVIDIA driver 525+
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

> **AMD GPU / Apple Silicon:** CPU-only path is used automatically. ROCm and
> Apple Metal are not supported. No extra configuration is required.

---

## CPU-Only Quickstart

```bash
# 1. Clone the repository
git clone https://github.com/<owner>/hypereels.git
cd hypereels

# 2. Create your local .env file
cp .env.example .env
# Edit .env if you want to change credentials or ports

# 3. Build images then start all services
docker compose build
docker compose up -d

# 4. Verify all services are healthy (wait ~60 s after startup)
docker compose ps
# Expected: app, redis, minio all show "healthy"
```

The app is available at **http://localhost:3000**.

---

## NVIDIA GPU Quickstart

> **Linux only.** macOS and Windows Docker Desktop do not support GPU passthrough.
> Requires NVIDIA driver 525+ and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

```bash
# 1–3: Same as CPU-only above

# 4. Enable GPU acceleration in .env
echo "FFMPEG_HWACCEL=nvenc" >> .env
echo "INSIGHTFACE_PROVIDERS=CUDAExecutionProvider" >> .env

# 5. Build and start using the GPU override file
docker compose -f docker-compose.yml -f docker-compose.gpu.yml build
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# 6. Verify GPU is in use
docker compose logs app | grep -E "(CUDA|NVENC|CPUExecutionProvider)"
```

If CUDA is unavailable at runtime despite the env vars being set, the system
automatically falls back to x264 / CPUExecutionProvider and logs a warning.
No manual intervention is required.

---

## Environment Variables

See `.env.example` for the full list with descriptions. Key variables:

| Variable | Default | Description |
|---|---|---|
| `FFMPEG_HWACCEL` | _(empty)_ | Set to `nvenc` for NVIDIA hardware encoding |
| `INSIGHTFACE_PROVIDERS` | `CPUExecutionProvider` | Set to `CUDAExecutionProvider` for NVIDIA GPU detection |
| `MINIO_ROOT_USER` | `minioadmin` | MinIO admin username (change in production) |
| `MINIO_ROOT_PASSWORD` | `minioadmin` | MinIO admin password (change in production) |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3000` | Public URL; update for LAN or remote access |

---

## Health Check

```bash
# Check all service states
docker compose ps

# Check the application health endpoint
curl -sf http://localhost:3000/api/health | python3 -m json.tool

# Expected response
# {
#   "status": "ok",
#   "queue": "connected",
#   "storage": "connected"
# }
```

All services should report **healthy** within 60 seconds of `docker compose up`.

---

## Stopping and Restarting

```bash
# Stop all services (data is preserved in named volumes)
docker compose down

# Stop and remove all data (clean slate)
docker compose down -v

# Restart a single service
docker compose restart app
```

---

## Upgrading

```bash
# Pull latest code
git pull

# Rebuild and restart the app container
docker compose build app
docker compose up -d app
```

---

## Notes

- **Data persistence:** Redis and MinIO data are stored in Docker named volumes
  (`redis_data`, `minio_data`). They survive `docker compose down` but are
  removed by `docker compose down -v`.
- **Session TTL:** All user assets auto-delete within 2 hours via MinIO lifecycle
  policy and application-level cleanup jobs. No manual purge is needed.
- **Single-machine only:** Split-system and multi-host deployments are not
  supported. All services must run on one machine.
- **No login required:** Sessions are ephemeral UUID tokens stored in the browser.
