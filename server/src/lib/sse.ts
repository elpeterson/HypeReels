/**
 * SSE connection manager.
 *
 * The API server subscribes to Redis pub/sub channel `session:{id}:events`
 * and fans out messages to all SSE connections for that session (handles
 * multiple browser tabs).
 *
 * Workers publish JSON strings to the same channel.
 */
import { Redis } from 'ioredis';
import type { FastifyReply } from 'fastify';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// Dedicated Redis subscriber (cannot share with BullMQ connection)
const subscriber = new Redis(requireEnv('REDIS_URL'), {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

// Map sessionId → Set of active reply objects
const connections = new Map<string, Set<FastifyReply>>();

// Map sessionId → ref count of subscriber channels
const subscriptions = new Map<string, number>();

export function sseChannelForSession(sessionId: string): string {
  return `session:${sessionId}:events`;
}

export async function initSSESubscriber(): Promise<void> {
  await subscriber.connect();

  subscriber.on('message', (channel: string, message: string) => {
    // channel = "session:{id}:events"
    const sessionId = channel.replace(/^session:/, '').replace(/:events$/, '');
    const conns = connections.get(sessionId);
    if (!conns || conns.size === 0) return;

    for (const reply of conns) {
      try {
        reply.raw.write(`data: ${message}\n\n`);
      } catch {
        // Client disconnected; will be cleaned up by the close handler
      }
    }
  });
}

/**
 * Register a new SSE connection for a session.
 * Returns a cleanup function to call when the connection closes.
 */
export async function addSSEConnection(
  sessionId: string,
  reply: FastifyReply,
): Promise<() => void> {
  // Set SSE headers
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders();

  // Send a keep-alive comment immediately
  reply.raw.write(': connected\n\n');

  const channel = sseChannelForSession(sessionId);

  if (!connections.has(sessionId)) {
    connections.set(sessionId, new Set());
  }
  connections.get(sessionId)!.add(reply);

  // Subscribe to Redis channel if first connection for this session
  const refCount = subscriptions.get(sessionId) ?? 0;
  if (refCount === 0) {
    await subscriber.subscribe(channel);
  }
  subscriptions.set(sessionId, refCount + 1);

  // Heartbeat every 25 s to keep proxy connections alive
  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(': heartbeat\n\n');
    } catch {
      // ignore — cleanup fn will handle it
    }
  }, 25_000);

  return async () => {
    clearInterval(heartbeat);
    connections.get(sessionId)?.delete(reply);

    const newCount = (subscriptions.get(sessionId) ?? 1) - 1;
    if (newCount <= 0) {
      subscriptions.delete(sessionId);
      connections.delete(sessionId);
      await subscriber.unsubscribe(channel).catch(() => undefined);
    } else {
      subscriptions.set(sessionId, newCount);
    }
  };
}

/**
 * Publish an event to all SSE clients for a session.
 * Used from within the API server (workers use their own Redis publisher).
 */
let publisher: Redis | null = null;

async function getPublisher(): Promise<Redis> {
  if (!publisher) {
    publisher = new Redis(requireEnv('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    await publisher.connect();
  }
  return publisher;
}

export async function publishSSEEvent(
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const pub = await getPublisher();
  await pub.publish(sseChannelForSession(sessionId), JSON.stringify(event));
}

export async function closeSSESubscriber(): Promise<void> {
  await subscriber.quit().catch(() => undefined);
  if (publisher) {
    await publisher.quit().catch(() => undefined);
  }
}
