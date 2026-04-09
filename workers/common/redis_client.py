"""BullMQ-compatible Redis job consumer for Python workers.

BullMQ stores jobs in Redis using a well-known key schema.  This module
implements just enough of that schema to:
  1. Block-pop the next job from a BullMQ queue.
  2. Move the job to the 'active' set while processing.
  3. Move the job to 'completed' or 'failed' when done.
  4. Publish progress/result events to the session pub/sub channel.

BullMQ v4 key layout (queue name = "person-detection"):
  bull:{queue}:wait          — LIST  of job IDs waiting
  bull:{queue}:active        — LIST  of job IDs being processed
  bull:{queue}:{id}          — HASH  of job fields (name, data, opts, …)
  bull:{queue}:completed     — ZSET  of completed job IDs
  bull:{queue}:failed        — ZSET  of failed job IDs
"""

from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import contextmanager
from typing import Any, Generator

import redis as redis_lib
from dotenv import load_dotenv

from common.logger import get_logger

load_dotenv()

log = get_logger(__name__)

_BULL_PREFIX = "bull"


def _make_client() -> redis_lib.Redis:
    url = os.environ["REDIS_URL"]  # e.g. redis://localhost:6379 or rediss://…
    return redis_lib.from_url(url, decode_responses=True)


# Module-level singleton — workers are long-running processes.
_client: redis_lib.Redis | None = None


def get_redis() -> redis_lib.Redis:
    global _client
    if _client is None:
        _client = _make_client()
    return _client


# ── Key helpers ───────────────────────────────────────────────────────────────

def _wait_key(queue: str) -> str:
    return f"{_BULL_PREFIX}:{queue}:wait"


def _active_key(queue: str) -> str:
    return f"{_BULL_PREFIX}:{queue}:active"


def _job_key(queue: str, job_id: str) -> str:
    return f"{_BULL_PREFIX}:{queue}:{job_id}"


def _completed_key(queue: str) -> str:
    return f"{_BULL_PREFIX}:{queue}:completed"


def _failed_key(queue: str) -> str:
    return f"{_BULL_PREFIX}:{queue}:failed"


# ── Job fetch / ack ───────────────────────────────────────────────────────────

def fetch_next_job(queue: str, block_seconds: int = 5) -> dict[str, Any] | None:
    """Block until a job is available on *queue*, then return its data dict.

    Moves the job ID from the 'wait' list to the 'active' list atomically
    using BRPOPLPUSH (available in Redis < 6.2) / BLMOVE (Redis ≥ 6.2).

    Returns None on timeout (caller should loop).
    """
    r = get_redis()
    wait_key = _wait_key(queue)
    active_key = _active_key(queue)

    try:
        # BLMOVE is Redis 6.2+; fall back to BRPOPLPUSH for older Redis.
        job_id: str | None = r.blmove(
            wait_key, active_key, block_seconds, "RIGHT", "LEFT"
        )
    except redis_lib.ResponseError:
        result = r.brpoplpush(wait_key, active_key, timeout=block_seconds)
        job_id = result  # type: ignore[assignment]

    if not job_id:
        return None

    raw = r.hgetall(_job_key(queue, job_id))
    if not raw:
        log.warning("job_key_missing", queue=queue, job_id=job_id)
        return None

    data = json.loads(raw.get("data", "{}"))
    return {
        "id": job_id,
        "name": raw.get("name", ""),
        "data": data,
        "opts": json.loads(raw.get("opts", "{}")),
        "timestamp": raw.get("timestamp"),
    }


def ack_job(queue: str, job_id: str, result: Any = None) -> None:
    """Mark *job_id* as completed."""
    r = get_redis()
    score = time.time() * 1000  # milliseconds epoch
    r.lrem(_active_key(queue), 0, job_id)
    r.zadd(_completed_key(queue), {job_id: score})
    if result is not None:
        r.hset(_job_key(queue, job_id), "returnvalue", json.dumps(result))
    log.info("job_completed", queue=queue, job_id=job_id)


def fail_job(queue: str, job_id: str, error: str) -> None:
    """Mark *job_id* as failed with an error message."""
    r = get_redis()
    score = time.time() * 1000
    r.lrem(_active_key(queue), 0, job_id)
    r.zadd(_failed_key(queue), {job_id: score})
    r.hset(_job_key(queue, job_id), "failedReason", error)
    log.error("job_failed", queue=queue, job_id=job_id, error=error)


# ── Session event publishing ──────────────────────────────────────────────────

def publish_event(session_id: str, event: dict[str, Any]) -> None:
    """Publish a JSON event to the session's SSE channel."""
    r = get_redis()
    channel = f"session:{session_id}:events"
    r.publish(channel, json.dumps(event))
    log.debug("event_published", channel=channel, event_type=event.get("type"))


# ── Context manager for safe job lifecycle ────────────────────────────────────

@contextmanager
def job_context(
    queue: str, job: dict[str, Any]
) -> Generator[dict[str, Any], None, None]:
    """Context manager that auto-acks or auto-fails a job.

    Usage::

        job = fetch_next_job("my-queue")
        with job_context("my-queue", job) as j:
            process(j["data"])
    """
    job_id = job["id"]
    try:
        yield job
        ack_job(queue, job_id)
    except Exception as exc:
        fail_job(queue, job_id, str(exc))
        raise
