# Profile 2 — GPU Self-Hosted (Unraid)

> **Deployment overview:** All services in a single `docker-compose.yml` on a single Unraid host. GPU passthrough to the Python worker container enables faster InsightFace inference. Managed by Docker Compose with `restart: unless-stopped` policies.

---

## Service Layout

All services run as Docker containers on a single Unraid host:

| Container | Image | Role | GPU |
|-----------|-------|------|-----|
| `hypereels-api` | `hypereels-api:latest` | Fastify API + static SPA | No |
| `hypereels-postgres` | `postgres:18` | PostgreSQL database | No |
| `hypereels-redis` | `redis:7-alpine` | BullMQ queues + pub/sub | No |
| `hypereels-minio` | `minio/minio` | Object storage (S3-compatible) | No |
| `hypereels-worker` | `hypereels-worker:latest` | Python workers (InsightFace, librosa, FFmpeg) | Yes (NVIDIA) |

**Key design decisions:**
- All Docker, managed by a single `docker-compose.yml`
- GPU passthrough via NVIDIA Container Runtime (`deploy.resources.reservations.devices`)
- Operator is responsible for GPU scheduling — ensure no other container (e.g., Frigate NVR) holds an exclusive GPU lock that blocks the worker
- PostgreSQL + Redis accessed via Docker service names (internal Docker network)
- SPA served by `@fastify/static` from volume-mounted `client-dist/`
- Process management: Docker Compose `restart: unless-stopped`

---

## 1. Prerequisites

- **Unraid 6.12+** with Docker support enabled
- **NVIDIA GPU** (GTX 1070 or better recommended for InsightFace GPU inference)
- NVIDIA Unraid plugin installed (see Section 2)
- `docker compose` v2 available (`docker compose version`)
- Git available on Unraid: install from Unraid Community Applications (NerdTools or similar)
- A reverse proxy on the LAN (Nginx Proxy Manager, Caddy, or Nginx) — see Section 8

**GPU requirement note:** Profile 2 enables GPU passthrough to the worker container. If your GPU is shared with other containers (e.g., Frigate NVR), ensure those containers do not hold an exclusive lock that prevents the HypeReels worker from acquiring GPU time. If GPU contention is a problem, run the worker CPU-only by removing the `deploy.resources.reservations.devices` section from `docker-compose.yml`.

---

## 2. NVIDIA Container Runtime Setup

### Install the Unraid NVIDIA Plugin

1. In Unraid, go to **Apps** (Community Applications plugin required)
2. Search for **NVIDIA Driver**
3. Install the NVIDIA Driver plugin
4. Reboot Unraid after installation

### Verify GPU is accessible

```bash
# On Unraid terminal
nvidia-smi
# Should show your GPU model, driver version, and CUDA version

docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi
# Should show the same GPU info — confirms Docker GPU passthrough works
```

If the above fails, verify the NVIDIA runtime is configured:

```bash
docker info | grep -i runtime
# Should include: nvidia
```

---

## 3. Clone Repo to Unraid

```bash
# On the Unraid terminal
mkdir -p /mnt/user/appdata/hypereels
git clone https://github.com/<ORG>/hypereels.git /mnt/user/appdata/hypereels
cd /mnt/user/appdata/hypereels
```

---

## 4. Configure Environment Files

Create the following `.env` files in `/mnt/user/appdata/hypereels/`:

### `.env` — API and shared config

```bash
cat > /mnt/user/appdata/hypereels/.env << 'EOF'
# ── Database ───────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://hypereels:<POSTGRES_PASSWORD>@hypereels-postgres:5432/hypereels
DATABASE_SSL=false

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://:<REDIS_PASSWORD>@hypereels-redis:6379
REDIS_PASSWORD=<REDIS_PASSWORD>

# ── MinIO ─────────────────────────────────────────────────────────────────────
MINIO_ENDPOINT=http://hypereels-minio:9000
MINIO_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
MINIO_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
MINIO_BUCKET=hypereels
MINIO_PUBLIC_URL=http://<UNRAID_HOST_IP>:9000/hypereels

# Legacy R2_* aliases — mirrors MINIO_* above
R2_ENDPOINT=http://hypereels-minio:9000
R2_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
R2_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
R2_BUCKET=hypereels
R2_ACCOUNT_ID=local
R2_PUBLIC_URL=http://<UNRAID_HOST_IP>:9000/hypereels

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

# ── InsightFace ───────────────────────────────────────────────────────────────
INSIGHTFACE_MODEL=buffalo_l
INSIGHTFACE_COSINE_THRESHOLD=0.45

# ── FFmpeg ────────────────────────────────────────────────────────────────────
FFMPEG_CRF=20
FFMPEG_PRESET=fast
FFMPEG_MAX_WIDTH=1920

# ── Session & upload limits ───────────────────────────────────────────────────
SESSION_TTL_HOURS=24
CLEANUP_GRACE_PERIOD_MINUTES=5
MAX_CLIPS_PER_SESSION=10
MAX_CLIP_DURATION_MS=300000
MAX_CLIP_SIZE_BYTES=500000000
MAX_AUDIO_DURATION_MS=600000
GENERATION_TIMEOUT_MS=900000
EOF
chmod 600 /mnt/user/appdata/hypereels/.env
```

### `.env.postgres` — PostgreSQL container

```bash
cat > /mnt/user/appdata/hypereels/.env.postgres << 'EOF'
POSTGRES_DB=hypereels
POSTGRES_USER=hypereels
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
EOF
chmod 600 /mnt/user/appdata/hypereels/.env.postgres
```

### `.env.redis` — Redis container

```bash
cat > /mnt/user/appdata/hypereels/.env.redis << 'EOF'
REDIS_PASSWORD=<REDIS_PASSWORD>
EOF
chmod 600 /mnt/user/appdata/hypereels/.env.redis
```

### `.env.minio` — MinIO container

```bash
cat > /mnt/user/appdata/hypereels/.env.minio << 'EOF'
MINIO_ROOT_USER=<MINIO_ROOT_USER>
MINIO_ROOT_PASSWORD=<MINIO_ROOT_PASSWORD>
EOF
chmod 600 /mnt/user/appdata/hypereels/.env.minio
```

---

## 5. Build SPA

On your developer machine (or on the Unraid host if Node.js is installed):

```bash
cd /mnt/user/appdata/hypereels/client
npm install
npm run build
# Output in client/dist/

# Copy SPA into API's static serving directory
cp -r /mnt/user/appdata/hypereels/client/dist \
      /mnt/user/appdata/hypereels/server/client-dist
```

---

## 6. docker-compose.yml

Create or review `/mnt/user/appdata/hypereels/docker-compose.yml`:

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
      - /mnt/user/appdata/hypereels-postgres:/var/lib/postgresql/data
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
      - /mnt/user/appdata/hypereels-minio:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - hypereels

  # ── Python Worker (GPU-enabled) ───────────────────────────────────────────────
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
      - /mnt/cache/appdata/hypereels/tmp:/tmp/hypereels
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

**Note on `MINIO_PUBLIC_URL`:** The value in `.env` uses the Unraid host IP (`<UNRAID_HOST_IP>:9000`) rather than the Docker service name. This is because presigned URLs are resolved by the **browser**, which is outside the Docker network and cannot resolve `hypereels-minio`. Use the actual LAN IP of your Unraid host.

---

## 7. Start Services

```bash
cd /mnt/user/appdata/hypereels

# Build images first
docker compose build

# Start all services
docker compose up -d

# Check all containers are running
docker compose ps
```

### Run migrations (first boot only)

Wait for PostgreSQL to be healthy, then apply schema migrations:

```bash
# Check PostgreSQL is healthy
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels

# Apply migrations
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
# Wait for MinIO to be healthy
docker exec hypereels-minio mc alias set local http://localhost:9000 \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

# Read credentials from env file
source /mnt/user/appdata/hypereels/.env.minio

docker exec hypereels-minio mc alias set local http://localhost:9000 \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
docker exec hypereels-minio mc mb --ignore-existing local/hypereels
docker exec hypereels-minio mc ilm rule add local/hypereels --expire-days 2 --tags "session_ttl=true"
docker exec hypereels-minio mc ilm rule ls local/hypereels
```

---

## 8. Reverse Proxy Setup

Choose any reverse proxy. The API listens on port 3001 on the Unraid host.

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
>    - URL: `<UNRAID_HOST_IP>` (or your reverse proxy IP if separate)
> 4. Save and wait ~60 seconds for DNS propagation
> 5. Verify: `curl -I https://<YOUR_DOMAIN>` should reach the proxy
> 6. NOW request the Let's Encrypt certificate

### Nginx Proxy Manager example

```
Domain Names:        <YOUR_DOMAIN>
Forward Hostname/IP: <UNRAID_HOST_IP>
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
  reverse_proxy <UNRAID_HOST_IP>:3001
  header Strict-Transport-Security "max-age=31536000"
}
```

---

## 9. GPU Verification

```bash
# Verify GPU is accessible inside the worker container
docker exec hypereels-worker python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
# Expected: CUDA available: True  Device: <your GPU name>

# Verify InsightFace can use the GPU
docker exec hypereels-worker python -c "
import insightface
app = insightface.app.FaceAnalysis(name='buffalo_l')
app.prepare(ctx_id=0)  # ctx_id=0 means GPU; ctx_id=-1 would be CPU
print('InsightFace loaded on GPU successfully')
"
```

If you see `CUDA available: False`, verify:
1. The NVIDIA plugin is installed and the host shows `nvidia-smi`
2. The `deploy.resources.reservations.devices` section is in `docker-compose.yml`
3. No other container holds an exclusive GPU lock

---

## 10. Smoke Test

After all services are running:

```bash
# 1. API health
curl http://<UNRAID_HOST_IP>:3001/health
# {"status":"ok"}

# 2. API via domain
curl https://<YOUR_DOMAIN>/health
# {"status":"ok"}

# 3. Python workers health
curl http://<UNRAID_HOST_IP>:8000/health
# {"status":"ok","service":"hypereels-python-worker"}

# 4. Redis connectivity
docker exec hypereels-redis redis-cli -a '<REDIS_PASSWORD>' ping
# PONG

# 5. PostgreSQL connectivity
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels
# /var/run/postgresql:5432 - accepting connections

# 6. MinIO Console
# Open http://<UNRAID_HOST_IP>:9001 in your browser
# Log in with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# Confirm the "hypereels" bucket exists with the ILM rule

# 7. UI
# Open https://<YOUR_DOMAIN> in your browser
# The HypeReels upload wizard should load
```

---

## 11. Backup

### PostgreSQL — nightly pg_dump via cron

Unraid supports cron via the User Scripts plugin (Community Applications) or manually via `/etc/cron.d/`:

```bash
# /etc/cron.d/hypereels-backup (on Unraid)
0 2 * * * root docker exec hypereels-postgres pg_dump -U hypereels hypereels | \
  gzip > /mnt/user/backups/hypereels/postgres-$(date +\%Y\%m\%d).sql.gz
```

### Redis — AOF persistence

Redis is configured with `appendonly yes` — queue data survives container restarts. The `hypereels-redis-data` named volume persists across `docker compose down` (but not `docker compose down -v`).

For off-container backup:

```bash
# Copy AOF to backup location
docker exec hypereels-redis cat /data/appendonly.aof | \
  gzip > /mnt/user/backups/hypereels/redis-$(date +%Y%m%d).aof.gz
```

### MinIO data

MinIO data is stored at `/mnt/user/appdata/hypereels-minio` on the Unraid array. Unraid's built-in backup (Unraid backup plugin or rclone) covers this directory.

### Docker Compose config

Back up `/mnt/user/appdata/hypereels/` (excluding large data directories) to ensure the compose file, `.env` files, and `client-dist/` are recoverable.

---

## Troubleshooting

### Worker container exits immediately

Check logs:

```bash
docker compose logs worker --tail 50
```

Common causes:
- Missing `.env` — verify all `<PLACEHOLDER>` values are filled in
- PostgreSQL or Redis not yet healthy — the `depends_on` healthcheck should handle this, but re-run `docker compose up -d` if services started out of order
- InsightFace model download failed — the container tries to download `buffalo_l` on first start; ensure the Unraid host has internet access

### GPU not detected in worker

```bash
docker exec hypereels-worker nvidia-smi
# If this fails: the GPU is not passed through — check NVIDIA plugin and docker-compose.yml
```

Remove the `deploy.resources.reservations.devices` section to fall back to CPU-only mode.

### MinIO presigned URLs not accessible from browser

The `MINIO_PUBLIC_URL` and `R2_PUBLIC_URL` in `.env` must use the Unraid host's LAN IP, not `hypereels-minio`. Presigned URLs are resolved by the browser, which is outside the Docker network.

```bash
# Verify the correct value is set
grep MINIO_PUBLIC_URL /mnt/user/appdata/hypereels/.env
# Should be: MINIO_PUBLIC_URL=http://<UNRAID_HOST_IP>:9000/hypereels
```

### Containers keep restarting

```bash
docker compose ps      # Check Status column
docker compose logs    # Check all logs at once
```

Check that all `<PLACEHOLDER>` values are replaced — the most common cause of restart loops is a missing or incorrect `DATABASE_URL` or `REDIS_URL`.
