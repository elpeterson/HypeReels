/**
 * MinIO / S3-compatible object storage client + signed URL helpers.
 *
 * Renamed from r2.ts → storage.ts to remove legacy Cloudflare R2 naming.
 * The implementation is unchanged: AWS SDK v3 with a custom MinIO endpoint.
 */
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export const storageClient = new S3Client({
  region: 'auto',
  endpoint: requireEnv('MINIO_ENDPOINT'),
  credentials: {
    accessKeyId: requireEnv('MINIO_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('MINIO_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: true, // required for MinIO
});

export const BUCKET = requireEnv('MINIO_BUCKET');

// ─────────────────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────────────────

export interface UploadStreamOptions {
  key: string;
  body: PutObjectCommandInput['Body'];
  contentType: string;
  contentLength?: number;
}

export async function uploadToStorage(opts: UploadStreamOptions): Promise<void> {
  await storageClient.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
      ...(opts.contentLength !== undefined
        ? { ContentLength: opts.contentLength }
        : {}),
    }),
  );
}

/** @deprecated Use uploadToStorage instead */
export const uploadStream = uploadToStorage;

// ─────────────────────────────────────────────────────────
// Signed URLs
// ─────────────────────────────────────────────────────────

/** Generate a presigned GET URL. Default TTL: 2 hours. */
export async function getSignedDownloadUrl(
  key: string,
  ttlSeconds = 7_200,
): Promise<string> {
  return getSignedUrl(
    storageClient,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: ttlSeconds },
  );
}

/** @deprecated Use getSignedDownloadUrl instead */
export const getPresignedDownloadUrl = getSignedDownloadUrl;

/** Generate a presigned PUT URL for direct browser → MinIO upload. */
export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  ttlSeconds = 3_600,
): Promise<string> {
  return getSignedUrl(
    storageClient,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: ttlSeconds },
  );
}

/** @deprecated Use getSignedUploadUrl instead */
export const getPresignedUploadUrl = getSignedUploadUrl;

// ─────────────────────────────────────────────────────────
// Deletion
// ─────────────────────────────────────────────────────────

export async function deleteObject(key: string): Promise<void> {
  await storageClient.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
  );
}

/**
 * Delete up to 1 000 objects in a single S3 bulk-delete call.
 * Returns the list of keys that failed.
 */
export async function deleteObjects(
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    chunks.push(keys.slice(i, i + 1000));
  }

  const failed: string[] = [];

  for (const chunk of chunks) {
    const result = await storageClient.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: false,
        },
      }),
    );
    for (const err of result.Errors ?? []) {
      if (err.Key) failed.push(err.Key);
    }
  }

  return failed;
}

/**
 * List all object keys under a given prefix.
 */
export async function listObjects(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await storageClient.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of result.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }

    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

// ─────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────

export const StorageKeys = {
  clipUpload: (sessionId: string, clipId: string, ext: string) =>
    `uploads/${sessionId}/${clipId}.${ext}`,

  audioUpload: (sessionId: string, audioId: string, ext: string) =>
    `uploads/${sessionId}/audio_${audioId}.${ext}`,

  clipThumbnail: (sessionId: string, clipId: string) =>
    `thumbnails/${sessionId}/${clipId}.jpg`,

  personThumbnail: (sessionId: string, personRefId: string) =>
    `thumbnails/${sessionId}/person_${personRefId}.jpg`,

  waveform: (sessionId: string, audioId: string) =>
    `thumbnails/${sessionId}/waveform_${audioId}.svg`,

  generatedReel: (sessionId: string, jobId: string) =>
    `generated/${sessionId}/hypereel_${jobId}.mp4`,

  sessionPrefix: (sessionId: string) => [
    `uploads/${sessionId}/`,
    `thumbnails/${sessionId}/`,
    `generated/${sessionId}/`,
  ],
};

/** @deprecated Use StorageKeys instead */
export const R2Keys = StorageKeys;
