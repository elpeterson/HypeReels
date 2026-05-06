/**
 * MinIO / S3-compatible object storage client.
 *
 * Uses AWS SDK v3 with S3-compatible endpoint configuration.
 * All file uploads go directly from browser to MinIO via presigned PUT URLs.
 * All downloads go directly from MinIO to browser via presigned GET URLs.
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config";

// ─── Singleton clients ────────────────────────────────────────────────────────

let _s3: S3Client | null = null;
let _s3Presign: S3Client | null = null;

/**
 * S3 client for server-side operations (list, delete, get, put from worker).
 * Uses the internal Docker network endpoint (http://minio:9000 inside Compose).
 */
export function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: config.minio.endpoint,
      region: config.minio.region,
      credentials: {
        accessKeyId: config.minio.accessKeyId,
        secretAccessKey: config.minio.secretAccessKey,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }
  return _s3;
}

/**
 * S3 client used ONLY for presigning URLs returned to the browser.
 * Uses MINIO_PUBLIC_URL so the embedded hostname is reachable from the
 * user's browser (e.g. http://localhost:9000), not the internal Docker hostname.
 */
function getPresignClient(): S3Client {
  if (!_s3Presign) {
    _s3Presign = new S3Client({
      endpoint: config.minio.publicUrl,
      region: config.minio.region,
      credentials: {
        accessKeyId: config.minio.accessKeyId,
        secretAccessKey: config.minio.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }
  return _s3Presign;
}

// ─── Object key helpers ───────────────────────────────────────────────────────

export const objectKeys = {
  clip: (sessionId: string, clipId: string, ext: string) =>
    `${sessionId}/clips/${clipId}.${ext}`,
  thumbnail: (sessionId: string, clipId: string) =>
    `${sessionId}/thumbs/${clipId}.jpg`,
  audio: (sessionId: string, ext: string) => `${sessionId}/audio.${ext}`,
  person: (sessionId: string, personId: string) =>
    `${sessionId}/persons/${personId}.jpg`,
  analysis: (sessionId: string) => `${sessionId}/analysis.json`,
  reel: (sessionId: string) => `${sessionId}/reel.mp4`,
};

// ─── Presigned URLs ───────────────────────────────────────────────────────────

/**
 * Generate a presigned PUT URL for direct browser-to-MinIO upload.
 * TTL is 15 minutes by default (config.session.presignedPutTtlSeconds).
 */
export async function createPresignedPutUrl(
  objectKey: string,
  contentType: string,
  maxSizeBytes: number
): Promise<string> {
  const client = getPresignClient(); // public URL — must be browser-reachable

  const command = new PutObjectCommand({
    Bucket: config.minio.bucket,
    Key: objectKey,
    ContentType: contentType,
    // Note: MinIO supports Content-Length-Range policy condition in presigned URLs
    // via the policy document, but the AWS SDK does not expose this directly.
    // We enforce size limits at the API validation layer instead.
  });

  return getSignedUrl(client, command, {
    expiresIn: config.session.presignedPutTtlSeconds,
  });
}

/**
 * Generate a presigned GET URL for direct MinIO-to-browser download.
 * TTL is 5 minutes by default (config.session.presignedGetTtlSeconds).
 */
export async function createPresignedGetUrl(
  objectKey: string,
  ttlSeconds?: number
): Promise<string> {
  const client = getPresignClient(); // public URL — must be browser-reachable

  const command = new GetObjectCommand({
    Bucket: config.minio.bucket,
    Key: objectKey,
  });

  return getSignedUrl(client, command, {
    expiresIn: ttlSeconds ?? config.session.presignedGetTtlSeconds,
  });
}

// ─── Object operations ────────────────────────────────────────────────────────

export async function deleteObject(objectKey: string): Promise<void> {
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.minio.bucket,
      Key: objectKey,
    })
  );
}

/**
 * Delete all objects under a session prefix.
 * Logs each deletion and handles errors gracefully per architecture.md §8.
 */
export async function deleteSessionObjects(
  sessionId: string
): Promise<{ deleted: number; errors: string[] }> {
  const client = getS3Client();
  const prefix = `${sessionId}/`;
  const errors: string[] = [];
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: config.minio.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = listResponse.Contents ?? [];

    if (objects.length > 0) {
      const deleteResponse = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.minio.bucket,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key! })),
            Quiet: false,
          },
        })
      );

      deleted += deleteResponse.Deleted?.length ?? 0;

      for (const err of deleteResponse.Errors ?? []) {
        const msg = `Failed to delete ${err.Key}: ${err.Message}`;
        errors.push(msg);
        console.error(`[storage] ${msg} (session=${sessionId})`);
      }
    }

    continuationToken = listResponse.IsTruncated
      ? listResponse.NextContinuationToken
      : undefined;
  } while (continuationToken);

  console.log(
    `[storage] deleted ${deleted} objects for session=${sessionId}, errors=${errors.length}`
  );

  return { deleted, errors };
}

/**
 * Get object content as a Buffer (for worker use — small JSON files).
 */
export async function getObjectBuffer(objectKey: string): Promise<Buffer> {
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.minio.bucket,
      Key: objectKey,
    })
  );

  if (!response.Body) {
    throw new Error(`Empty response body for key: ${objectKey}`);
  }

  // Collect stream into buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a Buffer to MinIO (for worker use).
 */
export async function putObject(
  objectKey: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: config.minio.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    })
  );
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function pingStorage(): Promise<boolean> {
  try {
    const client = getS3Client();
    await client.send(new HeadBucketCommand({ Bucket: config.minio.bucket }));
    return true;
  } catch {
    return false;
  }
}
