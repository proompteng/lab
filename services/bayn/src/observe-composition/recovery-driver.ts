import { Clock, Duration, Effect, Ref, Result, Semaphore } from 'effect'
import type { AutonomousCycleStartup } from '../app'
import type { AutonomousCycle } from '../cycle'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  cyclePassLogFacts,
  decideIdleReconciliationCadence,
  validateCyclePassTimeout,
  validateReconciliationInterval,
  type CycleRunContext,
  type CyclePassObservation,
  type CycleRunResult,
} from '../cycle/runner'
import { validateCycleLoopInterval } from '../cycle/runner/decisions'
import { type ReconciliationCadenceState } from '../cycle/runner/model'
import type { CycleDecisionBindingEvidence } from '../cycle/store'
import { OperationalError, operationalError } from '../errors'
import { archiveVerifiedIntradaySnapshotReference, type IntradayMarketDataService } from '../market-data'
import { type ReconciliationPassResult } from '../reconciler'
import { type Policy } from '../risk'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { reconstructBoundIntradaySnapshot, type CycleDecisionDocument } from '../shadow-decision-contract'
import { restrictMutationLoopFailure } from './mutation-interpreter'
import type {
  ExecutionCapability,
  ObserveAutonomousCycleInput,
  ObserveDecisionRuntime,
  ObserveStartupPreparation,
  RecoveryFirstCycleDriver,
  RecoveryFirstRuntime,
} from './model'
import { executionDecisionFinalizationHeadroomMs } from './model'
import {
  boundedReconciliationPass,
  buildMutationShadowCycleDecision,
  buildObserveCycleDecision,
  decisionBuildError,
  mutationCyclePassTimeoutError,
  observePass,
  reconciliationRunnerError,
  runMutationPassWithinTimeout,
  type ReconciliationPassError,
} from './decision-builder'
import {
  deferPostMutationReconciliation,
  isPostMutationReconciliation,
  mutationDecisionInput,
  runRecoveryFirstCyclePass,
} from './execution-cycle'

type RecoveryFirstDecisionBuilder = (
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, ObserveDecisionRuntime>

const verifyDecisionBindingEvidence = (
  marketData: IntradayMarketDataService | undefined,
  document: CycleDecisionDocument,
): Effect.Effect<CycleDecisionBindingEvidence, CycleDecisionBuildError> => {
  const binding = document.bindings.decisionMarketData ?? document.bindings.executionMarketData
  if (binding?.schemaVersion !== 'bayn.execution-market-data-binding.v2') return Effect.succeed({})
  if (
    marketData === undefined ||
    !('decisionMarketDataRows' in document) ||
    document.decisionMarketDataRows === undefined
  ) {
    return Effect.fail(
      new CycleDecisionBuildError({
        failure: 'contract',
        message: 'intraday decision has no archive reader or persisted rows for external verification',
      }),
    )
  }
  const snapshot = reconstructBoundIntradaySnapshot(binding, document.decisionMarketDataRows)
  if (snapshot === undefined) {
    return Effect.fail(
      new CycleDecisionBuildError({
        failure: 'contract',
        message: 'intraday decision rows do not reconstruct their bound archive snapshot',
      }),
    )
  }
  return marketData.verifyArchiveSnapshot(snapshot).pipe(
    Effect.map((verified) => ({
      intradaySnapshotReferences: [archiveVerifiedIntradaySnapshotReference(verified)],
    })),
    Effect.mapError(
      (cause) =>
        new CycleDecisionBuildError({
          failure: 'market-data',
          message: 'intraday decision does not match the immutable archive at its bound watermarks',
          cause,
        }),
    ),
  )
}

const observeMutationPass = (
  startup: Parameters<AutonomousCycleStartup>[0],
  observation: CyclePassObservation,
): Effect.Effect<AutonomousCyclePassObservation> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return observePass(startup.recordPass, observation).pipe(
    Effect.tap(() => log.pipe(Effect.annotateLogs(facts.annotations))),
  )
}

const markMutationReconciliationCompleted = (cadence: Ref.Ref<ReconciliationCadenceState>): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })))

export const runRestateAdvanceWithinTimeout = <A, E, R>(
  operationPermit: Semaphore.Semaphore,
  lifecycleAdvance: Effect.Effect<A, E, R>,
  timeoutMs: number,
  onTimeout: (error: CycleRunnerError) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  operationPermit.withPermit(lifecycleAdvance).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => onTimeout(mutationCyclePassTimeoutError(timeoutMs)),
    }),
  )

const attemptMutationIdleReconciliation = (
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<void, CycleRunnerError, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.tap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })),
    Effect.andThen(
      reconcile.pipe(
        Effect.asVoid,
        Effect.mapError(reconciliationRunnerError),
        Effect.tapError((lastFailure) =>
          Clock.currentTimeNanos.pipe(
            Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos, lastFailure })),
          ),
        ),
      ),
    ),
  )

const reconcileMutationBeforeExternallyDrivenAdvance = (
  input: ObserveAutonomousCycleInput,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<void, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
    if (decision._tag === 'RECONCILE') yield* attemptMutationIdleReconciliation(cadence, reconcile)
    else if (state.lastFailure !== undefined) return yield* state.lastFailure
  })

const observeMutationCycleResult = (
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  result: CycleRunResult,
): Effect.Effect<AutonomousCyclePassObservation> =>
  Ref.get(cadence).pipe(
    Effect.flatMap((state) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) =>
          state.lastFailure === undefined
            ? observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result })
            : observeMutationPass(startup, { outcome: 'FAILED', observedAt, error: state.lastFailure }),
        ),
      ),
    ),
  )

export const recoveryFirstCycleNextDelayMs = (input: {
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
}): number => Math.min(input.pollIntervalMs, input.reconciliationIntervalMs)

const makeRecoveryFirstCycleDriverEffect = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: ExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
): Effect.Effect<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const cadence = yield* Ref.make<ReconciliationCadenceState>({})
    const operationPermit = yield* Semaphore.make(1)
    const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
    const nextDelayMs = recoveryFirstCycleNextDelayMs(input)
    const reconcile = boundedReconciliationPass(input.reconciliationPassTimeoutMs).pipe(
      Effect.tap(() => markMutationReconciliationCompleted(cadence)),
    )
    const observeCycleFailure = (error: CycleRunnerError) =>
      (capability._tag === 'Mutation' ? restrictMutationLoopFailure(error) : Effect.void).pipe(
        Effect.catch((restrictionError: CycleRunnerError) =>
          currentUtcInstant.pipe(
            Effect.flatMap((observedAt) =>
              observeMutationPass(startup, { outcome: 'FAILED', observedAt, error: restrictionError }),
            ),
            Effect.andThen(Effect.fail(restrictionError)),
          ),
        ),
        Effect.andThen(currentUtcInstant),
        Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
        Effect.map((observation) => ({ observation })),
      )
    const advanceCycle = Effect.gen(function* () {
      const context: CycleRunContext<ObserveDecisionRuntime> = {
        cycleBindingId: startup.cycleBindingId,
        strategyName: 'intraday-momentum',
        strategyProtocolHash: preparation.strategyProtocolHash,
        accountId: input.accountId,
        executionPolicy: preparation.executionPolicy,
        buildDecision: (cycle) => buildDecision(cycle, reconcile),
        buildDecisionEvidence: (document) => verifyDecisionBindingEvidence(input.intradayMarketData, document),
      }
      const result = yield* runMutationPassWithinTimeout(
        runRecoveryFirstCyclePass(input, policy, context, reconcile, capability),
        cyclePassTimeoutMs,
      )
      if (isPostMutationReconciliation(result)) {
        // The broker mutation is already durably journaled. Do not hold this Restate command open while waiting for
        // broker consistency. Reset the in-process cadence so the next command performs a reconciliation preflight;
        // after a process restart cadence also starts empty and therefore reconciles. Restate persists the shorter
        // one-shot due time in controller state, so the continuation survives worker replacement without duplicating I/O.
        yield* Ref.set(cadence, {})
        return {
          result: deferPostMutationReconciliation(result),
          ...(result.delayMs > 0 ? { nextDelayMs: Math.min(result.delayMs, nextDelayMs) } : {}),
        }
      }
      return { result }
    }).pipe(
      Effect.matchEffect({
        onFailure: observeCycleFailure,
        onSuccess: ({ result, nextDelayMs }) =>
          observeMutationCycleResult(startup, cadence, result).pipe(
            Effect.map((observation) => ({
              observation,
              result,
              ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
            })),
          ),
      }),
    )
    const completeLifecycleAdvance = currentUtcInstant.pipe(
      Effect.flatMap((observedAt) => {
        const observation: AutonomousCyclePassObservation = {
          result: 'SUCCESS',
          observedAt,
          outcome: 'RECOVERED',
        }
        return startup.recordPass(observation).pipe(Effect.as({ observation }))
      }),
    )
    const continueAfterReconciliation =
      input.lifecycleMaintenance === undefined
        ? advanceCycle
        : input.lifecycleMaintenance.afterReconciliation.pipe(
            Effect.flatMap((disposition) => (disposition === 'CONTINUE' ? advanceCycle : completeLifecycleAdvance)),
          )
    const reconciliationPreflight =
      input.lifecycleMaintenance === undefined
        ? reconcileMutationBeforeExternallyDrivenAdvance(input, cadence, reconcile)
        : attemptMutationIdleReconciliation(cadence, reconcile)
    const runCycleAdvance = reconciliationPreflight.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          currentUtcInstant.pipe(
            Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
            Effect.map((observation) => ({ observation })),
          ),
        onSuccess: () => continueAfterReconciliation,
      }),
    )
    // Restate owns one bounded command. A lifecycle advance may finalize a receipt, so it always performs
    // a same-command reconciliation rather than reusing the ordinary cadence. Keep that preflight and maintenance in
    // the aggregate budget so a stalled prerequisite cannot outlive Restate's command window.
    const lifecycleAdvance =
      input.lifecycleMaintenance === undefined
        ? runCycleAdvance
        : input.lifecycleMaintenance.beforeReconciliation.pipe(Effect.andThen(runCycleAdvance))
    const advance = runRestateAdvanceWithinTimeout(
      operationPermit,
      lifecycleAdvance,
      cyclePassTimeoutMs,
      observeCycleFailure,
    )
    return {
      advance,
      nextDelayMs,
    }
  })

export const makeRecoveryFirstCycleDriver = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: ExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
  operation: 'autonomous cycle loop' | 'mutation autonomous cycle loop',
): Result.Result<Effect.Effect<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime>, OperationalError> => {
  const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
  return Result.mapError(
    Result.map(validateCycleLoopInterval(input.pollIntervalMs), () => input.reconciliationIntervalMs).pipe(
      Result.flatMap(validateReconciliationInterval),
      Result.flatMap(() => validateCyclePassTimeout(cyclePassTimeoutMs, input.reconciliationIntervalMs)),
      Result.map(() =>
        makeRecoveryFirstCycleDriverEffect(input, startup, preparation, policy, capability, buildDecision),
      ),
    ),
    (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: `${operation} failed to start`,
        cause,
      }),
  )
}

export const observeDecisionBuilder =
  (
    input: ObserveAutonomousCycleInput,
    preparation: ObserveStartupPreparation,
    policy: Policy,
  ): RecoveryFirstDecisionBuilder =>
  (cycle, reconcile) =>
    buildObserveCycleDecision({
      authorityGenerationHash: input.authorityGenerationHash,
      cycle,
      executionModel: preparation.executionModel,
      policy,
      reconcile,
      strategy: input.strategy,
      decisionFinalizationHeadroomMs: executionDecisionFinalizationHeadroomMs(input),
      ...(input.intradayMarketData === undefined ? {} : { intradayMarketData: input.intradayMarketData }),
    }).pipe(Effect.mapError(decisionBuildError))

export const mutationDecisionBuilder =
  (
    input: ObserveAutonomousCycleInput,
    preparation: ObserveStartupPreparation,
    policy: Policy,
  ): RecoveryFirstDecisionBuilder =>
  (cycle, reconcile) =>
    buildMutationShadowCycleDecision(mutationDecisionInput(input, preparation, policy, cycle, reconcile)).pipe(
      Effect.mapError(decisionBuildError),
    )
