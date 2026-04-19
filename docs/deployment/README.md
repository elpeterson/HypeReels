# HypeReels Deployment Profiles

HypeReels supports exactly **two deployment profiles**, each running all services on a **single machine**. There is no split-system or multi-host deployment.

| Profile | Hardware | GPU | Complexity | When to Use |
|---------|----------|-----|------------|-------------|
| [Profile 1 — CPU-Only](./profile-1-cpu.md) | Any Linux machine (Proxmox LXC or Docker) | Not required | Low | No GPU, or GPU shared with other critical workloads |
| [Profile 2 — GPU-Enabled](./profile-2-gpu.md) | Any Linux machine with NVIDIA GPU | Optional (CPU fallback) | Low | NVIDIA GPU available; want faster InsightFace inference |

> **Profile 3 (split-system: two machines simultaneously) is retired.** See `docs/infrastructure.md` for the deprecation notice. Do not use it for new deployments.

---

## Which Profile Should I Choose?

```
Do you have an NVIDIA GPU on your deployment machine?
│
├── No  ──────────────────────────────────────────────────► Profile 1 (CPU-Only)
│
└── Yes
    │
    ├── Is the GPU exclusively available to HypeReels,
    │   or can you accept shared/fallback behaviour?
    │   │
    │   ├── Yes / Don't care ────────────────────────────► Profile 2 (GPU-Enabled)
    │   │                                                   (GPU used when available;
    │   │                                                    CPU fallback if not)
    │   │
    │   └── No (GPU is 100% reserved for another
    │       critical service, e.g. Frigate NVR) ────────► Profile 1 (CPU-Only)
    │                                                       (avoids all GPU contention)
    │
    └── No GPU present but you chose Profile 2? ────────► That's fine — Profile 2
                                                           automatically falls back
                                                           to CPU inference
```

**Rule of thumb:**
- Start with Profile 2 if you have any NVIDIA GPU. The GPU is optional — CPU fallback is automatic.
- Use Profile 1 if you have no GPU, or if your GPU is fully committed to another always-on service and you cannot risk contention.

---

## Hardware Requirements Summary

| Requirement | Profile 1 (CPU-Only) | Profile 2 (GPU-Enabled) |
|-------------|---------------------|------------------------|
| CPU | 4+ cores, 2.0 GHz+ | 4+ cores, 2.0 GHz+ |
| RAM | 8 GB minimum | 16 GB recommended |
| Storage (OS + services) | 30 GB | 30 GB |
| Storage (data volume) | 200 GB+ | 200 GB+ |
| GPU | None required | NVIDIA (4+ GB VRAM recommended); CPU fallback if absent |
| OS | Linux (Proxmox 8+, Debian/Ubuntu, any Docker host) | Linux with Docker Engine 24+ |
| Required software | Proxmox VE 8+ **or** Docker Engine 24+ with Compose v2 | Docker Engine 24+ with Compose v2 + nvidia-container-toolkit |

---

## Profile Summaries

### Profile 1 — CPU-Only (Single Machine)

All five services (API, PostgreSQL, Redis, MinIO, Python workers) run on one machine. Two deployment paths are available:

- **Proxmox LXC path:** Three LXC containers — CT for API+PostgreSQL+Redis, CT for Python workers (Docker-in-LXC), CT for MinIO. Best for Proxmox users.
- **Docker Compose path:** Single `docker-compose.yml` brings up all services. Best for any Linux machine with Docker.

InsightFace runs CPU-only (`ctx_id=-1`, `CPUExecutionProvider`). FFmpeg uses software encoding (x264/libx264). No GPU required.

> **Reference implementation:** Case (Proxmox LXC, CPU-only). See the "Reference Implementation" callout in [profile-1-cpu.md](./profile-1-cpu.md).

### Profile 2 — GPU-Enabled (Single Machine)

All services run as Docker containers in a single `docker-compose.yml` on one machine. GPU access is passed to the worker container via the NVIDIA Container Runtime.

- InsightFace uses `CUDAExecutionProvider` when a GPU is present; falls back to `CPUExecutionProvider` automatically if no GPU is detected.
- FFmpeg can use NVENC hardware encoding when `FFMPEG_HWACCEL=nvenc` is set; defaults to x264 software encoding.
- The GPU is optional — the profile is identical to Profile 1 (Docker path) when run without a GPU.

> **Reference implementation:** Quorra (Unraid, NVIDIA GPU). See the "Reference Implementation" callout in [profile-2-gpu.md](./profile-2-gpu.md).

---

## Common to All Profiles

- **No cloud dependency** — the entire stack runs on-premises on your hardware
- **No user accounts** — UUID session tokens tie browser sessions to server state
- **Download and destroy** — all assets are permanently deleted after the user downloads their HypeReel
- **SPA served by API** — the React SPA is built to `server/client-dist/` and served by `@fastify/static`; no separate web server needed for static files
- **Single machine** — all services communicate via localhost or Docker internal network; no cross-host networking required

---

## Key Operational Notes

### PM2 and .env Files

> **⚠️ PM2 WARNING:** PM2 does not load `.env` files. The `env_file` option in `ecosystem.config.cjs` is silently ignored. All profiles use systemd `EnvironmentFile` (LXC/bare-metal) or Docker Compose `env_file` as the authoritative process management approach. PM2 is documented as a development-only alternative only.

### MinIO in Unprivileged LXC Containers

When MinIO's data directory is provided via a ZFS bind mount into an unprivileged LXC container, you **must** `chown -R 100000:100000` the host-side ZFS dataset before starting the container. Container root (UID 0) maps to host UID 100000 in unprivileged containers. If you skip this step, MinIO starts but fails all writes with `permission denied`.

### Cloudflare Tunnel and Let's Encrypt

If using a Cloudflare Zero Trust tunnel for external access, you **must** configure the tunnel public hostname **before** requesting a Let's Encrypt certificate in Nginx Proxy Manager. The ACME HTTP-01 challenge requires the domain to resolve and reach NPM; if the Cloudflare hostname is not configured first, certificate issuance will fail.

### GPU Contention (Profile 2)

If your GPU is shared with another container (e.g., a home security NVR running 24/7), the GPU-enabled profile will still work but InsightFace may fall back to CPU if the GPU is unavailable at inference time. To guarantee CPU-only behaviour and avoid any contention risk, use Profile 1 instead, or remove the `deploy.resources.reservations.devices` section from the Profile 2 `docker-compose.yml`.
