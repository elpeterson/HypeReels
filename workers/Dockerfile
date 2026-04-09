# HypeReels Python Worker Image
# Runs all three Python workers: person_detection, audio_analysis, assembly
# The WORKER env var selects which worker entrypoint to start.
#
# GPU ACCESS: This image runs CPU-only. Do NOT add --gpus all or
# --runtime=nvidia to the docker run command.
#
# Why CPU-only? Three-way GPU contention on Quorra's single NVIDIA GTX 1080 Ti:
#   1. Frigate NVR  — home security camera detection, always-on critical service
#   2. FileFlows    — media transcoding via NVENC (--runtime=nvidia)
#   3. HypeReels    — InsightFace person detection (this container)
# Giving any service exclusive GPU access risks degrading the others.
# InsightFace CPU-only yields ~30-60s per clip-minute, acceptable for async
# batch processing. See ADR-013 in docs/architecture.md.

FROM python:3.12-slim-bookworm

# ── System dependencies ───────────────────────────────────────────────────────
# FFmpeg 6 is available in Debian Bookworm backports
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# ── Application code ──────────────────────────────────────────────────────────
COPY . .

# Create tmp workspace that workers use for downloaded/processed files
RUN mkdir -p /tmp/hypereels

# ── Runtime ───────────────────────────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Default mode: HTTP server (consumed by Node backend via PYTHON_WORKER_URL).
# Override CMD with "python -m <worker>.<worker>_worker" for standalone queue
# consumer mode (useful in dev or when running workers on separate containers).
#
# Examples:
#   HTTP server (default):
#     CMD ["uvicorn", "workers.main:app", "--host", "0.0.0.0", "--port", "8000"]
#
#   Standalone queue consumer (legacy / dev):
#     CMD ["sh", "-c", "python -m ${WORKER}.${WORKER}_worker"]
#
# NOTE: Do NOT add --gpus all here. CPU-only per ADR-013 (GPU contention).
CMD ["uvicorn", "workers.main:app", "--host", "0.0.0.0", "--port", "8000"]
