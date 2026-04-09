import type { SSEEvent } from '@/types'

type SSEHandler = (event: SSEEvent) => void
type ErrorHandler = (err: Event) => void

export interface SSEClient {
  disconnect: () => void
}

/**
 * Connect to the SSE stream for a given session.
 *
 * The EventSource automatically reconnects on dropped connections.
 * Call the returned `disconnect()` to tear down the connection.
 */
export function connectSSE(
  sessionId: string,
  token: string,
  onEvent: SSEHandler,
  onError?: ErrorHandler
): SSEClient {
  const baseUrl = import.meta.env.VITE_API_URL ?? ''
  // The token is passed as a query param because EventSource doesn't support
  // custom headers in the browser. The server must accept `?token=` on this
  // endpoint in addition to the Authorization header used by REST calls.
  const url = `${baseUrl}/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`

  const es = new EventSource(url)

  es.onmessage = (raw: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(raw.data) as SSEEvent
      onEvent(parsed)
    } catch {
      console.warn('[SSE] Failed to parse event data:', raw.data)
    }
  }

  // Named event types the server may emit (in addition to unnamed 'message')
  const eventTypes: SSEEvent['type'][] = [
    'clip-validated',
    'clip-validation-failed',
    'audio-validated',
    'audio-analysed',
    'audio-analysis-failed',
    'detection-complete',
    'detection-failed',
    'generation-progress',
    'generation-complete',
    'generation-failed',
  ]

  for (const type of eventTypes) {
    es.addEventListener(type, (raw: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(raw.data) as SSEEvent
        onEvent(parsed)
      } catch {
        console.warn(`[SSE] Failed to parse '${type}' event:`, raw.data)
      }
    })
  }

  es.onerror = (err) => {
    console.warn('[SSE] Connection error:', err)
    onError?.(err)
  }

  return {
    disconnect: () => {
      es.close()
    },
  }
}
