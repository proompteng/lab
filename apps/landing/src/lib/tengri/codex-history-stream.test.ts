import { expect, mock, spyOn, test } from 'bun:test'
import * as Sentry from '@sentry/node'
import { context, propagation, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { observeRequest } from '../observability/server'
import type { CodexHistoryPage } from './codex-history'

void mock.module('server-only', () => ({}))
const { codexHistoryResponse } = await import('./codex-history-stream')

const metadata: CodexHistoryPage = { type: 'page', part: 'thread', rawJson: '{}', eventSequence: 10 }
function failure(cause: unknown) {
  return Object.assign(new Error(cause instanceof Error ? cause.message : 'Unavailable'), { status: 503 })
}

function historyResponse(
  pages: () => AsyncIterator<CodexHistoryPage>,
  { signal = new AbortController().signal, cancel = () => {}, mapError = failure } = {},
) {
  return codexHistoryResponse({ cancel, [Symbol.asyncIterator]: pages }, signal, (page) => page, mapError)
}

test('a failed history record reports the original exception and marks the live request span failed', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  provider.register()
  const capture = spyOn(Sentry, 'captureException').mockReturnValue('fixture-event')
  const cause = new Error('RPC connection lost')
  try {
    const request = new Request('https://proompteng.ai/api/tengri')
    const response = await observeRequest(request, 'tengri.history', () =>
      historyResponse(
        async function* () {
          yield metadata
          throw cause
        },
        { signal: request.signal },
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
  let reads = 0
  let cancelled = 0
  let returned = 0
  const response = await historyResponse(
    () => ({
      async next() {
        reads++
        return { done: false, value: metadata }
      },
      async return() {
        returned++
        return { done: true, value: metadata }
      },
    }),
    {
      cancel: () => {
        cancelled++
      },
    },
  )
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
  let cancelled = false
  const cancel = () => {
    cancelled = true
  }
  const response = await historyResponse(
    async function* () {
      yield metadata
      throw new Error('Authorization was revoked')
    },
    { cancel, mapError: () => Object.assign(new Error('Tengri request is not permitted'), { status: 403 }) },
  )
  const records = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records).toEqual([metadata, { type: 'error', error: 'Tengri request is not permitted', status: 403 }])
  expect(cancelled).toBe(true)
  const caller = new AbortController()
  const aborted = await historyResponse(
    async function* () {
      yield metadata
    },
    { signal: caller.signal, cancel },
  )
  cancelled = false
  caller.abort()
  expect(cancelled).toBe(true)
  expect(await aborted.text()).not.toContain('"type":"complete"')
})

test('fails before HTTP success when the initial RPC fails and emits completion only on a clean end', async () => {
  let cancelled = false
  await expect(
    historyResponse(
      () => ({
        async next() {
          throw new Error('Conversation is missing')
        },
      }),
      {
        cancel: () => {
          cancelled = true
        },
      },
    ),
  ).rejects.toThrow('Conversation is missing')
  expect(cancelled).toBe(true)
  const response = await historyResponse(async function* () {
    yield metadata
  })
  expect(await response.text()).toBe(`${JSON.stringify(metadata)}\n{"type":"complete"}\n`)
})
