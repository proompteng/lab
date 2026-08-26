import 'server-only'

type StreamSource<Value> = {
  cancel(): void
  off(event: 'data', listener: (value: Value) => void): unknown
  off(event: 'end', listener: () => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'data', listener: (value: Value) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  pause(): void
  resume(): void
}

type ServerSentEvent = { data: unknown; id?: number | string; event?: string }

const HEARTBEAT_INTERVAL_MS = 15_000
const ACTIVE_STREAM_LIMIT_PER_SUBJECT = 4

export function acquireTengriEventStreamSlot(subject: string): (() => void) | null {
  const state = globalThis as typeof globalThis & { tengriActiveStreams?: Map<string, number> }
  const activeStreams = (state.tengriActiveStreams ??= new Map())
  const active = activeStreams.get(subject) ?? 0
  if (active >= ACTIVE_STREAM_LIMIT_PER_SUBJECT) return null
  activeStreams.set(subject, active + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeStreams.get(subject) ?? 1) - 1
    if (remaining > 0) activeStreams.set(subject, remaining)
    else activeStreams.delete(subject)
  }
}

export function createTengriEventStream<Value>(
  source: StreamSource<Value>,
  signal: AbortSignal,
  normalize: (value: Value) => ServerSentEvent,
  onDispose?: () => void,
) {
  const encoder = new TextEncoder()
  let paused = false
  let disposed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let dispose: ((cancelSource: boolean) => boolean) | undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const disposeSource = (cancelSource: boolean) => {
        if (disposed) return false
        disposed = true
        try {
          if (heartbeat) clearInterval(heartbeat)
          signal.removeEventListener('abort', onAbort)
          source.off('data', onData)
          source.off('end', onEnd)
          source.off('error', onError)
          if (cancelSource) source.cancel()
        } finally {
          onDispose?.()
        }
        return true
      }
      dispose = disposeSource
      const onAbort = () => {
        if (!disposeSource(true)) return
        controller.close()
      }
      const onData = (value: Value) => {
        if (disposed) return
        try {
          const event = normalize(value)
          controller.enqueue(encoder.encode(serializeEvent(event)))
          if ((controller.desiredSize ?? 1) <= 0) {
            paused = true
            source.pause()
          }
        } catch {
          if (!disposeSource(true)) return
          controller.error(new Error('Tengri event stream returned an invalid event'))
        }
      }
      const onEnd = () => {
        if (!disposeSource(false)) return
        controller.close()
      }
      const onError = () => {
        if (!disposeSource(false)) return
        controller.error(new Error('Tengri event stream ended unexpectedly'))
      }

      source.on('data', onData)
      source.on('end', onEnd)
      source.on('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
      heartbeat = setInterval(() => {
        if (!disposed && !paused && (controller.desiredSize ?? 0) > 0) {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        }
      }, HEARTBEAT_INTERVAL_MS)
      if (signal.aborted) onAbort()
    },
    pull() {
      if (!disposed && paused) {
        paused = false
        source.resume()
      }
    },
    cancel() {
      dispose?.(true)
    },
  })
}

export function tengriEventStreamHeaders() {
  return {
    'Cache-Control': 'no-store, no-transform',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  }
}

function serializeEvent(event: ServerSentEvent) {
  const lines = []
  if (event.id !== undefined) lines.push(`id: ${String(event.id).replaceAll(/[\r\n]/g, '')}`)
  if (event.event) lines.push(`event: ${event.event.replaceAll(/[\r\n]/g, '')}`)
  for (const line of JSON.stringify(event.data).split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}
