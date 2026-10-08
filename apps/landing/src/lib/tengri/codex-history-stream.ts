import 'server-only'

import type { CodexHistoryPage } from './codex-history'
import type { TengriErrorCode } from './types'

type HistorySource<Value> = AsyncIterable<Value> & { cancel(): void }
type HistoryFailure = Error & { status: number; code?: TengriErrorCode }

export async function codexHistoryResponse<Value>(
  source: HistorySource<Value>,
  signal: AbortSignal,
  normalize: (value: Value) => CodexHistoryPage,
  failure: (error: unknown) => HistoryFailure,
) {
  const iterator = source[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let disposed = false
  let cancelled = false
  const dispose = (cancel: boolean) => {
    if (disposed) return
    disposed = true
    signal.removeEventListener('abort', abort)
    if (cancel) {
      source.cancel()
      void iterator.return?.().catch(() => {})
    }
  }
  const abort = () => dispose(true)
  signal.addEventListener('abort', abort, { once: true })
  let first: CodexHistoryPage | undefined
  try {
    signal.throwIfAborted()
    const initial = await iterator.next()
    signal.throwIfAborted()
    if (initial.done) throw new Error('Missing conversation metadata')
    first = normalize(initial.value)
    if (first.part !== 'thread') throw new Error('Missing conversation metadata')
  } catch (error) {
    dispose(true)
    throw failure(error)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (disposed) {
        if (!cancelled) controller.close()
        return
      }
      try {
        if (first) {
          controller.enqueue(encoder.encode(`${JSON.stringify(first)}\n`))
          first = undefined
          return
        }
        const page = await iterator.next()
        if (disposed) {
          if (!cancelled) controller.close()
          return
        }
        if (page.done) {
          controller.enqueue(encoder.encode('{"type":"complete"}\n'))
          dispose(false)
          controller.close()
        } else controller.enqueue(encoder.encode(`${JSON.stringify(normalize(page.value))}\n`))
      } catch (cause) {
        if (disposed) {
          if (!cancelled) controller.close()
          return
        }
        const error = failure(cause)
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: 'error', error: error.message, status: error.status, code: error.code })}\n`,
          ),
        )
        dispose(true)
        controller.close()
      }
    },
    cancel() {
      cancelled = true
      dispose(true)
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
