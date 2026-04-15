# HypeReels Infrastructure

> Owner: DevOps Engineer
> Last updated: 2026-04-08
> Proxmox version: 9.1.5 | Unraid version: 7.2.2

---

## 1. Infrastructure Overview

### Topology Diagram

```
Internet (Public IP: 70.22.248.227)
         |
         | HTTPS — Cloudflare Zero Trust Tunnel
         | (Cloudflare-Tron container on Quorra, existing)
         v
  Cloudflare Edge (hypereels.thesquids.ink)
         |
         | HTTP — tunnel to LAN
         v
+------------------------------------------------------------------+
|  CASE — Proxmox 9.1.5 (192.168.1.122)                           |
|                                                                  |
|  +--------------------------------------+                        |
|  | Nginx Proxy Manager (CT 100)         |                        |
|  | 192.168.1.123 :80/:443 (shared)      |                        |
|  | Web UI: :81                          |                        |
|  | Proxy: hypereels.thesquids.ink       |                        |
|  |        -> 192.168.1.136:3001         |                        |
|  +------------------+-------------------+                        |
|                     |                                            |
|       +-------------v--------------+                             |
|       | API Server (CT 113)        |                             |
|       | Node.js 20 / Fastify       |                             |
|       | 192.168.1.136:3001         |                             |
|       | /metrics endpoint          |                             |
|       +---+----------+-------------+                             |
|           |          |                                           |
|    +-------v--+  +---v---------------------------+              |
|    | Redis     |  | MinIO (CT 115)                |             |
|    | (CT 114)  |  | 192.168.1.138:9000 (S3 API)   |             |
|    | :6379     |  | 192.168.1.138:9001 (Console)   |             |
|    | BullMQ    |  | storage_1tb ZFS, 899 GB        |             |
|    | pub/sub   |  +-------------------------------+             |
|    | 192.168.1 |                                                 |
|    | .137      |                                                 |
|    +-----------+                                                 |
+------------------------------------------------------------------+
         |
         | LAN (192.168.1.0/24) — BullMQ + MinIO S3 API
         v
+------------------------------------------------------------------+
|  QUORRA — Unraid 7.2.2 (192.168.1.100)                          |
|                                                                  |
|  +---------------------------+  CPU-only (no --gpus all)         |
|  | worker-detection          |  ADR-013: GTX 1080 Ti reserved   |
|  | InsightFace buffalo_l     |  for Frigate + FileFlows          |
|  | port 8000 (health)        |  ~30-60s per clip-minute          |
|  +---------------------------+                                   |
|                                                                  |
|  +---------------------------+                                   |
|  | worker-audio              |  CPU-only                         |
|  | Python 3.12 + librosa     |  ~10-20s per audio track          |
|  +---------------------------+                                   |
|                                                                  |
|  +---------------------------+                                   |
|  | worker-assembly           |  CPU-only (x264 encode)           |
|  | Python 3.12 + FFmpeg 6    |  ~45-90s per 3-min reel           |
|  +---------------------------+                                   |
|                                                                  |
|  +---------------------------+  PostgreSQL 18 (Docker)           |
|  | hypereels-postgres        |  host port 7432 → 5432            |
|  | postgres:18               |  /mnt/user/appdata/               |
|  | 192.168.1.100:7432        |  hypereels-postgres               |
|  +---------------------------+                                   |
|                                                                  |
|  +---------------------------+  Existing — do not touch          |
|  | Frigate NVR               |  GTX 1080 Ti GPU (exclusive)      |
|  | Cloudflare-Tron           |  External tunnel (shared)         |
|  | Prometheus + Grafana      |  HypeReels integrates here        |
|  +---------------------------+                                   |
+------------------------------------------------------------------+
```

### Service Inventory — Case (Proxmox LXC)

| CT ID | IP | Port(s) | Role | Storage Pool | Autostart |
|-------|-----|---------|------|-------------|-----------|
| CT 100 | 192.168.1.123 | 80, 443, 81 | Nginx Proxy Manager (EXISTING, shared) | local | yes |
| CT 113 | 192.168.1.136 | 3001 | HypeReels API (Fastify/Node.js 20) | vm_storage (rootfs 8 GB) | yes |
| CT 114 | 192.168.1.137 | 6379 | Redis 7 | vm_storage (rootfs 4 GB) | yes |
| CT 115 | 192.168.1.138 | 9000, 9001 | MinIO (S3 API + Console) | storage_1tb (rootfs 8 GB + 200 GB data mp) | yes |

Note: CT 108 (192.168.1.131) is RESERVED for ntfy (planned push notification server). This reservation is why HypeReels containers begin at CT 113.

### Service Inventory — Quorra (Unraid Docker)

| Container Name | Image | Port | CPU Limit | RAM Limit | Temp Storage |
|---------------|-------|------|-----------|-----------|-------------|
| hypereels-postgres | postgres:18 | 7432:5432 | — | — | /mnt/user/appdata/hypereels-postgres |
| hypereels-worker-detection | hypereels-workers:latest | 8000 | 4 cores | 8 GB | /mnt/cache/appdata/hypereels/tmp |
| hypereels-worker-audio | hypereels-workers:latest | — (internal) | 2 cores | 4 GB | /mnt/cache/appdata/hypereels/tmp |
| hypereels-worker-assembly | hypereels-workers:latest | — (internal) | 8 cores | 12 GB | /mnt/cache/appdata/hypereels/tmp |

All Quorra containers: `restart: unless-stopped`, no `--gpus all` flag on workers (ADR-013).

---

## 2. Proxmox LXC Provisioning

All commands run on the Proxmox host (192.168.1.122) as root. The Debian 12 template must be downloaded first:

```bash
pveam update
pveam download local debian-12-standard_12.7-1_amd64.tar.zst
```

### CT 113 — HypeReels API

```bash
pct create 113 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hypereels-api \
  --cores 4 --memory 4096 --swap 1024 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.136/24,gw=192.168.1.1 \
  --storage vm_storage --rootfs vm_storage:8 \
  --nameserver 192.168.1.1 \
  --onboot 1 \
  --start 1

# Post-creation: enter container
pct enter 113
```

Post-creation setup for CT 113:

```bash
# Inside CT 113
apt-get update && apt-get upgrade -y
apt-get install -y curl git ca-certificates

# Install Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install ffmpeg (required by validation worker)
apt-get install -y ffmpeg

# Install postgresql-client (required to run DB migrations from CT 113)
apt-get install -y postgresql-client

# Install iptables-persistent (required for firewall rules below)
apt-get install -y iptables-persistent

# Create app user and directory
useradd -r -s /bin/bash -m -d /opt/hypereels hypereels
mkdir -p /opt/hypereels/app
chown hypereels:hypereels /opt/hypereels/app

# Clone repo (adjust remote URL to match your repo)
git clone https://github.com/<org>/hypereels.git /opt/hypereels/app
chown -R hypereels:hypereels /opt/hypereels/app

# Install dependencies and build TypeScript → dist/
cd /opt/hypereels/app/server
npm ci --omit=dev
npm run build

# Create production .env (see Section 3 "API Server" for full contents)
# Copy the block from Section 3 into /opt/hypereels/app/.env, then fill secrets
nano /opt/hypereels/app/.env
chmod 600 /opt/hypereels/app/.env
chown hypereels:hypereels /opt/hypereels/app/.env

# Run DB migrations (first boot only — all three are idempotent)
# Requires PostgreSQL on Quorra to be healthy first (Step 1 of startup sequence)
cd /opt/hypereels/app
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f server/src/db/migrations/001_initial_schema.sql
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f server/src/db/migrations/002_rename_r2_key_to_minio_key.sql
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f server/src/db/migrations/003_add_clip_validation.sql

# Verify migrations applied cleanly
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -c "\dt"

# Start with PM2
pm2 start /opt/hypereels/app/ecosystem.config.cjs
pm2 save

# Restrict port 3001 to LAN-internal callers only (NPM on 192.168.1.123, Quorra on 192.168.1.100)
# Allow loopback and the two permitted source IPs; drop everything else on 3001
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -p tcp --dport 3001 -s 192.168.1.123 -j ACCEPT
iptables -A INPUT -p tcp --dport 3001 -s 192.168.1.100 -j ACCEPT
iptables -A INPUT -p tcp --dport 3001 -j DROP
# Persist across reboots (iptables-persistent was installed above)
netfilter-persistent save

exit
```

PM2 ecosystem file at `/opt/hypereels/app/ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [
    {
      name: 'hypereels-api',
      script: './server/dist/index.js',
      cwd: '/opt/hypereels/app',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        HOST: '0.0.0.0',
      },
      error_file: '/var/log/hypereels/api-error.log',
      out_file: '/var/log/hypereels/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
}
```

Systemd unit to start PM2 on boot (`/etc/systemd/system/hypereels-pm2.service`):

```ini
[Unit]
Description=HypeReels PM2 process manager
After=network.target

[Service]
Type=forking
User=hypereels
WorkingDirectory=/opt/hypereels/app
ExecStart=/usr/bin/pm2 resurrect
ExecStop=/usr/bin/pm2 kill
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable hypereels-pm2
systemctl start hypereels-pm2
```

### PostgreSQL (Quorra Docker — `hypereels-postgres`)

PostgreSQL runs as a Docker container on Quorra alongside the Python workers. This is consistent with how `homeassistant-postgres` (port 5432) and `nextcloud-postgres` (port 6432) are already run on Quorra. The `hypereels-postgres` container uses the next available host port, 7432.

The container is defined in `workers/docker-compose.workers.yml`. To start it on Quorra:

```bash
# On Quorra — run from /mnt/cache/appdata/hypereels
mkdir -p /mnt/user/appdata/hypereels-postgres

docker-compose -f docker-compose.workers.yml --env-file .env.workers \
  up -d hypereels-postgres

# Verify it is healthy
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels
# Expected: /var/run/postgresql:5432 - accepting connections
```

Post-start init — create DB, user, and apply schema:

```bash
# Create DB and user (postgres:18 image auto-creates via POSTGRES_DB/POSTGRES_USER env;
# these are already set in docker-compose.workers.yml)
# If you need to run SQL manually:
docker exec -it hypereels-postgres psql -U hypereels -d hypereels <<'SQL'
SELECT version();
SQL

# Apply schema from CT 113 (all three migration files, in order — see Section 3 for full command):
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/app/server/src/db/migrations/001_initial_schema.sql
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/app/server/src/db/migrations/002_rename_r2_key_to_minio_key.sql
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/app/server/src/db/migrations/003_add_clip_validation.sql
```

Connection string from all clients:

```
postgresql://hypereels:<PASSWORD>@192.168.1.100:7432/hypereels
```

Note: No `pg_hba.conf` LAN rule configuration is required. Docker's bridge network with `0.0.0.0:7432` binding means the container accepts connections from any LAN host. Password authentication (`POSTGRES_PASSWORD`) is the access control mechanism. The CT 113 API and Quorra workers both connect to `192.168.1.100:7432`.

Data directory: `/mnt/user/appdata/hypereels-postgres` (on Quorra's Unraid array).

### CT 114 — Redis 7

```bash
pct create 114 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hypereels-redis \
  --cores 1 --memory 512 --swap 256 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.137/24,gw=192.168.1.1 \
  --storage vm_storage --rootfs vm_storage:4 \
  --nameserver 192.168.1.1 \
  --onboot 1 \
  --start 1

pct enter 114
```

Post-creation setup for CT 114:

```bash
# Inside CT 114
apt-get update && apt-get upgrade -y
apt-get install -y redis-server

# Configure Redis
REDIS_CONF="/etc/redis/redis.conf"
sed -i "s/^bind 127.0.0.1.*/bind 192.168.1.137/" "$REDIS_CONF"
sed -i "s/^# requirepass .*/requirepass REPLACE_WITH_STRONG_REDIS_PASSWORD/" "$REDIS_CONF"
sed -i "s/^# maxmemory .*/maxmemory 384mb/" "$REDIS_CONF"
sed -i "s/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/" "$REDIS_CONF"

# Enable AOF persistence for queue durability
sed -i "s/^appendonly no/appendonly yes/" "$REDIS_CONF"
sed -i "s/^appendfilename .*/appendfilename \"appendonly.aof\"/" "$REDIS_CONF"

# Systemd override for automatic restart
mkdir -p /etc/systemd/system/redis-server.service.d
cat > /etc/systemd/system/redis-server.service.d/override.conf <<'EOF'
[Service]
Restart=always
RestartSec=5
EOF

systemctl daemon-reload
systemctl enable redis-server
systemctl restart redis-server

exit
```

### CT 115 — MinIO

```bash
pct create 115 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hypereels-minio \
  --cores 2 --memory 2048 --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.138/24,gw=192.168.1.1 \
  --storage storage_1tb --rootfs storage_1tb:8 \
  --mp0 storage_1tb:200,mp=/data \
  --nameserver 192.168.1.1 \
  --onboot 1 \
  --start 1

pct enter 115
```

Post-creation setup for CT 115:

```bash
# Inside CT 115
apt-get update && apt-get upgrade -y
apt-get install -y curl wget

# Install MinIO server binary
wget -O /usr/local/bin/minio https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x /usr/local/bin/minio

# Install mc (MinIO client)
wget -O /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x /usr/local/bin/mc

# Create MinIO user and data directory
useradd -r -s /sbin/nologin -M minio-user
chown -R minio-user:minio-user /data
mkdir -p /etc/minio

# Create MinIO environment file
cat > /etc/minio/minio.env <<'EOF'
MINIO_ROOT_USER=REPLACE_WITH_MINIO_ACCESS_KEY
MINIO_ROOT_PASSWORD=REPLACE_WITH_MINIO_SECRET_KEY
MINIO_VOLUMES=/data
MINIO_OPTS="--console-address :9001"
EOF
chmod 600 /etc/minio/minio.env
chown minio-user:minio-user /etc/minio/minio.env

exit
```

MinIO systemd unit at `/etc/systemd/system/minio.service` (inside CT 115):

```ini
[Unit]
Description=MinIO Object Storage
Documentation=https://min.io/docs/minio/linux/index.html
Wants=network-online.target
After=network-online.target
AssertFileIsExecutable=/usr/local/bin/minio

[Service]
WorkingDirectory=/data
User=minio-user
Group=minio-user
ProtectProc=invisible
EnvironmentFile=/etc/minio/minio.env
ExecStartPre=/bin/bash -c "if [ -z \"${MINIO_VOLUMES}\" ]; then echo \"Variable MINIO_VOLUMES not set in /etc/minio/minio.env\"; exit 1; fi"
ExecStart=/usr/local/bin/minio server $MINIO_OPTS $MINIO_VOLUMES
Restart=always
LimitNOFILE=65536
TasksMax=infinity
TimeoutStopSec=infinity
SendSIGKILL=no

[Install]
WantedBy=multi-user.target
```

```bash
# Inside CT 115 — enable and start MinIO
systemctl daemon-reload
systemctl enable minio
systemctl start minio

# Wait for MinIO to become healthy before running mc commands
echo "Waiting for MinIO to be ready..."
until curl -sf http://192.168.1.138:9000/minio/health/live > /dev/null 2>&1; do
  sleep 2
done
echo "MinIO is ready"

# Configure bucket and lifecycle (run after MinIO is healthy)
# Source env file to get $MINIO_ROOT_USER and $MINIO_ROOT_PASSWORD
source /etc/minio/minio.env
mc alias set local http://192.168.1.138:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb local/hypereels
mc ilm rule add local/hypereels --expire-days 2 --tags "session_ttl=true"

# Verify ILM rule
mc ilm rule ls local/hypereels

# Health check (MinIO S3 API)
curl -sf http://192.168.1.138:9000/minio/health/live && echo "MinIO API healthy"

# Verify Console is accessible (HTTP 200 or 302)
curl -sf -o /dev/null -w "%{http_code}" http://192.168.1.138:9001 | grep -qE "^(200|302)" \
  && echo "MinIO Console (192.168.1.138:9001) accessible" \
  || echo "WARNING: MinIO Console not responding on port 9001 — check MINIO_OPTS in minio.env"
```

---

## 3. Service Configuration

### PostgreSQL 18 (Quorra Docker — 192.168.1.100:7432)

The `hypereels-postgres` container is managed by `workers/docker-compose.workers.yml`. Key runtime parameters are set via environment variables in that file. No `postgresql.conf` or `pg_hba.conf` manual edits are required — Docker's bridge network with `0.0.0.0:7432` binding handles LAN connectivity; password auth is the access control.

Connection string:

```
postgresql://hypereels:<PASSWORD>@192.168.1.100:7432/hypereels
```

Apply schema on first boot (run from CT 113 or any host with `psql` access):

```bash
# All three migration files must be applied in order.
# Each migration is idempotent — safe to re-run if a previous apply was interrupted.
# Install postgresql-client on CT 113 if needed: apt-get install -y postgresql-client

cd /opt/hypereels/app
for f in \
  server/src/db/migrations/001_initial_schema.sql \
  server/src/db/migrations/002_rename_r2_key_to_minio_key.sql \
  server/src/db/migrations/003_add_clip_validation.sql
do
  echo "Applying $f ..."
  PGPASSWORD=<POSTGRES_PASSWORD> psql \
    -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
    -f "$f"
done

# Verify tables exist
PGPASSWORD=<POSTGRES_PASSWORD> psql \
  -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -c "\dt"
```

All migrations use `IF NOT EXISTS` / `DO $$ ... IF NOT EXISTS` guards — safe to re-run on an existing database.

Backup: `pg_dump` runs on Quorra (see Section 8). No `pct exec` is needed — `pg_dump` connects over `192.168.1.100:7432` from any host with psql access.

### Redis 7 (CT 114 — 192.168.1.137)

Key configuration in `/etc/redis/redis.conf`:

```
bind 192.168.1.137
requirepass <REDIS_PASSWORD>
maxmemory 384mb
maxmemory-policy allkeys-lru
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
save 900 1
save 300 10
```

Verify connectivity from CT 114:

```bash
redis-cli -h 192.168.1.137 -a '<REDIS_PASSWORD>' PING
# Expected: PONG
```

### MinIO (CT 115 — 192.168.1.138)

Bucket structure in use:

```
Bucket: hypereels
  uploads/{session_id}/clips/{clip_id}.mp4
  uploads/{session_id}/audio.{ext}
  generated/{session_id}/hypereel_{short_id}.mp4
  thumbnails/{session_id}/{clip_id}.jpg
  thumbnails/{session_id}/waveform.svg
  thumbnails/{session_id}/persons/{person_ref_id}.jpg
  backups/postgres/{date}.sql.gz
  backups/redis/{date}.aof.gz
```

ILM lifecycle rule — session TTL safety net:

```bash
# Rule name: session-ttl-safety-net
# Objects tagged session_ttl=true are deleted after 48 hours
mc ilm rule add local/hypereels --expire-days 2 --tags "session_ttl=true"

# Verify
mc ilm rule ls local/hypereels
```

Presigned URL TTLs:
- Upload PUT URLs: 15 minutes
- Thumbnail/waveform GET URLs: 1 hour
- Final download GET URL: 2 hours

### API Server (CT 113 — 192.168.1.136:3001)

Production `.env` at `/opt/hypereels/app/.env`:

```bash
# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://hypereels:<POSTGRES_PASSWORD>@192.168.1.100:7432/hypereels
DATABASE_SSL=false

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://:<REDIS_PASSWORD>@192.168.1.137:6379
REDIS_PASSWORD=<REDIS_PASSWORD>

# ── MinIO (CT 115, storage_1tb) ───────────────────────────────────────────────
# Use a dedicated MinIO service account (least-privilege), not the root credentials
MINIO_ENDPOINT=http://192.168.1.138:9000
MINIO_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
MINIO_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
MINIO_BUCKET=hypereels
MINIO_PUBLIC_URL=http://192.168.1.138:9000/hypereels

# Legacy R2_* aliases — kept for internal SDK compatibility; mirrors MINIO_* above
R2_ENDPOINT=http://192.168.1.138:9000
R2_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
R2_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
R2_BUCKET=hypereels
R2_PUBLIC_URL=http://192.168.1.138:9000/hypereels

# ── API server ────────────────────────────────────────────────────────────────
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=https://hypereels.thesquids.ink

# ── Python workers (Quorra Docker, 192.168.1.100) ────────────────────────────
PYTHON_WORKER_URL=http://192.168.1.100:8000
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

# ── Prometheus metrics ────────────────────────────────────────────────────────
METRICS_PATH=/metrics
```

All secrets are stored only in this file. The file is owned by `hypereels:hypereels` and has mode `600`. Secrets are never committed to version control.

> **Note on MinIO credentials:** The `MINIO_ACCESS_KEY_ID` / `R2_ACCESS_KEY_ID` here should be a dedicated MinIO service account (not the root credentials from `/etc/minio/minio.env` on CT 115). Create one via the MinIO Console at http://192.168.1.138:9001 → Identity → Service Accounts, with a read/write policy scoped to the `hypereels` bucket.

Health check:

```bash
curl -sf http://192.168.1.136:3001/health
# Expected: {"status":"ok"}
```

---

## 4. Quorra Docker Deployment

The Python workers run as Docker containers on Quorra at `/mnt/cache/appdata/hypereels/`.

### Worker Container Configuration

See `workers/docker-compose.workers.yml` for the full compose definition. Key points:

- No `--gpus all` flag — CPU-only per ADR-013 (GTX 1080 Ti is reserved for Frigate and FileFlows)
- Temp files mount to `/mnt/cache/appdata/hypereels/tmp` on Quorra's NVMe SSD cache
- Workers connect to Redis at `192.168.1.137:6379` and MinIO at `192.168.1.138:9000` over the LAN
- The `hypereels-postgres` container also lives in this compose file; it connects to no external services and binds host port 7432
- Container restart policy: `unless-stopped`

### Deploy on Quorra

```bash
# On Quorra — run as root or docker-capable user
mkdir -p /mnt/cache/appdata/hypereels/tmp
mkdir -p /mnt/user/appdata/hypereels-postgres

# Copy compose file and env
cp workers/docker-compose.workers.yml /mnt/cache/appdata/hypereels/
cp workers/.env.workers.example /mnt/cache/appdata/hypereels/.env.workers
# Edit .env.workers with real credentials

# Start PostgreSQL first (workers depend on it being healthy)
cd /mnt/cache/appdata/hypereels
docker-compose -f docker-compose.workers.yml --env-file .env.workers up -d hypereels-postgres
sleep 10
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels

# Apply schema (first boot only — all three migration files in order)
# Run from CT 113 after the repo is cloned to /opt/hypereels/app
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/app/server/src/db/migrations/001_initial_schema.sql
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/app/server/src/db/migrations/002_rename_r2_key_to_minio_key.sql
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels \
  -f /opt/hypereels/app/server/src/db/migrations/003_add_clip_validation.sql

# Build and start workers
docker-compose -f docker-compose.workers.yml --env-file .env.workers up -d --build

# Verify health
docker ps --filter name=hypereels
curl -sf http://localhost:8000/health
```

### GPU Scheduling Note (ADR-013)

The GTX 1080 Ti on Quorra is shared by three services:
1. Frigate NVR — always-on home security; highest priority; must never be preempted
2. FileFlows — NVENC media transcoding; active when encoding jobs run
3. HypeReels InsightFace — batch async detection

**Decision (ADR-013):** HypeReels InsightFace runs CPU-only. The `--gpus all` flag is not present in `docker-compose.workers.yml`. This avoids any GPU contention with Frigate. Detection time is ~30–60 seconds per clip-minute, which is acceptable for async processing.

**Operational impact:** If a user submits a 5-minute clip, detection takes 2.5–5 minutes. SSE progress events keep the user informed. No operator intervention is required. If CPU load on Quorra becomes a bottleneck under concurrent sessions, reduce BullMQ `person-detection` queue concurrency from 1 to 1 (already the default) or migrate workers to Case's Xeon LXC.

**Upgrade path:** To enable GPU mode in a future sprint, add `deploy.resources.reservations.devices` to the worker-detection service in `docker-compose.workers.yml`. No application code changes are required.

---

## 5. Nginx Proxy Manager Configuration

NPM is already running at http://192.168.1.123:81. Add one proxy host for HypeReels.

### Steps

1. Log in to NPM at http://192.168.1.123:81
2. Navigate to Proxy Hosts → Add Proxy Host
3. Enter the following:

**Details tab:**
```
Domain Names:           hypereels.thesquids.ink
Scheme:                 http
Forward Hostname/IP:    192.168.1.136
Forward Port:           3001
Cache Assets:           OFF
Block Common Exploits:  ON
Websockets Support:     ON  (required for SSE keep-alive connections)
```

**SSL tab:**
```
SSL Certificate:        Request a new SSL Certificate
Force SSL:              ON
HTTP/2 Support:         ON
HSTS Enabled:           ON
HSTS Subdomains:        OFF
```

**Advanced tab — custom Nginx config block:**
```nginx
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
proxy_buffering off;
proxy_cache off;
add_header Strict-Transport-Security "max-age=31536000" always;
```

The `proxy_read_timeout 86400s` is required for SSE (Server-Sent Events) connections, which are long-lived HTTP responses that stream progress events to the browser. Without this, Nginx terminates the connection after its default 60-second read timeout.

### Verify

```bash
curl -I https://hypereels.thesquids.ink/health
# Expected: HTTP/2 200
```

---

## 6. Cloudflare Tunnel Configuration

The Cloudflare-Tron container (`figro/unraid-cloudflared-tunnel`) is already running on Quorra. Do NOT create a new tunnel.

### Option A — Cloudflare Zero Trust Dashboard (Recommended)

1. Log in to https://one.dash.cloudflare.com
2. Navigate to Networks → Tunnels
3. Select the existing tunnel used by Cloudflare-Tron on Quorra
4. Click "Edit" → "Public Hostname" tab → "Add a public hostname"
5. Enter:

```
Subdomain:   hypereels
Domain:      thesquids.ink
Path:        (leave blank)
Service:     HTTP
URL:         192.168.1.123
```

This routes `hypereels.thesquids.ink` through the Cloudflare edge → existing tunnel → NPM at 192.168.1.123 → CT 113 API at 192.168.1.136:3001.

### Option B — Edit Tunnel Config YAML

If Cloudflare-Tron uses a config file (check the Cloudflare-Tron container config in Unraid for the config path), add this ingress rule:

```yaml
ingress:
  # HypeReels — add before the catch-all rule
  - hostname: hypereels.thesquids.ink
    service: http://192.168.1.123
    originRequest:
      httpHostHeader: hypereels.thesquids.ink
      noTLSVerify: true
  # ... existing rules ...
  - service: http_status:404
```

After editing the YAML, restart the Cloudflare-Tron container in Unraid to apply the change.

### Verify External Access

From outside the LAN (e.g., mobile data or a VPN exit node):

```bash
curl -I https://hypereels.thesquids.ink/health
# Expected: HTTP/2 200
```

---

## 7. Prometheus and Grafana Integration

The existing Prometheus and Grafana stack runs on Quorra. Add HypeReels as one scrape target and one dashboard.

### Add Prometheus Scrape Target

**Prerequisite — `--web.enable-lifecycle` flag:**
The hot-reload endpoint (`POST /-/reload`) only works when Prometheus is started with the `--web.enable-lifecycle` flag. Verify this is already set on the existing Quorra Prometheus container:

```bash
# On Quorra — check if the flag is present
docker inspect prometheus | grep -o -- '--web.enable-lifecycle'
# Expected output: --web.enable-lifecycle
# If missing, add the flag to the Prometheus container's command args in Unraid
# (edit the container template in Unraid UI or docker-compose, then restart Prometheus).
# TODO: operator must verify --web.enable-lifecycle is set on the existing Prometheus container
```

Find the exact path to Prometheus config and rules directories:

```bash
# On Quorra
docker inspect prometheus | python3 -c "
import sys, json
mounts = json.load(sys.stdin)[0]['Mounts']
for m in mounts: print(m['Source'], '->', m['Destination'])
"
# Look for the mount whose Destination is /etc/prometheus or similar.
# That Source path is where you add entries to prometheus.yml and create the rules/ subdir.
```

Edit the discovered `prometheus.yml` on Quorra:

```yaml
# Add to scrape_configs section — do NOT replace existing targets
- job_name: 'hypereels-api'
  static_configs:
    - targets: ['192.168.1.136:3001']
  metrics_path: '/metrics'
  scrape_interval: 15s
  scrape_timeout: 10s

# Also add the Python workers health endpoint for worker availability alerting
- job_name: 'hypereels-workers'
  static_configs:
    - targets: ['192.168.1.100:8000']
  metrics_path: '/metrics'
  scrape_interval: 30s
  scrape_timeout: 10s
```

Ensure the `rule_files:` stanza in `prometheus.yml` includes the HypeReels alert rules file (see alert rules section below):

```yaml
rule_files:
  # ... existing entries ...
  - "rules/hypereels.yml"
```

Reload Prometheus (no restart needed — requires `--web.enable-lifecycle`):

```bash
curl -X POST http://192.168.1.100:9090/-/reload
# Expected: empty 200 response
```

Verify the target is up:

```bash
curl -s http://192.168.1.100:9090/api/v1/targets | \
  python3 -c "import sys,json; [print(t['labels']['job'], t['health']) for t in json.load(sys.stdin)['data']['activeTargets']]"
# Expected lines containing: hypereels-api up
#                             hypereels-workers up
```

### Grafana Dashboard

Import `docs/grafana-dashboard.json` into the existing Grafana instance:

1. Open Grafana at http://192.168.1.100:3000 (Quorra Docker)
2. Navigate to Dashboards → Import
3. Upload `docs/grafana-dashboard.json`
4. Select the existing Prometheus data source
5. Click Import

The dashboard includes these panels:

| Panel | Query | Type |
|-------|-------|------|
| HTTP Request Rate | `rate(http_requests_total[5m])` by endpoint | Graph |
| HTTP p95 Latency | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` | Graph |
| BullMQ Queue Depth | `bullmq_queue_depth` by queue name | Gauge |
| BullMQ Job Rate | `rate(hypereel_jobs_completed_total[5m])` by status | Graph |
| Active Sessions | `hypereel_sessions_active` | Stat |
| MinIO Storage Used | `minio_bucket_usage_total_bytes` | Stat |

### Key Metrics Exposed by CT 113

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `hypereel_sessions_active` | Gauge | — | Current active session count |
| `hypereel_jobs_queued_total` | Counter | `queue` | Jobs enqueued per queue |
| `hypereel_jobs_completed_total` | Counter | `queue`, `status` | Completed/failed jobs |
| `hypereel_job_duration_seconds` | Histogram | `queue` | Processing latency |
| `hypereel_upload_bytes_total` | Counter | — | Total bytes ingested |
| `hypereel_minio_objects_total` | Gauge | — | Current MinIO object count |

---

## 8. Backup and Restore Runbook

### Backup Strategy

#### PostgreSQL — Nightly pg_dump (Quorra)

PostgreSQL runs as a Docker container on Quorra. The backup cron runs on Quorra (not via `pct exec`) and connects to the container over `192.168.1.100:7432`.

Cron entry on Quorra (edit with `crontab -e` as root):

```bash
# /etc/cron.d/hypereels-backup
# Nightly PostgreSQL dump at 02:00
# PGPASSWORD must be set so pg_dump does not hang waiting for interactive input in cron.
0 2 * * * root PGPASSWORD=<POSTGRES_PASSWORD> /usr/bin/pg_dump \
  -h 192.168.1.100 -p 7432 -U hypereels hypereels | \
  gzip > /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz && \
  /usr/local/bin/mc cp /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz \
    local/hypereels/backups/postgres/ && \
  rm -f /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz
```

> **Note:** Replace `<POSTGRES_PASSWORD>` with the actual password, or store it in a root-owned, 600-mode file (e.g., `/root/.pgpass`) and use the `.pgpass` mechanism instead to avoid the password appearing in the cron file.

Install `mc` on Quorra and configure the alias (points at MinIO CT 115):

```bash
wget -O /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x /usr/local/bin/mc
mc alias set local http://192.168.1.138:9000 <MINIO_ACCESS_KEY> <MINIO_SECRET_KEY>
```

#### Redis — Weekly AOF copy (run from Quorra, pulls file from CT 114 via scp)

`mc` is NOT installed on CT 114 (minimal Redis LXC). The backup cron runs on **Quorra**, copies the AOF from CT 114 over scp, then uploads to MinIO via `mc`.

Prerequisite: passwordless SSH from Quorra root to CT 114:

```bash
# On Quorra — copy Quorra's root SSH public key to CT 114
ssh-copy-id root@192.168.1.137
# Or manually append /root/.ssh/id_rsa.pub to /root/.ssh/authorized_keys on CT 114
```

Cron entry on Quorra (edit with `crontab -e` as root):

```bash
# /etc/cron.d/hypereels-redis-backup (on Quorra)
# Weekly Redis AOF backup every Sunday at 03:00
0 3 * * 0 root \
  scp root@192.168.1.137:/var/lib/redis/appendonly.aof \
    /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof && \
  gzip /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof && \
  /usr/local/bin/mc cp /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof.gz \
    local/hypereels/backups/redis/ && \
  rm -f /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof.gz
```

#### Proxmox CT Snapshots — Weekly

Run on the Proxmox host (192.168.1.122). Snapshots cover CT 113 (API), CT 114 (Redis), and CT 115 (MinIO). PostgreSQL data lives on Quorra and is covered by the nightly `pg_dump` backup above.

```bash
# /etc/cron.d/hypereels-pct-snapshots
# Weekly snapshots every Saturday at 04:00
0 4 * * 6 root \
  pct snapshot 113 weekly-$(date +\%Y\%m\%d) --description "Weekly snapshot" && \
  pct snapshot 114 weekly-$(date +\%Y\%m\%d) --description "Weekly snapshot" && \
  pct snapshot 115 weekly-$(date +\%Y\%m\%d) --description "Weekly snapshot"
```

Retain only the last 4 snapshots per CT (delete older ones manually or add a pruning script).

#### MinIO Config — Monthly Rclone to Unraid Array

This backs up the MinIO configuration and policies only — not session data (which is ephemeral by design):

```bash
# On Quorra — install rclone and configure an rclone remote named "unraid-array"
# /etc/cron.d/hypereels-minio-config-backup (on Quorra)
0 5 1 * * root rclone copy /mnt/cache/appdata/hypereels/config \
  unraid-array:/mnt/user/backups/hypereels/minio-config/$(date +\%Y\%m)/
```

### Restore Procedures

#### Restore PostgreSQL

PostgreSQL runs on Quorra. Restore connects directly to `192.168.1.100:7432`.

```bash
# 1. Download backup from MinIO (run on Quorra or any LAN host with mc configured)
mc cp local/hypereels/backups/postgres/hypereels-postgres-YYYYMMDD.sql.gz /tmp/

# 2. Drop and recreate database (destructive — ensure no active connections)
# Run on Quorra or any host with psql access
psql -h 192.168.1.100 -p 7432 -U hypereels -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='hypereels';"
psql -h 192.168.1.100 -p 7432 -U hypereels -d postgres \
  -c "DROP DATABASE hypereels;"
psql -h 192.168.1.100 -p 7432 -U hypereels -d postgres \
  -c "CREATE DATABASE hypereels OWNER hypereels;"

# 3. Restore
gunzip -c /tmp/hypereels-postgres-YYYYMMDD.sql.gz | \
  psql -h 192.168.1.100 -p 7432 -U hypereels -d hypereels
```

#### Restore Redis

```bash
# Run from Quorra (mc is installed here; CT 114 has no mc)

# 1. Download backup from MinIO to Quorra
/usr/local/bin/mc cp local/hypereels/backups/redis/hypereels-redis-YYYYMMDD.aof.gz /tmp/
gunzip /tmp/hypereels-redis-YYYYMMDD.aof.gz

# 2. Stop Redis on CT 114
pct exec 114 -- systemctl stop redis-server

# 3. Copy AOF from Quorra to CT 114
scp /tmp/hypereels-redis-YYYYMMDD.aof root@192.168.1.137:/var/lib/redis/appendonly.aof
ssh root@192.168.1.137 "chown redis:redis /var/lib/redis/appendonly.aof"

# 4. Restart Redis on CT 114
pct exec 114 -- systemctl start redis-server

# 5. Clean up temp file on Quorra
rm -f /tmp/hypereels-redis-YYYYMMDD.aof
```

#### Restore from Proxmox Snapshot

```bash
# On Proxmox host — list snapshots
pct listsnapshot 113

# Roll back to a snapshot (stops and restores the CT)
pct rollback 113 weekly-YYYYMMDD

# Restart
pct start 113
```

---

## 9. Startup and Shutdown Runbook

### Start Order

Services must start in dependency order: PostgreSQL before API (API needs DB on boot), Redis before API (BullMQ needs Redis), MinIO before workers (workers read/write objects).

```
hypereels-postgres (Quorra Docker) → CT 114 (Redis) → CT 115 (MinIO) → CT 113 (API) → Quorra workers
```

**Full startup sequence:**

```bash
# Step 1 — Start PostgreSQL on Quorra (run from Proxmox host via SSH to Quorra)
ssh root@192.168.1.100 \
  "cd /mnt/cache/appdata/hypereels && \
   docker-compose -f docker-compose.workers.yml --env-file .env.workers up -d hypereels-postgres"
sleep 10
# Verify — run the health check *inside* Quorra over SSH, not locally
ssh root@192.168.1.100 "docker exec hypereels-postgres pg_isready -U hypereels -d hypereels"
# Expected: /var/run/postgresql:5432 - accepting connections

# Step 2 — Start Redis (run on Proxmox host)
pct start 114
sleep 5
# Verify
pct exec 114 -- redis-cli -h 192.168.1.137 -a '<REDIS_PASSWORD>' PING
# Expected: PONG

# Step 3 — Start MinIO (run on Proxmox host)
pct start 115
sleep 10
# Verify
curl -sf http://192.168.1.138:9000/minio/health/live && echo "MinIO healthy"

# Step 4 — Start API (run on Proxmox host)
pct start 113
sleep 15
# Verify
curl -sf http://192.168.1.136:3001/health
# Expected: {"status":"ok"}

# Step 5 — Start Quorra workers (run on Quorra or via SSH)
ssh root@192.168.1.100 \
  "cd /mnt/cache/appdata/hypereels && \
   docker-compose -f docker-compose.workers.yml --env-file .env.workers up -d"

# Verify workers
curl -sf http://192.168.1.100:8000/health
# Expected: {"status":"ok"}
```

### Stop Order

Drain in-flight jobs before stopping workers; stop API before data services. PostgreSQL on Quorra stops last.

```
Quorra workers → CT 113 (API) → CT 115 (MinIO) → CT 114 (Redis) → hypereels-postgres (Quorra Docker)
```

**Full shutdown sequence:**

```bash
# Step 1 — Stop Quorra Python workers (drain in-flight jobs first)
ssh root@192.168.1.100 \
  "cd /mnt/cache/appdata/hypereels && \
   docker-compose -f docker-compose.workers.yml stop \
     hypereels-worker-detection hypereels-worker-audio hypereels-worker-assembly"
# Allow up to 60 seconds for in-flight jobs to complete before force-stop

# Step 2 — Stop API (stops accepting new requests; cleanup workers finish)
pct exec 113 -- pm2 stop hypereels-api
sleep 10
pct stop 113

# Step 3 — Stop MinIO
pct stop 115

# Step 4 — Stop Redis (AOF ensures queued jobs survive)
pct stop 114

# Step 5 — Stop PostgreSQL on Quorra
ssh root@192.168.1.100 \
  "cd /mnt/cache/appdata/hypereels && \
   docker-compose -f docker-compose.workers.yml stop hypereels-postgres"
```

### Autostart Verification

After a host reboot, all LXC containers on Case should start automatically (Proxmox autostart enabled at `--onboot 1`). The `hypereels-postgres` Docker container on Quorra starts automatically via `restart: unless-stopped`. Verify:

```bash
# On Proxmox host — list all containers and their running state
pct list

# Check autostart is enabled for all 3 HypeReels CTs on Case
for id in 113 114 115; do
  echo -n "CT $id onboot: "
  pct config $id | grep onboot
done

# On Quorra — verify hypereels-postgres is running
ssh root@192.168.1.100 "docker ps --filter name=hypereels-postgres"
```

---

## 10. Monitoring and Alerting

Alerting rules are defined in `docs/prometheus-alerts.yml`. Load into the existing Prometheus instance on Quorra.

### Alert Summary

| Alert | Condition | Severity |
|-------|-----------|----------|
| HypeReelsAPIDown | No scrape for > 2 minutes | critical |
| HypeReelsQueueDepthHigh | Any queue depth > 10 for > 5 minutes | warning |
| HypeReelsPostgresConnectionsHigh | PG connections > 80 | warning |
| HypeReelsMinIOStorageHigh | MinIO storage > 80% of 899 GB | warning |
| HypeReelsSessionCleanupStale | Cleanup job not run in > 25 hours | warning |
| HypeReels5xxRateHigh | 5xx error rate > 1% over 5 minutes | warning |
| HypeReelsBucketGrowthAnomaly | Bucket grows > 50 GB in 1 hour | critical |

### Load Alert Rules

Copy `docs/prometheus-alerts.yml` to the Prometheus rules directory on Quorra and reload.

First, find the exact path where the Prometheus config lives on Quorra:

```bash
# On Quorra — find the host-side mount for /etc/prometheus (or equivalent)
PROM_CONFIG_DIR=$(docker inspect prometheus | python3 -c "
import sys, json
mounts = json.load(sys.stdin)[0]['Mounts']
for m in mounts:
    if '/etc/prometheus' in m['Destination'] or m['Destination'] == '/prometheus':
        print(m['Source'])
        break
")
echo "Prometheus config dir: $PROM_CONFIG_DIR"
# TODO: operator must verify this path matches their Prometheus container config mount
```

Copy the rules file and ensure `prometheus.yml` references it:

```bash
# Create rules subdirectory if it doesn't exist
mkdir -p "$PROM_CONFIG_DIR/rules"

# Copy alert rules from repo (run from the repo directory on Quorra, or scp the file over)
cp docs/prometheus-alerts.yml "$PROM_CONFIG_DIR/rules/hypereels.yml"

# Ensure prometheus.yml includes the rules file (add if missing):
# rule_files:
#   - "rules/hypereels.yml"
grep -q "rules/hypereels.yml" "$PROM_CONFIG_DIR/prometheus.yml" \
  || echo '  - "rules/hypereels.yml"' >> "$PROM_CONFIG_DIR/prometheus.yml"

# Reload Prometheus (requires --web.enable-lifecycle — see Section 7)
curl -X POST http://192.168.1.100:9090/-/reload

# Verify rules loaded
curl -s http://192.168.1.100:9090/api/v1/rules | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
groups = data['data']['groups']
hr = [r['name'] for g in groups for r in g['rules'] if g['name'] == 'hypereels']
print('Loaded rules:', hr if hr else 'NONE — check rule_files stanza in prometheus.yml')
"
```

### Uptime Check

The API `/health` endpoint responds with `{"status":"ok"}` when PostgreSQL, Redis, and MinIO are all reachable. Prometheus scrapes this via the metrics path every 15 seconds.

For external uptime monitoring, add `https://hypereels.thesquids.ink/health` as a Cloudflare Health Check in the Zero Trust dashboard (free tier supports this).

---

## 11. Known Issues and Relevant ADRs

### ADR-013 — InsightFace CPU-Only (GPU Contention)

**Summary:** Frigate NVR, FileFlows, and HypeReels InsightFace all share the single GTX 1080 Ti on Quorra. Frigate and FileFlows are critical infrastructure; InsightFace runs CPU-only to avoid preempting them.

**Operational impact:**
- Person detection is 5–10x slower than GPU mode (~30–60s per clip-minute vs ~4–6s)
- BullMQ `person-detection` queue concurrency is limited to 1 to prevent CPU saturation
- Detection time for a 5-minute clip: 2.5–5 minutes (fully async; user sees SSE progress)
- No operator intervention required under normal load

**Tuning levers:**
- `INSIGHTFACE_COSINE_THRESHOLD` (default: 0.45) — lower to merge more faces across clips; raise to reduce false merges
- BullMQ concurrency: currently 1 for `person-detection`; do not raise without monitoring Quorra CPU load

**Upgrade path:** Add GPU support in a future sprint by adding `deploy.resources.reservations.devices` to the `worker-detection` service in `workers/docker-compose.workers.yml`. No application code changes required.

### ADR-014 — NPM as Shared Reverse Proxy

**Summary:** CT 100 (Nginx Proxy Manager) is a shared infrastructure component serving multiple proxy hosts for `thesquids.ink`. HypeReels adds exactly one proxy host entry.

**Operational rules:**
- Do NOT modify CT 100's global Nginx config in ways that affect other proxy hosts
- Do NOT recreate or replace CT 100 — it is shared infrastructure
- When troubleshooting HypeReels proxy issues, scope changes to the HypeReels proxy host only
- NPM web UI access: http://192.168.1.123:81 (requires NPM admin credentials)

**Adding the proxy host:** See Section 5 of this document.

### ADR-015 — Cloudflare Tunnel for External Access

**Summary:** External access to `hypereels.thesquids.ink` is provided by the existing Cloudflare-Tron tunnel on Quorra. No firewall port forwarding is required.

**Operational rules:**
- Do NOT create a new Cloudflare tunnel — extend the existing one
- If external access is unavailable, check: (a) Cloudflare-Tron container is running on Quorra, (b) the public hostname is configured in the Zero Trust dashboard, (c) NPM is running on CT 100
- LAN users can always access HypeReels directly via http://192.168.1.136:3001 or http://192.168.1.123 (NPM) even if the tunnel is down

**Update procedure:** See Section 6 of this document.

### CT 108 Reserved for ntfy

CT 108 (192.168.1.131) is reserved for a planned ntfy push notification server and is NOT available for HypeReels. This is why HypeReels LXC containers begin at CT 113. Do not create CT 108 without planning for ntfy integration.

### MinIO Ephemeral Compliance

All session objects are tagged `session_ttl=true` at upload time. The ILM lifecycle rule deletes tagged objects after 48 hours as a safety net. The primary deletion mechanism is the Cleanup Worker, which runs within 5 minutes of download confirmation.

**Audit trail:** Each deletion event logs `{session_id_hash: sha256(session_id), deleted_at, file_count}` — no filenames or user-identifiable content.

**Operator checklist for ephemeral compliance:**
- [ ] Verify ILM rule is active: `mc ilm rule ls local/hypereels`
- [ ] Monitor bucket total size — unexpected growth indicates cleanup failures
- [ ] Check `cleanup_failures` table in PostgreSQL for unresolved entries: `SELECT * FROM cleanup_failures WHERE resolved_at IS NULL;`
- [ ] Alert: `HypeReelsBucketGrowthAnomaly` fires if bucket grows > 50 GB in 1 hour

---

## 12. Local Development

The local development stack uses `docker-compose.yml` at the repo root. It runs all services (PostgreSQL, Redis, MinIO, API, Python workers) in Docker containers on a developer laptop.

### Start Local Stack

```bash
# From repo root
cp .env.example .env
# Edit .env if needed (defaults work for local dev)

docker-compose up -d

# Verify all services healthy
docker-compose ps
curl -sf http://localhost:3001/health
curl -sf http://localhost:8000/health
```

### Local vs Production Differences

| Concern | Local Dev | Production |
|---------|-----------|------------|
| PostgreSQL | Docker container, no password | Quorra Docker (hypereels-postgres), strong password |
| Redis | Docker container, no auth | CT 114, requirepass set |
| MinIO | Docker container, minioadmin/minioadmin | CT 115, dedicated service account |
| TLS | None (localhost) | Cloudflare + NPM Let's Encrypt |
| Process manager | docker-compose restart | PM2 + systemd |
| Workers | Single container, all workers | docker-compose.workers.yml on Quorra |
| Metrics | /metrics on :3001 (local only) | Scraped by Quorra Prometheus |

### Run Tests

```bash
# Unit tests (TypeScript)
npm run test:unit

# Integration tests (requires docker-compose stack running)
docker-compose up -d
npm run test:integration

# Python unit tests
cd workers && pytest tests/ -v

# Infrastructure smoke tests (against production — requires LAN access)
# See Section 7 of test-plan.md
```

---

## 13. Deployment Pipeline

There is no automated CI/CD pipeline for the on-premises MVP. Deployment is manual following this procedure. A GitHub Actions workflow (`infra/ci.yml`) is provided for future use when a runner is configured.

### Manual Deployment to Production

#### Case — API Server (CT 113)

```bash
# SSH into CT 113 (or use pct exec)
pct exec 113 -- bash -c "
  cd /opt/hypereels/app
  git fetch origin
  git checkout main
  git pull origin main
  cd server && npm ci --omit=dev
  npm run build
  pm2 reload hypereels-api --update-env
"

# Verify
curl -sf http://192.168.1.136:3001/health
```

#### Quorra — Python Workers

```bash
# SSH into Quorra
ssh root@192.168.1.100

cd /mnt/cache/appdata/hypereels

# Pull updated code (or copy via scp from dev machine)
git -C /path/to/hypereels-repo pull origin main

# Rebuild and redeploy workers (rolling — pulls and restarts)
docker-compose -f docker-compose.workers.yml --env-file .env.workers \
  up -d --build --force-recreate

# Verify
docker ps --filter name=hypereels
curl -sf http://localhost:8000/health
```

### Smoke Test After Deployment

```bash
# Run all infrastructure smoke tests
API=http://192.168.1.136:3001

# 1. API health
curl -sf $API/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'"
echo "API: ok"

# 2. PostgreSQL (via API health check — API returns unhealthy if DB unreachable)
curl -sf $API/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('DB:', d.get('db', 'ok'))"

# 3. Redis
redis-cli -h 192.168.1.137 -a '<REDIS_PASSWORD>' PING

# 4. MinIO bucket
mc ls local/hypereels

# 5. MinIO ILM
mc ilm rule ls local/hypereels | grep "session_ttl"

# 6. NPM proxy
curl -sf https://hypereels.thesquids.ink/health

# 7. Prometheus scraping
curl -s http://192.168.1.100:9090/api/v1/targets | \
  python3 -c "
import sys, json
targets = json.load(sys.stdin)['data']['activeTargets']
ht = [t for t in targets if 'hypereels' in t['labels'].get('job','')]
print('Prometheus target:', ht[0]['health'] if ht else 'NOT FOUND')
"

# 8. Python workers
curl -sf http://192.168.1.100:8000/health
```

---

## Appendix: Secrets Reference

All secrets below must be set in the appropriate location before deployment. Never commit actual values to version control.

| Secret | Location | Used By |
|--------|----------|---------|
| PostgreSQL password | CT 113 `.env` (`DATABASE_URL`) and `workers/.env.workers` (`POSTGRES_PASSWORD`) | API, workers, hypereels-postgres Docker env |
| Redis password | CT 113 `.env` (`REDIS_URL`) and CT 114 `redis.conf` | API, workers |
| MinIO access key | CT 113 `.env` (`MINIO_ACCESS_KEY_ID` / `R2_ACCESS_KEY_ID`) and CT 115 `/etc/minio/minio.env` (as `MINIO_ROOT_USER`) | API, workers |
| MinIO secret key | CT 113 `.env` (`MINIO_SECRET_ACCESS_KEY` / `R2_SECRET_ACCESS_KEY`) and CT 115 `/etc/minio/minio.env` (as `MINIO_ROOT_PASSWORD`) | API, workers |
| MinIO backup key | Quorra `mc alias` config | Backup cron jobs (pg_dump cron on Quorra) |
| Cloudflare tunnel token | Cloudflare-Tron container config on Quorra | External access |
| NPM admin password | NPM web UI (built-in auth) | Proxy host management |
