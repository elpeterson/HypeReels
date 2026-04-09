/**
 * Clip routes:
 *   POST   /sessions/:id/clips
 *   GET    /sessions/:id/clips
 *   DELETE /sessions/:id/clips/:clip_id
 */
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { query, withTransaction } from '../db/client.js';
import { uploadToStorage, deleteObject, StorageKeys } from '../lib/storage.js';
import { enqueueClipValidationJob, enqueuePersonDetection } from '../jobs/producers.js';

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
]);

const ALLOWED_VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);
const MAX_CLIPS_PER_SESSION = 10;
const MAX_CLIP_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const clipsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /sessions/:id/clips ──────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/clips',
    async (request, reply) => {
      const { session } = request;

      if (session.status === 'locked') {
        return reply.code(409).send({
          error: {
            code: 'SESSION_LOCKED',
            message: 'Session is locked for generation. No new clips can be added.',
          },
        });
      }

      // Check clip count
      const countRes = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM clips WHERE session_id = $1 AND status != 'invalid'`,
        [session.id],
      );
      if (parseInt(countRes.rows[0]?.count ?? '0', 10) >= MAX_CLIPS_PER_SESSION) {
        return reply.code(422).send({
          error: {
            code: 'CLIP_LIMIT_EXCEEDED',
            message: `Maximum of ${MAX_CLIPS_PER_SESSION} clips per session.`,
          },
        });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({
          error: { code: 'NO_FILE', message: 'No file was uploaded.' },
        });
      }

      const ext = path.extname(data.filename).toLowerCase();
      const mime = data.mimetype;

      if (!ALLOWED_VIDEO_EXT.has(ext) || !ALLOWED_VIDEO_MIME.has(mime)) {
        // Drain the stream to avoid memory leak
        data.file.resume();
        return reply.code(422).send({
          error: {
            code: 'UNSUPPORTED_FORMAT',
            message: 'Unsupported format. Please upload MP4, MOV, MKV, or WebM.',
          },
        });
      }

      const clipId = randomUUID();
      const r2Key = StorageKeys.clipUpload(session.id, clipId, ext.slice(1));

      // Stream directly to R2
      let fileSizeBytes = 0;
      const countingStream = data.file.on('data', (chunk: Buffer) => {
        fileSizeBytes += chunk.length;
        if (fileSizeBytes > MAX_CLIP_SIZE_BYTES) {
          countingStream.destroy(
            new Error('FILE_TOO_LARGE'),
          );
        }
      });

      try {
        await uploadToStorage({
          key: r2Key,
          body: data.file,
          contentType: mime,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'FILE_TOO_LARGE') {
          // Best-effort cleanup — object may be partially written
          await deleteObject(r2Key).catch(() => undefined);
          return reply.code(422).send({
            error: {
              code: 'FILE_TOO_LARGE',
              message: 'File too large. Maximum size is 2 GB per clip.',
            },
          });
        }
        throw err;
      }

      // Insert clip row
      await query(
        `INSERT INTO clips (id, session_id, original_filename, minio_key, file_size_bytes, status)
         VALUES ($1, $2, $3, $4, $5, 'validating')`,
        [clipId, session.id, data.filename, r2Key, fileSizeBytes],
      );

      // Enqueue clip validation job
      await enqueueClipValidationJob(session.id, clipId, r2Key);

      return reply.code(202).send({ clip_id: clipId });
    },
  );

  // ── GET /sessions/:id/clips ───────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/clips',
    async (request, reply) => {
      const { session } = request;

      const clipsRes = await query(
        `SELECT id, original_filename, status, detection_status,
                thumbnail_url, duration_ms, file_size_bytes, validation_error, created_at
         FROM clips WHERE session_id = $1 ORDER BY created_at`,
        [session.id],
      );

      return reply.send({ clips: clipsRes.rows });
    },
  );

  // ── DELETE /sessions/:id/clips/:clip_id ───────────────────
  fastify.delete<{ Params: { id: string; clip_id: string } }>(
    '/sessions/:id/clips/:clip_id',
    async (request, reply) => {
      const { session } = request;
      const { clip_id } = request.params;

      if (session.status === 'locked') {
        return reply.code(409).send({
          error: {
            code: 'SESSION_LOCKED',
            message: 'Session is locked for generation.',
          },
        });
      }

      // Fetch clip to get MinIO key
      const clipRes = await query<{ minio_key: string; thumbnail_url: string | null }>(
        `SELECT minio_key, thumbnail_url FROM clips WHERE id = $1 AND session_id = $2`,
        [clip_id, session.id],
      );

      if (clipRes.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'CLIP_NOT_FOUND', message: 'Clip not found.' },
        });
      }

      const { minio_key: r2Key, thumbnail_url: thumbnailUrl } = clipRes.rows[0]!;

      // Delete DB rows (highlights cascade from FK)
      await withTransaction(async (client) => {
        await client.query(
          `DELETE FROM person_detections WHERE clip_id = $1`,
          [clip_id],
        );
        await client.query(`DELETE FROM clips WHERE id = $1`, [clip_id]);
      });

      // Delete R2 objects (fire-and-forget is acceptable — R2 TTL is safety net)
      await Promise.all([
        deleteObject(r2Key).catch(() => undefined),
        thumbnailUrl
          ? deleteObject(
              new URL(thumbnailUrl).pathname.slice(1),
            ).catch(() => undefined)
          : Promise.resolve(),
      ]);

      return reply.code(204).send();
    },
  );

  // ── POST /sessions/:id/detect ─────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/detect',
    async (request, reply) => {
      const { session } = request;

      const clipsRes = await query<{ id: string; minio_key: string }>(
        `SELECT id, minio_key FROM clips
         WHERE session_id = $1 AND status = 'valid' AND detection_status = 'pending'`,
        [session.id],
      );

      if (clipsRes.rowCount === 0) {
        return reply.code(200).send({
          message: 'No clips pending detection.',
          queued: 0,
        });
      }

      const jobs: Array<{ clip_id: string; job_id: string }> = [];
      for (const clip of clipsRes.rows) {
        await query(
          `UPDATE clips SET detection_status = 'processing' WHERE id = $1`,
          [clip.id],
        );
        const jobId = await enqueuePersonDetection(session.id, clip.id, clip.minio_key);
        jobs.push({ clip_id: clip.id, job_id: jobId });
      }

      return reply.code(202).send({ queued: jobs.length, jobs });
    },
  );
};

export default clipsRoutes;
