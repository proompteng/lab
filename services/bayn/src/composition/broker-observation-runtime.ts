import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  References,
  Result,
  Scope,
  ScopedRef,
  Tracer,
} from 'effect'
import { HttpClient } from 'effect/http'

import type { ApplicationPlanFor } from '../app'
import { layer as brokerSessionLayer, BrokerSession } from '../broker/alpaca/session'
import { alpacaHttpLayer } from '../broker/alpaca/http'
import { makeBrokerObservationBudget } from '../broker/alpaca/poll-budget'
import { brokerSnapshotCacheConfig, captureBrokerObservation } from '../broker/alpaca/snapshot-cache'
import { observedBrokerSnapshotHash, observationUnavailable } from '../broker/alpaca/observed-snapshot'
import type { BrokerReadError } from '../broker/alpaca/failures'
import { makeBrokerObservationStore } from '../db/broker-observations'
import { PostgresClientLive } from '../db/postgres-client'
import type { BrokerObservationPoll, BrokerObservationRuntime } from '../restate/restate-broker-observations'
import { withObservedSpan } from '../telemetry'

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
  plan: ApplicationPlanFor<'AutonomousService'>,
): Effect.Effect<
  {
    readonly runtime: BrokerObservationRuntime
    readonly pollIntervalMs: number
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const telemetry = Layer.mergeAll(
      Layer.succeed(Logger.CurrentLoggers, yield* Logger.CurrentLoggers),
      Layer.succeed(Tracer.Tracer, yield* Tracer.Tracer),
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
      ),
    )
    return {
      pollIntervalMs: config.pollIntervalMs,
      runtime: {
        activate: (signal) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.activate),
            { signal },
          ),
        nextPollNotBeforeMs: (signal) => managed.runPromise(budget.nextPollNotBeforeMs, { signal }),
        preparePoll: (signal) => managed.runPromise(budget.prepareCapture, { signal }),
        poll: (signal, reservation) =>
          managed.runPromise(
            Effect.gen(function* () {
              const claim = yield* budget.claimCapture(reservation.captureToken, reservation.captureStartDeadlineMs)
              if (claim._tag !== 'Claimed') {
                yield* Effect.flatMap(store, (value) => value.invalidate)
                if (claim._tag === 'ExpiredUnused') {
                  // Returning this result journals proof before the owner replaces speculative debt.
                  // Any interruption/failure before that result, or a repeated claim, keeps the full reservation.
                  yield* Effect.logWarning('Broker observation capture expired before starting').pipe(
                    Effect.annotateLogs({
                      'broker.capture_not_started_reason': 'expired_unused_ticket',
                      'broker.capture_start_lateness_ms': claim.expiredByMs,
                    }),
                  )
                  return {
                    _tag: 'Unavailable',
                    captureNotStarted: { reason: 'ExpiredUnusedTicket', expiredByMs: claim.expiredByMs },
                    nextPollNotBeforeMs: yield* budget.nextPollNotBeforeMs,
                  } as const
                }
                return {
                  _tag: 'Unavailable',
                  nextPollNotBeforeMs: Math.max(reservation.interruptedNotBeforeMs, yield* budget.nextPollNotBeforeMs),
                } as const
              }
              // A claimed worker can replace its interruption reservation with measured usage after completion.
              // Typed, completed persistence failures have no broker request still in flight.
              return yield* settleCompletedBrokerObservationPoll(
                Effect.gen(function* () {
                  yield* budget.beginCapture
                  const persistence = yield* store
                  const ticket = yield* persistence.begin
                  const capture = Effect.gen(function* () {
                    const broker = yield* ScopedRef.get(brokerRuntimes)
                    const parent = yield* Effect.currentSpan.pipe(Effect.orDie)
                    const annotations = yield* References.CurrentLogAnnotations
                    return yield* Effect.tryPromise({
                      try: (captureSignal) =>
                        broker.runPromise(
                          Effect.gen(function* () {
                            return yield* captureBrokerObservation(
                              (yield* BrokerSession).read,
                              ticket.startedAt,
                              captureTimeoutMs,
                            )
                          }).pipe(Effect.withParentSpan(parent), Effect.annotateLogs(annotations)),
                          { signal: captureSignal },
                        ),
                      catch: (cause) => observationUnavailable('Verified broker observation acquisition failed', cause),
                    })
                  })
                  const result = yield* capture.pipe(
                    withObservedSpan('bayn.broker.observation.capture'),
                    Effect.timeoutOrElse({
                      duration: captureTimeoutMs,
                      orElse: () =>
                        Effect.fail(observationUnavailable('Broker observation acquisition exceeded its deadline')),
                    }),
                    Effect.result,
                  )
                  if (Result.isFailure(result)) {
                    // ManagedRuntime's lazy layer build can outlive the canceled capture effect.
                    // Stop it before a persistence failure may release the measured request budget.
                    yield* ScopedRef.set(brokerRuntimes, acquireBroker)
                    yield* persistence.failed(ticket)
                    yield* Effect.logWarning('Broker observation poll failed').pipe(
                      Effect.annotateLogs({
                        'broker.operation': result.failure.operation,
                        'broker.failure_kind': result.failure.kind,
                      }),
                    )
                    return { _tag: 'Unavailable', nextPollNotBeforeMs: yield* budget.nextPollNotBeforeMs } as const
                  }
                  const nextPollNotBeforeMs = yield* budget.nextPollNotBeforeMs
                  const publication = yield* persistence
                    .publish(ticket, result.success)
                    .pipe(withObservedSpan('bayn.broker.observation.publish'), Effect.result)
                  if (Result.isFailure(publication)) {
                    yield* persistence.failed(ticket)
                    yield* Effect.logWarning('Broker observation publication failed')
                    return { _tag: 'Unavailable', nextPollNotBeforeMs } as const
                  }
                  if (!publication.success) return { _tag: 'Invalidated', nextPollNotBeforeMs } as const
                  yield* Effect.logInfo('Broker observation published').pipe(
                    Effect.annotateLogs({
                      'broker.snapshot_hash': observedBrokerSnapshotHash(result.success),
                      'broker.observed_at': result.success.observedAt,
                      'broker.source_revision': plan.config.build.sourceRevision,
                      'broker.next_poll_not_before_ms': nextPollNotBeforeMs,
                    }),
                  )
                  return {
                    _tag: 'Published',
                    snapshotHash: observedBrokerSnapshotHash(result.success),
                    nextPollNotBeforeMs,
                  } as const
                }),
                budget.nextPollNotBeforeMs,
              )
            }).pipe(
              Effect.onInterrupt(() => Effect.flatMap(store, (value) => value.invalidate)),
              withObservedSpan('bayn.broker.observation.poll', {
                'bayn.source.revision': plan.config.build.sourceRevision,
              }),
              Effect.annotateLogs({ sourceRevision: plan.config.build.sourceRevision }),
            ),
            { signal },
          ),
      },
    }
  })
