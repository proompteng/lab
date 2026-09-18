import { operationCurrentTimeMillis, operationTimeoutOrElse } from '../operation-timeout'
import { ActiveExecutionStages, type ActiveExecutionStage, withObservedStage } from '../telemetry'
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
import { type IntradayMarketDataService } from '../market-data'
import { type ReconciliationPassResult } from '../reconciler'
import { type Policy } from '../risk'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { reconstructBoundIntradaySnapshot, type CycleDecisionDocument } from '../shadow-decision-contract'
import { restrictMutationLoopFailure, shouldRestrictMutationLoopFailure } from './mutation-interpreter'
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
  if (binding === undefined || binding.schemaVersion === 'bayn.reconciled-position-liquidation-binding.v1')
    return Effect.succeed({})
  if (
    marketData === undefined ||
    !('decisionMarketDataRows' in document) ||
    (binding.schemaVersion !== 'bayn.execution-market-data-binding.v3' &&
      binding.schemaVersion !== 'bayn.execution-market-data-binding.v4')
  )
    return Effect.fail(
      new CycleDecisionBuildError({
        failure: 'contract',
        message: 'Decision requires canonical market data and persisted input rows',
      }),
    )
  const inputs = [{ binding, rows: document.decisionMarketDataRows }]
  const pricing = document.bindings.executionMarketData
  if (pricing !== undefined && pricing.snapshotId !== binding.snapshotId) {
    if (
      (pricing.schemaVersion !== 'bayn.execution-market-data-binding.v3' &&
        pricing.schemaVersion !== 'bayn.execution-market-data-binding.v4') ||
      document.executionMarketDataRows === undefined
    )
      return Effect.fail(
        new CycleDecisionBuildError({
          failure: 'contract',
          message: 'Pricing requires canonical market data and persisted input rows',
        }),
      )
    inputs.push({ binding: pricing, rows: document.executionMarketDataRows })
  }
  return Effect.forEach(inputs, ({ binding: source, rows }) => {
    const snapshot = rows === undefined ? undefined : reconstructBoundIntradaySnapshot(source, rows)
    if (snapshot === undefined)
      return Effect.fail(
        new CycleDecisionBuildError({
          failure: 'contract',
          message: 'Decision or pricing input cut does not reproduce',
        }),
      )
    return marketData.verifyReference(snapshot).pipe(
      Effect.mapError(
        (cause) =>
          new CycleDecisionBuildError({
            failure: 'market-data',
            message: 'Decision source evidence is unavailable',
            cause,
          }),
      ),
    )
  }).pipe(
    Effect.map(
      (references): CycleDecisionBindingEvidence => ({
        simulatedSnapshotReferences: references.filter(
          (reference) => reference.schemaVersion === 'bayn.simulated-snapshot-reference.v1',
        ),
        streamingSnapshotReferences: references.filter(
          (reference) => reference.schemaVersion === 'bayn.streaming-snapshot-reference.v1',
        ),
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
  Effect.gen(function* () {
    const startedAt = yield* operationCurrentTimeMillis
    const activeStages = (yield* ActiveExecutionStages) ?? new Map<symbol, ActiveExecutionStage>()
    let interruptionRequestedAt = startedAt
    return yield* operationPermit.withPermit(lifecycleAdvance).pipe(
      withObservedStage('bayn.execution.advance'),
      Effect.provideService(ActiveExecutionStages, activeStages),
      operationTimeoutOrElse({
        duration: Duration.millis(timeoutMs),
        onDeadline: operationCurrentTimeMillis.pipe(
          Effect.flatMap((requestedAt) => {
            interruptionRequestedAt = requestedAt
            return Effect.logWarning('Bayn execution pass interruption requested').pipe(
              Effect.annotateLogs({
                service: 'bayn',
                timeoutMs,
                executionElapsedMs: Math.max(0, requestedAt - startedAt),
                activeStages: [...activeStages.values()].map(({ startedAt: stageStartedAt, ...stage }) => ({
                  ...stage,
                  elapsedMs: Math.max(0, requestedAt - stageStartedAt),
                })),
              }),
            )
          }),
        ),
        orElse: () =>
          operationCurrentTimeMillis.pipe(
            Effect.flatMap((finishedAt) =>
              Effect.logError('Bayn execution pass deadline exceeded').pipe(
                Effect.annotateLogs({
                  service: 'bayn',
                  timeoutMs,
                  elapsedMs: Math.max(0, finishedAt - startedAt),
                  deadlineOverrunMs: Math.max(0, finishedAt - startedAt - timeoutMs),
                  executionElapsedMs: Math.max(0, interruptionRequestedAt - startedAt),
                  cancellationElapsedMs: Math.max(0, finishedAt - interruptionRequestedAt),
                }),
                Effect.andThen(
                  onTimeout(mutationCyclePassTimeoutError(timeoutMs)).pipe(
                    withObservedStage('bayn.execution.timeout-recovery', {
                      slowAfterMs: 1_000,
                      recordCompletion: true,
                    }),
                  ),
                ),
              ),
            ),
          ),
      }),
    )
  })

const attemptMutationIdleReconciliation = (
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<ReconciliationPassResult, CycleRunnerError, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.tap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })),
    Effect.andThen(
      reconcile.pipe(
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
): Effect.Effect<ReconciliationPassResult | undefined, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
    if (decision._tag === 'RECONCILE') return yield* attemptMutationIdleReconciliation(cadence, reconcile)
    else if (state.lastFailure !== undefined) return yield* state.lastFailure
    return undefined
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
      (capability._tag !== 'RecoveryOnly' && shouldRestrictMutationLoopFailure(error)
        ? restrictMutationLoopFailure(error).pipe(
            withObservedStage('bayn.execution.restriction-persistence', {
              dependency: 'postgresql',
              slowAfterMs: 1_000,
              recordCompletion: true,
            }),
          )
        : Effect.void
      ).pipe(
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
    const advanceCycle = (preflight: ReconciliationPassResult | undefined) =>
      Effect.gen(function* () {
        const pendingPreflight = yield* Ref.make(preflight)
        const reconcileForAdvance = Ref.getAndSet(pendingPreflight, undefined).pipe(
          Effect.flatMap((available) => (available === undefined ? reconcile : Effect.succeed(available))),
        )
        const context: CycleRunContext<ObserveDecisionRuntime> = {
          cycleBindingId: startup.cycleBindingId,
          strategyName: 'intraday-momentum',
          strategyProtocolHash: preparation.strategyProtocolHash,
          accountId: input.accountId,
          executionPolicy: preparation.executionPolicy,
          buildDecision: (cycle) => buildDecision(cycle, reconcileForAdvance),
          buildDecisionEvidence: (document) => verifyDecisionBindingEvidence(input.intradayMarketData, document),
        }
        const result = yield* runMutationPassWithinTimeout(
          runRecoveryFirstCyclePass(input, policy, context, reconcileForAdvance, capability),
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
    const reconciliationPreflight = reconcileMutationBeforeExternallyDrivenAdvance(input, cadence, reconcile)
    const runCycleAdvance = reconciliationPreflight.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          currentUtcInstant.pipe(
            Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
            Effect.map((observation) => ({ observation })),
          ),
        onSuccess: (preflight) =>
          advanceCycle(preflight).pipe(
            Effect.flatMap((advanced) =>
              capability._tag !== 'Mutation' ||
              input.intradayMarketData === undefined ||
              advanced.observation.result === 'FAILURE'
                ? Effect.succeed(advanced)
                : input.intradayMarketData.check.pipe(
                    Effect.matchEffect({
                      onFailure: (cause) =>
                        observeCycleFailure(
                          new CycleRunnerError({
                            operation: 'build-decision',
                            failure: 'market-data',
                            message: 'Execution worker market projection is unavailable',
                            cause,
                          }),
                        ).pipe(Effect.map((failed) => ({ ...advanced, ...failed }))),
                      onSuccess: () => Effect.succeed(advanced),
                    }),
                  ),
            ),
          ),
      }),
    )
    const advance = runRestateAdvanceWithinTimeout(
      operationPermit,
      runCycleAdvance.pipe(withObservedStage('bayn.execution.cycle-pass')),
      cyclePassTimeoutMs,
      observeCycleFailure,
    )
    return {
      advance,
      timeoutMs: cyclePassTimeoutMs,
      onTimeout: observeCycleFailure,
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
