import { expect, mock, spyOn, test } from 'bun:test'
import * as Sentry from '@sentry/node'
import { context, propagation, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { observeRequest } from '../observability/server'
import type { CodexHistoryPage } from './codex-history'

void mock.module('server-only', () => ({}))

const metadata: CodexHistoryPage = { type: 'page', part: 'thread', rawJson: '{}', eventSequence: 10 }
function failure(cause: unknown) {
  return Object.assign(new Error(cause instanceof Error ? cause.message : 'Unavailable'), { status: 503 })
}

test('a failed history record reports the original exception and marks the live request span failed', async () => {
  const { codexHistoryResponse } = await import('./codex-history-stream')
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  provider.register()
  const capture = spyOn(Sentry, 'captureException').mockReturnValue('fixture-event')
  const cause = new Error('RPC connection lost')
  try {
    const request = new Request('https://proompteng.ai/api/tengri')
    const response = await observeRequest(request, 'tengri.history', () =>
      codexHistoryResponse(
        {
          cancel() {},
          async *[Symbol.asyncIterator]() {
            yield metadata
            throw cause
          },
        },
        request.signal,
        (page) => page,
        failure,
      ),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"error"')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]?.[0]).toBe(cause)
    expect(exporter.getFinishedSpans()).toHaveLength(1)
    expect(exporter.getFinishedSpans()[0]!.status.code).toBe(2)
  } finally {
    capture.mockRestore()
    await provider.shutdown()
    context.disable()
    trace.disable()
    propagation.disable()
  }
})

test('forwards one page at a time, honors backpressure, and cancels the upstream stream on disconnect', async () => {
  const { codexHistoryResponse } = await import('./codex-history-stream')
  let reads = 0
  let cancelled = 0
  let returned = 0
  const source = {
    cancel() {
      cancelled++
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          reads++
          return { done: false as const, value: metadata }
        },
        async return() {
          returned++
          return { done: true as const, value: metadata }
        },
      }
    },
  }
  const response = await codexHistoryResponse(source, new AbortController().signal, (page) => page, failure)
  await Promise.resolve()
  expect(reads).toBe(1)
  const reader = response.body!.getReader()
  await reader.read()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reads).toBe(2)
  await reader.cancel()
  expect(cancelled).toBe(1)
  expect(returned).toBe(1)
})

test('does not emit completion after an upstream failure or abort', async () => {
  const { codexHistoryResponse } = await import('./codex-history-stream')
  let cancelled = false
  const source = {
    cancel() {
      cancelled = true
    },
    async *[Symbol.asyncIterator]() {
      yield metadata
      throw new Error('Authorization was revoked')
    },
  }
  const response = await codexHistoryResponse(
    source,
    new AbortController().signal,
    (page) => page,
    () => Object.assign(new Error('Tengri request is not permitted'), { status: 403 }),
  )
  const records = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records).toEqual([metadata, { type: 'error', error: 'Tengri request is not permitted', status: 403 }])
  expect(cancelled).toBe(true)
  const caller = new AbortController()
  const aborted = await codexHistoryResponse(
    {
      cancel() {
        cancelled = true
      },
      async *[Symbol.asyncIterator]() {
        yield metadata
      },
    },
    caller.signal,
    (page) => page,
    failure,
  )
  cancelled = false
  caller.abort()
  expect(cancelled).toBe(true)
  expect(await aborted.text()).not.toContain('"type":"complete"')
})

test('fails before HTTP success when the initial RPC fails and emits completion only on a clean end', async () => {
  const { codexHistoryResponse } = await import('./codex-history-stream')
  let cancelled = false
  expect(
    await codexHistoryResponse(
      {
        cancel() {
          cancelled = true
        },
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<CodexHistoryPage>> {
              throw new Error('Conversation is missing')
            },
          }
        },
      },
      new AbortController().signal,
      (page) => page,
      failure,
    ).catch((error: unknown) => error),
  ).toMatchObject({ message: 'Conversation is missing' })
  expect(cancelled).toBe(true)
  const response = await codexHistoryResponse(
    {
      cancel() {},
      async *[Symbol.asyncIterator]() {
        yield metadata
      },
    },
    new AbortController().signal,
    (page) => page,
    failure,
  )
  expect(await response.text()).toBe(`${JSON.stringify(metadata)}\n{"type":"complete"}\n`)
})
