# Profile 1 — CPU-Only (Single Machine)

> **Deployment overview:** All HypeReels services run on a single machine — no GPU required. PostgreSQL, Redis, MinIO, the Fastify API, and all Python workers are co-located. Two paths are available: Proxmox LXC (three containers) or Docker Compose (all-in-one). InsightFace runs CPU-only.

---

> ### Reference Implementation
>
> **Case** (Proxmox host, CPU-only): Dual Xeon X5650, 144 GB RAM, ZFS storage.
> The instructions below are written generically for any self-hoster. Case-specific IPs and pool names appear only here.
>
> | Service | CT ID | IP | Storage pool |
> |---------|-------|----|--------------|
> | API + PostgreSQL + Redis | CT 113 | 192.168.1.136 | vm_storage |
> | MinIO | CT 115 | 192.168.1.138 | storage_1tb (899 GB ZFS) |
>
> Replace all `<PLACEHOLDER>` values with your own network addresses and pool names when following the guide below.

---

## Hardware Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| CPU | 4 cores / 8 threads at 2.0 GHz | 8+ cores |
| RAM | 8 GB | 16 GB |
| Storage — OS + services | 30 GB | 50 GB SSD |
| Storage — data volume (MinIO) | 200 GB | 500 GB+ (ZFS pool or dedicated volume) |
| Network | Static IP or DHCP reservation | Gigabit LAN |
| GPU | None required | — |

**Required software (choose one path):**
- **Proxmox path:** Proxmox VE 8.x or 9.x
- **Docker Compose path:** Docker Engine 24+ with Docker Compose v2 (any Linux distro)

---

## Path A: Docker Compose (Recommended for Most Self-Hosters)

This is the easiest deployment path. A single `docker-compose.yml` starts all services. Works on any Linux machine with Docker installed — no Proxmox required.

### A1. Install Docker Engine

```bash
# Install Docker Engine (Debian/Ubuntu)
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

### A2. Clone the Repo

```bash
mkdir -p /opt/hypereels
git clone https://github.com/<ORG>/hypereels.git /opt/hypereels/app
cd /opt/hypereels/app
```

### A3. Configure Environment Files

```bash
# Main .env — API and shared config
cat > /opt/hypereels/app/.env << 'EOF'
# ── Database (Docker service name) ────────────────────────────────────────────
DATABASE_URL=postgresql://hypereels:<POSTGRES_PASSWORD>@hypereels-postgres:5432/hypereels
DATABASE_SSL=false

# ── Redis (Docker service name) ───────────────────────────────────────────────
REDIS_URL=redis://:<REDIS_PASSWORD>@hypereels-redis:6379
REDIS_PASSWORD=<REDIS_PASSWORD>

# ── MinIO ─────────────────────────────────────────────────────────────────────
# Internal (service-to-service) endpoint uses Docker service name
MINIO_ENDPOINT=http://hypereels-minio:9000
MINIO_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
MINIO_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
MINIO_BUCKET=hypereels
# Public URL must use the HOST IP — presigned URLs are resolved by the browser,
# which is outside the Docker network. Replace <HOST_IP> with your machine's LAN IP.
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

# ── InsightFace (CPU-only) ────────────────────────────────────────────────────
INSIGHTFACE_MODEL=buffalo_l
INSIGHTFACE_PROVIDERS=CPUExecutionProvider
INSIGHTFACE_COSINE_THRESHOLD=0.45

# ── FFmpeg (software encoding) ────────────────────────────────────────────────
FFMPEG_CRF=20
FFMPEG_PRESET=fast
FFMPEG_MAX_WIDTH=1920
# FFMPEG_HWACCEL is not set — software (x264) encoding is the default

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

# PostgreSQL container env
cat > /opt/hypereels/app/.env.postgres << 'EOF'
POSTGRES_DB=hypereels
POSTGRES_USER=hypereels
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
EOF
chmod 600 /opt/hypereels/app/.env.postgres

# Redis container env
cat > /opt/hypereels/app/.env.redis << 'EOF'
REDIS_PASSWORD=<REDIS_PASSWORD>
EOF
chmod 600 /opt/hypereels/app/.env.redis

# MinIO container env
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

### A4. Build the SPA

```bash
cd /opt/hypereels/app/client
npm install
npm run build
# Copy output to API's static serving directory
cp -r dist ../server/client-dist
```

### A5. docker-compose.yml

Save this as `/opt/hypereels/app/docker-compose.yml` (CPU-only profile — no GPU sections):

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
      - hypereels-postgres-data:/var/lib/postgresql/data
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
      - hypereels-minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - hypereels

  # ── Python Worker (CPU-only — no GPU sections) ────────────────────────────────
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
      # CPU-only InsightFace — explicitly set (no GPU required)
      - INSIGHTFACE_PROVIDERS=CPUExecutionProvider
    volumes:
      - /tmp/hypereels:/tmp/hypereels
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
  hypereels-postgres-data:
  hypereels-redis-data:
  hypereels-minio-data:
```

### A6. Start Services

```bash
cd /opt/hypereels/app

# Build images
docker compose build

# Start all services
docker compose up -d

# Check status
docker compose ps
```

### A7. Run Migrations (First Boot Only)

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

# Verify tables
docker exec hypereels-postgres psql -U hypereels -d hypereels -c "\dt"
```

### A8. Create MinIO Bucket and Lifecycle Rule

```bash
source /opt/hypereels/app/.env.minio

docker exec hypereels-minio mc alias set local http://localhost:9000 \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
docker exec hypereels-minio mc mb --ignore-existing local/hypereels
docker exec hypereels-minio mc ilm rule add local/hypereels \
  --expire-days 2 --tags "session_ttl=true"
docker exec hypereels-minio mc ilm rule ls local/hypereels
```

### A9. Reverse Proxy

The API listens on port 3001. Point your reverse proxy at `http://<HOST_IP>:3001`.

See [Section 8 in Path B](#8-reverse-proxy) for Nginx Proxy Manager and Caddy examples — they apply equally to the Docker Compose path.

---

## Path B: Proxmox LXC

Three LXC containers on a single Proxmox host. PostgreSQL and Redis run natively (apt) in CT 200 alongside the API, avoiding the Redis systemd sandboxing issue that affects separate unprivileged LXCs. Python workers run as a combined Docker container in a privileged LXC (CT 201). MinIO runs in CT 202.

### Service Layout

| CT ID | Role | RAM | Disk | IP |
|-------|------|-----|------|----|
| CT 200 | `hypereels-api` — Fastify API + PostgreSQL (apt) + Redis (apt) | 6 GB | 20 GB | `<API_LXC_IP>` |
| CT 201 | `hypereels-worker` — Python workers (Docker, combined) | 8 GB | 10 GB | `<WORKER_LXC_IP>` |
| CT 202 | `hypereels-minio` — MinIO object storage | 4 GB | 200 GB+ (ZFS pool) | `<MINIO_LXC_IP>` |

**Key design decisions:**
- PostgreSQL and Redis in CT 200 avoid an extra LXC and sidestep the Redis systemd sandboxing problem — no unit override needed since Redis runs in the same LXC context as the API.
- CT 201 is a **privileged** LXC — this is required to run Docker Engine inside an LXC.
- Process management: systemd `EnvironmentFile` (NOT PM2 — see warning below).
- SPA is served by `@fastify/static` from `server/client-dist/`.

---

## 1. Prerequisites

- **Proxmox VE 8.x or 9.x** installed and reachable at `https://<PROXMOX_HOST_IP>:8006`
- LXC template downloaded: `debian-12-standard` (recommended) or `ubuntu-24.04-standard`
  ```bash
  pveam update
  pveam download local debian-12-standard_12.7-1_amd64.tar.zst
  ```
- Bridge `vmbr0` configured (default Proxmox bridge is fine)
- Storage pools:
  - A ZFS pool for MinIO data (200 GB+ recommended). Note the pool name — referred to as `<ZFS_POOL>` throughout.
  - A pool for LXC root volumes — referred to as `<ROOT_POOL>`.
- CT IDs 200–202 available (adjust if your environment uses different IDs)
- Network: LXC containers will get static IPs on your LAN. Choose three unused IPs and note them as `<API_LXC_IP>`, `<WORKER_LXC_IP>`, and `<MINIO_LXC_IP>`.
- A reverse proxy (Nginx Proxy Manager, Caddy, or Nginx) — see [Section 8](#8-reverse-proxy).

---

## 2. LXC Creation

Run all `pct create` commands on the **Proxmox host** as root.

### CT 200 — API + PostgreSQL + Redis

```bash
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hypereels-api \
  --cores 4 \
  --memory 6144 \
  --swap 1024 \
  --net0 name=eth0,bridge=vmbr0,ip=<API_LXC_IP>/24,gw=<GATEWAY_IP> \
  --storage <ROOT_POOL> \
  --rootfs <ROOT_POOL>:20 \
  --nameserver <DNS_IP> \
  --onboot 1 \
  --unprivileged 1 \
  --start 1
```

### CT 201 — Python Workers (Docker)

CT 201 must be **privileged** to run Docker Engine inside an LXC.

```bash
pct create 201 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hypereels-worker \
  --cores 8 \
  --memory 8192 \
  --swap 2048 \
  --net0 name=eth0,bridge=vmbr0,ip=<WORKER_LXC_IP>/24,gw=<GATEWAY_IP> \
  --storage <ROOT_POOL> \
  --rootfs <ROOT_POOL>:10 \
  --nameserver <DNS_IP> \
  --onboot 1 \
  --unprivileged 0 \
  --start 1
```

### CT 202 — MinIO

```bash
# Create ZFS dataset for MinIO data on the Proxmox host
zfs create <ZFS_POOL>/minio-data

# Create the LXC
pct create 202 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname hypereels-minio \
  --cores 2 \
  --memory 4096 \
  --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=<MINIO_LXC_IP>/24,gw=<GATEWAY_IP> \
  --storage <ROOT_POOL> \
  --rootfs <ROOT_POOL>:8 \
  --nameserver <DNS_IP> \
  --onboot 1 \
  --unprivileged 1 \
  --start 1

# Bind-mount the ZFS dataset into CT 202
pct set 202 --mp0 /<ZFS_POOL>/minio-data,mp=/data

# REQUIRED: Unprivileged LXC containers remap UIDs. Container root (UID 0) maps
# to host UID 100000. The ZFS dataset is owned by host root (UID 0:0), which is
# inaccessible from inside the container. Fix by chowning to the mapped UID:
chown -R 100000:100000 /<ZFS_POOL>/minio-data/
# This must be run on the Proxmox HOST (not inside the container).
# If you forget this step, MinIO will start but fail all writes with 'permission denied'.
```

---

## 3. CT 200 Setup — API + PostgreSQL + Redis

```bash
pct enter 200
```

### Install packages

```bash
apt-get update && apt-get upgrade -y
apt-get install -y curl git ca-certificates ffmpeg postgresql-client iptables-persistent

# Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# PostgreSQL 16 (or later) via apt
apt-get install -y postgresql postgresql-contrib

# Redis 7 via apt
apt-get install -y redis-server
```

### Configure PostgreSQL

```bash
# Start PostgreSQL
systemctl enable postgresql
systemctl start postgresql

# Create database and user
su - postgres -c "psql <<SQL
CREATE USER hypereels WITH PASSWORD '<POSTGRES_PASSWORD>';
CREATE DATABASE hypereels OWNER hypereels;
GRANT ALL PRIVILEGES ON DATABASE hypereels TO hypereels;
SQL"

# Allow connections from worker LXC (edit pg_hba.conf)
PG_VERSION=$(pg_lscluster | awk 'NR==2{print $1}')
PG_CONF="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"
echo "host    hypereels    hypereels    <WORKER_LXC_IP>/32    md5" >> "$PG_CONF"

# Listen on all interfaces (so workers in other LXCs can connect)
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" \
  /etc/postgresql/${PG_VERSION}/main/postgresql.conf

systemctl restart postgresql
```

### Configure Redis

```bash
# Redis runs on the same LXC as the API — no systemd unit override needed.
# The sandboxing issue (226/NAMESPACE) only applies when Redis is in a SEPARATE
# unprivileged LXC. Here it shares the context with the API LXC.

REDIS_CONF="/etc/redis/redis.conf"
# Bind to loopback + API LXC IP (workers in other LXCs access via API_LXC_IP)
sed -i "s/^bind 127.0.0.1.*/bind 127.0.0.1 <API_LXC_IP>/" "$REDIS_CONF"
sed -i "s/^# requirepass .*/requirepass <REDIS_PASSWORD>/" "$REDIS_CONF"
sed -i "s/^# maxmemory .*/maxmemory 512mb/" "$REDIS_CONF"
sed -i "s/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/" "$REDIS_CONF"
sed -i "s/^appendonly no/appendonly yes/" "$REDIS_CONF"

systemctl enable redis-server
systemctl start redis-server

# Verify Redis is up
redis-cli -h 127.0.0.1 -a '<REDIS_PASSWORD>' ping
# PONG
```

### Deploy application

```bash
# Create app user and directory
useradd -r -s /bin/bash -m -d /opt/hypereels hypereels
mkdir -p /opt/hypereels/app
chown hypereels:hypereels /opt/hypereels/app

# Clone repo (preferred — avoids macOS/Linux binary incompatibility from rsync/scp)
git clone https://github.com/<ORG>/hypereels.git /opt/hypereels/app
chown -R hypereels:hypereels /opt/hypereels/app

# Build TypeScript
cd /opt/hypereels/app/server
npm ci --omit=dev
npm run build

# Build SPA (see Section 7) and place output at server/client-dist/
# The API serves the SPA via @fastify/static from this directory.
```

> **Note on file transfer:** If you cannot clone directly into the container (no internet access), use rsync from your developer machine:
> ```bash
> rsync -av --exclude=node_modules --exclude='.git' server/ root@<API_LXC_IP>:/opt/hypereels/server/
> # --exclude=node_modules is critical — macOS-compiled .node binaries are incompatible with Linux.
> # Run npm ci inside CT 200 after the transfer.
> ```

### Create .env

```bash
cat > /opt/hypereels/app/.env << 'EOF'
# ── Database (local PostgreSQL) ───────────────────────────────────────────────
DATABASE_URL=postgresql://hypereels:<POSTGRES_PASSWORD>@127.0.0.1:5432/hypereels
DATABASE_SSL=false

# ── Redis (local Redis) ───────────────────────────────────────────────────────
REDIS_URL=redis://:<REDIS_PASSWORD>@127.0.0.1:6379
REDIS_PASSWORD=<REDIS_PASSWORD>

# ── MinIO (CT 202) ────────────────────────────────────────────────────────────
MINIO_ENDPOINT=http://<MINIO_LXC_IP>:9000
MINIO_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
MINIO_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
MINIO_BUCKET=hypereels
MINIO_PUBLIC_URL=http://<MINIO_LXC_IP>:9000/hypereels

# Legacy R2_* aliases — kept for internal SDK compatibility; mirrors MINIO_* above
R2_ENDPOINT=http://<MINIO_LXC_IP>:9000
R2_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
R2_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
R2_BUCKET=hypereels
R2_ACCOUNT_ID=local
R2_PUBLIC_URL=http://<MINIO_LXC_IP>:9000/hypereels

# ── API server ────────────────────────────────────────────────────────────────
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=https://<YOUR_DOMAIN>

# ── Python workers (CT 201) ───────────────────────────────────────────────────
PYTHON_WORKER_URL=http://<WORKER_LXC_IP>:8000
PYTHON_TIMEOUT_MS=300000
PYTHON_WORKER_AUDIO_TIMEOUT_MS=300000
PYTHON_WORKER_ASSEMBLY_TIMEOUT_MS=900000

# ── InsightFace (CPU-only) ────────────────────────────────────────────────────
INSIGHTFACE_MODEL=buffalo_l
INSIGHTFACE_PROVIDERS=CPUExecutionProvider
INSIGHTFACE_COSINE_THRESHOLD=0.45

# ── FFmpeg (software encoding) ────────────────────────────────────────────────
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
EOF

chmod 600 /opt/hypereels/app/.env
chown hypereels:hypereels /opt/hypereels/app/.env
```

### Run migrations

```bash
cd /opt/hypereels/app
for f in \
  server/src/db/migrations/001_initial_schema.sql \
  server/src/db/migrations/002_rename_r2_key_to_minio_key.sql \
  server/src/db/migrations/003_add_clip_validation.sql
do
  echo "Applying $f ..."
  PGPASSWORD=<POSTGRES_PASSWORD> psql \
    -h 127.0.0.1 -p 5432 -U hypereels -d hypereels \
    -f "$f"
done

# Verify tables exist
PGPASSWORD=<POSTGRES_PASSWORD> psql -h 127.0.0.1 -p 5432 -U hypereels -d hypereels -c "\dt"
```

### Install systemd unit

> **⚠️ PM2 WARNING:** PM2 does not load `.env` files. The `env_file` option in `ecosystem.config.cjs` is silently ignored. Use systemd with `EnvironmentFile` instead. PM2 is documented at the bottom of this section as a development-only alternative.

```bash
# PRODUCTION (recommended): Use systemd with EnvironmentFile
cp /opt/hypereels/app/server/hypereels-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable hypereels-api
systemctl start hypereels-api
systemctl status hypereels-api

# ALTERNATIVE (development only): PM2
# WARNING: Requires env vars to be set in the shell environment or inlined in ecosystem.config.cjs
# npm install -g pm2
# pm2 start /opt/hypereels/app/ecosystem.config.cjs
# pm2 save
```

### Firewall

```bash
# Restrict port 3001 to reverse proxy and workers only
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -p tcp --dport 3001 -s <REVERSE_PROXY_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 3001 -s <WORKER_LXC_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 3001 -j DROP
netfilter-persistent save
```

---

## 4. CT 201 Setup — Python Workers (Docker)

CT 201 is a privileged LXC. Enter it:

```bash
pct enter 201
```

### Install Docker Engine

```bash
apt-get update && apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key and repository
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

# Verify
docker run --rm hello-world
```

### Deploy workers

```bash
# Clone repo
git clone https://github.com/<ORG>/hypereels.git /opt/hypereels

# Create env file for workers
cat > /opt/hypereels/workers/.env << 'EOF'
DATABASE_URL=postgresql://hypereels:<POSTGRES_PASSWORD>@<API_LXC_IP>:5432/hypereels
DATABASE_SSL=false
REDIS_URL=redis://:<REDIS_PASSWORD>@<API_LXC_IP>:6379
R2_ENDPOINT=http://<MINIO_LXC_IP>:9000
R2_ACCESS_KEY_ID=<MINIO_SERVICE_ACCOUNT_KEY>
R2_SECRET_ACCESS_KEY=<MINIO_SERVICE_ACCOUNT_SECRET>
R2_BUCKET=hypereels
R2_ACCOUNT_ID=local
R2_PUBLIC_URL=http://<MINIO_LXC_IP>:9000/hypereels
PYTHON_WORKER_URL=http://<WORKER_LXC_IP>:8000
PORT=8000
FFMPEG_PATH=/usr/bin/ffmpeg
# CPU-only InsightFace — no GPU required
INSIGHTFACE_PROVIDERS=CPUExecutionProvider
EOF
chmod 600 /opt/hypereels/workers/.env

# Build and run the combined worker container (CPU-only — no --gpus all)
cd /opt/hypereels
docker build -t hypereels-workers:latest ./workers

docker run -d \
  --name hypereels-workers \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /tmp/hypereels:/tmp/hypereels \
  --env-file /opt/hypereels/workers/.env \
  hypereels-workers:latest

# Verify
curl http://localhost:8000/health
# {"status":"ok","service":"hypereels-python-worker"}
```

> **InsightFace model download:** On first run, the worker downloads the `buffalo_l` model pack (~500 MB) from the InsightFace CDN. This requires internet access from CT 201. If the container cannot reach the internet, pre-download the model and volume-mount it:
> ```bash
> # On a machine with internet access:
> pip install insightface
> python -c "import insightface; app = insightface.app.FaceAnalysis(name='buffalo_l'); app.prepare(ctx_id=-1)"
> # Copy ~/.insightface/models/buffalo_l/ to CT 201 and add:
> # -v /path/to/models:/root/.insightface/models
> ```

---

## 5. CT 202 Setup — MinIO

```bash
pct enter 202
```

### Install MinIO

```bash
apt-get update && apt-get install -y curl wget

# Install MinIO server binary
wget -O /usr/local/bin/minio https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x /usr/local/bin/minio

# Install mc (MinIO client)
wget -O /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x /usr/local/bin/mc

# Create MinIO service user and directories
useradd -r -s /sbin/nologin -M minio-user
mkdir -p /data /etc/minio
chown -R minio-user:minio-user /data /etc/minio
```

### Configure MinIO

```bash
cat > /etc/minio/minio.env << 'EOF'
MINIO_ROOT_USER=<MINIO_ROOT_USER>
MINIO_ROOT_PASSWORD=<MINIO_ROOT_PASSWORD>
MINIO_VOLUMES=/data
MINIO_OPTS="--console-address :9001"
EOF
chmod 600 /etc/minio/minio.env
chown minio-user:minio-user /etc/minio/minio.env
```

### Install systemd unit

```bash
cat > /etc/systemd/system/minio.service << 'EOF'
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
EnvironmentFile=/etc/minio/minio.env
ExecStartPre=/bin/bash -c "if [ -z \"${MINIO_VOLUMES}\" ]; then echo 'MINIO_VOLUMES not set'; exit 1; fi"
ExecStart=/usr/local/bin/minio server $MINIO_OPTS $MINIO_VOLUMES
Restart=always
LimitNOFILE=65536
TasksMax=infinity
TimeoutStopSec=infinity
SendSIGKILL=no

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable minio
systemctl start minio
```

### Create bucket and lifecycle rule

```bash
# Wait for MinIO to be ready
until curl -sf http://localhost:9000/minio/health/live > /dev/null 2>&1; do
  sleep 2
done
echo "MinIO is ready"

# Source env to get credentials
source /etc/minio/minio.env

# Configure alias and create bucket
# NOTE: mc is installed to /usr/local/bin/mc and is NOT on PATH by default — use the full path.
/usr/local/bin/mc alias set local http://<MINIO_LXC_IP>:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
/usr/local/bin/mc mb --ignore-existing local/hypereels

# Apply 48-hour ILM expiry to objects tagged session_ttl=true
/usr/local/bin/mc ilm rule add local/hypereels --expire-days 2 --tags "session_ttl=true"

# Verify
/usr/local/bin/mc ilm rule ls local/hypereels

# Health check
curl -sf http://<MINIO_LXC_IP>:9000/minio/health/live && echo "MinIO API healthy"
```

MinIO Console is accessible at `http://<MINIO_LXC_IP>:9001` — log in with `<MINIO_ROOT_USER>` / `<MINIO_ROOT_PASSWORD>`.

---

## 6. Environment Configuration

All secrets are consolidated in `/opt/hypereels/app/.env` on CT 200. The `.env` template was shown in [Section 3](#3-ct-200-setup--api--postgresql--redis). Replace all `<PLACEHOLDER>` values before starting services.

**Checklist:**
- [ ] `<POSTGRES_PASSWORD>` — strong random password (`openssl rand -base64 32`)
- [ ] `<REDIS_PASSWORD>` — strong random password
- [ ] `<MINIO_ROOT_USER>` — MinIO root access key (used for initial setup)
- [ ] `<MINIO_ROOT_PASSWORD>` — MinIO root secret key
- [ ] `<MINIO_SERVICE_ACCOUNT_KEY>` — create a service account in MinIO Console → Identity → Service Accounts (scoped to `hypereels` bucket read/write)
- [ ] `<MINIO_SERVICE_ACCOUNT_SECRET>` — service account secret
- [ ] `<YOUR_DOMAIN>` — your external domain (e.g. `hypereels.example.com`)
- [ ] `<API_LXC_IP>`, `<WORKER_LXC_IP>`, `<MINIO_LXC_IP>` — static IPs assigned in Section 2

---

## 7. SPA Build and Deploy

Build the frontend on your developer machine:

```bash
# From the repo root
cd client
npm install
npm run build
# Output in client/dist/
```

Copy the SPA build into the API's static serving directory:

```bash
# From the repo root on your developer machine
rsync -av --delete client/dist/ root@<API_LXC_IP>:/opt/hypereels/app/server/client-dist/
```

Or via git clone (the build output is in `client/dist/` — copy to `server/client-dist/` after cloning):

```bash
# Inside CT 200
cp -r /opt/hypereels/app/client/dist /opt/hypereels/app/server/client-dist
```

The API's `@fastify/static` plugin serves `server/client-dist/` at the root path. No separate Nginx LXC is needed for the SPA.

---

## 8. Reverse Proxy

Choose any reverse proxy that can terminate TLS and proxy to the API port. For Docker Compose deployments, the API is at `http://<HOST_IP>:3001`. For LXC deployments, the API is at `http://<API_LXC_IP>:3001`.

Options:
- **Nginx Proxy Manager** (recommended for homelab — GUI-based, Let's Encrypt built-in)
- **Caddy** (automatic HTTPS, minimal config)
- **Nginx** (full control)

### Pre-flight: Cloudflare Tunnel (if applicable)

If using a Cloudflare Zero Trust tunnel for external HTTPS access:

> **⚠️ IMPORTANT — Do this BEFORE requesting the Let's Encrypt certificate:**
>
> The Cloudflare tunnel public hostname must be configured BEFORE NPM completes the ACME HTTP-01 challenge. If the hostname is not in Cloudflare first, Let's Encrypt cannot reach your proxy and certificate issuance will fail.
>
> 1. Go to: https://one.dash.cloudflare.com → Networks → Tunnels
> 2. Select your tunnel → Configure → Public Hostnames → Add a public hostname
> 3. Set:
>    - Subdomain: `<YOUR_SUBDOMAIN>` (e.g., `hypereels`)
>    - Domain: `<YOUR_DOMAIN>` (e.g., `example.com`)
>    - Type: HTTP
>    - URL: `<REVERSE_PROXY_IP>` (your proxy's LAN IP)
> 4. Save and wait ~60 seconds for DNS propagation
> 5. Verify: `curl -I https://<YOUR_DOMAIN>` should reach the proxy (may 502 — that's fine)
> 6. NOW request the Let's Encrypt certificate in NPM

### Nginx Proxy Manager example

In NPM (http://`<NPM_IP>`:81), add a Proxy Host:

```
Domain Names:        <YOUR_DOMAIN>
Forward Hostname/IP: <API_LXC_IP>   (or <HOST_IP> for Docker Compose path)
Forward Port:        3001
Websockets Support:  ON  (required for SSE)
SSL Tab:             Request new Let's Encrypt certificate
Force SSL:           ON
HTTP/2 Support:      ON
```

Advanced tab (custom Nginx config):
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
  reverse_proxy <API_LXC_IP>:3001
  header Strict-Transport-Security "max-age=31536000"
}
```

---

## 9. Verification / Smoke Test

After all services are running:

```bash
# Replace <API_IP> with <API_LXC_IP> (Proxmox path) or <HOST_IP> (Docker path)
# Replace <WORKER_IP> with <WORKER_LXC_IP> (Proxmox path) or <HOST_IP> (Docker path)

# 1. API health (direct LAN)
curl http://<API_IP>:3001/health
# {"status":"ok"}

# 2. API health (via reverse proxy + domain)
curl https://<YOUR_DOMAIN>/health
# {"status":"ok"}

# 3. Python workers health
curl http://<WORKER_IP>:8000/health
# {"status":"ok","service":"hypereels-python-worker"}

# 4. Redis connectivity (Proxmox path)
redis-cli -h <API_LXC_IP> -a '<REDIS_PASSWORD>' ping
# PONG

# 4. Redis connectivity (Docker path)
docker exec hypereels-redis redis-cli -a '<REDIS_PASSWORD>' ping
# PONG

# 5. PostgreSQL connectivity (Proxmox path)
psql -h <API_LXC_IP> -p 5432 -U hypereels -d hypereels -c "SELECT NOW();"

# 5. PostgreSQL connectivity (Docker path)
docker exec hypereels-postgres pg_isready -U hypereels -d hypereels

# 6. MinIO Console
# Open http://<MINIO_LXC_IP>:9001  (Proxmox path)
# Open http://<HOST_IP>:9001        (Docker path)
# Log in with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# Confirm the "hypereels" bucket exists

# 7. UI
# Open https://<YOUR_DOMAIN> in your browser
# The HypeReels upload wizard should load
```

---

## 10. Backup

### PostgreSQL — nightly pg_dump

**Proxmox path** — run from CT 200 (PostgreSQL is local):

```bash
# Cron entry on CT 200 (crontab -e as root)
0 2 * * * PGPASSWORD=<POSTGRES_PASSWORD> /usr/bin/pg_dump \
  -h 127.0.0.1 -p 5432 -U hypereels hypereels | \
  gzip > /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz && \
  /usr/local/bin/mc cp /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz \
    local/hypereels/backups/postgres/ && \
  rm -f /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz
```

**Docker Compose path:**

```bash
# /etc/cron.d/hypereels-backup
0 2 * * * root docker exec hypereels-postgres pg_dump -U hypereels hypereels | \
  gzip > /opt/hypereels/backups/postgres-$(date +\%Y\%m\%d).sql.gz
```

### Redis — AOF persistence + weekly backup

Redis is configured with `appendonly yes` — data survives Redis restarts.

```bash
# Cron entry — weekly AOF snapshot (Proxmox path, CT 200)
0 3 * * 0 cp /var/lib/redis/appendonly.aof /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof && \
  gzip /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof && \
  /usr/local/bin/mc cp /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof.gz \
    local/hypereels/backups/redis/ && \
  rm -f /tmp/hypereels-redis-$(date +\%Y\%m\%d).aof.gz
```

### Proxmox CT Snapshots — weekly

```bash
# Cron entry on the Proxmox host (crontab -e as root)
0 4 * * 6 pct snapshot 200 weekly-$(date +\%Y\%m\%d) --description "Weekly snapshot" && \
           pct snapshot 201 weekly-$(date +\%Y\%m\%d) --description "Weekly snapshot" && \
           pct snapshot 202 weekly-$(date +\%Y\%m\%d) --description "Weekly snapshot"
```

Retain the last 4 snapshots per CT; delete older ones manually or with a pruning script.

---

## Troubleshooting

### MinIO writes fail with "permission denied"

The ZFS dataset was not chowned before the container started. On the **Proxmox host** (not inside CT 202):

```bash
chown -R 100000:100000 /<ZFS_POOL>/minio-data/
pct reboot 202
```

### Workers cannot reach API / Redis / MinIO

**Proxmox path** — verify CT 201 can reach CT 200 and CT 202:

```bash
pct exec 201 -- nc -zv <API_LXC_IP> 3001
pct exec 201 -- nc -zv <API_LXC_IP> 6379
pct exec 201 -- nc -zv <MINIO_LXC_IP> 9000
```

Check the iptables rules on CT 200 are not blocking worker traffic:

```bash
pct exec 200 -- iptables -L INPUT -n
```

**Docker Compose path** — verify containers are on the same network:

```bash
docker network inspect hypereels_hypereels
docker exec hypereels-worker curl http://hypereels-minio:9000/minio/health/live
```

### MinIO bucket not found

**Proxmox path:**
```bash
# Check the bind mount is active inside CT 202
pct exec 202 -- df -h /data

# If not mounted, re-attach and reboot
pct set 202 --mp0 /<ZFS_POOL>/minio-data,mp=/data
chown -R 100000:100000 /<ZFS_POOL>/minio-data/
pct reboot 202

# Re-create bucket if missing (full path required — mc is not on PATH)
pct exec 202 -- /usr/local/bin/mc alias set local http://<MINIO_LXC_IP>:9000 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
pct exec 202 -- /usr/local/bin/mc mb --ignore-existing local/hypereels
```

**Docker Compose path:**
```bash
docker exec hypereels-minio mc mb --ignore-existing local/hypereels
```

### InsightFace model download fails

On first run, the worker downloads `buffalo_l` (~500 MB) from the InsightFace CDN. If the container has no internet access, pre-download the model on a machine that does:

```bash
pip install insightface
python -c "import insightface; app = insightface.app.FaceAnalysis(name='buffalo_l'); app.prepare(ctx_id=-1)"
# Then volume-mount ~/.insightface/models into the container:
# -v /path/to/models:/root/.insightface/models
```

### MinIO presigned URLs not accessible from browser

`MINIO_PUBLIC_URL` (and `R2_PUBLIC_URL`) must use the **host's LAN IP**, not a Docker service name or `localhost`. Presigned URLs are resolved by the browser, which is outside the Docker network.

```bash
# For Docker Compose path, verify:
grep MINIO_PUBLIC_URL /opt/hypereels/app/.env
# Should be: MINIO_PUBLIC_URL=http://<HOST_IP>:9000/hypereels
```
