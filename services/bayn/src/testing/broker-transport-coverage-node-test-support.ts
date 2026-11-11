import assert from 'node:assert/strict'
import * as Undici from '@effect/platform-node/Undici'
import { Effect, Exit, Logger, Redacted, References, Result, Tracer } from 'effect'
import { alpacaHttpLayer, make } from '../broker/alpaca/http'
import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'

const connection = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: 'e6fe16f3-64a4-4921-8928-cadf02f92f98',
    key: Redacted.make('fixture-key'),
    secret: Redacted.make('fixture-secret'),
    proxyUrl: 'http://proxy.invalid:3128',
    operationTimeoutMs: 50,
    retryAttempts: 0,
  }),
)
for (const intercepted of [true, false]) {
  for (const mode of ['before-start', 'after-start', 'valid', 'rejected'] as const) {
    let calls = 0,
      aborted = 0,
      destroyed = 0
    let signal: AbortSignal | undefined
    const spans: Tracer.Span[] = []
    const logs: Readonly<Record<string, unknown>>[] = []
    class Fixture extends Undici.Dispatcher {
      override dispatch(options: Undici.Dispatcher.DispatchOptions, handler: Undici.Dispatcher.DispatchHandler) {
        calls++
        assert.equal(options.method, 'GET')
        assert.equal(options.origin, alpacaSandboxBaseUrl)
        assert.equal(options.path, '/v2/calendar?start=2026-11-11&end=2026-11-11&date_type=TRADING')
        signal = (options as Undici.Dispatcher.RequestOptions).signal as AbortSignal
        let isAborted = false
        let abortReason: Error | null = null
        const controller: Undici.Dispatcher.DispatchController = {
          get aborted() {
            return isAborted
          },
          paused: false,
          get reason() {
            return abortReason
          },
          pause() {},
          resume() {},
          abort(reason) {
            aborted++
            isAborted = true
            abortReason = reason as Error
            handler.onResponseError?.(this, reason as Error)
          },
        }
        if (mode !== 'before-start') handler.onRequestStart?.(controller, null)
        if (mode === 'valid' || mode === 'rejected') {
          handler.onResponseStart?.(controller, 200, mode === 'valid' ? { 'x-request-id': 'fixture' } : {}, 'OK')
          handler.onResponseData?.(controller, Buffer.from('[]'))
          handler.onResponseEnd?.(controller, {})
        }
        return true
      }
    }
    const dispatcher = new Fixture()
    if (!intercepted) Object.defineProperty(dispatcher, 'compose', { value: undefined })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const underlying = yield* Tracer.Tracer
        return yield* Effect.gen(function* () {
          const broker = yield* make(connection)
          return yield* broker.marketCalendar({ start: '2026-11-11', end: '2026-11-11' }).pipe(Effect.exit)
        }).pipe(
          Effect.provide(
            alpacaHttpLayer(connection, {
              create: () => dispatcher,
              destroy: async () => {
                destroyed++
              },
            }),
          ),
          Effect.provideService(Tracer.Tracer, {
            span(options) {
              const span = underlying.span(options)
              spans.push(span)
              return span
            },
          }),
        )
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ fiber }) => logs.push(fiber.getRef(References.CurrentLogAnnotations)))]),
        ),
      ),
    )
    const headers = spans.find((s) => s.name === 'bayn.alpaca.read.headers')
    assert(headers)
    const attributes = Object.fromEntries(
      [...headers.attributes].filter(([key]) => key.startsWith('broker.transport.')),
    )
    assert.equal(attributes['broker.transport.interceptor_available'], intercepted)
    assert.equal(attributes['broker.transport.interceptor_installed'], intercepted)
    assert.equal(calls, 1)
    assert.equal(destroyed, 1)
    assert.equal(Exit.isSuccess(result), mode === 'valid')
    if (mode === 'before-start' || mode === 'after-start') assert.equal(signal?.aborted, true)
    if (mode === 'after-start') assert.equal(aborted, 1)
    assert.equal(attributes['broker.transport.attempts'], !intercepted ? 0 : 1)
    assert.equal(
      attributes['broker.transport.phase'],
      !intercepted
        ? 'unobserved'
        : mode === 'before-start'
          ? 'before_dispatch'
          : mode === 'after-start'
            ? 'waiting_response'
            : 'headers_received',
    )
    const transportLogs = logs.filter((log) => 'broker.transport.phase' in log)
    assert.equal(transportLogs.length, mode === 'before-start' || mode === 'after-start' ? 1 : 0)
    for (const log of transportLogs) {
      assert.equal(log['broker.transport.interceptor_available'], intercepted)
      assert.equal(log['broker.transport.interceptor_installed'], intercepted)
      for (const forbidden of ['fixture-key', 'fixture-secret', 'proxy.invalid', connection.expectedAccountId])
        assert(!JSON.stringify(log).includes(forbidden))
    }
    process.stdout.write(JSON.stringify({ mode, intercepted, attributes }) + '\n')
  }
}

// The proxy accepts only a loopback TCP connection and never connects to an upstream.
const { createServer } = await import('node:http')
const server = createServer()
const sockets = new Set<import('node:net').Socket>()
let connects = 0,
  destroyed = 0
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
server.on('connect', () => {
  connects++
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')
const spans: Tracer.Span[] = []
try {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const underlying = yield* Tracer.Tracer
      return yield* Effect.gen(function* () {
        const broker = yield* make({ ...connection, operationTimeoutMs: 1000 })
        return yield* broker.marketCalendar({ start: '2026-11-11', end: '2026-11-11' }).pipe(Effect.exit)
      }).pipe(
        Effect.provide(
          alpacaHttpLayer(connection, {
            create: () => new Undici.ProxyAgent({ uri: `http://127.0.0.1:${address.port}` }),
            destroy: async (dispatcher) => {
              destroyed++
              await dispatcher.destroy()
            },
          }),
        ),
        Effect.provideService(Tracer.Tracer, {
          span(options) {
            const span = underlying.span(options)
            spans.push(span)
            return span
          },
        }),
      )
    }).pipe(Effect.provide(Logger.layer([]))),
  )
  assert(Exit.isFailure(result))
  assert.equal(connects, 1)
  assert.equal(destroyed, 1)
  const headers = spans.find((s) => s.name === 'bayn.alpaca.read.headers')
  assert(headers)
  const attributes = Object.fromEntries([...headers.attributes].filter(([key]) => key.startsWith('broker.transport.')))
  assert.equal(attributes['broker.transport.attempts'], 1)
  assert.equal(attributes['broker.transport.interceptor_available'], true)
  assert.equal(attributes['broker.transport.interceptor_installed'], true)
  process.stdout.write(JSON.stringify({ mode: 'real-proxy-withheld-connect', connects, destroyed, attributes }) + '\n')
} finally {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

process.stdout.write('broker transport coverage passed\n')
