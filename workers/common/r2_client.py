"""Cloudflare R2 client — boto3 S3-compatible.

Cloudflare R2 exposes an S3-compatible API.  We configure boto3 with a
custom endpoint_url pointing at R2 and disable AWS request signing (R2
uses its own HMAC credentials via the same ENV vars).

Environment variables required:
  R2_ENDPOINT_URL      — e.g. https://<account-id>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID     — R2 API token (Access Key ID)
  R2_SECRET_ACCESS_KEY — R2 API token (Secret Access Key)
  R2_BUCKET_NAME       — default bucket name
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import BinaryIO

import boto3
from botocore.client import Config
from dotenv import load_dotenv

from common.logger import get_logger

load_dotenv()

log = get_logger(__name__)

_s3_client = None


def _get_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT_URL"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )
    return _s3_client


def _bucket() -> str:
    return os.environ["R2_BUCKET_NAME"]


# ── Download ──────────────────────────────────────────────────────────────────

def download_to_tmp(r2_key: str, suffix: str = "") -> Path:
    """Download an R2 object to a temporary file; return the local path.

    The caller is responsible for deleting the file when done.
    """
    client = _get_client()
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir="/tmp/hypereels")
    os.close(fd)
    path = Path(tmp_path)
    log.info("r2_download_start", key=r2_key, local=str(path))
    client.download_file(_bucket(), r2_key, str(path))
    log.info("r2_download_complete", key=r2_key, bytes=path.stat().st_size)
    return path


def download_fileobj(r2_key: str, fileobj: BinaryIO) -> None:
    """Stream an R2 object into an open file-like object."""
    client = _get_client()
    client.download_fileobj(_bucket(), r2_key, fileobj)


# ── Upload ────────────────────────────────────────────────────────────────────

def upload_file(local_path: Path | str, r2_key: str, content_type: str = "application/octet-stream") -> None:
    """Upload a local file to R2."""
    client = _get_client()
    log.info("r2_upload_start", key=r2_key, local=str(local_path))
    client.upload_file(
        str(local_path),
        _bucket(),
        r2_key,
        ExtraArgs={"ContentType": content_type},
    )
    log.info("r2_upload_complete", key=r2_key)


def upload_bytes(data: bytes, r2_key: str, content_type: str = "application/octet-stream") -> None:
    """Upload raw bytes to R2."""
    import io
    client = _get_client()
    client.upload_fileobj(
        io.BytesIO(data),
        _bucket(),
        r2_key,
        ExtraArgs={"ContentType": content_type},
    )
    log.info("r2_upload_bytes_complete", key=r2_key, bytes=len(data))


# ── Presigned URLs ────────────────────────────────────────────────────────────

def generate_presigned_url(r2_key: str, expires_in: int = 7200) -> str:
    """Generate a presigned GET URL valid for *expires_in* seconds (default 2 h)."""
    client = _get_client()
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": r2_key},
        ExpiresIn=expires_in,
    )
    return url


# ── Delete ────────────────────────────────────────────────────────────────────

def delete_object(r2_key: str) -> None:
    client = _get_client()
    client.delete_object(Bucket=_bucket(), Key=r2_key)
    log.info("r2_delete", key=r2_key)
