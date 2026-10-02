import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Result, Scope, ScopedRef } from 'effect'
import { HttpClient } from 'effect/http'

import type { ApplicationPlanFor } from '../app'
import { layer as brokerSessionLayer, BrokerSession } from '../broker/alpaca/session'
import { alpacaHttpLayer } from '../broker/alpaca/http'
import { makeBrokerObservationBudget } from '../broker/alpaca/poll-budget'
import { brokerSnapshotCacheConfig, captureBrokerObservation } from '../broker/alpaca/snapshot-cache'
import { observedBrokerSnapshotHash, observationUnavailable } from '../broker/alpaca/observed-snapshot'
import { makeBrokerObservationStore } from '../db/broker-observations'
import { PostgresClientLive } from '../db/postgres-client'
import type { BrokerObservationRuntime } from '../restate/restate-broker-observations'

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
    const persistenceResources = PostgresClientLive(plan.config).pipe(Layer.provide(NodeServices.layer))
    const managed = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(persistenceResources)),
      (value) => value.disposeEffect,
    )
    const budget = yield* makeBrokerObservationBudget
    const pollingHttp = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, budget.decorate)).pipe(
      Layer.provide(alpacaHttpLayer(plan.config.alpaca)),
    )
    const brokerResources = brokerSessionLayer(plan.config.alpaca).pipe(Layer.provide(pollingHttp))
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
              if (!(yield* budget.claimCapture(reservation.captureToken, reservation.captureStartDeadlineMs))) {
                yield* Effect.flatMap(store, (value) => value.invalidate)
                return {
                  _tag: 'Unavailable',
                  nextPollNotBeforeMs: Math.max(reservation.interruptedNotBeforeMs, yield* budget.nextPollNotBeforeMs),
                } as const
              }
              yield* budget.beginCapture
              const persistence = yield* store
              const ticket = yield* persistence.begin
              const capture = Effect.gen(function* () {
                const broker = yield* ScopedRef.get(brokerRuntimes)
                return yield* Effect.tryPromise({
                  try: (captureSignal) =>
                    broker.runPromise(
                      Effect.gen(function* () {
                        return yield* captureBrokerObservation(
                          (yield* BrokerSession).read,
                          ticket.startedAt,
                          captureTimeoutMs,
                        )
                      }),
                      { signal: captureSignal },
                    ),
                  catch: (cause) => observationUnavailable('Verified broker observation acquisition failed', cause),
                })
              })
              const result = yield* capture.pipe(
                Effect.timeoutOrElse({
                  duration: captureTimeoutMs,
                  orElse: () =>
                    Effect.fail(observationUnavailable('Broker observation acquisition exceeded its deadline')),
                }),
                Effect.result,
              )
              const nextPollNotBeforeMs = yield* budget.nextPollNotBeforeMs
              if (Result.isFailure(result)) {
                yield* persistence.failed(ticket)
                yield* ScopedRef.set(brokerRuntimes, acquireBroker)
                yield* Effect.logWarning('Broker observation poll failed').pipe(
                  Effect.annotateLogs({
                    'broker.operation': result.failure.operation,
                    'broker.failure_kind': result.failure.kind,
                  }),
                )
                return { _tag: 'Unavailable', nextPollNotBeforeMs } as const
              }
              const publication = yield* persistence.publish(ticket, result.success).pipe(Effect.result)
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
            }).pipe(Effect.onInterrupt(() => Effect.flatMap(store, (value) => value.invalidate))),
            { signal },
          ),
      },
    }
  })
