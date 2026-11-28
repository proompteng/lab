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
  Ref,
  References,
  Result,
  Scope,
  ScopedRef,
  Tracer,
} from 'effect'
import { HttpClient } from 'effect/http'

import type { ApplicationPlan } from '../app'
import { layer as brokerSessionLayer, BrokerSession } from '../broker/alpaca/session'
import { alpacaHttpLayer, make as makeAlpacaRead } from '../broker/alpaca/http'
import {
  brokerObservationQuotaWindowMs,
  makeBrokerObservationBudget,
  protectionReadBackoffUntil,
} from '../broker/alpaca/poll-budget'
import { brokerSnapshotCacheConfig, makeBrokerObservationCapture } from '../broker/alpaca/snapshot-cache'
import { observationUnavailable } from '../broker/alpaca/observed-snapshot'
import { canonicalHashV1Result } from '../hash'
import { BrokerPollFailureReason, BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { BrokerObservationClaimStatus, makeBrokerObservationStore } from '../db/broker-observations'
import { BrokerProjectionStoreLive } from '../db/execution-store'
import { BrokerEventStore, ExecutionStoreError, IntentBindingStore } from '../db/execution-store/contract'
import {
  readProtectionReleaseBasis,
  readProtectionReleaseReference,
  recordProtectionReleaseProof,
} from '../db/protection-release'
import { PostgresClientLive } from '../db/postgres-client'
import { IntentStoreLive } from '../execution/intents/postgres'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { readProtectionRelease } from '../execution/protection-release'
import { BrokerEnvironment } from '../broker/identity'
import type { BrokerObservationPoll, BrokerObservationRuntime } from '../restate/restate-broker-observations'
import { verifyBrokerNotification } from '../broker/notifications'
import { projectBrokerActivity, verifyBrokerActivity } from '../broker/activities'
import {
  BrokerStreamReconciliationReason,
  projectBrokerTradeUpdate,
  type BrokerSourceProjectionReceipt,
} from '../broker/trade-update-projection'
import { withObservedStage } from '../telemetry'
import { utcInstantFromEpochMillis } from '../time'
import { ValkeyCache, ValkeyCacheError, ValkeyCacheInputError, ValkeyFailureCategory } from '../valkey-cache'
import { currentOpenTelemetryParentSpan } from '../restate/restate-telemetry'
import { OrderStatus } from '../broker/alpaca/model'
import {
  FillActivityRelation,
  FillMismatchOrderRole,
  ReconciliationError,
} from '../simulation-reconciliation/broker-reconciler-model'
import type { BrokerActivityRuntime } from '../restate/restate-broker-activities'

const brokerSourceProjectionTotal = Metric.counter('bayn_broker_source_projection_total', { incremental: true })
const brokerSourceProjectionLag = Metric.histogram('bayn_broker_source_projection_lag_seconds', {
  boundaries: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
})
const brokerSourceProjectionPending = Metric.gauge('bayn_broker_source_projection_pending')
const brokerSourceProjectionOldestPending = Metric.gauge('bayn_broker_source_projection_oldest_pending_seconds')
const brokerSourceProjectionObservationSuccess = Metric.gauge('bayn_broker_source_projection_observation_success')

const observeBrokerSourceProjection = (receipt: BrokerSourceProjectionReceipt, replayed: boolean) =>
  Effect.gen(function* () {
    const outcome =
      receipt._tag === 'Projected'
        ? 'projected'
        : receipt._tag === 'CanonicallyCovered'
          ? 'canonically_covered'
          : 'reconcile_required'
    const reason = receipt._tag === 'ReconcileRequired' ? receipt.reason : 'none'
    const lagSeconds = Math.max(0, (yield* Clock.currentTimeMillis) - Date.parse(receipt.observedAt)) / 1_000
    const attributes = { namespace: 'bayn', outcome, reason, replayed: String(replayed) }
    yield* Metric.update(brokerSourceProjectionTotal.pipe(Metric.withAttributes(attributes)), 1)
    if (!replayed)
      yield* Metric.update(
        brokerSourceProjectionLag.pipe(Metric.withAttributes({ namespace: 'bayn', outcome, reason })),
        lagSeconds,
      )
    yield* Effect.annotateCurrentSpan({
      'bayn.broker.source_event.outcome': outcome,
      'bayn.broker.source_event.reason': reason,
      'bayn.broker.source_event.replayed': replayed,
      'bayn.broker.source_event.lag_ms': lagSeconds * 1_000,
    })
  })

const diagnosticData = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

const snapshotFailureAnnotations = (failure: unknown): Readonly<Record<string, string>> => {
  const cause = diagnosticData(failure, 'cause')
  if (!isNativeError(cause) || Object.getPrototypeOf(cause) !== ReconciliationError.prototype) return {}
  const detail = diagnosticData(cause, 'failure')
  if (diagnosticData(detail, '_tag') !== 'Snapshot') return {}
  const reason = diagnosticData(detail, 'reason')
  if (
    typeof reason !== 'string' ||
    !['HistoryChanged', 'FillActivitiesPending', 'AccountBaselineMissing', 'TradingDayChanged'].includes(reason)
  )
    return {}
  const annotations: Record<string, string> = { 'broker.snapshot_failure_reason': reason }
  if (reason !== 'FillActivitiesPending') return annotations
  const mismatch = diagnosticData(detail, 'fillMismatch')
  for (const [field, key, allowed] of [
    ['activityRelation', 'broker.fill_activity_relation', Object.values(FillActivityRelation)],
    ['orderRole', 'broker.fill_mismatch_order_role', Object.values(FillMismatchOrderRole)],
    ['orderStatus', 'broker.fill_mismatch_order_status', Object.values(OrderStatus)],
  ] as const) {
    const value = diagnosticData(mismatch, field)
    if (typeof value === 'string' && allowed.some((entry) => entry === value)) annotations[key] = value
  }
  return annotations
}

export const brokerPollFailureAnnotations = (failure: unknown): Readonly<Record<string, string>> => {
  const unknown = { 'broker.poll_failure_reason': 'unknown' }
  if (!isNativeError(failure)) return unknown
  try {
    // Inspect fixed data fields on the wrapper and its direct typed reconciliation cause only.
    // Never read accessors, messages, payloads, or recursively traverse causes.
    const reason: unknown = Object.getOwnPropertyDescriptor(failure, 'pollFailureReason')?.value
    return typeof reason === 'string' && Object.values(BrokerPollFailureReason).some((value) => value === reason)
      ? {
          'broker.poll_failure_reason': reason,
          ...(reason === BrokerPollFailureReason.SnapshotRejected ? snapshotFailureAnnotations(failure) : {}),
        }
      : unknown
  } catch {
    return unknown
  }
}

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
    if (!isNativeError(cause)) return unknown
    const prototype = Object.getPrototypeOf(cause)
    if (prototype === ValkeyCacheInputError.prototype) {
      const operation: unknown = Object.getOwnPropertyDescriptor(cause, 'operation')?.value
      return {
        'broker.publication_dependency': 'valkey',
        'broker.publication_operation':
          typeof operation === 'string' && ['get', 'put', 'remove', 'configure', 'connect'].includes(operation)
            ? operation
            : 'unknown',
        'broker.publication_failure_category': 'input_validation',
        'broker.publication_cause_category': 'input_validation',
      }
    }
    if (prototype !== ValkeyCacheError.prototype) return unknown
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
    readonly activityRuntime: BrokerActivityRuntime
    readonly maxAgeMs: number
    readonly freshnessLeadMs: number
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
    const persistenceResources = IntentStoreLive.pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(PostgresClientLive(plan.config).pipe(Layer.provide(NodeServices.layer))),
      Layer.provideMerge(telemetry),
    )
    const managed = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(persistenceResources)),
      (value) => value.disposeEffect,
    )
    const projectionResources = BrokerProjectionStoreLive.pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(PostgresClientLive(plan.config).pipe(Layer.provide(NodeServices.layer))),
      Layer.provideMerge(telemetry),
    )
    // ManagedRuntime builds its layer on the first run. Source projection owns only PostgreSQL evidence and intent
    // bindings; financial reconciliation and TigerBeetle remain outside this runtime.
    const projection = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(projectionResources)),
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
    const acquireBroker = Effect.gen(function* () {
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => ManagedRuntime.make(brokerResources)),
        (value) => value.disposeEffect,
      )
      return { runtime, capture: yield* makeBrokerObservationCapture }
    })
    const brokerRuntimes = yield* ScopedRef.fromAcquire(acquireBroker)
    const protectionHttp = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(alpacaHttpLayer(plan.config.alpaca).pipe(Layer.provideMerge(telemetry)))),
      (value) => value.disposeEffect,
    )
    const config = yield* brokerSnapshotCacheConfig.pipe(Effect.orDie)
    const captureTimeoutMs = Math.min(plan.config.operationTimeoutMs, Math.floor(config.maxAgeMs / 2))
    const store = yield* Effect.cached(
      Effect.map(PgClient.PgClient, (sql) =>
        makeBrokerObservationStore(
          sql,
          plan.config.alpaca.expectedAccountId,
          plan.config.build.sourceRevision,
          config.maxAgeMs,
          cache,
        ),
      ),
    )
    const accountActivity =
      plan.config.alpaca.environment === BrokerEnvironment.Sandbox
        ? Effect.promise((signal) =>
            managed.runPromiseExit(
              Effect.flatMap(store, (value) => value.readAccountActivity),
              { signal },
            ),
          ).pipe(
            Effect.flatMap((exit) =>
              Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
            ),
            Effect.mapError((cause) =>
              cause instanceof BrokerReadError
                ? cause
                : observationUnavailable('Durable Activity SSE storage is unavailable', cause),
            ),
          )
        : undefined
    const observeProjectionBacklog = Effect.promise((signal) =>
      managed.runPromise(
        Effect.flatMap(store, (value) => value.readProjectionBacklog),
        { signal },
      ),
    ).pipe(
      Effect.flatMap(({ pending, oldestPendingSeconds }) =>
        Effect.all(
          [
            Metric.update(brokerSourceProjectionPending.pipe(Metric.withAttributes({ namespace: 'bayn' })), pending),
            Metric.update(
              brokerSourceProjectionOldestPending.pipe(Metric.withAttributes({ namespace: 'bayn' })),
              oldestPendingSeconds,
            ),
            Metric.update(
              brokerSourceProjectionObservationSuccess.pipe(Metric.withAttributes({ namespace: 'bayn' })),
              1,
            ),
          ],
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Metric.update(
          brokerSourceProjectionObservationSuccess.pipe(Metric.withAttributes({ namespace: 'bayn' })),
          0,
        ).pipe(Effect.andThen(Effect.logWarning('Broker source projection backlog observation failed', cause))),
      ),
    )
    yield* Effect.forever(observeProjectionBacklog.pipe(Effect.andThen(Effect.sleep('15 seconds')))).pipe(
      Effect.forkScoped,
    )
    return {
      maxAgeMs: config.maxAgeMs,
      freshnessLeadMs: captureTimeoutMs,
      activityRuntime: {
        verify: (candidate, nowMs) => verifyBrokerActivity(candidate, plan.config.alpaca, nowMs),
        cursor: (signal) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.readActivityCursor),
            { signal },
          ),
        record: (signal, event) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.recordActivity(event, projectBrokerActivity(event))),
            { signal },
          ),
        completeCatchup: (signal, event) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.recordActivityCatchup(event)),
            { signal },
          ),
        heartbeat: (signal, event) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.recordActivityHeartbeat(event)),
            { signal },
          ),
      },
      runtime: {
        verifyNotification: (candidate, nowMs) => verifyBrokerNotification(candidate, plan.config.alpaca, nowMs),
        recordNotification: (signal, notification) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.recordNotification(notification)),
            { signal },
          ),
        isNotificationCovered: (signal, eventId) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.isNotificationCovered(eventId)),
            { signal },
          ),
        project: (signal, eventId, allowProtectionWait = true) =>
          projection.runPromise(
            Effect.gen(function* () {
              const source = yield* store
              const retained = yield* source.readSourceProjection(eventId)
              if (retained !== undefined) {
                yield* observeBrokerSourceProjection(retained, true)
                return retained
              }
              const retain = (receipt: BrokerSourceProjectionReceipt) => source.recordProjection(receipt)
              const record = (receipt: BrokerSourceProjectionReceipt) =>
                retain(receipt).pipe(Effect.tap((recorded) => observeBrokerSourceProjection(recorded, false)))
              const notification = yield* source.readNotification(eventId)
              const writerFence = yield* WriterFence
              const prepared = yield* writerFence
                .transaction(
                  Effect.gen(function* () {
                    if (yield* source.isNotificationCovered(notification.eventId))
                      return {
                        _tag: 'Receipt' as const,
                        receipt: yield* retain({
                          _tag: 'CanonicallyCovered',
                          eventId: notification.eventId,
                          observedAt: notification.receivedAt,
                        }),
                      }
                    if (
                      notification._tag === 'TradeUpdate' &&
                      !(yield* source.isSessionBoundaryCovered(notification.session.sessionId))
                    )
                      return {
                        _tag: 'Receipt' as const,
                        receipt: yield* retain({
                          _tag: 'ReconcileRequired',
                          eventId: notification.eventId,
                          observedAt: notification.receivedAt,
                          reason: BrokerStreamReconciliationReason.SessionBoundary,
                        }),
                      }
                    if (
                      notification._tag === 'TradeUpdate' &&
                      (yield* source.hasSessionProjectionGap(notification.session.sessionId))
                    )
                      return {
                        _tag: 'Receipt' as const,
                        receipt: yield* retain({
                          _tag: 'ReconcileRequired',
                          eventId: notification.eventId,
                          observedAt: notification.receivedAt,
                          reason: BrokerStreamReconciliationReason.UnresolvedGap,
                        }),
                      }
                    const bindings = yield* (yield* IntentBindingStore).bindings(plan.config.alpaca.expectedAccountId)
                    let decision = projectBrokerTradeUpdate(notification, bindings)
                    if (decision._tag === 'ProtectionBindingRequired') {
                      const protectionOrder = yield* source.readProtectionOrder(
                        decision.brokerOrderId,
                        decision.clientOrderId,
                      )
                      if (protectionOrder !== undefined)
                        decision = projectBrokerTradeUpdate(notification, bindings, protectionOrder)
                    }
                    if (decision._tag === 'ProtectionBindingRequired') {
                      const deadlineMs = Date.parse(notification.receivedAt) + plan.config.operationTimeoutMs
                      if (decision.canWait && allowProtectionWait && (yield* Clock.currentTimeMillis) < deadlineMs)
                        return {
                          _tag: 'Pending' as const,
                          pending: {
                            _tag: 'AwaitingProtection' as const,
                            eventId: notification.eventId,
                            observedAt: notification.receivedAt,
                            deadlineAt: utcInstantFromEpochMillis(deadlineMs),
                          },
                        }
                      return {
                        _tag: 'Receipt' as const,
                        receipt: yield* retain({
                          _tag: 'ReconcileRequired',
                          eventId: notification.eventId,
                          observedAt: notification.receivedAt,
                          reason: BrokerStreamReconciliationReason.MissingIntent,
                        }),
                      }
                    }
                    if (decision._tag === 'ReconcileRequired')
                      return { _tag: 'Receipt' as const, receipt: yield* retain(decision) }
                    const events = yield* BrokerEventStore
                    const orderEventId = (yield* events.ingest(decision.order)).eventId
                    const fill = decision.fill
                    return {
                      _tag: 'Receipt' as const,
                      receipt: yield* retain({
                        _tag: 'Projected',
                        eventId: decision.eventId,
                        observedAt: decision.observedAt,
                        orderEventId,
                        ...(fill === undefined ? {} : { fillEventId: (yield* events.ingest(fill)).eventId }),
                      }),
                    }
                  }),
                )
                .pipe(Effect.result)
              if (Result.isFailure(prepared)) {
                const failure = prepared.failure
                if (
                  failure instanceof ExecutionStoreError &&
                  (failure.failure === 'conflict' || failure.failure === 'decode' || failure.failure === 'invariant')
                ) {
                  const receipt = {
                    _tag: 'ReconcileRequired',
                    eventId: notification.eventId,
                    observedAt: notification.receivedAt,
                    reason: BrokerStreamReconciliationReason.ProjectionConflict,
                  } satisfies BrokerSourceProjectionReceipt
                  return yield* record(receipt)
                }
                return yield* failure
              }
              if (prepared.success._tag === 'Pending') return prepared.success.pending
              yield* observeBrokerSourceProjection(prepared.success.receipt, false)
              return prepared.success.receipt
            }).pipe(
              withObservedStage('bayn.broker.source-event.project', {
                dependency: 'postgresql',
                operation: 'project',
              }),
            ),
            { signal },
          ),
        invalidate: (signal) =>
          managed.runPromise(
            Effect.flatMap(store, (value) => value.invalidate),
            { signal },
          ),
        probeProtection: (signal, cycleId, claimId) =>
          managed.runPromise(
            Effect.gen(function* () {
              if (plan.config.alpaca.environment !== BrokerEnvironment.Sandbox) return undefined
              const accountId = plan.config.alpaca.expectedAccountId
              const retained = yield* readProtectionReleaseReference(accountId, cycleId, claimId)
              if (retained !== undefined) return retained
              const basis = yield* readProtectionReleaseBasis(accountId, cycleId)
              if (basis === undefined) return undefined
              const elapsed = (yield* Clock.currentTimeMillis) - Date.parse(basis.acceptedAt)
              if (elapsed < 0 || elapsed >= config.maxAgeMs) return undefined
              const persistence = yield* store
              const maximumReadMs = Math.min(1_800, captureTimeoutMs)
              const paidAtMs = yield* persistence.reserveProtectionRead(basis.command, claimId, maximumReadMs)
              if (paidAtMs === undefined) return undefined
              const brokerBackoff = yield* Ref.make(0)
              const readback = Effect.gen(function* () {
                const http = yield* HttpClient.HttpClient
                const client = HttpClient.transform(http, (response) =>
                  response.pipe(
                    Effect.tap((value) =>
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((now) =>
                          Ref.update(brokerBackoff, (until) => Math.max(until, protectionReadBackoffUntil(value, now))),
                        ),
                      ),
                    ),
                  ),
                )
                const read = yield* makeAlpacaRead({ ...plan.config.alpaca, retryAttempts: 0 }).pipe(
                  Effect.provideService(HttpClient.HttpClient, client),
                )
                return yield* readProtectionRelease(read, basis, config.maxAgeMs)
              })
              const observed = yield* Effect.promise((readSignal) =>
                protectionHttp.runPromiseExit(readback, { signal: readSignal }),
              ).pipe(Effect.timeoutOption(maximumReadMs))
              // Even a lost response is paid for by the durable reservation of all four requests.
              yield* persistence.settleProtectionRead(claimId, Math.max(paidAtMs, yield* Ref.get(brokerBackoff)))
              if (
                Option.isNone(observed) ||
                Exit.isFailure(observed.value) ||
                observed.value.value._tag !== 'VerifiedProtectionRelease'
              )
                return undefined
              const proof = observed.value.value
              const proofId = yield* recordProtectionReleaseProof(basis, proof, config.maxAgeMs, claimId)
              return proofId === undefined
                ? undefined
                : { proofId, cycleId: basis.trigger.cycleId, checkedAt: proof.checkedAt }
            }).pipe(withObservedStage('bayn.broker.observation.protection-probe', { dependency: 'broker' })),
            { signal },
          ),
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
                let sessionVerified = false
                const capture = Effect.gen(function* () {
                  const broker = yield* ScopedRef.get(brokerRuntimes)
                  const parent = yield* Effect.currentSpan.pipe(Effect.orDie)
                  const annotations = yield* References.CurrentLogAnnotations
                  return yield* Effect.promise((captureSignal) =>
                    broker.runtime.runPromiseExit(
                      Effect.gen(function* () {
                        const session = yield* BrokerSession
                        sessionVerified = true
                        if (accountActivity === undefined)
                          return yield* broker.capture(session.read, ticket, captureTimeoutMs)
                        const durableActivity = yield* accountActivity.pipe(Effect.option)
                        return yield* broker.capture(
                          Option.isNone(durableActivity) ? session.read : { ...session.read, accountActivity },
                          ticket,
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
                      Effect.fail(
                        observationUnavailable(
                          sessionVerified
                            ? 'Broker observation polling exceeded its deadline'
                            : 'Broker observation acquisition exceeded its deadline',
                          undefined,
                          sessionVerified
                            ? BrokerPollFailureReason.PollDeadline
                            : BrokerPollFailureReason.AcquisitionDeadline,
                        ),
                      ),
                  }),
                  Effect.onExit((exit) => {
                    if (Exit.isSuccess(exit)) return Effect.void
                    const reusableSessionFailure =
                      exit.cause.reasons.length > 0 &&
                      exit.cause.reasons.every(
                        (reason) =>
                          reason._tag === 'Fail' &&
                          reason.error.retryable &&
                          reason.error.kind !== BrokerReadErrorKind.Transport &&
                          (reason.error.kind !== BrokerReadErrorKind.Timeout ||
                            reason.error.pollFailureReason === BrokerPollFailureReason.SnapshotRejected),
                      )
                    // A rejected snapshot can reuse its verified connection. Exhausted transport/timeouts
                    // must dispose the old dispatcher so a stuck pool cannot stall the next capture too.
                    // Reacquisition stays lazy and the next poll repeats account/permission verification.
                    return sessionVerified && reusableSessionFailure
                      ? Effect.void
                      : ScopedRef.set(brokerRuntimes, acquireBroker)
                  }),
                  Effect.result,
                )
                if (Result.isFailure(result)) {
                  yield* persistence.failed(ticket, yield* budget.nextPollNotBeforeMs)
                  yield* Effect.logWarning('Broker observation poll failed').pipe(
                    Effect.annotateLogs({
                      'broker.operation': result.failure.operation,
                      'broker.failure_kind': result.failure.kind,
                      'broker.retryable': result.failure.retryable,
                      ...brokerPollFailureAnnotations(result.failure),
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
                  .publish(ticket, result.success, nextPollNotBeforeMs, yield* budget.protectionReadAllowance)
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
                    'broker.pending_cash_fee_count': result.success.pendingCashFeeCount,
                    'broker.source_revision': plan.config.build.sourceRevision,
                    'broker.next_poll_not_before_ms': nextPollNotBeforeMs,
                  }),
                )
                return {
                  _tag: 'Published',
                  snapshotHash,
                  observedAt: result.success.observedAt,
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
              slowAfterMs: null,
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
