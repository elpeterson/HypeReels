/**
 * Audio routes:
 *   POST   /sessions/:id/audio
 *   GET    /sessions/:id/audio
 *   DELETE /sessions/:id/audio
 */
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { query, withTransaction } from '../db/client.js';
import { uploadToStorage, deleteObject, StorageKeys } from '../lib/storage.js';
import {
  enqueueAudioValidation,
  enqueueAudioAnalysis,
} from '../jobs/producers.js';

const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/x-aac',
  'audio/mp4',
  'audio/ogg',
]);

const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg']);
const MAX_AUDIO_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

const audioRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /sessions/:id/audio ──────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/audio',
    async (request, reply) => {
      const { session } = request;

      if (session.status === 'locked') {
        return reply.code(409).send({
          error: { code: 'SESSION_LOCKED', message: 'Session is locked.' },
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

      if (!ALLOWED_AUDIO_EXT.has(ext) || !ALLOWED_AUDIO_MIME.has(mime)) {
        data.file.resume();
        return reply.code(422).send({
          error: {
            code: 'UNSUPPORTED_FORMAT',
            message:
              'Unsupported format. Please upload MP3, WAV, AAC, or OGG.',
          },
        });
      }

      // Delete any existing audio track for this session (replace semantics)
      const existingRes = await query<{ id: string; minio_key: string }>(
        `SELECT id, minio_key FROM audio_tracks WHERE session_id = $1`,
        [session.id],
      );
      if (existingRes.rowCount && existingRes.rowCount > 0) {
        const existing = existingRes.rows[0]!;
        await withTransaction(async (client) => {
          await client.query(
            `DELETE FROM audio_tracks WHERE session_id = $1`,
            [session.id],
          );
        });
        await deleteObject(existing.minio_key).catch(() => undefined);
      }

      const audioId = randomUUID();
      const r2Key = StorageKeys.audioUpload(session.id, audioId, ext.slice(1));

      let fileSizeBytes = 0;
      const countingStream = data.file.on('data', (chunk: Buffer) => {
        fileSizeBytes += chunk.length;
        if (fileSizeBytes > MAX_AUDIO_SIZE_BYTES) {
          countingStream.destroy(new Error('FILE_TOO_LARGE'));
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
          await deleteObject(r2Key).catch(() => undefined);
          return reply.code(422).send({
            error: {
              code: 'FILE_TOO_LARGE',
              message: 'File too large. Maximum audio size is 500 MB.',
            },
          });
        }
        throw err;
      }

      await query(
        `INSERT INTO audio_tracks
           (id, session_id, original_filename, minio_key, file_size_bytes, status)
         VALUES ($1, $2, $3, $4, $5, 'validating')`,
        [audioId, session.id, data.filename, r2Key, fileSizeBytes],
      );

      // Enqueue validation + audio analysis (validation must succeed first;
      // the Python worker handles sequencing internally)
      await enqueueAudioValidation(session.id, audioId, r2Key);
      await enqueueAudioAnalysis(session.id, audioId, r2Key);

      return reply.code(202).send({ audio_id: audioId });
    },
  );

  // ── GET /sessions/:id/audio ───────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/audio',
    async (request, reply) => {
      const { session } = request;

      const audioRes = await query(
        `SELECT id, original_filename, status, analysis_status,
                duration_ms, waveform_url, file_size_bytes, created_at,
                analysis_json->>'bpm' AS bpm
         FROM audio_tracks WHERE session_id = $1 LIMIT 1`,
        [session.id],
      );

      if (audioRes.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'AUDIO_NOT_FOUND', message: 'No audio track uploaded.' },
        });
      }

      return reply.send({ audio: audioRes.rows[0] });
    },
  );

  // ── DELETE /sessions/:id/audio ────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/sessions/:id/audio',
    async (request, reply) => {
      const { session } = request;

      const audioRes = await query<{ minio_key: string; waveform_url: string | null }>(
        `SELECT minio_key, waveform_url FROM audio_tracks WHERE session_id = $1`,
        [session.id],
      );

      if (audioRes.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'AUDIO_NOT_FOUND', message: 'No audio track to delete.' },
        });
      }

      const { minio_key, waveform_url } = audioRes.rows[0]!;

      await query(
        `DELETE FROM audio_tracks WHERE session_id = $1`,
        [session.id],
      );

      await Promise.all([
        deleteObject(minio_key).catch(() => undefined),
        waveform_url
          ? deleteObject(new URL(waveform_url).pathname.slice(1)).catch(
              () => undefined,
            )
          : Promise.resolve(),
      ]);

      return reply.code(204).send();
    },
  );
};

export default audioRoutes;
