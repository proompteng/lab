import { isNativeError } from 'node:util/types'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Metric,
  Option,
  References,
  Result,
  Scope,
  ScopedRef,
  Tracer,
} from 'effect'
import { HttpClient } from 'effect/http'

import type { ApplicationPlan } from '../app'
import { layer as brokerSessionLayer, BrokerSession } from '../broker/alpaca/session'
import { alpacaHttpLayer } from '../broker/alpaca/http'
import { brokerObservationQuotaWindowMs, makeBrokerObservationBudget } from '../broker/alpaca/poll-budget'
import { brokerSnapshotCacheConfig, captureBrokerObservation } from '../broker/alpaca/snapshot-cache'
import { observationUnavailable } from '../broker/alpaca/observed-snapshot'
import { canonicalHashV1Result } from '../hash'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { BrokerObservationClaimStatus, makeBrokerObservationStore } from '../db/broker-observations'
import { PostgresClientLive } from '../db/postgres-client'
import type { BrokerObservationPoll, BrokerObservationRuntime } from '../restate/restate-broker-observations'
import { withObservedStage } from '../telemetry'
import { ValkeyCache, ValkeyCacheError, ValkeyFailureCategory } from '../valkey-cache'
import { currentOpenTelemetryParentSpan } from '../restate/restate-telemetry'

export const brokerPublicationFailureAnnotations = (failure: BrokerReadError): Readonly<Record<string, string>> => {
  const unknown = {
    'broker.publication_dependency': 'unknown',
    'broker.publication_operation': 'unknown',
    'broker.publication_failure_category': 'unknown',
    'broker.publication_cause_category': 'unknown',
  }
  if (!isNativeError(failure)) return unknown
  try {
    // The persistence wrapper retains the original cache error as its direct cause.
    const cause: unknown = Object.getOwnPropertyDescriptor(failure, 'cause')?.value
    if (!isNativeError(cause) || Object.getPrototypeOf(cause) !== ValkeyCacheError.prototype) return unknown
    const operation: unknown = Object.getOwnPropertyDescriptor(cause, 'operation')?.value
    const category: unknown = Object.getOwnPropertyDescriptor(cause, 'category')?.value
    const causeCategory: unknown = Object.getOwnPropertyDescriptor(cause, 'causeCategory')?.value
    return {
      'broker.publication_dependency': 'valkey',
      'broker.publication_operation':
        typeof operation === 'string' && ['get', 'put', 'remove', 'configure', 'connect'].includes(operation)
          ? operation
          : 'unknown',
      'broker.publication_failure_category':
        typeof category === 'string' && Object.values(ValkeyFailureCategory).some((value) => value === category)
          ? category
          : 'unknown',
      'broker.publication_cause_category':
        typeof causeCategory === 'string' &&
        Object.values(ValkeyFailureCategory).some((value) => value === causeCategory)
          ? causeCategory
          : 'unknown',
    }
  } catch {
    return unknown
  }
}

export const settleCompletedBrokerObservationPoll = <R>(
  poll: Effect.Effect<BrokerObservationPoll, BrokerReadError, R>,
  nextPollNotBeforeMs: Effect.Effect<number>,
) =>
  poll.pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause)
      if (Cause.hasDies(cause) || Cause.hasInterrupts(cause) || Option.isNone(failure)) return Effect.failCause(cause)
      return Effect.gen(function* () {
        yield* Effect.logWarning('Broker observation poll completed without publication', cause)
        return { _tag: 'Unavailable', nextPollNotBeforeMs: yield* nextPollNotBeforeMs } as const
      })
    }),
  )

export const acquireBrokerObservationRuntime = (
  plan: ApplicationPlan,
): Effect.Effect<
  {
    readonly runtime: BrokerObservationRuntime
    readonly pollIntervalMs: number
  },
  never,
  Scope.Scope | ValkeyCache
> =>
  Effect.gen(function* () {
    const cache = yield* ValkeyCache
    const telemetry = Layer.mergeAll(
      Layer.succeed(Metric.CurrentMetricAttributes, yield* Metric.CurrentMetricAttributes),
      Layer.succeed(Metric.MetricRegistry, yield* Metric.MetricRegistry),
      Layer.succeed(Logger.CurrentLoggers, yield* Logger.CurrentLoggers),
      Layer.succeed(Tracer.Tracer, yield* Tracer.Tracer),
      Layer.succeed(Clock.Clock, yield* Clock.Clock),
    )
    const persistenceResources = PostgresClientLive(plan.config).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provideMerge(telemetry),
    )
    const managed = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(persistenceResources)),
      (value) => value.disposeEffect,
    )
    const budget = yield* makeBrokerObservationBudget
    const pollingHttp = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, budget.decorate)).pipe(
      Layer.provide(alpacaHttpLayer(plan.config.alpaca)),
    )
    const brokerResources = brokerSessionLayer(plan.config.alpaca).pipe(
      Layer.provide(pollingHttp),
      Layer.provideMerge(telemetry),
    )
    const acquireBroker = Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(brokerResources)),
      (value) => value.disposeEffect,
    )
    const brokerRuntimes = yield* ScopedRef.fromAcquire(acquireBroker)
    const config = yield* brokerSnapshotCacheConfig.pipe(Effect.orDie)
    const captureTimeoutMs = Math.min(plan.config.operationTimeoutMs, config.maxAgeMs - config.pollIntervalMs)
    const store = Effect.map(PgClient.PgClient, (sql) =>
      makeBrokerObservationStore(
        sql,
        plan.config.alpaca.expectedAccountId,
        plan.config.build.sourceRevision,
        config.maxAgeMs,
        cache,
      ),
    )
    return {
      pollIntervalMs: config.pollIntervalMs,
      runtime: {
        activate: (signal, nextPollNotBeforeMs) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.activate(nextPollNotBeforeMs)),
            { signal },
          ),
        poll: (signal, reservation) => {
          const parent = currentOpenTelemetryParentSpan()
          const poll = Effect.gen(function* () {
            // The durable claim must precede HTTP and remain outside completed-work error recovery.
            const persistence = yield* store
            const requestedAtMs = yield* Clock.currentTimeMillis
            const captureStartDeadlineMs = requestedAtMs + plan.config.operationTimeoutMs
            const interruptedNotBeforeMs =
              captureStartDeadlineMs + plan.config.operationTimeoutMs * 3 + brokerObservationQuotaWindowMs
            const claim = yield* persistence.begin(reservation.captureId, interruptedNotBeforeMs)
            if (claim.status !== BrokerObservationClaimStatus.Reserved)
              return {
                _tag: claim.status === BrokerObservationClaimStatus.QuotaWait ? 'QuotaWait' : 'Unavailable',
                nextPollNotBeforeMs: claim.nextPollNotBeforeMs,
              } as const
            const ticket = claim.ticket
            const claimedAtMs = yield* Clock.currentTimeMillis
            if (claimedAtMs < requestedAtMs)
              return yield* observationUnavailable('Broker observation clock regressed before HTTP')
            yield* budget.beginCapture
            const now = yield* Clock.currentTimeMillis
            if (now < claimedAtMs)
              return yield* observationUnavailable('Broker observation clock regressed before HTTP')
            if (now > captureStartDeadlineMs) {
              yield* persistence.failed(ticket, yield* budget.nextPollNotBeforeMs)
              const expiredByMs = now - captureStartDeadlineMs
              yield* Effect.logWarning('Broker observation capture expired before starting').pipe(
                Effect.annotateLogs({
                  'broker.capture_not_started_reason': 'expired_unused_ticket',
                  'broker.capture_start_lateness_ms': expiredByMs,
                }),
              )
              return {
                _tag: 'Unavailable',
                captureNotStarted: { reason: 'ExpiredUnusedTicket', expiredByMs },
                nextPollNotBeforeMs: yield* budget.nextPollNotBeforeMs,
              } as const
            }
            return yield* settleCompletedBrokerObservationPoll(
              Effect.gen(function* () {
                const capture = Effect.gen(function* () {
                  const broker = yield* ScopedRef.get(brokerRuntimes)
                  const parent = yield* Effect.currentSpan.pipe(Effect.orDie)
                  const annotations = yield* References.CurrentLogAnnotations
                  return yield* Effect.promise((captureSignal) =>
                    broker.runPromiseExit(
                      Effect.gen(function* () {
                        return yield* captureBrokerObservation(
                          (yield* BrokerSession).read,
                          ticket.startedAt,
                          captureTimeoutMs,
                        )
                      }).pipe(Effect.withParentSpan(parent), Effect.annotateLogs(annotations)),
                      { signal: captureSignal },
                    ),
                  ).pipe(
                    Effect.flatMap((exit) =>
                      Exit.isSuccess(exit)
                        ? Effect.succeed(exit.value)
                        : Effect.failCause(
                            Cause.map(exit.cause, (cause) => {
                              if (cause instanceof BrokerReadError) return cause
                              if (cause.cause instanceof BrokerReadError) return cause.cause
                              return new BrokerReadError({
                                operation: 'preflight',
                                kind: BrokerReadErrorKind.Forbidden,
                                retryable: false,
                                message: 'Broker account read permissions are unavailable',
                                cause: cause.cause,
                              })
                            }),
                          ),
                    ),
                  )
                })
                const result = yield* capture.pipe(
                  withObservedStage('bayn.broker.observation.capture', { dependency: 'alpaca' }),
                  Effect.timeoutOrElse({
                    duration: captureTimeoutMs,
                    orElse: () =>
                      Effect.fail(observationUnavailable('Broker observation acquisition exceeded its deadline')),
                  }),
                  // Stop lazy layer acquisition on every failed exit before any known-work quota settlement.
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) ? ScopedRef.set(brokerRuntimes, acquireBroker) : Effect.void,
                  ),
                  Effect.result,
                )
                if (Result.isFailure(result)) {
                  yield* persistence.failed(ticket, yield* budget.nextPollNotBeforeMs)
                  yield* Effect.logWarning('Broker observation poll failed').pipe(
                    Effect.annotateLogs({
                      'broker.operation': result.failure.operation,
                      'broker.failure_kind': result.failure.kind,
                      'broker.retryable': result.failure.retryable,
                      ...(result.failure.status === undefined ? {} : { 'broker.http_status': result.failure.status }),
                    }),
                  )
                  return { _tag: 'Unavailable', nextPollNotBeforeMs: yield* budget.nextPollNotBeforeMs } as const
                }
                const snapshotHash = yield* Effect.fromResult(canonicalHashV1Result(result.success)).pipe(
                  Effect.mapError((cause) => observationUnavailable('Broker snapshot cannot be canonicalized', cause)),
                )
                const nextPollNotBeforeMs = yield* budget.nextPollNotBeforeMs
                const publication = yield* persistence
                  .publish(ticket, result.success, nextPollNotBeforeMs)
                  .pipe(
                    withObservedStage('bayn.broker.observation.publish', { dependency: 'postgresql' }),
                    Effect.result,
                  )
                if (Result.isFailure(publication)) {
                  yield* persistence.failed(ticket, nextPollNotBeforeMs)
                  yield* Effect.logWarning('Broker observation publication failed').pipe(
                    Effect.annotateLogs(brokerPublicationFailureAnnotations(publication.failure)),
                  )
                  return { _tag: 'Unavailable', nextPollNotBeforeMs } as const
                }
                if (!publication.success) {
                  yield* persistence.failed(ticket, nextPollNotBeforeMs)
                  return { _tag: 'Invalidated', nextPollNotBeforeMs } as const
                }
                yield* Effect.logInfo('Broker observation published').pipe(
                  Effect.annotateLogs({
                    'broker.snapshot_hash': snapshotHash,
                    'broker.observed_at': result.success.observedAt,
                    'broker.source_revision': plan.config.build.sourceRevision,
                    'broker.next_poll_not_before_ms': nextPollNotBeforeMs,
                  }),
                )
                return {
                  _tag: 'Published',
                  snapshotHash,
                  nextPollNotBeforeMs,
                } as const
              }),
              budget.nextPollNotBeforeMs,
            )
          }).pipe(
            // A canceled predecessor must not invalidate a newer capture or a published result. Retain the
            // interrupted capture's quota debt; only its still-owned unfinished projection is fenced.
            Effect.onInterrupt(() => Effect.flatMap(store, (value) => value.interrupt(reservation.captureId))),
            withObservedStage('bayn.broker.observation.poll', {
              attributes: { 'bayn.source.revision': plan.config.build.sourceRevision },
            }),
            Effect.annotateLogs({ sourceRevision: plan.config.build.sourceRevision }),
          )
          const sampled = Effect.gen(function* () {
            const startedAtMs = yield* Clock.currentTimeMillis
            const result = yield* poll
            return { poll: result, startedAtMs, completedAtMs: yield* Clock.currentTimeMillis }
          })
          return managed.runPromise(parent === undefined ? sampled : sampled.pipe(Effect.withParentSpan(parent)), {
            signal,
          })
        },
      },
    }
  })
