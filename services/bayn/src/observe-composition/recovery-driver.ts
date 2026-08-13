import { Clock, Duration, Effect, Ref, Result, Semaphore } from 'effect'
import type { AutonomousCycleLoop, AutonomousCycleStartup } from '../app'
import type { AutonomousCycle } from '../cycle'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  cyclePassLogFacts,
  decideIdleReconciliationCadence,
  shouldDeferCyclePollForReconciliation,
  validateCyclePassTimeout,
  validateReconciliationInterval,
  type CycleRunContext,
  type CyclePassObservation,
  type CycleRunResult,
} from '../cycle/runner'
import { validateCycleLoopInterval } from '../cycle/runner/decisions'
import { type ReconciliationCadenceState } from '../cycle/runner/model'
import { OperationalError, operationalError } from '../errors'
import { type ReconciliationPassResult } from '../reconciler'
import { type Policy } from '../risk'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import type { CycleDecisionDocument } from '../shadow-decision-contract'
import { restrictMutationLoopFailure } from './mutation-interpreter'
import type {
  ExecutionCapability,
  ObserveAutonomousCycleInput,
  ObserveDecisionRuntime,
  ObserveStartupPreparation,
  LifecycleAdvanceDisposition,
  RecoveryFirstCycleDriver,
  RecoveryFirstCycleDriverInterpreter,
  RecoveryFirstRuntime,
} from './model'
import {
  boundedReconciliationPass,
  buildMutationShadowCycleDecision,
  buildObserveCycleDecision,
  decisionBuildError,
  notDueReconciliationError,
  observePass,
  runMutationPassWithinTimeout,
  type ReconciliationPassError,
} from './decision-builder'
import {
  completePostMutationReconciliation,
  isPostMutationReconciliation,
  mutationDecisionInput,
  runRecoveryFirstCyclePass,
} from './execution-cycle'

type RecoveryFirstDecisionBuilder = (
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, ObserveDecisionRuntime>

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

const mutationNanosPerMillisecond = 1_000_000n

const mutationIntervalNanos = (intervalMs: number): bigint => BigInt(intervalMs) * mutationNanosPerMillisecond

const mutationSleepUntil = (deadlineNanos: bigint): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((nowNanos) => {
      const remainingNanos = deadlineNanos - nowNanos
      if (remainingNanos <= 0n) return Effect.void
      const remainingMs = Number((remainingNanos + mutationNanosPerMillisecond - 1n) / mutationNanosPerMillisecond)
      return Effect.sleep(Duration.millis(remainingMs))
    }),
  )

const mutationIdleReconciliationError = (cause: ReconciliationPassError): CycleRunnerError => {
  const converted = notDueReconciliationError(cause)
  return new CycleRunnerError({
    operation: 'reconcile-not-due',
    failure: converted.failure,
    message: converted.message,
    cause: converted,
  })
}

const markMutationReconciliationCompleted = (cadence: Ref.Ref<ReconciliationCadenceState>): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })))

export const runExternalLifecycleAdvanceWithinTimeout = <A, E, R>(
  operationPermit: Semaphore.Semaphore,
  beforeLifecycleAdvance: Effect.Effect<LifecycleAdvanceDisposition, E, R> | undefined,
  runCycleAdvance: Effect.Effect<A, E, R>,
  completeLifecycleAdvance: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | CycleRunnerError, R> =>
  runMutationPassWithinTimeout(
    operationPermit.withPermit(
      beforeLifecycleAdvance === undefined
        ? runCycleAdvance
        : beforeLifecycleAdvance.pipe(
            Effect.flatMap((disposition) => (disposition === 'CONTINUE' ? runCycleAdvance : completeLifecycleAdvance)),
          ),
    ),
    timeoutMs,
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
        Effect.mapError(mutationIdleReconciliationError),
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

const reconcileMutationNotDuePass = (
  input: ObserveAutonomousCycleInput,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<CycleRunResult, CycleRunnerError, ObserveDecisionRuntime> => {
  if (result.outcome !== 'NOT_DUE') return Effect.succeed(result)
  return Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
    if (decision._tag === 'WAIT') {
      if (state.lastFailure !== undefined) return yield* state.lastFailure
      return result
    }
    yield* attemptMutationIdleReconciliation(cadence, reconcile)
    return result
  })
}

const observeMutationIdleReconciliation = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }>,
): Effect.Effect<AutonomousCyclePassObservation, never, ObserveDecisionRuntime> =>
  reconcileMutationNotDuePass(input, cadence, reconcile, result).pipe(
    Effect.flatMap((reconciled) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) =>
          observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result: reconciled }),
        ),
      ),
    ),
    Effect.catch((error) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
      ),
    ),
  )

const observeMutationCadenceReconciliation = (
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult | undefined,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Ref.get(cadence).pipe(
    Effect.flatMap((state) =>
      attemptMutationIdleReconciliation(cadence, reconcile).pipe(
        Effect.flatMap(() =>
          result !== undefined && (result.outcome === 'NOT_DUE' || state.lastFailure !== undefined)
            ? currentUtcInstant.pipe(
                Effect.flatMap((observedAt) =>
                  observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result }),
                ),
              )
            : Effect.void,
        ),
      ),
    ),
    Effect.catch((error) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
      ),
    ),
  )

const waitUntilNextMutationPoll = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult | undefined,
  nextPollAtNanos: bigint,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Effect.suspend(() =>
    Effect.gen(function* () {
      const nowNanos = yield* Clock.currentTimeNanos
      const state = yield* Ref.get(cadence)
      const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
      if (decision._tag === 'RECONCILE') {
        yield* observeMutationCadenceReconciliation(startup, cadence, reconcile, result)
        return yield* waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
      }
      const reconciliationAtNanos = nowNanos + decision.remainingNanos
      const pollStartAtNanos = nowNanos > nextPollAtNanos ? nowNanos : nextPollAtNanos
      const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
      if (
        shouldDeferCyclePollForReconciliation({
          lastAttemptAtNanos: state.lastAttemptAtNanos,
          nextPollAtNanos,
          pollStartAtNanos,
          reconciliationAtNanos,
          cyclePassTimeoutNanos: mutationIntervalNanos(cyclePassTimeoutMs),
        })
      ) {
        yield* mutationSleepUntil(reconciliationAtNanos)
        return yield* waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
      }
      if (nowNanos >= nextPollAtNanos) return
      if (nextPollAtNanos < reconciliationAtNanos) return yield* mutationSleepUntil(nextPollAtNanos)
      yield* mutationSleepUntil(reconciliationAtNanos)
      return yield* waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
    }),
  )

const waitAfterMutationPass = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((completedAtNanos) => {
      const nextPollAtNanos = completedAtNanos + mutationIntervalNanos(input.pollIntervalMs)
      return waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
    }),
  )

const maintainMutationReconciliation = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((completedAtNanos) =>
      waitUntilNextMutationPoll(
        input,
        startup,
        cadence,
        reconcile,
        undefined,
        completedAtNanos + mutationIntervalNanos(input.pollIntervalMs),
      ),
    ),
  )

const waitAfterMutationFailure = maintainMutationReconciliation

const observeMutationCycleResult = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<AutonomousCyclePassObservation, never, ObserveDecisionRuntime> =>
  result.outcome === 'NOT_DUE'
    ? observeMutationIdleReconciliation(input, startup, cadence, reconcile, result)
    : Ref.get(cadence).pipe(
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

const makeRecoveryFirstCycleDriver = (
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
    const reconcile = boundedReconciliationPass(input.reconciliationPassTimeoutMs).pipe(
      Effect.tap(() => markMutationReconciliationCompleted(cadence)),
    )
    const advanceCycle = Effect.gen(function* () {
      const context: CycleRunContext<ObserveDecisionRuntime> = {
        qualificationRunId: startup.qualificationRunId,
        ...(input.cycleCadence === undefined ? {} : { cadence: input.cycleCadence }),
        strategyProtocolHash: preparation.strategyProtocolHash,
        accountId: input.accountId,
        executionPolicy: preparation.executionPolicy,
        buildDecision: (cycle) => buildDecision(cycle, reconcile),
      }
      const result = yield* runMutationPassWithinTimeout(
        runRecoveryFirstCyclePass(input, preparation, policy, context, reconcile, capability),
        cyclePassTimeoutMs,
      )
      if (isPostMutationReconciliation(result)) {
        return yield* completePostMutationReconciliation(result, reconcile)
      }
      return result
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
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
          ),
        onSuccess: (result) =>
          observeMutationCycleResult(input, startup, cadence, reconcile, result).pipe(
            Effect.map((observation) => ({ observation, result })),
          ),
      }),
    )
    const runCycleAdvance =
      input.interpretCycleDriver === undefined
        ? advanceCycle
        : reconcileMutationBeforeExternallyDrivenAdvance(input, cadence, reconcile).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                currentUtcInstant.pipe(
                  Effect.flatMap((observedAt) =>
                    observeMutationPass(startup, { outcome: 'FAILED', observedAt, error }),
                  ),
                  Effect.map((observation) => ({ observation })),
                ),
              onSuccess: () => advanceCycle,
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
    // The external driver owns one bounded command. Include lifecycle maintenance and the reconciliation preflight in
    // the same aggregate budget as the cycle pass so a stalled prerequisite cannot outlive Restate's command window.
    const lifecycleAdvance =
      input.beforeLifecycleAdvance === undefined
        ? runCycleAdvance
        : input.beforeLifecycleAdvance.pipe(
            Effect.flatMap((disposition) => (disposition === 'CONTINUE' ? runCycleAdvance : completeLifecycleAdvance)),
          )
    const advance =
      input.interpretCycleDriver === undefined
        ? operationPermit.withPermit(lifecycleAdvance)
        : runExternalLifecycleAdvanceWithinTimeout(
            operationPermit,
            input.beforeLifecycleAdvance,
            runCycleAdvance,
            completeLifecycleAdvance,
            cyclePassTimeoutMs,
          )
    const maintainReconciliation = operationPermit.withPermit(
      reconcileMutationBeforeExternallyDrivenAdvance(input, cadence, reconcile).pipe(
        Effect.catch((error) =>
          // Reconciliation persistence owns guardian readiness; do not replace Restate lifecycle progress.
          Effect.logError('Bayn Restate reconciliation guardian failed', error).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              failure: error.failure,
              reason: error.message,
            }),
          ),
        ),
      ),
    )
    return {
      advance,
      maintainReconciliation,
      nextDelayMs: recoveryFirstCycleNextDelayMs(input),
      wait: (completed) =>
        completed.result === undefined
          ? waitAfterMutationFailure(input, startup, cadence, reconcile)
          : waitAfterMutationPass(input, startup, cadence, reconcile, completed.result),
    }
  })

export const interpretRecoveryFirstCycleInProcess: RecoveryFirstCycleDriverInterpreter = (driver) => {
  const run = (): Effect.Effect<void, never, RecoveryFirstRuntime> =>
    Effect.suspend(() =>
      driver.advance.pipe(
        Effect.flatMap(driver.wait),
        Effect.catch((restrictionError) => Effect.die(restrictionError)),
        Effect.andThen(run()),
      ),
    )
  return run()
}

export const makeRecoveryFirstAutonomousLoop = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: ExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
  operation: 'autonomous cycle loop' | 'mutation autonomous cycle loop',
): Result.Result<AutonomousCycleLoop<RecoveryFirstRuntime>, OperationalError> => {
  const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
  return Result.mapError(
    Result.map(validateCycleLoopInterval(input.pollIntervalMs), () => input.reconciliationIntervalMs).pipe(
      Result.flatMap(validateReconciliationInterval),
      Result.flatMap(() => validateCyclePassTimeout(cyclePassTimeoutMs, input.reconciliationIntervalMs)),
      Result.map(() =>
        makeRecoveryFirstCycleDriver(input, startup, preparation, policy, capability, buildDecision).pipe(
          Effect.flatMap(input.interpretCycleDriver ?? interpretRecoveryFirstCycleInProcess),
        ),
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
