import { afterEach, beforeEach, expect, test } from 'bun:test'
import { watchTengriEvents } from './event-stream'

class TestEventSource {
  static readonly CLOSED = 2
  static sources: TestEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((message: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    TestEventSource.sources.push(this)
  }
  close() {
    this.closed = true
    this.readyState = TestEventSource.CLOSED
  }
  fail(state: number) {
    this.readyState = state
    this.onerror?.()
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
let stop = () => {}
beforeEach(() => {
  TestEventSource.sources = []
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: TestEventSource })
})
afterEach(() => {
  stop()
  if (original) Object.defineProperty(globalThis, 'EventSource', original)
  else Reflect.deleteProperty(globalThis, 'EventSource')
})

test('reopens a closed stream from the latest cursor and ignores retired callbacks', async () => {
  let cursor = 0
  let opened = 0
  let errors = 0
  const messages: string[] = []
  stop = watchTengriEvents(() => `/events?after=${cursor}`, {
    onOpen: () => opened++,
    onError: () => errors++,
    onMessage: (event) => messages.push(event.data),
  })
  const first = TestEventSource.sources[0]!
  const lateMessage = first.onmessage
  cursor = 7
  first.fail(TestEventSource.CLOSED)
  first.onerror?.()
  await Bun.sleep(1_100)
  expect(TestEventSource.sources).toHaveLength(2)
  expect(first.closed).toBe(true)
  const second = TestEventSource.sources[1]!
  expect(second.url).toBe('/events?after=7')
  second.onopen?.()
  second.onmessage?.(new MessageEvent('message', { data: 'current' }))
  lateMessage?.(new MessageEvent('message', { data: 'retired' }))
  expect({ opened, errors, messages }).toEqual({ opened: 1, errors: 1, messages: ['current'] })
  stop()
  second.onmessage?.(new MessageEvent('message', { data: 'after stop' }))
  expect(messages).toEqual(['current'])
  expect(second.closed).toBe(true)
})

test('leaves native reconnection active and cancels a pending explicit retry on disposal', async () => {
  const handlers = { onOpen() {}, onError() {}, onMessage() {} }
  stop = watchTengriEvents(() => '/events', handlers)
  TestEventSource.sources[0]!.fail(0)
  await Bun.sleep(1_100)
  expect(TestEventSource.sources).toHaveLength(1)
  TestEventSource.sources[0]!.fail(TestEventSource.CLOSED)
  stop()
  await Bun.sleep(1_100)
  expect(TestEventSource.sources).toHaveLength(1)
})

test('backs off repeated terminal failures and resets after a successful open', async () => {
  stop = watchTengriEvents(() => '/events', { onOpen() {}, onError() {}, onMessage() {} })
  TestEventSource.sources[0]!.fail(TestEventSource.CLOSED)
  await Bun.sleep(1_100)
  TestEventSource.sources[1]!.fail(TestEventSource.CLOSED)
  await Bun.sleep(1_100)
  expect(TestEventSource.sources).toHaveLength(2)
  await Bun.sleep(1_100)
  expect(TestEventSource.sources).toHaveLength(3)
  TestEventSource.sources[2]!.onopen?.()
  TestEventSource.sources[2]!.fail(TestEventSource.CLOSED)
  await Bun.sleep(1_100)
  expect(TestEventSource.sources).toHaveLength(4)
}, 10_000)
