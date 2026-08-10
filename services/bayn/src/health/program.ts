import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Ref, Result, Schedule } from 'effect'

import {
  OrderCollection,
  SortDirection,
  verifyBrokerAccountPermissions,
  type BrokerAccountPreflightFailure,
  type BrokerReadShape,
} from '../broker/alpaca'
import type { RuntimeConfig } from '../config'
import type { FinalizedSnapshotProvenance } from '../contracts'
import type { QualificationRecord, RecoveredEvaluationEvidence } from '../db/evidence-store'
import { OperationalError, operationalError } from '../errors'
import { databaseOperation, withinDeadline } from '../operations'
import {
  qualificationEvidenceSatisfied,
  type BrokerConfiguration,
  type RuntimeEvidence,
  type RuntimeState,
} from '../runtime-state'
import { utcInstantFromEpochMillisResult } from '../time'
import {
  deriveHealthLogDecisions,
  deriveHealthTransition,
  renderDurableEvidenceFailure,
  renderSignalIdentityFailure,
  validateDurableEvidence,
  validateSignalIdentity,
} from './decisions'
import type {
  AutonomousCycleFiberObservation,
  BrokerHealthObservation,
  BrokerProbe,
  HealthDependencies,
  HealthLogDecision,
  HealthProbeResults,
  ProbeResult,
} from './model'
import { Pipeable } from '../pipeable'

const probeFailureMessage = <E>(cause: Cause.Cause<E>, fallback: string): string => {
  const errors = Cause.prettyErrors(cause).map((error) => error.message)
  return errors.join('; ') || fallback
}

const observe = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback = 'unknown probe failure',
): Effect.Effect<ProbeResult<A>, never, R> =>
  Effect.flatMap(Effect.exit(effect), (exit): Effect.Effect<ProbeResult<A>> => {
    if (Exit.isSuccess(exit)) return Effect.succeed({ _tag: 'Available', value: exit.value })
    if (Cause.hasInterrupts(exit.cause)) return Effect.interrupt
    return Effect.succeed({ _tag: 'Unavailable', error: probeFailureMessage(exit.cause, fallback) })
  })

const renderBrokerPermissionFailure = (failure: BrokerAccountPreflightFailure): string => {
  switch (failure._tag) {
    case 'BrokerAccountNotActive':
      return `account status is ${failure.status}, expected ACTIVE`
    case 'BrokerAccountBlocked':
      return 'account is blocked'
    case 'BrokerTradingBlocked':
      return 'trading is blocked'
    case 'BrokerTradingSuspendedByUser':
      return 'trading is suspended by the user'
    case 'BrokerFractionalTradingDisabled':
      return 'fractional trading is disabled'
  }
}

const namedBrokerRead = <A, E, R>(
  behavior: string,
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<ProbeResult<A>, never, R> =>
  observe(effect, `unknown ${behavior} failure`).pipe(
    Effect.map(
      (result): ProbeResult<A> =>
        result._tag === 'Available'
          ? result
          : {
              _tag: 'Unavailable',
              error: `Alpaca ${behavior} unavailable: ${result.error}`,
            },
    ),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.succeed({
          _tag: 'Unavailable' as const,
          error: `Alpaca ${behavior} timed out after ${timeoutMs}ms`,
        }),
    }),
  )

const observeBroker = (read: BrokerReadShape, timeoutMs: number): Effect.Effect<ProbeResult<BrokerHealthObservation>> =>
  Effect.all(
    {
      account: namedBrokerRead('account read', read.account, timeoutMs),
      accountConfiguration: namedBrokerRead('account configuration read', read.accountConfiguration, timeoutMs),
      positions: namedBrokerRead('positions read', read.positions, timeoutMs),
      openOrders: namedBrokerRead(
        'open orders read',
        read.orders({ status: OrderCollection.Open, limit: 1 }),
        timeoutMs,
      ),
      recentOrders: namedBrokerRead(
        'recent orders read',
        read.orders({ status: OrderCollection.All, limit: 1, direction: SortDirection.Descending }),
        timeoutMs,
      ),
      fills: namedBrokerRead(
        'recent fills read',
        read.fillActivities({ pageSize: 1, direction: SortDirection.Descending }),
        timeoutMs,
      ),
    },
    { concurrency: 6 },
  ).pipe(
    Effect.map((results): ProbeResult<BrokerHealthObservation> => {
      const failures = Object.values(results).flatMap((result) => (result._tag === 'Unavailable' ? [result.error] : []))
      if (failures.length > 0) return { _tag: 'Unavailable', error: failures.join('; ') }

      if (results.account._tag !== 'Available' || results.accountConfiguration._tag !== 'Available') {
        return { _tag: 'Unavailable', error: 'Alpaca continuous broker-read health did not complete' }
      }
      const permissions = verifyBrokerAccountPermissions(
        results.account.value.value,
        results.accountConfiguration.value.value,
      )
      return {
        _tag: 'Available',
        value: {
          accountId: results.account.value.value.id,
          permissionError: Result.isFailure(permissions)
            ? `Alpaca account permission drift detected: ${renderBrokerPermissionFailure(permissions.failure)}`
            : null,
        },
      }
    }),
  )

const ensureSignalIdentityDataFirst = (
  snapshot: FinalizedSnapshotProvenance,
  evidence: RuntimeEvidence | null,
): Effect.Effect<void, OperationalError> =>
  Effect.mapError(
    Effect.fromResult(validateSignalIdentity(snapshot, evidence)),
    (failure) =>
      new OperationalError({
        component: 'market-data',
        operation: 'check-identity',
        message: `Signal identity check failed: ${renderSignalIdentityFailure(failure)}`,
        retryable: false,
        cause: failure,
      }),
  )

export const ensureSignalIdentity = Pipeable.dual(2, ensureSignalIdentityDataFirst)

const ensureDurableEvidenceDataFirst = (
  recovered: RecoveredEvaluationEvidence | null,
  qualification: QualificationRecord | null,
  evidence: RuntimeEvidence | null,
): Effect.Effect<void, OperationalError> =>
  Effect.mapError(
    Effect.fromResult(validateDurableEvidence(recovered, qualification, evidence)),
    (failure) =>
      new OperationalError({
        component: 'database',
        operation: 'verify-evidence',
        message: `durable evidence verification failed: ${renderDurableEvidenceFailure(failure)}`,
        retryable: false,
        cause: failure,
      }),
  )

export const ensureDurableEvidence = Pipeable.dual(3, ensureDurableEvidenceDataFirst)

const sampleAutonomousCycleFiber = (fiber: Fiber.Fiber<void, never> | undefined): AutonomousCycleFiberObservation => {
  if (fiber === undefined) return { _tag: 'NotProvided' }
  const exit = fiber.pollUnsafe()
  if (exit === undefined) return { _tag: 'Running' }
  if (Exit.isSuccess(exit)) return { _tag: 'ExitedSuccessfully' }
  return {
    _tag: 'ExitedWithFailure',
    error: probeFailureMessage(exit.cause, Cause.pretty(exit.cause)),
  }
}

const brokerConfiguration = (broker: BrokerProbe | undefined): BrokerConfiguration | undefined =>
  broker === undefined
    ? undefined
    : {
        expectedAccountId: broker.expectedAccountId,
        executionEligible: broker.executionEligible,
        executionDisabledReason: broker.executionDisabledReason,
      }

const interpretHealthLogs = (decisions: readonly HealthLogDecision[]): Effect.Effect<void> =>
  Effect.forEach(
    decisions,
    (decision) => {
      const log = decision.level === 'INFO' ? Effect.logInfo : Effect.logWarning
      return log(decision.message).pipe(Effect.annotateLogs(decision.annotations))
    },
    { discard: true },
  )

const collectHealthProbeResults = (
  config: RuntimeConfig,
  evidence: RuntimeEvidence | null,
  marketData: HealthDependencies['marketData'],
  journal: HealthDependencies['journal'],
  evidenceStore: HealthDependencies['evidenceStore'],
  cycleObservability: HealthDependencies['cycleObservability'],
  broker: BrokerProbe | undefined,
  cycleObservationId: string | undefined,
  qualificationEvidenceRequired: boolean,
): Effect.Effect<HealthProbeResults, never> => {
  const cycleBindingId = cycleObservationId ?? evidence?.evaluation.runId
  return Effect.map(
    Effect.all(
      [
        observe(
          withinDeadline(
            databaseOperation(evidenceStore.check, 'continuous-health'),
            config.operationTimeoutMs,
            'database',
            'continuous-health',
          ),
        ),
        observe(
          withinDeadline(marketData.check, config.operationTimeoutMs, 'market-data', 'continuous-health').pipe(
            Effect.flatMap((snapshot) =>
              qualificationEvidenceRequired ? ensureSignalIdentity(snapshot, evidence) : Effect.void,
            ),
          ),
        ),
        observe(
          withinDeadline(
            evidence === null ? journal.check : journal.checkRun(evidence.reconciliation),
            config.operationTimeoutMs,
            'journal',
            'continuous-health',
          ),
        ),
        observe(
          !qualificationEvidenceRequired
            ? Effect.void
            : evidence === null
              ? Effect.fail(operationalError('database', 'verify-evidence', 'startup evidence is unavailable'))
              : withinDeadline(
                  Effect.all([
                    databaseOperation(
                      evidenceStore.recover(evidence.evaluation.runId, evidence.provenance),
                      'continuous-recovery',
                    ),
                    databaseOperation(
                      evidenceStore.readQualification(evidence.evaluation.runId),
                      'continuous-qualification',
                    ),
                  ]),
                  config.operationTimeoutMs,
                  'database',
                  'continuous-recovery',
                ).pipe(
                  Effect.flatMap(([recovered, qualification]) =>
                    ensureDurableEvidence(Option.getOrNull(recovered), Option.getOrNull(qualification), evidence),
                  ),
                ),
        ),
        observe(
          cycleBindingId === undefined
            ? Effect.fail(operationalError('database', 'cycle-observability', 'startup evidence is unavailable'))
            : withinDeadline(
                databaseOperation(
                  cycleObservability.read(cycleBindingId, broker?.expectedAccountId),
                  'cycle-observability',
                ),
                config.operationTimeoutMs,
                'database',
                'cycle-observability',
              ),
        ),
        broker === undefined ? Effect.succeed(null) : observeBroker(broker.read, config.operationTimeoutMs),
      ],
      { concurrency: 'unbounded' },
    ),
    ([postgresql, signal, tigerBeetle, durableEvidence, cycle, brokerResult]) => ({
      postgresql,
      signal,
      tigerBeetle,
      durableEvidence,
      cycle,
      broker: brokerResult,
    }),
  )
}

export const checkHealth = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  dependencies: HealthDependencies,
  broker?: BrokerProbe,
  autonomousCycleFiber?: Fiber.Fiber<void, never>,
  cycleObservationId?: string,
  qualificationEvidenceRequired = true,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const initial = yield* Ref.get(state)
    const results = yield* collectHealthProbeResults(
      config,
      initial.evidence,
      dependencies.marketData,
      dependencies.journal,
      dependencies.evidenceStore,
      dependencies.cycleObservability,
      broker,
      cycleObservationId,
      qualificationEvidenceRequired,
    )
    const checkedAtMs = yield* Clock.currentTimeMillis
    const checkedAtResult = utcInstantFromEpochMillisResult(checkedAtMs)
    const clock = Result.match(checkedAtResult, {
      onFailure: (failure) => ({ _tag: 'Unavailable' as const, observedAtMs: checkedAtMs, failure }),
      onSuccess: (checkedAt) => ({ _tag: 'Available' as const, checkedAt, checkedAtMs }),
    })
    const cycleFiber = sampleAutonomousCycleFiber(autonomousCycleFiber)
    const transition = yield* Ref.modify(state, (current) => {
      const decision = deriveHealthTransition(current, {
        config,
        evidenceAvailable: qualificationEvidenceSatisfied(initial),
        results,
        broker: brokerConfiguration(broker),
        cycleFiber,
        clock,
      })
      return [decision, decision.next] as const
    })
    yield* interpretHealthLogs(deriveHealthLogDecisions(transition))
  }).pipe(Effect.withLogSpan('health'))

export const runHealthMonitor = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  dependencies: HealthDependencies,
  broker?: BrokerProbe,
  autonomousCycleFiber?: Fiber.Fiber<void, never>,
  cycleObservationId?: string,
  qualificationEvidenceRequired = true,
): Effect.Effect<void> =>
  checkHealth(
    config,
    state,
    dependencies,
    broker,
    autonomousCycleFiber,
    cycleObservationId,
    qualificationEvidenceRequired,
  ).pipe(Effect.repeat(Schedule.spaced(Duration.millis(config.healthIntervalMs))), Effect.asVoid)
