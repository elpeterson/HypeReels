# HypeReels

## Product

HypeReels is a web application that automatically generates high-energy "hype reel" videos by intelligently combining user-uploaded video clips with a chosen song.

## Domain Concepts

| Term | Definition |
|------|-----------|
| **Clip** | A user-uploaded video file. May contain multiple people and multiple scenes. |
| **Highlight** | A user-defined time range within a clip that *must* appear in the final reel. A clip can have zero, one, or many highlights. Portions outside a highlight are free for the AI to trim. |
| **Person of Interest** | The subject selected by the user from AI-detected people in the uploaded clips. The reel prioritizes moments featuring this person. |
| **Beat Sync** | The process of aligning video cuts and transitions to musical events (beats, drops, phrase boundaries). |
| **HypeReel** | The final generated video: selected clips, trimmed and sequenced, overlaid with the user's audio track, cut to the beat. |
| **Waveform Analysis** | Extraction of amplitude envelope, beat timestamps, BPM, and musical phrase boundaries from the audio track. |

## MVP Scope

1. **Upload**: User uploads one or more video clips and one audio track (song).
2. **Person Detection**: AI analyzes each clip and returns detected persons as thumbnails. User selects one person of interest.
3. **Highlight Selection**: User optionally marks highlight segments (time ranges) per clip. Highlights are guaranteed to appear in the reel; everything else is at the AI's discretion.
4. **Song Analysis**: Backend extracts BPM, beat timestamps, and waveform envelope from the audio track.
5. **HypeReel Generation**: AI assembles clips — prioritizing highlight segments and person-of-interest moments — and sequences cuts to sync with the beat.
6. **Download & Destroy**: User downloads the completed HypeReel. All uploaded assets and generated files are immediately and permanently deleted. No login required.

## Out of MVP Scope (Future Enhancements)

- Multi-person selection in a single reel
- Manual person annotation → named person profiles with persistent recognition
- Spotify integration for song selection and streaming
- User authentication + persistent project storage
- Mobile app
- Preview before download
- Custom transition effects

## Tech Stack

> Defined by the Architect. See `docs/architecture.md`.

## Deployment Profiles

HypeReels supports exactly **two single-system deployment profiles**. All services run on one machine — there is no supported split-system or multi-host deployment.

| Profile | Description | Reference Implementation |
|---------|-------------|--------------------------|
| **Profile 1 — CPU-Only** | All services on one machine, no GPU. Two paths: Proxmox LXC or Docker Compose. InsightFace: `CPUExecutionProvider`. FFmpeg: x264. | Case (Proxmox LXC) |
| **Profile 2 — GPU-Enabled** | All services as Docker containers on one machine. NVIDIA GPU optional — CPU fallback automatic. InsightFace: CUDA → CPU fallback. FFmpeg: NVENC opt-in via `FFMPEG_HWACCEL=nvenc`. | Quorra (Unraid Docker) |

> **Profile 3 (split-system) is retired.** See `docs/infrastructure.md` for the deprecation notice.

Deployment docs:
- `docs/deployment/README.md` — profile comparison and hardware requirements
- `docs/deployment/profile-1-cpu.md` — CPU-only single-machine deployment
- `docs/deployment/profile-2-gpu.md` — GPU-enabled single-machine deployment

## Engineering Workflow

Seven specialized agents collaborate in a sequential pipeline. Each agent reads the artifacts produced by previous agents and writes its own.

| Step | Agent | When to Invoke | Primary Output |
|------|-------|---------------|----------------|
| 1 | `@product-owner` | New feature request or sprint kickoff | `docs/user-stories.md` |
| 2 | `@architect` | After user stories are finalized | `docs/architecture.md` |
| 3 | `@frontend-engineer` | After architecture is ready | UI components + pages |
| 4 | `@backend-engineer` | After architecture is ready | APIs + business logic |
| 5 | `@ai-ml-engineer` | After architecture is ready | ML pipelines + processing jobs |
| 6 | `@qa-engineer` | After implementation is complete | `docs/test-plan.md` + tests |
| 7 | `@devops-engineer` | After QA sign-off | `docs/infrastructure.md` + CI/CD |

Steps 3, 4, and 5 can run in parallel once the architecture is ready.

## Key Artifact Files

| File | Owner | Purpose |
|------|-------|---------|
| `docs/user-stories.md` | Product Owner | Sprint backlog and acceptance criteria |
| `docs/architecture.md` | Architect | System design, tech stack, data models, component boundaries |
| `docs/api-spec.md` | Backend Engineer | REST API specification (OpenAPI/Swagger format) |
| `docs/test-plan.md` | QA Engineer | Test strategy, test cases, coverage targets |
| `docs/infrastructure.md` | DevOps Engineer | **DEPRECATED** — retired Profile 3 (split-system) reference. See `docs/deployment/` for current profiles. |
