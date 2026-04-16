# HypeReels Deployment Profiles

Three deployment configurations are supported:

| Profile | Hardware | GPU | Complexity | When to Use |
|---------|----------|-----|------------|-------------|
| [CPU Self-Hosted](./profile-1-cpu.md) | Single Proxmox host | Not required | Low | Homelab, development, Proxmox users |
| [GPU Self-Hosted](./profile-2-gpu.md) | Single Unraid host | Required (NVIDIA) | Low | Unraid users wanting faster inference |
| Production (split-host) | Two servers | Optional | Medium | Production deployments — document privately |

## Choosing a Profile

- If you have **Proxmox** and no GPU → [Profile 1 — CPU Self-Hosted](./profile-1-cpu.md)
- If you have **Unraid** and an NVIDIA GPU → [Profile 2 — GPU Self-Hosted](./profile-2-gpu.md)
- If you're running a production instance on multiple servers → Profile 3 (document in your private runbook; see `docs/infrastructure.md` for the owner's reference implementation)

## Profile Summaries

### Profile 1 — CPU Self-Hosted (Proxmox)

Three LXC containers on a single Proxmox host. PostgreSQL and Redis run natively alongside the API, eliminating the need for extra containers. Python workers run as a combined Docker container in a privileged LXC. InsightFace runs CPU-only. No GPU required. Process management via systemd.

Suitable for: homelab operators, developers who already run Proxmox.

### Profile 2 — GPU Self-Hosted (Unraid)

All services in a single `docker-compose.yml` on a single Unraid host. GPU passthrough to the Python worker container enables faster InsightFace inference. Managed by Docker Compose with restart policies.

Suitable for: Unraid users who want faster person detection and have an NVIDIA GPU available.

### Profile 3 — Production / Split-Host (Internal)

Two physical servers: a Proxmox host for stateful services (API, Redis, MinIO) and an Unraid host for Python ML workers and PostgreSQL. This profile is specific to the owner's deployment and should not be documented in a public repository with real IPs or credentials. See `docs/infrastructure.md` for the owner's reference implementation.

## Common to All Profiles

- **No cloud dependency** — the entire stack runs on-premises
- **No user accounts** — UUID session tokens tie browser sessions to server state
- **Download and destroy** — all assets are deleted after download
- **SPA served by API** — the React SPA is built to `server/client-dist/` and served by `@fastify/static`

## Key Operational Notes

### PM2 and .env Files

> **⚠️ PM2 WARNING:** PM2 does not load `.env` files. The `env_file` option in `ecosystem.config.cjs` is silently ignored. All profiles in this documentation use systemd `EnvironmentFile` as the primary process management approach. PM2 is documented as a development-only alternative only.

### MinIO in Unprivileged LXC Containers

When MinIO's data directory is provided via a ZFS bind mount into an unprivileged LXC container, you **must** `chown -R 100000:100000` the host-side ZFS dataset before starting the container. Container root (UID 0) maps to host UID 100000 in unprivileged containers. If you skip this step, MinIO starts but fails all writes with `permission denied`.

### Redis systemd in Unprivileged LXC

The default `redis-server.service` unit uses systemd namespace sandboxing (`PrivateUsers`, `PrivateTmp`, etc.) that fails with `status=226/NAMESPACE` in unprivileged LXC containers. Profile 1 avoids this entirely by running Redis natively on the same LXC as the API. Profile 3 requires replacing the systemd unit with a minimal version (see `docs/infrastructure.md`).

### Cloudflare Tunnel and Let's Encrypt

If using a Cloudflare Zero Trust tunnel for external access, you **must** configure the tunnel public hostname **before** requesting a Let's Encrypt certificate in Nginx Proxy Manager. The ACME HTTP-01 challenge requires the domain to resolve and reach NPM; if the Cloudflare hostname isn't configured first, certificate issuance will fail.
