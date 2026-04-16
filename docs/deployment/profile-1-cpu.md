# Profile 1 — CPU Self-Hosted (Proxmox)

> **Deployment overview:** Three LXC containers on a single Proxmox host. No GPU required. InsightFace runs CPU-only. PostgreSQL and Redis run natively (apt) inside CT 200 alongside the API. Python workers run as a combined Docker container in a privileged LXC (CT 201). MinIO runs in CT 202 with a ZFS bind mount.

---

## Service Layout

| CT ID | Role | RAM | Disk | IP |
|-------|------|-----|------|----|
| CT 200 | `hypereels-api` — Fastify API + PostgreSQL (apt) + Redis (apt) | 6 GB | 20 GB | `<API_LXC_IP>` |
| CT 201 | `hypereels-worker` — Python workers (Docker, combined) | 8 GB | 10 GB | `<WORKER_LXC_IP>` |
| CT 202 | `hypereels-minio` — MinIO object storage | 4 GB | 200 GB+ (ZFS pool) | `<MINIO_LXC_IP>` |

**Key design decisions:**
- PostgreSQL and Redis in CT 200 avoid an extra LXC and sidestep the Redis systemd sandboxing problem — no unit override needed since Redis runs in the same LXC context as the API.
- CT 201 is a **privileged** LXC — this is required to run Docker Engine inside an LXC without needing the `nesting=1` workaround.
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

# Allow LAN connections (edit pg_hba.conf)
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
# git clone is the preferred approach: dependencies are installed natively in the container.
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
# Copy workers directory (preferred: clone repo)
git clone https://github.com/<ORG>/hypereels.git /opt/hypereels

# Or rsync (excludes node_modules):
# rsync -av --exclude=node_modules --exclude='.git' workers/ root@<WORKER_LXC_IP>:/opt/hypereels/workers/

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
> python -c "import insightface; app = insightface.app.FaceAnalysis(name='buffalo_l'); app.prepare(ctx_id=0)"
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
- [ ] `<POSTGRES_PASSWORD>` — strong random password
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

Choose any reverse proxy that can terminate TLS and proxy to `http://<API_LXC_IP>:3001`. Options:
- **Nginx Proxy Manager** (recommended for homelab — GUI-based, Let's Encrypt built-in)
- **Caddy** (automatic HTTPS, minimal config)
- **Nginx** (full control)

### Pre-flight: Cloudflare Tunnel (if applicable)

If using a Cloudflare Zero Trust tunnel for external HTTPS access:

> **⚠️ IMPORTANT — Do this BEFORE requesting the Let's Encrypt certificate:**
>
> The Cloudflare tunnel public hostname must be configured BEFORE NPM completes the ACME HTTP-01 challenge. If the hostname isn't in Cloudflare first, Let's Encrypt cannot reach your proxy and certificate issuance will fail.
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
Forward Hostname/IP: <API_LXC_IP>
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
# 1. API health (direct LAN)
curl http://<API_LXC_IP>:3001/health
# {"status":"ok"}

# 2. API health (via reverse proxy + domain)
curl https://<YOUR_DOMAIN>/health
# {"status":"ok"}

# 3. Python workers health
curl http://<WORKER_LXC_IP>:8000/health
# {"status":"ok","service":"hypereels-python-worker"}

# 4. Redis connectivity
redis-cli -h <API_LXC_IP> -a '<REDIS_PASSWORD>' ping
# PONG

# 5. PostgreSQL connectivity
psql -h <API_LXC_IP> -p 5432 -U hypereels -d hypereels -c "SELECT NOW();"

# 6. MinIO Console
# Open http://<MINIO_LXC_IP>:9001 in your browser
# Log in with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# Confirm the "hypereels" bucket exists

# 7. UI
# Open https://<YOUR_DOMAIN> in your browser
# The HypeReels upload wizard should load
```

---

## 10. Backup

### PostgreSQL — nightly pg_dump

Run from CT 200 (PostgreSQL is local):

```bash
# Cron entry on CT 200 (crontab -e as root)
0 2 * * * PGPASSWORD=<POSTGRES_PASSWORD> /usr/bin/pg_dump \
  -h 127.0.0.1 -p 5432 -U hypereels hypereels | \
  gzip > /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz && \
  /usr/local/bin/mc cp /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz \
    local/hypereels/backups/postgres/ && \
  rm -f /tmp/hypereels-postgres-$(date +\%Y\%m\%d).sql.gz
```

> Install `mc` on CT 200: `wget -O /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc && chmod +x /usr/local/bin/mc && /usr/local/bin/mc alias set local http://<MINIO_LXC_IP>:9000 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>`

### Redis — AOF persistence + weekly backup

Redis is configured with `appendonly yes` — data survives Redis restarts. For off-host backup:

```bash
# Cron entry on CT 200 (crontab -e as root) — weekly AOF snapshot
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

Verify CT 201 can reach CT 200 and CT 202:

```bash
pct exec 201 -- nc -zv <API_LXC_IP> 3001
pct exec 201 -- nc -zv <API_LXC_IP> 6379
pct exec 201 -- nc -zv <MINIO_LXC_IP> 9000
```

Check the iptables rules on CT 200 are not blocking worker traffic:

```bash
pct exec 200 -- iptables -L INPUT -n
```

### MinIO bucket not found

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

### InsightFace model download fails

See the note in Section 4. Pre-download the `buffalo_l` model on a machine with internet access and volume-mount it into the worker container.
