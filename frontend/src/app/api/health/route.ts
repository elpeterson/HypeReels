/**
 * GET /api/health
 *
 * Returns status of the application, queue (Redis), and storage (MinIO).
 */

import { NextResponse } from "next/server";
import { pingRedis } from "../../../lib/redis";
import { pingStorage } from "../../../lib/storage";

export async function GET(): Promise<NextResponse> {
  const [queueOk, storageOk] = await Promise.allSettled([
    pingRedis(),
    pingStorage(),
  ]);

  const queue =
    queueOk.status === "fulfilled" && queueOk.value ? "connected" : "error";
  const storage =
    storageOk.status === "fulfilled" && storageOk.value
      ? "connected"
      : "error";

  const status = queue === "connected" && storage === "connected" ? "ok" : "degraded";

  return NextResponse.json({ status, queue, storage });
}
