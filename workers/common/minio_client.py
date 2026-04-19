"""MinIO client — re-export shim for r2_client.

The underlying r2_client uses R2-style env var names (R2_ENDPOINT_URL,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) but connects to a
self-hosted MinIO endpoint — the S3-compatible API is identical.

This shim exists so modules can import from ``common.minio_client`` without
knowing the underlying module name, which predates the MinIO migration.

Usage::

    from common.minio_client import download_to_tmp, upload_bytes, generate_presigned_url
"""

from common.r2_client import (  # noqa: F401  (all re-exported, no unused-import)
    delete_object,
    download_fileobj,
    download_to_tmp,
    generate_presigned_url,
    upload_bytes,
    upload_file,
)
