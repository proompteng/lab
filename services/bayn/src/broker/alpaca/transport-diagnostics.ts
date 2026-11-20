import { NodeHttpClient } from '@effect/platform-node'
import type * as Undici from '@effect/platform-node/Undici'
import { Cause, Clock, Effect, Exit } from 'effect'

import type { BrokerReadOperation } from './failures'

enum TransportPhase {
  Unobserved = 'unobserved',
  BeforeDispatch = 'before_dispatch',
  WaitingResponse = 'waiting_response',
  HeadersReceived = 'headers_received',
}

interface Observation {
  readonly now: () => bigint
  interceptorInstalled?: boolean
  active: boolean
  attempts: number
  started: number
  phase: TransportPhase
  attemptAt?: bigint | undefined
  startedAt?: bigint | undefined
  headersAt?: bigint | undefined
}

// Only a private, request-local opaque token opts a read in. No global Undici subscribers or request values.
const observations = new WeakMap<object, Observation>()
const note = (observation: Observation, update: () => void) => {
  if (!observation.active) return
  try {
    update()
  } catch {
    // Diagnostics must not throw into Undici's handler and abort the original request.
  }
}

export const readTransportInterceptor: Undici.Dispatcher.DispatchInterceptor = (dispatch) => (options, handler) => {
  const opaque: unknown = Object.getOwnPropertyDescriptor(options, 'opaque')?.value
  const observation = typeof opaque === 'object' && opaque !== null ? observations.get(opaque) : undefined
  if (observation === undefined) return dispatch(options, handler)
  note(observation, () => {
    observation.attempts++
    observation.phase = TransportPhase.BeforeDispatch
    observation.attemptAt = observation.now()
    observation.startedAt = undefined
    observation.headersAt = undefined
  })
  const attempt = observation.attempts
  const observed: Undici.Dispatcher.DispatchHandler = {
    onRequestStart: (...args) => {
      note(observation, () => {
        if (observation.attempts !== attempt) return
        observation.started++
        observation.phase = TransportPhase.WaitingResponse
        observation.startedAt = observation.now()
      })
      return handler.onRequestStart?.(...args)
    },
    onResponseStart: (...args) => {
      note(observation, () => {
        if (observation.attempts !== attempt || args[1] < 200) return
        observation.phase = TransportPhase.HeadersReceived
        observation.headersAt = observation.now()
      })
      return handler.onResponseStart?.(...args)
    },
    onRequestUpgrade: (...args) => handler.onRequestUpgrade?.(...args),
    onResponseData: (...args) => handler.onResponseData?.(...args),
    onResponseEnd: (...args) => handler.onResponseEnd?.(...args),
    onResponseError: (...args) => handler.onResponseError?.(...args),
    onResponseStarted: (...args) => handler.onResponseStarted?.(...args),
    onBodySent: (...args) => handler.onBodySent?.(...args),
    onRequestSent: (...args) => handler.onRequestSent?.(...args),
  }
  return dispatch(options, observed)
}

/** Acquisition coverage is separate from whether this request reached the interceptor. */
export const withReadTransportCoverage =
  (interceptorInstalled: boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const options = yield* NodeHttpClient.UndiciOptions
      const opaque: unknown = Object.getOwnPropertyDescriptor(options, 'opaque')?.value
      const observation = typeof opaque === 'object' && opaque !== null ? observations.get(opaque) : undefined
      if (observation !== undefined)
        note(observation, () => {
          observation.interceptorInstalled = interceptorInstalled
        })
    }).pipe(
      Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)),
      Effect.andThen(effect),
    )

const elapsed = (start: bigint | undefined, end: bigint) =>
  start === undefined ? 0 : Math.max(0, Number(end - start) / 1_000_000)

/** Pre-dispatch includes pool wait and connection setup; it is not a DNS, CONNECT or TLS latency measurement. */
export const withReadTransportDiagnostics =
  (operation: BrokerReadOperation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const options = yield* NodeHttpClient.UndiciOptions
      const token = {}
      const observation: Observation = {
        now: () => clock.monotonicTimeNanosUnsafe(),
        active: true,
        attempts: 0,
        started: 0,
        phase: TransportPhase.Unobserved,
      }
      observations.set(token, observation)
      // Undici accepts arbitrary opaque data; the platform reference fixes its generic to the default null.
      const requestOptions = { ...options, opaque: token } as unknown as Partial<Undici.Dispatcher.RequestOptions>
      return yield* effect.pipe(
        Effect.provideService(NodeHttpClient.UndiciOptions, requestOptions),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            observation.active = false
            observations.delete(token)
            const end = observation.now()
            const attributes = {
              ...(observation.interceptorInstalled === undefined
                ? {}
                : {
                    'broker.transport.interceptor_available': observation.interceptorInstalled,
                    'broker.transport.interceptor_installed': observation.interceptorInstalled,
                  }),
              'broker.transport.phase': observation.phase,
              'broker.transport.attempts': observation.attempts,
              'broker.transport.started': observation.started,
              'broker.transport.last_pre_dispatch_ms': elapsed(observation.attemptAt, observation.startedAt ?? end),
              'broker.transport.last_response_wait_ms': elapsed(observation.startedAt, observation.headersAt ?? end),
            }
            yield* Effect.annotateCurrentSpan(attributes)
            if (Exit.isFailure(exit))
              yield* Effect.logWarning('Broker read transport observation').pipe(
                Effect.annotateLogs({ operation, ...attributes }),
              )
          }).pipe(Effect.ignoreCause),
        ),
      )
    })
