import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeHttpClient } from '@effect/platform-node'
import type * as Undici from '@effect/platform-node/Undici'
import { Cause, Clock, Config, Deferred, Effect, Exit, Fiber, Logger, Option } from 'effect'
import { TestClock } from 'effect/testing'

import {
  readTransportInterceptor,
  withReadTransportCoverage,
  withReadTransportDiagnostics,
} from './transport-diagnostics'

const controller: Undici.Dispatcher.DispatchController = {
  aborted: false,
  paused: false,
  reason: null,
  abort: () => {},
  pause: () => {},
  resume: () => {},
}
const options = { origin: 'https://private-provider.example', path: '/private-account', method: 'GET' as const }
const annotations = (span: { attributes: ReadonlyMap<string, unknown> }) =>
  Object.fromEntries([...span.attributes].filter(([key]) => key.startsWith('broker.transport.')))
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.withSpan('transport-test'), Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
  )

test('unobserved dispatch preserves the exact options, handler and return value', () => {
  const handler = {}
  const dispatch = readTransportInterceptor((actualOptions, actualHandler) => {
    expect(actualOptions).toBe(options)
    expect(actualHandler).toBe(handler)
    return false
  })
  expect(dispatch(options, handler)).toBe(false)
})

test.each([true, false])(
  'coverage %s does not claim a dispatcher callback or replace an early interruption',
  async (installed) => {
    await run(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan
        const exit = yield* Effect.interrupt.pipe(
          withReadTransportCoverage(installed),
          withReadTransportDiagnostics('market-calendar'),
          Effect.exit,
        )
        assertInterrupted(exit)
        expect(annotations(span)).toEqual({
          'broker.transport.interceptor_available': installed,
          'broker.transport.interceptor_installed': installed,
          'broker.transport.phase': 'unobserved',
          'broker.transport.attempts': 0,
          'broker.transport.started': 0,
          'broker.transport.last_pre_dispatch_ms': 0,
          'broker.transport.last_response_wait_ms': 0,
        })
      }),
    )
  },
)

const assertInterrupted = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('Expected interruption')
  expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
}

test('request-local timing forwards every callback and excludes all request values', async () => {
  await run(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      let observed: Undici.Dispatcher.DispatchHandler = {}
      const seen: string[] = []
      const original: Undici.Dispatcher.DispatchHandler = {
        onRequestStart: (c, context) => {
          expect(c).toBe(controller)
          expect(context).toBe('private-context')
          seen.push('start')
        },
        onResponseStart: (c, status, headers) => {
          expect(c).toBe(controller)
          expect(status).toBe(200)
          expect(headers).toEqual({ secret: 'private-response' })
          seen.push('headers')
        },
        onResponseData: (_c, chunk) => {
          expect(chunk.toString()).toBe('private-body')
          seen.push('data')
        },
        onResponseEnd: () => {
          seen.push('end')
        },
        onResponseStarted: () => {
          seen.push('response-started')
        },
        onBodySent: () => {
          seen.push('body-sent')
        },
        onRequestSent: () => {
          seen.push('sent')
        },
      }
      const dispatch = readTransportInterceptor((actualOptions, handler) => {
        expect(actualOptions.headers).toEqual({ authorization: 'private-token' })
        observed = handler
        return false
      })
      const result = yield* Effect.gen(function* () {
        const scoped = yield* NodeHttpClient.UndiciOptions
        expect(dispatch({ ...options, ...scoped, headers: { authorization: 'private-token' } }, original)).toBe(false)
        yield* TestClock.adjust(200)
        observed.onRequestStart?.(controller, 'private-context')
        observed.onBodySent?.(Buffer.from('private-upload'))
        observed.onRequestSent?.()
        yield* TestClock.adjust(300)
        observed.onResponseStarted?.()
        observed.onResponseStart?.(controller, 200, { secret: 'private-response' })
        observed.onResponseData?.(controller, Buffer.from('private-body'))
        observed.onResponseEnd?.(controller, {})
        return 'original-result'
      }).pipe(withReadTransportDiagnostics('positions'))
      expect(result).toBe('original-result')
      expect(seen).toEqual(['start', 'body-sent', 'sent', 'response-started', 'headers', 'data', 'end'])
      expect(annotations(span)).toEqual({
        'broker.transport.phase': 'headers_received',
        'broker.transport.attempts': 1,
        'broker.transport.started': 1,
        'broker.transport.last_pre_dispatch_ms': 200,
        'broker.transport.last_response_wait_ms': 300,
      })
      expect(JSON.stringify(annotations(span))).not.toContain('private')
    }),
  )
})

test.each([false, true])('deadline preserves cancellation and distinguishes dispatched=%s', async (started) => {
  await run(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      const entered = yield* Deferred.make<void>()
      let finalized = 0
      let observed: Undici.Dispatcher.DispatchHandler = {}
      const dispatch = readTransportInterceptor((_options, handler) => {
        observed = handler
        return true
      })
      const effect = Effect.gen(function* () {
        dispatch({ ...options, ...(yield* NodeHttpClient.UndiciOptions) }, {})
        if (started) {
          yield* TestClock.adjust(100)
          observed.onRequestStart?.(controller, null)
        }
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      }).pipe(
        Effect.ensuring(Effect.sync(() => finalized++)),
        withReadTransportDiagnostics('account'),
        Effect.timeout('1 second'),
      )
      const fiber = yield* effect.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(started ? 900 : 1000)
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(finalized).toBe(1)
      expect(annotations(span)).toEqual({
        'broker.transport.phase': started ? 'waiting_response' : 'before_dispatch',
        'broker.transport.attempts': 1,
        'broker.transport.started': started ? 1 : 0,
        'broker.transport.last_pre_dispatch_ms': started ? 100 : 1000,
        'broker.transport.last_response_wait_ms': started ? 900 : 0,
      })
      const before = annotations(span)
      observed.onResponseStart?.(controller, 200, { secret: 'late' })
      expect(annotations(span)).toEqual(before)
    }),
  )
})

test.each([-3_600_000, 3_600_000])(
  'wall-clock correction %s cannot change elapsed transport timing',
  async (correction) => {
    for (const phase of ['before_dispatch', 'waiting_response', 'headers_received'] as const) {
      await run(
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan
          const clock = yield* Clock.Clock
          let wallOffset = 0
          const wallMillis = () => clock.currentTimeMillisUnsafe() + wallOffset
          const wallNanos = () => clock.currentTimeNanosUnsafe() + BigInt(wallOffset) * 1_000_000n
          const correctedClock: Clock.Clock = {
            ...clock,
            currentTimeMillisUnsafe: wallMillis,
            currentTimeMillis: Effect.sync(wallMillis),
            currentTimeNanosUnsafe: wallNanos,
            currentTimeNanos: Effect.sync(wallNanos),
          }
          let observed: Undici.Dispatcher.DispatchHandler = {}
          const dispatch = readTransportInterceptor((_options, handler) => {
            observed = handler
            return true
          })
          yield* Effect.gen(function* () {
            dispatch({ ...options, ...(yield* NodeHttpClient.UndiciOptions) }, {})
            yield* TestClock.adjust(200)
            wallOffset = correction
            expect(yield* Clock.currentTimeMillis).toBe(200 + correction)
            if (phase !== 'before_dispatch') observed.onRequestStart?.(controller, null)
            yield* TestClock.adjust(300)
            wallOffset = 2 * correction
            if (phase === 'headers_received') observed.onResponseStart?.(controller, 200, {})
            yield* TestClock.adjust(75)
            wallOffset = 3 * correction
          }).pipe(withReadTransportDiagnostics('account'), Effect.provideService(Clock.Clock, correctedClock))
          expect(annotations(span)).toEqual({
            'broker.transport.phase': phase,
            'broker.transport.attempts': 1,
            'broker.transport.started': phase === 'before_dispatch' ? 0 : 1,
            'broker.transport.last_pre_dispatch_ms': phase === 'before_dispatch' ? 575 : 200,
            'broker.transport.last_response_wait_ms':
              phase === 'before_dispatch' ? 0 : phase === 'waiting_response' ? 375 : 300,
          })
        }),
      )
    }
  },
)

test('late prior-attempt callbacks cannot overwrite the latest retry observation', async () => {
  await run(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      const handlers: Undici.Dispatcher.DispatchHandler[] = []
      const dispatch = readTransportInterceptor((_options, handler) => {
        handlers.push(handler)
        return true
      })
      yield* Effect.gen(function* () {
        const scoped = yield* NodeHttpClient.UndiciOptions
        dispatch({ ...options, ...scoped }, {})
        yield* TestClock.adjust(50)
        dispatch({ ...options, ...scoped }, {})
        handlers[0]?.onRequestStart?.(controller, null)
        handlers[0]?.onResponseStart?.(controller, 200, {})
        yield* TestClock.adjust(100)
      }).pipe(withReadTransportDiagnostics('account'))
      expect(annotations(span)).toEqual({
        'broker.transport.phase': 'before_dispatch',
        'broker.transport.attempts': 2,
        'broker.transport.started': 0,
        'broker.transport.last_pre_dispatch_ms': 100,
        'broker.transport.last_response_wait_ms': 0,
      })
    }),
  )
})

test('nested reads have independent tokens and release them after observation', async () => {
  await run(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      let retained: Undici.Dispatcher.DispatchOptions = options
      let forwarded: Undici.Dispatcher.DispatchHandler = {}
      const dispatch = readTransportInterceptor((request, handler) => {
        retained = request
        forwarded = handler
        return true
      })
      yield* Effect.gen(function* () {
        const outer = yield* NodeHttpClient.UndiciOptions
        dispatch({ ...options, ...outer }, {})
        yield* Effect.gen(function* () {
          const inner = yield* NodeHttpClient.UndiciOptions
          expect(inner.opaque).not.toBe(outer.opaque)
          dispatch({ ...options, ...inner }, {})
          forwarded.onRequestStart?.(controller, null)
          forwarded.onResponseStart?.(controller, 200, {})
        }).pipe(withReadTransportDiagnostics('positions'))
        expect(annotations(span)['broker.transport.phase']).toBe('headers_received')
        const untouched = {}
        dispatch(retained, untouched)
        expect(forwarded).toBe(untouched)
      }).pipe(withReadTransportDiagnostics('account'))
      expect(annotations(span)['broker.transport.phase']).toBe('before_dispatch')
      expect(annotations(span)['broker.transport.attempts']).toBe(1)
    }),
  )
})

test('informational headers do not claim the final broker response arrived', async () => {
  await run(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      let forwarded = 0
      const dispatch = readTransportInterceptor((_options, handler) => {
        handler.onRequestStart?.(controller, null)
        handler.onResponseStart?.(controller, 103, { link: 'private-hint' })
        return true
      })
      yield* Effect.gen(function* () {
        dispatch(
          { ...options, ...(yield* NodeHttpClient.UndiciOptions) },
          {
            onResponseStart: (_c, status) => {
              expect(status).toBe(103)
              forwarded++
            },
          },
        )
      }).pipe(withReadTransportDiagnostics('account'))
      expect(forwarded).toBe(1)
      expect(annotations(span)['broker.transport.phase']).toBe('waiting_response')
    }),
  )
})

test.each(['failure', 'defect', 'interrupt'] as const)(
  '%s retains its exit when diagnostic logging throws',
  async (kind) => {
    const failure = { private: 'failure' }
    await run(
      Effect.gen(function* () {
        const effect =
          kind === 'failure' ? Effect.fail(failure) : kind === 'defect' ? Effect.die(failure) : Effect.interrupt
        const exit = yield* effect.pipe(
          withReadTransportDiagnostics('account'),
          Effect.provide(
            Logger.layer([
              Logger.make(() => {
                throw new Error('diagnostic failure')
              }),
            ]),
          ),
          Effect.exit,
        )
        if (Exit.isSuccess(exit)) throw new Error('Expected original failure')
        if (kind === 'failure') expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(failure)
        else if (kind === 'interrupt') expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        else expect(exit.cause.reasons).toEqual([expect.objectContaining({ _tag: 'Die', defect: failure })])
      }),
    )
  },
)

test.each([
  ['broker-transport-node-test-support', 'broker transport node passed'],
  ['broker-transport-coverage-node-test-support', 'broker transport coverage passed'],
])(
  'production Node Undici %s',
  async (fixture, receipt) => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-broker-transport-'))
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, `../../testing/${fixture}.ts`)],
        target: 'node',
        outdir: directory,
      })
      expect(built.success).toBe(true)
      const node = Effect.runSync(Config.String('BAYN_TEST_NODE_BINARY').pipe(Config.withDefault('node')))
      const child = Bun.spawn([node, join(directory, `${fixture}.js`)], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      expect(stdout).toContain(receipt)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)
