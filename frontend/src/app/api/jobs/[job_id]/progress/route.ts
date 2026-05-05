/**
 * GET /api/jobs/[job_id]/progress
 *
 * Read job progress from Redis.
 * Returns: { job_id, status, stage, pct, message, updated_at, error? }
 *
 * progress_pct: 0 for queued, 1-99 for processing, 100 for completed.
 */

import { NextResponse } from "next/server";
import { getJobProgress } from "../../../../../lib/redis";
import { notFound, internalError } from "../../../../../lib/errors";

interface RouteParams {
  params: { job_id: string };
}

export async function GET(
  _req: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { job_id } = params;
    const progress = await getJobProgress(job_id);

    if (!progress) {
      return notFound("Job not found or progress expired");
    }

    return NextResponse.json(progress);
  } catch (err) {
    console.error("[GET /api/jobs/[job_id]/progress] error:", err);
    return internalError();
  }
}
