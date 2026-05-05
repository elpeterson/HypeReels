# HypeReels — Application image
# Serves Next.js (frontend + API routes) and runs the embedded BullMQ worker.
# Compatible with CPU-only and NVIDIA GPU hosts (CUDA → CPU auto-fallback).

FROM node:20-slim AS base

# ─── System dependencies ──────────────────────────────────────────────────────
# ffmpeg        — video thumbnail extraction and reel assembly
# python3 / pip — ML scripts (InsightFace, librosa)
# build-essential / cmake — native Python extension compilation
# libgl1 / libglib2.0-0   — OpenCV headless runtime
# libgomp1                 — OpenMP (onnxruntime parallel ops)
# libsndfile1              — audio I/O (soundfile / librosa)

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    cmake \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

# ─── Python ML dependencies ───────────────────────────────────────────────────
# Install onnxruntime first so insightface finds it during its own install.
# opencv-python-headless avoids pulling in X11/GTK display libraries.

RUN pip3 install --no-cache-dir --break-system-packages \
    onnxruntime \
  && pip3 install --no-cache-dir --break-system-packages \
    "insightface==0.7.3" \
    librosa \
    numpy \
    opencv-python-headless \
    soundfile \
    scipy

# ─── Node dependencies ────────────────────────────────────────────────────────
WORKDIR /app

# Copy manifests first so Docker layer caching works on unchanged deps
COPY frontend/package.json frontend/package-lock.json ./

RUN npm ci --omit=dev

# ─── Application source ───────────────────────────────────────────────────────
COPY frontend/ .

# Copy Python worker scripts so they are available at /app/workers/scripts/
COPY workers/ /app/workers/

# Build Next.js for production
RUN npm run build

# ─── Runtime environment ──────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# Python scripts location expected by src/lib/config.ts
ENV PYTHON_SCRIPTS_DIR=/app/workers/scripts

EXPOSE 3000

# Next.js standalone output produces .next/standalone/server.js;
# fall back to "npm start" if standalone output is not configured.
CMD ["npm", "start"]
