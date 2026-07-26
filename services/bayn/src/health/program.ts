import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Ref, Schedule } from 'effect'

import type { BrokerReadShape } from '../broker/alpaca'
import type { RuntimeConfig } from '../config'
import type { FinalizedSnapshotProvenance } from '../contracts'
import { CycleObservability } from '../db/cycle-observability'
import { EvidenceStore, type QualificationRecord, type RecoveredEvaluationEvidence } from '../db/evidence-store'
import { OperationalError, operationalError } from '../errors'
import { Journal } from '../ledger'
import { MarketData } from '../market-data'
import { databaseOperation, withinDeadline } from '../operations'
import type { BrokerConfiguration, RuntimeEvidence, RuntimeState } from '../runtime-state'
import { utcInstantFromEpochMillis } from '../time'
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
  BrokerProbe,
  HealthLogDecision,
  HealthProbeResults,
  ProbeResult,
} from './model'

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

const observeBroker = (read: BrokerReadShape, timeoutMs: number): Effect.Effect<ProbeResult<string>> =>
  Effect.map(
    observe(
      read.account.pipe(
        Effect.map((value) => ({ _tag: 'AccountRead' as const, value })),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.succeed({ _tag: 'TimedOut' as const }),
        }),
      ),
      'unknown broker probe failure',
    ),
    (result): ProbeResult<string> => {
      if (result._tag === 'Unavailable') return result
      if (result.value._tag === 'TimedOut') {
        return {
          _tag: 'Unavailable',
          error: `Alpaca account probe timed out after ${timeoutMs}ms`,
        }
      }
      return { _tag: 'Available', value: result.value.value.value.id }
    },
  )

export const ensureSignalIdentity = (
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

export const ensureDurableEvidence = (
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
  marketData: MarketData['Service'],
  journal: Journal['Service'],
  evidenceStore: EvidenceStore['Service'],
  cycleObservability: CycleObservability['Service'],
  broker: BrokerProbe | undefined,
): Effect.Effect<HealthProbeResults, never> =>
  Effect.map(
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
            Effect.flatMap((snapshot) => ensureSignalIdentity(snapshot, evidence)),
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
          evidence === null
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
          evidence === null
            ? Effect.fail(operationalError('database', 'cycle-observability', 'startup evidence is unavailable'))
            : withinDeadline(
                databaseOperation(
                  cycleObservability.read(evidence.evaluation.runId, broker?.expectedAccountId),
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

export const probe = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  autonomousCycleFiber?: Fiber.Fiber<void, never>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    const cycleObservability = yield* CycleObservability
    const initial = yield* Ref.get(state)
    const results = yield* collectHealthProbeResults(
      config,
      initial.evidence,
      marketData,
      journal,
      evidenceStore,
      cycleObservability,
      broker,
    )
    const checkedAtMs = yield* Clock.currentTimeMillis
    const checkedAt = utcInstantFromEpochMillis(checkedAtMs)
    const cycleFiber = sampleAutonomousCycleFiber(autonomousCycleFiber)
    const transition = yield* Ref.modify(state, (current) => {
      const decision = deriveHealthTransition(current, {
        config,
        evidenceAvailable: initial.evidence !== null,
        results,
        broker: brokerConfiguration(broker),
        cycleFiber,
        checkedAt,
        checkedAtMs,
      })
      return [decision, decision.next] as const
    })
    yield* interpretHealthLogs(deriveHealthLogDecisions(transition))
  }).pipe(Effect.withLogSpan('health'))

export const monitor = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  autonomousCycleFiber?: Fiber.Fiber<void, never>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability> =>
  probe(config, state, broker, autonomousCycleFiber).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.healthIntervalMs))),
    Effect.asVoid,
  )
