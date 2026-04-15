# HypeReels API Specification

> Owner: Backend Engineer
> Last updated: 2026-04-02
> Base URL: `http://localhost:3001` (dev) / `https://api.hypereels.app` (prod)

---

## OpenAPI 3.0 Specification

```yaml
openapi: "3.0.3"
info:
  title: HypeReels API
  version: "1.0.0"
  description: |
    REST API for HypeReels — an ephemeral, session-scoped video reel generator.

    All endpoints (except POST /sessions and GET /health) require a valid session
    token supplied as a Bearer token in the Authorization header.

    Error responses always follow the envelope:
      { "error": { "code": "STRING", "message": "Human-readable text", "details"?: [...] } }

servers:
  - url: http://localhost:3001
    description: Local development
  - url: https://api.hypereels.app
    description: Production

# ─── Security ─────────────────────────────────────────────────────────────────
components:
  securitySchemes:
    SessionToken:
      type: http
      scheme: bearer
      description: |
        UUID session token returned by POST /sessions.
        Example: Authorization: Bearer 550e8400-e29b-41d4-a716-446655440000

  # ─── Reusable schemas ───────────────────────────────────────────────────────
  schemas:

    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
              description: Machine-readable error code (SCREAMING_SNAKE_CASE)
            message:
              type: string
              description: Human-readable description
            details:
              type: array
              description: Per-field validation details (present on 400/422)
              items:
                type: object
                properties:
                  path:    { type: string }
                  message: { type: string }

    Session:
      type: object
      required: [session_id, token]
      properties:
        session_id: { type: string, format: uuid }
        token:      { type: string, format: uuid, description: "Use this as the Bearer token" }

    SessionState:
      type: object
      properties:
        session_id:           { type: string, format: uuid }
        status:               { type: string, enum: [active, locked, complete, deleted] }
        current_step:
          type: string
          enum: [upload-clips, upload-audio, detect-persons, mark-highlights, review, generate, download]
        person_of_interest_id: { type: string, format: uuid, nullable: true }
        clips:
          type: array
          items: { $ref: '#/components/schemas/Clip' }
        audio:
          nullable: true
          allOf: [{ $ref: '#/components/schemas/AudioTrack' }]
        persons:
          type: array
          items: { $ref: '#/components/schemas/PersonSummary' }
        latest_job:
          nullable: true
          allOf: [{ $ref: '#/components/schemas/GenerationJob' }]

    Clip:
      type: object
      required: [id, original_filename, status, detection_status, file_size_bytes, created_at]
      properties:
        id:                 { type: string, format: uuid }
        original_filename:  { type: string }
        status:             { type: string, enum: [uploading, validating, valid, invalid] }
        detection_status:   { type: string, enum: [pending, processing, complete, failed] }
        thumbnail_url:      { type: string, format: uri, nullable: true }
        duration_ms:        { type: integer, nullable: true, description: "Clip duration in milliseconds" }
        file_size_bytes:    { type: integer }
        validation_error:   { type: string, nullable: true }
        created_at:         { type: string, format: date-time }

    AudioTrack:
      type: object
      required: [id, original_filename, status, analysis_status, file_size_bytes, created_at]
      properties:
        id:                 { type: string, format: uuid }
        original_filename:  { type: string }
        status:             { type: string, enum: [uploading, validating, valid, invalid] }
        analysis_status:    { type: string, enum: [pending, processing, complete, failed] }
        duration_ms:        { type: integer, nullable: true }
        bpm:                { type: number, nullable: true, description: "Beats per minute (from analysis)" }
        waveform_url:       { type: string, format: uri, nullable: true }
        file_size_bytes:    { type: integer }
        created_at:         { type: string, format: date-time }

    Highlight:
      type: object
      required: [id, start_ms, end_ms]
      properties:
        id:       { type: string, format: uuid }
        start_ms: { type: integer, minimum: 0 }
        end_ms:   { type: integer }

    PersonSummary:
      type: object
      required: [person_ref_id, thumbnail_url, confidence, clip_appearances]
      properties:
        person_ref_id:    { type: string, format: uuid }
        thumbnail_url:    { type: string, format: uri }
        confidence:       { type: number, minimum: 0, maximum: 1 }
        clip_appearances:
          type: array
          items:
            type: object
            properties:
              detection_id: { type: string, format: uuid }
              clip_id:      { type: string, format: uuid }
              appearances:
                type: array
                items:
                  type: object
                  properties:
                    start_ms: { type: integer }
                    end_ms:   { type: integer }
                    bounding_box:
                      type: object
                      properties:
                        left:   { type: number }
                        top:    { type: number }
                        width:  { type: number }
                        height: { type: number }

    GenerationJob:
      type: object
      required: [id, status, created_at]
      properties:
        id:                 { type: string, format: uuid }
        status:
          type: string
          enum: [queued, processing, rendering, complete, failed, cancelled]
        progress_pct:       { type: integer, minimum: 0, maximum: 100, nullable: true }
        output_url:         { type: string, format: uri, nullable: true, description: "Presigned download URL (valid 2 h)" }
        output_duration_ms: { type: integer, nullable: true }
        output_size_bytes:  { type: integer, nullable: true }
        error_message:      { type: string, nullable: true }
        started_at:         { type: string, format: date-time, nullable: true }
        completed_at:       { type: string, format: date-time, nullable: true }
        created_at:         { type: string, format: date-time }

    SSEEvent:
      type: object
      description: |
        Server-Sent Events are plain text/event-stream.
        Each `data:` line contains a JSON object with a `type` field.
        Known types:

        | type                    | Trigger                                       |
        |-------------------------|-----------------------------------------------|
        | detection-complete      | personDetectionWorker finishes a clip         |
        | detection-failed        | personDetectionWorker fails for a clip        |
        | audio-analysed          | audioAnalysisWorker writes analysis to DB     |
        | audio-analysis-failed   | audioAnalysisWorker fails                     |
        | generation-progress     | assemblyWorker intermediate progress update   |
        | generation-complete     | assemblyWorker writes final MP4 + signed URL  |
        | generation-failed       | assemblyWorker fails                          |
      required: [type]
      properties:
        type: { type: string }

# ─── Paths ────────────────────────────────────────────────────────────────────
paths:

  # ── Health ──────────────────────────────────────────────────────────────────
  /health:
    get:
      operationId: healthCheck
      summary: Health check
      tags: [System]
      responses:
        "200":
          description: Service is healthy
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:    { type: string, enum: [ok] }
                  timestamp: { type: string, format: date-time }
              example:
                status: ok
                timestamp: "2026-04-02T12:00:00.000Z"
        "503":
          description: Database unreachable
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:  { type: string, enum: [error] }
                  message: { type: string }

  # ── Sessions ─────────────────────────────────────────────────────────────────
  /sessions:
    post:
      operationId: createSession
      summary: Create a new anonymous session
      tags: [Sessions]
      description: |
        Creates a new ephemeral session. The returned `token` must be sent as
        `Authorization: Bearer <token>` on every subsequent request.

        No authentication required — this is the bootstrap endpoint.
      responses:
        "201":
          description: Session created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Session' }
              example:
                session_id: "550e8400-e29b-41d4-a716-446655440000"
                token: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
        "500":
          description: Server error
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

  /sessions/{id}/state:
    get:
      operationId: getSessionState
      summary: Get full session state (for page refresh / step restoration)
      tags: [Sessions]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Current session state
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionState' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }
        "410": { $ref: '#/components/responses/Gone' }

  /sessions/{id}:
    delete:
      operationId: deleteSession
      summary: Explicitly delete session and all assets (start-over)
      tags: [Sessions]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "202":
          description: Cleanup job enqueued
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  /sessions/{id}/events:
    get:
      operationId: subscribeToSessionEvents
      summary: Subscribe to session SSE stream
      tags: [Sessions]
      security: [{ SessionToken: [] }]
      description: |
        Opens a persistent Server-Sent Events connection. The server publishes
        events to this stream as background jobs complete.

        The stream stays open until the client disconnects. A `: heartbeat`
        comment is sent every 25 seconds to prevent proxy timeouts.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: SSE stream (text/event-stream)
          content:
            text/event-stream:
              schema: { $ref: '#/components/schemas/SSEEvent' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  # ── Clips ────────────────────────────────────────────────────────────────────
  /sessions/{id}/clips:
    post:
      operationId: uploadClip
      summary: Upload a video clip
      tags: [Clips]
      security: [{ SessionToken: [] }]
      description: |
        Accepts a single video file (multipart/form-data).
        Supported: MP4, MOV, MKV, WebM (max 2 GB per clip, max 10 clips per session).
        Returns 202 immediately; a validation job runs asynchronously.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file:
                  type: string
                  format: binary
      responses:
        "202":
          description: Upload accepted; validation queued
          content:
            application/json:
              schema:
                type: object
                properties:
                  clip_id: { type: string, format: uuid }
              example:
                clip_id: "a84e0f43-1234-4abc-8765-fedcba098765"
        "400": { $ref: '#/components/responses/BadRequest' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "409":
          description: Session is locked for generation
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        "422":
          description: Unsupported format, file too large, or clip limit exceeded
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

    get:
      operationId: listClips
      summary: List all clips in the session
      tags: [Clips]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Clip list
          content:
            application/json:
              schema:
                type: object
                properties:
                  clips:
                    type: array
                    items: { $ref: '#/components/schemas/Clip' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  /sessions/{id}/clips/{clip_id}:
    delete:
      operationId: deleteClip
      summary: Remove a clip from the session
      tags: [Clips]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: clip_id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "204": { description: Clip deleted }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }
        "409":
          description: Session is locked (generation in progress)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

  /sessions/{id}/detect:
    post:
      operationId: triggerPersonDetection
      summary: Enqueue person detection for all pending validated clips
      tags: [Clips]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Nothing to queue (all clips already processed)
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
                  queued:  { type: integer }
        "202":
          description: Detection jobs queued
          content:
            application/json:
              schema:
                type: object
                properties:
                  queued: { type: integer }
                  jobs:
                    type: array
                    items:
                      type: object
                      properties:
                        clip_id: { type: string, format: uuid }
                        job_id:  { type: string }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  # ── Audio ────────────────────────────────────────────────────────────────────
  /sessions/{id}/audio:
    post:
      operationId: uploadAudio
      summary: Upload an audio track
      tags: [Audio]
      security: [{ SessionToken: [] }]
      description: |
        Replaces any previously uploaded audio track for the session.
        Supported: MP3, WAV, AAC, OGG, FLAC (max 500 MB).
        Returns 202 immediately; validation + audio-analysis jobs are queued.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file:
                  type: string
                  format: binary
      responses:
        "202":
          description: Upload accepted; analysis queued
          content:
            application/json:
              schema:
                type: object
                properties:
                  audio_id: { type: string, format: uuid }
              example:
                audio_id: "b94e0f43-5678-4def-9012-abcdef123456"
        "400": { $ref: '#/components/responses/BadRequest' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "409":
          description: Session is locked
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        "422":
          description: Unsupported format or file too large
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

    get:
      operationId: getAudio
      summary: Get audio track status and metadata
      tags: [Audio]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Audio track details
          content:
            application/json:
              schema:
                type: object
                properties:
                  audio: { $ref: '#/components/schemas/AudioTrack' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404":
          description: No audio track uploaded yet
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

    delete:
      operationId: deleteAudio
      summary: Delete the audio track
      tags: [Audio]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "204": { description: Audio deleted }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  # ── Person Detection ─────────────────────────────────────────────────────────
  /sessions/{id}/persons:
    get:
      operationId: listPersons
      summary: List detected persons in the session
      tags: [Persons]
      security: [{ SessionToken: [] }]
      description: |
        Returns one entry per unique person detected across all clips, ordered
        by confidence descending. May return an empty list if detection has not
        yet run or found no people.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Person list with current selection
          content:
            application/json:
              schema:
                type: object
                properties:
                  persons:
                    type: array
                    items: { $ref: '#/components/schemas/PersonSummary' }
                  person_of_interest_id:
                    type: string
                    format: uuid
                    nullable: true
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  /sessions/{id}/person-of-interest:
    put:
      operationId: setPersonOfInterest
      summary: Select or clear the person of interest
      tags: [Persons]
      security: [{ SessionToken: [] }]
      description: |
        Sets the person whose moments are prioritised in the final reel.
        Send `person_ref_id: null` to clear the selection.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [person_ref_id]
              properties:
                person_ref_id:
                  type: string
                  format: uuid
                  nullable: true
            examples:
              select:
                value: { person_ref_id: "c04e0f43-abcd-4abc-8765-0123456789ab" }
              clear:
                value: { person_ref_id: null }
      responses:
        "200":
          description: Person of interest updated
          content:
            application/json:
              schema:
                type: object
                properties:
                  person_of_interest_id:
                    type: string
                    format: uuid
                    nullable: true
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }
        "422": { $ref: '#/components/responses/UnprocessableEntity' }

  # ── Highlights ───────────────────────────────────────────────────────────────
  /sessions/{id}/clips/{clip_id}/highlights:
    put:
      operationId: setHighlights
      summary: Replace all highlights for a clip
      tags: [Highlights]
      security: [{ SessionToken: [] }]
      description: |
        **Canonical route: `PUT /sessions/:id/clips/:clip_id/highlights`**

        Full replace semantics — deletes all existing highlights and inserts the
        provided list. Send an empty array to clear all highlights.

        Constraints:
          - Clip must have status = 'valid'
          - Each highlight must be >= 1 000 ms long
          - `end_ms` must not exceed the clip's `duration_ms`
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: clip_id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [highlights]
              properties:
                highlights:
                  type: array
                  items:
                    type: object
                    required: [start_ms, end_ms]
                    properties:
                      start_ms: { type: integer, minimum: 0 }
                      end_ms:   { type: integer }
            examples:
              two_highlights:
                value:
                  highlights:
                    - { start_ms: 5000,  end_ms: 15000 }
                    - { start_ms: 30000, end_ms: 42000 }
              clear:
                value: { highlights: [] }
      responses:
        "200":
          description: Updated highlights list
          content:
            application/json:
              schema:
                type: object
                properties:
                  highlights:
                    type: array
                    items: { $ref: '#/components/schemas/Highlight' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }
        "409":
          description: Session locked or clip not yet validated
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        "422": { $ref: '#/components/responses/UnprocessableEntity' }

    get:
      operationId: getHighlights
      summary: Get all highlights for a clip
      tags: [Highlights]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: clip_id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Highlights list (may be empty)
          content:
            application/json:
              schema:
                type: object
                properties:
                  highlights:
                    type: array
                    items: { $ref: '#/components/schemas/Highlight' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  # ── Generation ───────────────────────────────────────────────────────────────
  /sessions/{id}/generate:
    post:
      operationId: triggerGeneration
      summary: Trigger HypeReel generation
      tags: [Generation]
      security: [{ SessionToken: [] }]
      description: |
        Validates preconditions, locks the session, then enqueues assembly.

        Pre-conditions:
          - At least one clip with status = 'valid'
          - An audio track with analysis_status = 'complete'

        Subscribe to `GET /sessions/:id/events` to receive `generation-complete`.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "202":
          description: Generation job queued
          content:
            application/json:
              schema:
                type: object
                properties:
                  job_id: { type: string, format: uuid }
              example:
                job_id: "d84e0f43-9999-4bbb-cccc-000011112222"
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }
        "409":
          description: A generation job is already active
          content:
            application/json:
              schema:
                allOf:
                  - { $ref: '#/components/schemas/ErrorEnvelope' }
                  - type: object
                    properties:
                      job_id: { type: string, format: uuid }
        "422":
          description: Precondition not met
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

  /sessions/{id}/generate/{job_id}:
    get:
      operationId: getGenerationJob
      summary: Poll generation job status
      tags: [Generation]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: job_id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Job status
          content:
            application/json:
              schema: { $ref: '#/components/schemas/GenerationJob' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

    delete:
      operationId: cancelGenerationJob
      summary: Cancel a queued or in-progress generation job
      tags: [Generation]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: job_id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200":
          description: Job cancelled
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }
        "409":
          description: Job cannot be cancelled in its current state
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

  # ── Download ─────────────────────────────────────────────────────────────────
  /sessions/{id}/reel:
    get:
      operationId: downloadReel
      summary: Get download URL for completed reel (redirects to presigned MinIO URL)
      tags: [Download]
      security:
        - SessionToken: []
      description: |
        Returns **HTTP 302** to the presigned MinIO URL stored in
        `generation_jobs.output_url`. The URL is valid for 2 hours from the
        time generation completed.

        Frontend should call `POST /sessions/:id/download-initiated` immediately
        so cleanup is scheduled.

        If `Accept: application/json` is sent, the server returns 200 with a JSON
        body containing `download_url` and `expires_at` instead of redirecting.
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Presigned download URL for the completed HypeReel (JSON response)
          content:
            application/json:
              schema:
                type: object
                properties:
                  download_url:
                    type: string
                    format: uri
                    description: Presigned MinIO URL valid for 2 hours
                  expires_at:
                    type: string
                    format: date-time
                    description: Approximate expiry time of the presigned URL
        "302":
          description: Redirect to presigned MinIO MP4 download URL
          headers:
            Location:
              schema: { type: string, format: uri }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404":
          description: Reel not ready or URL missing
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        "409":
          description: Reel generation not yet complete
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        "410": { $ref: '#/components/responses/Gone' }

  /sessions/{id}/download-initiated:
    post:
      operationId: notifyDownloadInitiated
      summary: Notify that download has started (schedules 5-minute cleanup)
      tags: [Download]
      security: [{ SessionToken: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "202":
          description: Cleanup scheduled
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  /sessions/{id}/done:
    post:
      operationId: confirmDone
      summary: Confirm download complete; trigger immediate cleanup
      tags: [Download]
      security: [{ SessionToken: [] }]
      description: |
        Triggers immediate deletion of all session assets.
        The session token is invalidated after this call.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "202":
          description: Immediate cleanup enqueued
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "404": { $ref: '#/components/responses/NotFound' }

  # ─── Shared response definitions ─────────────────────────────────────────────
  responses:
    Unauthorized:
      description: Missing or invalid Bearer token
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
          example:
            error:
              code: MISSING_TOKEN
              message: "Authorization: Bearer <token> header is required."

    NotFound:
      description: Resource not found
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
          example:
            error:
              code: SESSION_NOT_FOUND
              message: "Session not found. Please start over."

    Gone:
      description: Session has been deleted or expired (410)
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
          example:
            error:
              code: SESSION_GONE
              message: "Your session has expired or been deleted. Please start over."

    BadRequest:
      description: Malformed request
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }

    UnprocessableEntity:
      description: Semantic validation error
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
```

---

## Frontend Integration Notes

### Session Token Flow

1. On first page load: `POST /sessions` — store `token` in `localStorage`.
2. Every subsequent request: `Authorization: Bearer <token>`.
3. On 404/410 response: clear token, redirect to home with "session expired" message.

### Confirmed: `GET /sessions/:id/reel` Exists

`GET /sessions/:id/reel` is present in `server/src/routes/download.ts` and returns
HTTP 302 to the presigned MinIO URL stored in `generation_jobs.output_url`.

The `assemblyWorker` generates a fresh presigned URL (2 h TTL) at completion time and
persists it to `generation_jobs.output_url`, so the redirect is ready immediately after
the `generation-complete` SSE event arrives.

If you need a guaranteed fresh URL (user waited > 2 hours): read `output_url` from
`GET /sessions/:id/generate/:job_id`. A dedicated "re-sign URL" endpoint is out of
MVP scope.

### Confirmed: Highlight Route

The canonical route is **`PUT /sessions/:id/clips/:clip_id/highlights`** — implemented
in `server/src/routes/highlights.ts`. Note: path parameter is `clip_id`, not `clipId`.

### Recommended Frontend Call Sequence

```
1.  POST /sessions                           → store token
2.  POST /sessions/:id/clips  (×N parallel)  → upload clips
3.  POST /sessions/:id/audio                 → upload audio
4.  POST /sessions/:id/detect                → trigger person detection
5.  GET  /sessions/:id/events                → open SSE stream
    ← detection-complete  (per clip)
    ← audio-analysed
6.  GET  /sessions/:id/persons               → render person picker
7.  PUT  /sessions/:id/person-of-interest    → user selects person
8.  PUT  /sessions/:id/clips/:id/highlights  → (optional, per clip)
9.  POST /sessions/:id/generate              → lock session, queue assembly
    ← generation-progress  (optional)
    ← generation-complete { download_url }
10. GET  /sessions/:id/reel                  → 302 → MP4 download
11. POST /sessions/:id/download-initiated    → schedule 5-min cleanup
12. POST /sessions/:id/done                  → immediate cleanup
```

### SSE Event Payload Reference

| `type`                  | Key payload fields                                                  |
|-------------------------|---------------------------------------------------------------------|
| `detection-complete`    | `clip_id`, `persons[]` (person_ref_id, thumbnail_url, confidence)  |
| `detection-failed`      | `clip_id`, `error`                                                  |
| `audio-analysed`        | `audio_track_id`, `bpm`, `beats_count`, `duration_ms`              |
| `audio-analysis-failed` | `audio_track_id`, `error`                                           |
| `generation-progress`   | `job_id`, `status`, `progress_pct`                                  |
| `generation-complete`   | `job_id`, `download_url`, `output_duration_ms`, `output_size_bytes` |
| `generation-failed`     | `job_id`, `error`                                                   |

---

## Python Worker Integration Notes

### Audio Analysis Service

**HTTP POST** `PYTHON_WORKER_URL/analyse-audio`
Called by: `server/src/workers/audioAnalysisWorker.ts`

Request body:
```json
{
  "audio_url": "https://presigned-r2-url-to-audio-file",
  "session_id": "uuid",
  "audio_track_id": "uuid"
}
```

Required response (synchronous, budget 5 min):
```json
{
  "bpm": 128.0,
  "beats_ms": [0, 468, 937],
  "downbeats_ms": [0, 1875, 3750],
  "onsets_ms": [0, 120, 340],
  "energy_envelope": [[0, 0.42], [100, 0.55]],
  "phrases": [{ "start_ms": 0, "end_ms": 8000, "label": "intro" }],
  "duration_ms": 210000
}
```

### Assembly Service

**HTTP POST** `PYTHON_WORKER_URL/assemble-reel`
Called by: `server/src/workers/assemblyWorker.ts`

Key request fields:
```json
{
  "session_id": "uuid",
  "job_id": "uuid",
  "audio_r2_key": "uploads/{sessionId}/audio_{id}.mp3",
  "audio_analysis": { "bpm": 128, "beats_ms": [...], "..." : "..." },
  "clips": [{
    "clip_id": "uuid",
    "r2_key": "uploads/{sessionId}/{id}.mp4",
    "duration_ms": 30000,
    "highlights": [{ "start_ms": 5000, "end_ms": 15000 }],
    "person_appearances": [{ "start_ms": 5000, "end_ms": 15000, "confidence": 0.95, "person_ref_id": "uuid" }]
  }],
  "person_of_interest_id": "uuid or null",
  "r2_endpoint": "http://minio:9000",
  "r2_access_key_id": "...",
  "r2_secret_access_key": "...",
  "r2_bucket": "hypereels",
  "output_r2_key": "generated/{sessionId}/hypereel_{jobId}.mp4"
}
```

Required response (synchronous, budget 15 min):
```json
{
  "output_r2_key": "generated/{sessionId}/hypereel_{jobId}.mp4",
  "output_size_bytes": 125829120,
  "output_duration_ms": 60000,
  "edl_json": { "segments": [...] }
}
```

Python **must** upload the rendered MP4 directly to R2 (using provided credentials
and `output_r2_key`) before returning this response. The Node worker then generates
the presigned download URL and notifies the frontend via SSE.
