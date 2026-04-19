# Profile 2 — GPU-Enabled (Single Machine)

> **Deployment overview:** All HypeReels services run as Docker containers in a single `docker-compose.yml` on one machine. An NVIDIA GPU is **optional** — InsightFace automatically falls back to CPU inference if no GPU is detected. GPU passthrough to the worker container uses the NVIDIA Container Runtime.

---

> ### Reference Implementation
>
> **Quorra** (Unraid host, NVIDIA GTX 1080 Ti): Unraid 7.2.2, NVIDIA Container Runtime via Unraid NVIDIA plugin.
> The instructions below are written generically for any self-hoster with a Docker-capable Linux machine. Quorra-specific paths appear only here.
>
> | Container | Unraid data path |
> |-----------|-----------------|
> | PostgreSQL | `/mnt/user/appdata/hypereels-postgres` |
> | MinIO | `/mnt/user/appdata/hypereels-minio` |
> | Worker temp | `/mnt/cache/appdata/hypereels/tmp` |
>
> Replace all `<PLACEHOLDER>` values with your own paths when following the guide below.

---

## Hardware Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| CPU | 4 cores / 8 threads at 2.0 GHz | 8+ cores |
| RAM | 16 GB | 32 GB |
| Storage — OS + services | 30 GB SSD | 50 GB NVMe |
| Storage — data volume (MinIO) | 200 GB | 500 GB+ |
| Network | Static IP or DHCP reservation | Gigabit LAN |
| GPU | None required (CPU fallback) | NVIDIA with 4+ GB VRAM |

**Required software:**
- Docker Engine 24+ with Docker Compose v2
- `nvidia-container-toolkit` (if using GPU acceleration)

> **GPU is optional.** If no NVIDIA GPU is present, or if `nvidia-container-toolkit` is not installed, InsightFace falls back to `CPUExecutionProvider` automatically. You do not need to modify any configuration — the fallback is handled in the worker's startup code. The only difference between GPU and CPU mode is InsightFace inference speed.

---

## 1. Install Docker Engine

```bash
# Debian / Ubuntu
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker
docker run --rm hello-world
```

---

## 2. NVIDIA Container Toolkit Setup (GPU Only)

Skip this section if you are running CPU-only.

### Generic Linux (non-Unraid)

```bash
# Add NVIDIA Container Toolkit repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

apt-get update
apt-get install -y nvidia-container-toolkit

# Configure Docker to use the NVIDIA runtime
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker
```

### Unraid

1. In Unraid, go to **Apps** (Community Applications plugin required)
2. Search for **NVIDIA Driver**
3. Install the NVIDIA Driver plugin
4. Reboot Unraid after installation

### Verify GPU passthrough works

```bash
# Confirm nvidia-smi works on the host
nvidia-smi

# Confirm Docker GPU passthrough works
docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi
# Should show the same GPU info

# Confirm the NVIDIA runtime is registered
docker info | grep -i runtime
# Should include: nvidia
```

---

## 3. Clone the Repo

```bash
mkdir -p /opt/hypereels
git clone https://github.com/<ORG>/hypereels.git /opt/hypereels/app
cd /opt/hypereels/app
```

> **Unraid path:** `mkdir -p /mnt/user/appdata/hypereels && git clone https://github.com/<ORG>/hypereels.git /mnt/user/appdata/hypereels`

---

## 4. Configure Environment Files

```bash
# ── Main .env — API and shared config ─────────────────────────────────────────
cat > /opt/hypereels/app/.env << 'EOF'
# ── Database (Docker service name) ────────────────────────────────────────────
DATABASE_URL=postgresql://hypereels:<POSTGRES_PASSWORD>@hypereels-postgres:5432/hypereels
DATABASE_SSL=false

# ── Redis (Docker service name) ───────────────────────────────────────────────
REDIS_URL=redis://:<REDIS_PASSWORD>@hypereels-redis:6379
REDIS_PASSWORD=<REDIS_PASSWORD>

# ── MinIO ─────────────────────────────────────────────────────────────────────
# Internal endpoint uses Docker service name
MINIO_ENDPOINT=http://hypereels-minio:9000
MINIO_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
MINIO_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
MINIO_BUCKET=hypereels
# Public URL must use the HOST IP — presigned URLs are resolved by the browser,
# which is outside the Docker network.
MINIO_PUBLIC_URL=http://<HOST_IP>:9000/hypereels

# Legacy R2_* aliases — mirrors MINIO_* above
R2_ENDPOINT=http://hypereels-minio:9000
R2_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
R2_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
R2_BUCKET=hypereels
R2_ACCOUNT_ID=local
R2_PUBLIC_URL=http://<HOST_IP>:9000/hypereels

# ── API server ────────────────────────────────────────────────────────────────
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=https://<YOUR_DOMAIN>

# ── Python workers ────────────────────────────────────────────────────────────
PYTHON_WORKER_URL=http://hypereels-worker:8000
PYTHON_TIMEOUT_MS=300000
PYTHON_WORKER_AUDIO_TIMEOUT_MS=300000
PYTHON_WORKER_ASSEMBLY_TIMEOUT_MS=900000

# ── InsightFace — GPU with automatic CPU fallback ─────────────────────────────
# When GPU is available: CUDAExecutionProvider is tried first.
# When GPU is unavailable: CPUExecutionProvider is used automatically.
# No manual change is needed — the worker handles the fallback internally.
INSIGHTFACE_MODEL=buffalo_l
INSIGHTFACE_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
INSIGHTFACE_COSINE_THRESHOLD=0.45

# ── FFmpeg ────────────────────────────────────────────────────────────────────
FFMPEG_CRF=20
FFMPEG_PRESET=fast
FFMPEG_MAX_WIDTH=1920
# Set FFMPEG_HWACCEL=nvenc to enable NVIDIA NVENC hardware encoding.
# Requires a GPU with NVENC support (GTX 1060 or newer). Falls back to x264 if not set.
# FFMPEG_HWACCEL=nvenc

# ── Session & upload limits ───────────────────────────────────────────────────
SESSION_TTL_HOURS=24
CLEANUP_GRACE_PERIOD_MINUTES=5
MAX_CLIPS_PER_SESSION=10
MAX_CLIP_DURATION_MS=300000
MAX_CLIP_SIZE_BYTES=500000000
MAX_AUDIO_DURATION_MS=600000
GENERATION_TIMEOUT_MS=900000

# ── Prometheus metrics ────────────────────────────────────────────────────────
METRICS_PATH=/metrics
EOF
chmod 600 /opt/hypereels/app/.env

# ── PostgreSQL container env ───────────────────────────────────────────────────
cat > /opt/hypereels/app/.env.postgres << 'EOF'
POSTGRES_DB=hypereels
POSTGRES_USER=hypereels
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
EOF
chmod 600 /opt/hypereels/app/.env.postgres

# ── Redis container env ────────────────────────────────────────────────────────
cat > /opt/hypereels/app/.env.redis << 'EOF'
REDIS_PASSWORD=<REDIS_PASSWORD>
EOF
chmod 600 /opt/hypereels/app/.env.redis

# ── MinIO container env ────────────────────────────────────────────────────────
cat > /opt/hypereels/app/.env.minio << 'EOF'
MINIO_ROOT_USER=<MINIO_ROOT_USER>
MINIO_ROOT_PASSWORD=<MINIO_ROOT_PASSWORD>
EOF
chmod 600 /opt/hypereels/app/.env.minio
```

**Generate strong passwords:**
```bash
openssl rand -base64 32  # run once per secret
```

---

## 5. Build the SPA

```bash
cd /opt/hypereels/app/client
npm install
npm run build
# Copy output to API's static serving directory
cp -r dist ../server/client-dist
```

---

## 6. docker-compose.yml

This file includes GPU passthrough for the worker. If you are running CPU-only (no GPU or `nvidia-container-toolkit` not installed), remove or comment out the `deploy` section in the `worker` service — everything else stays the same.

```yaml
services:

  # ── API + SPA ────────────────────────────────────────────────────────────────
  api:
    image: hypereels-api:latest
    build:
      context: .
      dockerfile: server/Dockerfile
    container_name: hypereels-api
    restart: unless-stopped
    ports:
      - "3001:3001"
    env_file:
      - .env
    volumes:
      - ./server/client-dist:/app/client-dist:ro
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    networks:
      - hypereels

  # ── PostgreSQL ────────────────────────────────────────────────────────────────
  postgres:
    image: postgres:18
    container_name: hypereels-postgres
    restart: unless-stopped
    env_file:
      - .env.postgres
    volumes:
      - /opt/hypereels/data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hypereels -d hypereels"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - hypereels

  # ── Redis ─────────────────────────────────────────────────────────────────────
  redis:
    image: redis:7-alpine
    container_name: hypereels-redis
    restart: unless-stopped
    command: >
      redis-server
      --requirepass ${REDIS_PASSWORD}
      --appendonly yes
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
    env_file:
      - .env.redis
    volumes:
      - hypereels-redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - hypereels

  # ── MinIO ─────────────────────────────────────────────────────────────────────
  minio:
    image: minio/minio:latest
    container_name: hypereels-minio
    restart: unless-stopped
    command: server /data --console-address :9001
    env_file:
      - .env.minio
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - /opt/hypereels/data/minio:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - hypereels

  # ── Python Worker (GPU-enabled with CPU fallback) ─────────────────────────────
  worker:
    image: hypereels-worker:latest
    build:
      context: .
      dockerfile: workers/Dockerfile
    container_name: hypereels-worker
    restart: unless-stopped
    ports:
      - "8000:8000"
    env_file:
      - .env
    environment:
      - PORT=8000
      - FFMPEG_PATH=/usr/bin/ffmpeg
    volumes:
      - /tmp/hypereels:/tmp/hypereels
    # GPU passthrough — remove this 'deploy' section to force CPU-only mode
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    networks:
      - hypereels

networks:
  hypereels:
    driver: bridge

volumes:
  hypereels-redis-data:
```

> **Unraid data paths:** Replace `/opt/hypereels/data/postgres` with `/mnt/user/appdata/hypereels-postgres`, `/opt/hypereels/data/minio` with `/mnt/user/appdata/hypereels-minio`, and `/tmp/hypereels` with `/mnt/cache/appdata/hypereels/tmp`.

**To run CPU-only (remove GPU passthrough):** Delete or comment out the `deploy` block in the `worker` service. InsightFace will use `CPUExecutionProvider` because `INSIGHTFACE_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider` — CUDA is tried first, fails gracefully, and CPU is used. No other changes needed.

**To check for GPU contention:** If another container on your machine uses the GPU 24/7 (e.g., a home security NVR), InsightFace may fall back to CPU when that container holds an exclusive lock. To avoid any contention, remove the `deploy` section — CPU-only mode guarantees no GPU scheduling conflicts.

---

## 7. Start Services

```bash
cd /opt/hypereels/app

# Build images
docker compose build

# Start all services
docker compose up -d

# Check status
docker compose ps
```

### Run migrations (first boot only)

```bash
# Wait for PostgreSQL to be healthy, then apply schema migrations
for f in \
  server/src/db/migrations/001_initial_schema.sql \
  server/src/db/migrations/002_rename_r2_key_to_minio_key.sql \
  server/src/db/migrations/003_add_clip_validation.sql
do
  echo "Applying $f ..."
  docker exec -i hypereels-postgres psql -U hypereels -d hypereels < "$f"
done

# Verify tables exist
docker exec hypereels-postgres psql -U hypereels -d hypereels -c "\dt"
```

### Create MinIO bucket and lifecycle rule

```bash
source /opt/hypereels/app/.env.minio

docker exec hypereels-minio mc alias set local http://localhost:9000 \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
docker exec hypereels-minio mc mb --ignore-existing local/hypereels
docker exec hypereels-minio mc ilm rule add local/hypereels \
  --expire-days 2 --tags "session_ttl=true"
docker exec hypereels-minio mc ilm rule ls local/hypereels
```

---

## 8. Reverse Proxy Setup

The API listens on port 3001 on the host. Point your reverse proxy at `http://<HOST_IP>:3001`.

### Pre-flight: Cloudflare Tunnel (if applicable)

If using a Cloudflare Zero Trust tunnel for external HTTPS access:

> **⚠️ IMPORTANT — Do this BEFORE requesting the Let's Encrypt certificate:**
>
> The Cloudflare tunnel public hostname must be configured BEFORE the reverse proxy completes the ACME HTTP-01 challenge.
>
> 1. Go to: https://one.dash.cloudflare.com → Networks → Tunnels
> 2. Select your tunnel → Configure → Public Hostnames → Add a public hostname
> 3. Set:
>    - Subdomain: `<YOUR_SUBDOMAIN>`
>    - Domain: `<YOUR_DOMAIN>`
>    - Type: HTTP
>    - URL: `<HOST_IP>` (or your reverse proxy IP if separate)
> 4. Save and wait ~60 seconds for DNS propagation
> 5. Verify: `curl -I https://<YOUR_DOMAIN>` should reach the proxy
> 6. NOW request the Let's Encrypt certificate

### Nginx Proxy Manager example

```
Domain Names:        <YOUR_DOMAIN>
Forward Hostname/IP: <HOST_IP>
Forward Port:        3001
Websockets Support:  ON
SSL:                 Request Let's Encrypt certificate
Force SSL:           ON
```

Custom Nginx config:
```nginx
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
proxy_buffering off;
proxy_cache off;
client_max_body_size 2048m;
add_header Strict-Transport-Security "max-age=31536000" always;
```

### Caddy example

```caddyfile
<YOUR_DOMAIN> {
  reverse_proxy <HOST_IP>:3001
  header Strict-Transport-Security "max-age=31536000"
}
```

---

## 9. GPU Verification

After the worker container starts, verify GPU mode:

```bash
# Check GPU is visible inside the container
docker exec hypereels-worker nvidia-smi
# Expected: GPU model, driver version, CUDA version

# Check InsightFace startup logs for GPU/CPU mode
docker logs hypereels-worker 2>&1 | grep -i "provider\|cuda\|cpu"
# GPU mode: "Applied providers: ['CUDAExecutionProvider']"
# CPU mode: "Applied providers: ['CPUExecutionProvider']" with warning "GPU not available"

# Check InsightFace can use the GPU directly
docker exec hypereels-worker python -c "
import insightface
app = insightface.app.FaceAnalysis(name='buffalo_l')
app.prepare(ctx_id=0)  # ctx_id=0 = GPU; ctx_id=-1 = CPU
print('InsightFace mode: GPU')
" 2>&1 || echo "GPU not available — CPU mode active"
```

**If `nvidia-smi` fails inside the container:**
1. Verify `nvidia-smi` works on the host
2. Confirm `docker info | grep nvidia` shows the NVIDIA runtime
3. Check the `deploy.resources.reservations.devices` section is present in `docker-compose.yml`
4. Ensure no other container holds an exclusive GPU lock

**To force CPU-only mode:** Remove the `deploy` section from the `worker` service in `docker-compose.yml` and run `docker compose up -d worker`.

**NVENC hardware encoding (FFmpeg):** Uncomment `FFMPEG_HWACCEL=nvenc` in `.env` to enable NVIDIA hardware video encoding. This requires a GPU with NVENC support (GTX 1060 or newer). If NVENC is unavailable or the env var is not set, FFmpeg falls back to software (x264) encoding automatically.

---

## 10. Smoke Test

After all services are running:

```bash
# 1. API health
curl http://<HOST_IP>:3001/health
# {"status":"ok"}

# 2. API via domain
curl https://<YOUR_DOMAIN>/health
# {"status":"ok"}

# 3. Python workers health
curl http://<HOST_IP>:8000/health
# {"status":"ok","service":"hypereels-python-worker"}

# 4. Redis connectivity
docker exec hypereels-redis redis-cli -a '<REDIS_PASSWORD>' ping
# PONG

# 5. PostgreSQL connectivity
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels
# /var/run/postgresql:5432 - accepting connections

# 6. MinIO Console
# Open http://<HOST_IP>:9001 in your browser
# Log in with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# Confirm the "hypereels" bucket exists with the ILM rule

# 7. GPU status (if applicable)
docker exec hypereels-worker nvidia-smi
# Or confirm CPU fallback:
docker logs hypereels-worker 2>&1 | grep -i provider

# 8. UI
# Open https://<YOUR_DOMAIN> in your browser
# The HypeReels upload wizard should load
```

---

## 11. Backup

### PostgreSQL — nightly pg_dump

```bash
# /etc/cron.d/hypereels-backup (adjust path for Unraid: /etc/cron.d/ or User Scripts plugin)
0 2 * * * root docker exec hypereels-postgres pg_dump -U hypereels hypereels | \
  gzip > /opt/hypereels/backups/postgres-$(date +\%Y\%m\%d).sql.gz
```

### Redis — AOF persistence

Redis is configured with `appendonly yes` — queue data survives container restarts. The `hypereels-redis-data` named volume persists across `docker compose down` (but not `docker compose down -v`).

```bash
# Off-container AOF backup
docker exec hypereels-redis cat /data/appendonly.aof | \
  gzip > /opt/hypereels/backups/redis-$(date +%Y%m%d).aof.gz
```

### MinIO data

MinIO data is stored at the bind mount path in `docker-compose.yml` (`/opt/hypereels/data/minio` or the Unraid equivalent). Back this up with your normal host backup tool (Unraid backup plugin, rclone, rsync, etc.).

---

## Troubleshooting

### Worker container exits immediately

```bash
docker compose logs worker --tail 50
```

Common causes:
- Missing or incomplete `.env` — verify all `<PLACEHOLDER>` values are filled in
- PostgreSQL or Redis not yet healthy — re-run `docker compose up -d` if services started out of order
- InsightFace model download failed — the container tries to download `buffalo_l` on first start; ensure the host has internet access

### GPU not detected in worker

```bash
docker exec hypereels-worker nvidia-smi
```

If this fails:
1. Verify `nvidia-smi` works on the host
2. Verify `nvidia-container-toolkit` is installed and Docker is configured to use it (`docker info | grep nvidia`)
3. Check the `deploy.resources.reservations.devices` section is present in `docker-compose.yml`

To fall back to CPU mode without further debugging, remove the `deploy` section from the `worker` service and re-run `docker compose up -d worker`.

### MinIO presigned URLs not accessible from browser

`MINIO_PUBLIC_URL` (and `R2_PUBLIC_URL`) in `.env` must use the **host's LAN IP**, not `hypereels-minio`. Presigned URLs are resolved by the browser, which is outside the Docker network.

```bash
grep MINIO_PUBLIC_URL /opt/hypereels/app/.env
# Should be: MINIO_PUBLIC_URL=http://<HOST_IP>:9000/hypereels
```

### Containers keep restarting

```bash
docker compose ps      # Check Status column
docker compose logs    # Check all logs at once
```

The most common cause is a missing or incorrect `DATABASE_URL` or `REDIS_URL`. Verify all `<PLACEHOLDER>` values are replaced.

### Checking for GPU contention

If another container on your machine uses the GPU (e.g., Frigate NVR, a media transcoder), run:

```bash
nvidia-smi
# Look for processes listed under "Processes" — any process holding exclusive context
# will prevent other containers from acquiring GPU time
```

To see which Docker containers have GPU access:
```bash
docker inspect $(docker ps -q) | grep -A 10 '"DeviceRequests"'
```

If GPU contention is confirmed and affects HypeReels, remove the `deploy` section from the worker service to run CPU-only. InsightFace will detect the GPU is unavailable and log a warning before falling back to CPU inference automatically.
