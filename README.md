# HypeReels

Generate high-energy hype reel videos by combining your clips with a song, automatically cut to the beat.

## What It Does

Upload one or more video clips and an audio track. HypeReels detects people in your clips so you can select a subject to prioritize, then assembles a beat-synced reel from your best moments. Sessions are fully ephemeral — no account required, no files retained after download.

## Prerequisites

**All hosts:**

- [Docker Engine](https://docs.docker.com/engine/install/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20+ (bundled with Docker Desktop)

**NVIDIA GPU hosts only:**

- NVIDIA driver 525+
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

## CPU-Only Quickstart

Works on any hardware — Intel, AMD, or Apple Silicon.

```bash
git clone https://github.com/elpeterson/HypeReels.git
cd HypeReels
cp .env.example .env
docker compose build
docker compose up -d
```

Open **http://localhost:3000**.

## NVIDIA GPU Quickstart

Requires an NVIDIA GPU and the NVIDIA Container Toolkit (see Prerequisites above).

```bash
git clone https://github.com/elpeterson/HypeReels.git
cd HypeReels
cp .env.example .env

# Enable GPU acceleration
echo "FFMPEG_HWACCEL=nvenc" >> .env
echo "INSIGHTFACE_PROVIDERS=CUDAExecutionProvider" >> .env

docker compose build
docker compose up -d
```

Open **http://localhost:3000**.

If CUDA is unavailable at runtime, the system falls back to CPU automatically and logs a warning — no crash, no manual intervention.

## AMD GPU + Apple Silicon

No extra configuration needed. Both use the CPU-only path. AMD ROCm and Apple Metal are not supported.

## How It Works

1. Upload clips (MP4, MOV, MKV, WebM) and an audio track (MP3, WAV, AAC, FLAC, M4A).
2. Select a person of interest from AI-detected people, or skip to use all clip content.
3. Optionally mark highlight segments — those moments are guaranteed to appear in the reel.
4. Click Generate. The system analyzes beats, selects scenes, and assembles the reel.
5. Download the MP4. All files — clips, audio, and the reel — are permanently deleted immediately after download.

One download opportunity per session. No accounts. Nothing is stored.

## Full Setup Details

See [docs/deployment.md](docs/deployment.md) for environment variable reference, health checks, upgrade steps, and operational notes.
