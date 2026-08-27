import { EventEmitter } from 'node:events'
import { describe, expect, mock, test } from 'bun:test'

void mock.module('server-only', () => ({}))
const { MAX_EVENT_STREAMS_PER_SUBJECT } = await import('./limits')
const { acquireTengriEventStreamSlot, createTengriEventStream } = await import('./sse')

function fakeSource() {
  let cancellations = 0
  let pauses = 0
  let resumes = 0
  const source = Object.assign(new EventEmitter(), {
    cancel() {
      cancellations += 1
    },
    pause() {
      pauses += 1
    },
    resume() {
      resumes += 1
    },
  })
  return {
    source,
    stats: () => ({ cancellations, pauses, resumes }),
  }
}

describe('Tengri SSE bridge', () => {
  test('serializes event IDs and removes upstream listeners when the client disconnects', async () => {
    const upstream = fakeSource()
    let releases = 0
    const stream = createTengriEventStream(
      upstream.source,
      new AbortController().signal,
      (value: { sequence: number }) => ({
        id: value.sequence,
        data: value,
      }),
      () => {
        releases += 1
      },
    )
    const reader = stream.getReader()

    upstream.source.emit('data', { sequence: 7 })
    const frame = await reader.read()
    expect(new TextDecoder().decode(frame.value)).toBe('id: 7\ndata: {"sequence":7}\n\n')

    await reader.cancel()
    expect(upstream.stats().cancellations).toBe(1)
    expect(upstream.source.listenerCount('data')).toBe(0)
    expect(upstream.source.listenerCount('end')).toBe(0)
    expect(upstream.source.listenerCount('error')).toBe(0)
    expect(releases).toBe(1)
  })

  test('cancels and closes the upstream stream when the request is aborted', async () => {
    const upstream = fakeSource()
    const controller = new AbortController()
    const reader = createTengriEventStream(upstream.source, controller.signal, (value) => ({ data: value })).getReader()

    controller.abort()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(upstream.stats().cancellations).toBe(1)
  })

  test('budgets every supported desktop window plus reconnect overlap and releases slots idempotently', () => {
    const releases = Array.from({ length: MAX_EVENT_STREAMS_PER_SUBJECT }, () =>
      acquireTengriEventStreamSlot('github:stream-test'),
    )
    expect(releases.every(Boolean)).toBe(true)
    expect(acquireTengriEventStreamSlot('github:stream-test')).toBeNull()
    const otherRelease = acquireTengriEventStreamSlot('github:other-user')
    expect(otherRelease).not.toBeNull()

    releases[0]?.()
    releases[0]?.()
    const replacement = acquireTengriEventStreamSlot('github:stream-test')
    expect(replacement).not.toBeNull()

    for (const release of releases.slice(1)) release?.()
    replacement?.()
    otherRelease?.()
  })
})
