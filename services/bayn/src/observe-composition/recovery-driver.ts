import { positionProtectionIntervalMs } from '../jev/exit-policy'
import { firstIntradayObservationAtMs, selectIntradayExecutionSession } from '../cycle/runner/calendar-decisions'
import { strategyTradingProtocol } from '../strategy'
import { continuousExecutionPolicy } from '../market-hours'
import type { ReconciliationRuntime } from './model'
import { operationCurrentTimeMillis, operationTimeoutOrElse } from '../operation-timeout'
import { ActiveExecutionStages, type ActiveExecutionStage, withObservedStage } from '../telemetry'
import { Clock, Duration, Effect, Exit, Ref, Result, Semaphore } from 'effect'
import type { AutonomousCycleStartupInput } from '../app'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../cycle/model'
import { unusedEntryExpiresAt } from '../cycle/entry-admission'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  type CycleRunContext,
  type CyclePassObservation,
  type CycleRunResult,
} from '../cycle/runner/model'
import { cyclePassLogFacts } from '../cycle/runner/pass-decisions'
import {
  decideIdleReconciliationCadence,
  validateCyclePassTimeout,
  validateReconciliationInterval,
} from '../cycle/runner/reconciliation-cadence'
import { type ReconciliationCadenceState } from '../cycle/runner/model'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import type { CycleDecisionBindingEvidence } from '../cycle/store/model'
import { OperationalError, operationalError } from '../errors'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import { type IntradayMarketDataService } from '../market-data/intraday/model'
import { type ReconciliationPassResult } from '../reconciler'
import { type Policy } from '../risk'
import { AuthorityGenerationStore } from '../db/execution-store/contract'
import { Authority, OrderStatus, ReconciliationStatus, type AuthorityState } from '../execution/contracts'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import {
  decisionSourceRows,
  reconstructBoundIntradaySnapshot,
  type CycleDecisionDocument,
} from '../shadow-decision-contract'
import {
  confirmAcceptedCancellation,
  restrictMutationLoopFailure,
  shouldRestrictMutationLoopFailure,
} from './mutation-interpreter'
import { recover as recoverMutation } from '../execution/coordinator'
import type {
  ExecutionCapability,
  ObserveAutonomousCycleInput,
  ObserveDecisionRuntime,
  ObserveStartupPreparation,
  RecoveryFirstCycleDriver,
  RecoveryFirstCycleAdvance,
  RecoveryFirstRuntime,
  RecoveryFirstCyclePassResult,
  PostMutationReconciliation,
} from './model'
import { executionDecisionFinalizationHeadroomMs } from './model'
import {
  boundedReconciliationPass,
  buildMutationShadowCycleDecision,
  buildObserveCycleDecision,
  decisionBuildError,
  mutationCyclePassTimeoutError,
  ReconciliationPassTimeoutError,
  observePass,
  reconciliationRunnerError,
  runMutationPassWithinTimeout,
  type ReconciliationPassError,
  type PricingReconciliationRead,
} from './decision-builder'
import {
  deferPostMutationReconciliation,
  isPostMutationReconciliation,
  mutationDecisionInput,
  runRecoveryFirstCyclePass,
  recoverExpiredEntryBeforeReconciliation,
  readUnfinishedMutationCycle,
} from './execution-cycle'

type MutationReconciliationCadenceState = ReconciliationCadenceState & {
  readonly lastResult?: ReconciliationPassResult
}

type RecoveryFirstDecisionBuilder = (
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ReconciliationRuntime>,
  reconcileForPricing?: PricingReconciliationRead<ReconciliationRuntime>,
) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, ObserveDecisionRuntime>

const reconciliationReusableUntil = (
  cached: ReconciliationPassResult,
  authority: AuthorityState,
  now: number,
  maximumAgeMs: number,
): number | undefined => {
  if (
    cached.riskContext.authority?.generationHash !== authority.generationHash ||
    cached.riskContext.authority.version !== authority.version ||
    cached.report.reconciliation.status !== ReconciliationStatus.Exact ||
    !cached.report.metrics.accountingExact ||
    cached.riskContext.unknownMutationCount !== 0
  )
    return undefined
  const state = cached.brokerState
  const observations = [
    state.account.observedAt,
    state.positionsObservedAt,
    state.ordersObservedAt,
    cached.report.reconciliation.reconciledAt,
    cached.riskContext.authorityObservedAt,
  ]
  if (observations.some((at) => at === null || !Number.isFinite(Date.parse(at)) || Date.parse(at) > now))
    return undefined
  return Math.min(...observations.map((at) => Date.parse(at ?? ''))) + maximumAgeMs
}

export const canReuseSourceWaitReconciliation = (
  previous: ReconciliationPassResult,
  authority: AuthorityState,
  now: number,
  maximumAgeMs: number,
): boolean => {
  const freshUntil = reconciliationReusableUntil(previous, authority, now, maximumAgeMs)
  return (
    freshUntil !== undefined &&
    now < freshUntil &&
    previous.brokerState.positions.length === 0 &&
    previous.brokerState.unknownOrderCount === 0 &&
    !previous.brokerState.orders.some((order) =>
      [OrderStatus.New, OrderStatus.Pending, OrderStatus.PartiallyFilled].includes(order.status),
    )
  )
}

/** Owned by one serialized pass, discarded before its post-mutation continuation. */
export const reconciliationForPreparation = <R>(
  initial: ReconciliationPassResult | undefined,
  refresh: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, R>,
  readAuthority: Effect.Effect<AuthorityState, ReconciliationPassError, R>,
  maximumAgeMs: number,
) =>
  Effect.gen(function* () {
    const previous = yield* Ref.make(initial)
    const preflightAvailable = yield* Ref.make(initial !== undefined)
    const refreshAndRemember = refresh.pipe(
      Effect.tap((facts) => Ref.set(previous, facts)),
      Effect.tap(() => Ref.set(preflightAvailable, false)),
    )
    return {
      refresh: refreshAndRemember,
      read: Effect.gen(function* () {
        const cached = yield* Ref.get(previous)
        const firstUse = yield* Ref.getAndSet(preflightAvailable, false)
        const now = yield* Clock.currentTimeMillis
        const authority = yield* readAuthority
        if (
          cached !== undefined &&
          firstUse &&
          cached.riskContext.authority?.generationHash === authority.generationHash &&
          cached.riskContext.authority.version === authority.version
        )
          return cached
        if (cached !== undefined && now < (reconciliationReusableUntil(cached, authority, now, maximumAgeMs) ?? now))
          return cached
        return yield* refreshAndRemember
      }),
      readForPricing: (minimumRemainingMs: number) =>
        Effect.gen(function* () {
          // Unlike the ordinary first use, pricing must prove prospective coverage even for preflight facts.
          yield* Ref.set(preflightAvailable, false)
          const cached = yield* Ref.get(previous)
          const authority = yield* readAuthority
          const now = yield* Clock.currentTimeMillis
          const freshUntil =
            cached === undefined ? undefined : reconciliationReusableUntil(cached, authority, now, maximumAgeMs)
          if (cached !== undefined && freshUntil !== undefined && now + minimumRemainingMs < freshUntil)
            return { reconciliation: cached, freshUntil }
          const reconciliation = yield* refreshAndRemember
          const refreshedAuthority = yield* readAuthority
          const refreshedAt = yield* Clock.currentTimeMillis
          const refreshedUntil = reconciliationReusableUntil(
            reconciliation,
            refreshedAuthority,
            refreshedAt,
            maximumAgeMs,
          )
          return {
            reconciliation,
            freshUntil:
              refreshedUntil !== undefined && refreshedAt + minimumRemainingMs < refreshedUntil
                ? refreshedUntil
                : undefined,
          }
        }),
    }
  })

const verifyDecisionBindingEvidence = (
  marketData: IntradayMarketDataService | undefined,
  document: CycleDecisionDocument,
): Effect.Effect<CycleDecisionBindingEvidence, CycleDecisionBuildError> => {
  const binding = document.bindings.decisionMarketData ?? document.bindings.executionMarketData
  const rows = decisionSourceRows(document)
  if (binding === undefined || binding.schemaVersion === 'bayn.reconciled-position-liquidation-binding.v1')
    return Effect.succeed({})
  if (
    marketData === undefined ||
    document.mode === Authority.Observe ||
    rows === undefined ||
    (binding.schemaVersion !== 'bayn.execution-market-data-binding.v3' &&
      binding.schemaVersion !== 'bayn.execution-market-data-binding.v4')
  )
    return Effect.fail(
      new CycleDecisionBuildError({
        failure: 'contract',
        message: 'Decision requires canonical market data and persisted input rows',
      }),
    )
  const inputs = [{ binding, rows }]
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
          (reference) => reference.schemaVersion === 'bayn.simulated-snapshot-reference.v2',
        ),
        streamingSnapshotReferences: references.filter(
          (reference) => reference.schemaVersion === 'bayn.streaming-snapshot-reference.v1',
        ),
      }),
    ),
  )
}

const observeMutationPass = (
  startup: AutonomousCycleStartupInput,
  observation: CyclePassObservation,
): Effect.Effect<AutonomousCyclePassObservation> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return observePass(startup.recordPass, observation).pipe(
    Effect.tap(() => log.pipe(Effect.annotateLogs(facts.annotations))),
  )
}

const markMutationReconciliationCompleted = (
  cadence: Ref.Ref<MutationReconciliationCadenceState>,
  lastResult: ReconciliationPassResult,
): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos, lastResult })),
  )

export const runRestateAdvanceWithinTimeout = <A, E, R>(
  operationPermit: Semaphore.Semaphore,
  lifecycleAdvance: Effect.Effect<A, E, R>,
  timeoutMs: number,
  onTimeout: (error: CycleRunnerError) => Effect.Effect<A, E, R>,
  stage: 'bayn.execution.bounded-pass' | 'bayn.execution.generation-pass' = 'bayn.execution.bounded-pass',
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* operationCurrentTimeMillis
    const activeStages = (yield* ActiveExecutionStages) ?? new Map<symbol, ActiveExecutionStage>()
    let interruptionRequestedAt = startedAt
    return yield* operationPermit.withPermit(lifecycleAdvance).pipe(
      withObservedStage(stage, { slowAfterMs: null }),
      Effect.provideService(ActiveExecutionStages, activeStages),
      operationTimeoutOrElse({
        duration: Duration.millis(timeoutMs),
        onDeadline: operationCurrentTimeMillis.pipe(
          Effect.flatMap((requestedAt) => {
            interruptionRequestedAt = requestedAt
            return Effect.logWarning('Bayn execution pass interruption requested').pipe(
              Effect.annotateLogs({
                service: 'bayn',
                stage,
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
                  stage,
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
  cadence: Ref.Ref<MutationReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ReconciliationRuntime>,
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

const isPendingBrokerReconciliation = (error: CycleRunnerError): boolean =>
  error.operation === 'reconcile' &&
  error.cause instanceof OperationalError &&
  error.cause.operation === 'reconciliation' &&
  error.cause.cause instanceof BrokerReadError &&
  error.cause.cause.kind === BrokerReadErrorKind.ObservationPending

const reconcileMutationBeforeExternallyDrivenAdvance = (
  input: ObserveAutonomousCycleInput,
  maximumAgeMs: number,
  cadence: Ref.Ref<MutationReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ReconciliationRuntime>,
): Effect.Effect<ReconciliationPassResult | undefined, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
    if (
      decision._tag === 'RECONCILE' ||
      (state.lastFailure !== undefined && isPendingBrokerReconciliation(state.lastFailure))
    )
      return yield* attemptMutationIdleReconciliation(cadence, reconcile)
    else if (state.lastFailure !== undefined) return yield* state.lastFailure
    const previous = state.lastResult
    if (previous === undefined) return undefined
    const store = yield* AuthorityGenerationStore
    const authority = yield* store.readAuthorityState.pipe(Effect.mapError(reconciliationRunnerError))
    const now = yield* Clock.currentTimeMillis
    return canReuseSourceWaitReconciliation(
      previous,
      authority,
      now,
      Math.min(maximumAgeMs, input.reconciliationIntervalMs),
    )
      ? previous
      : undefined
  })

const observeMutationCycleResult = (
  startup: AutonomousCycleStartupInput,
  cadence: Ref.Ref<MutationReconciliationCadenceState>,
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
  readonly reconciliationIntervalMs: number
  readonly postMutationDelayMs?: number
}): number => {
  const cadence = input.reconciliationIntervalMs
  return input.postMutationDelayMs === undefined
    ? cadence
    : Math.min(cadence, Math.max(mutationConsistencyDelayMs, input.postMutationDelayMs))
}

/** Protection reconciliation remains bounded even when its source stops publishing. */
export const executionEvidenceContinuationDelayMs = (
  result: CycleRunResult,
  normalDelayMs: number,
  observedAt: string,
): number | undefined => {
  if (
    result.outcome !== 'RECOVERED' ||
    result.action !== 'WAITING' ||
    (result.waitReason !== 'CLOSE_QUOTE_PENDING' &&
      result.waitReason !== 'JEV_POSITION_AWAITING_RECONCILIATION' &&
      result.waitReason !== 'PROTECTION_PUBLICATION_PENDING')
  )
    return undefined
  const remainingMs = Date.parse(result.cycle.window.executionCloseAt) - Date.parse(observedAt)
  return remainingMs > 0 ? Math.min(positionProtectionIntervalMs, normalDelayMs, remainingMs) : undefined
}

/** The expired attempt has ended; the next pass must revalidate a distinct attempt before the unchanged cutoff. */
export const unusedEntryHandoffDelayMs = (
  result: CycleRunResult,
  normalDelayMs: number,
  observedAt: string,
): number | undefined => {
  if (
    result.outcome !== 'RECOVERED' ||
    result.action !== 'BLOCKED' ||
    result.cycle.state !== CycleState.Blocked ||
    result.cycle.terminalReason !== CycleTerminalReason.UnusedEntryExpired ||
    result.cycle.bindings.snapshotId !== undefined ||
    result.cycle.bindings.decisionHash !== undefined
  )
    return undefined
  const now = Date.parse(observedAt)
  return now >= unusedEntryExpiresAt(result.cycle) && now < Date.parse(result.cycle.window.submissionCutoffAt)
    ? Math.min(1, normalDelayMs)
    : undefined
}

/** A known eligibility boundary is a timer; missing source evidence waits for its stream. */
export const decisionReadinessContinuationDelayMs = (
  result: CycleRunResult,
  normalDelayMs: number,
  observedAt: string,
): number | undefined => {
  if (result.outcome !== 'RECOVERED' || result.action !== 'WAITING' || result.readiness === undefined) return undefined
  if (
    result.readiness.reason === DecisionReadinessReason.InferenceExpired ||
    result.readiness.reason === DecisionReadinessReason.ExecutionRiskExpired
  ) {
    const now = Date.parse(observedAt)
    const cycle = result.cycle
    const expiresAt = unusedEntryExpiresAt(cycle)
    return cycle.state === CycleState.Active &&
      cycle.bindings.snapshotId === undefined &&
      cycle.bindings.decisionHash === undefined &&
      now >= Math.max(Date.parse(cycle.createdAt), Date.parse(cycle.window.submissionOpenAt)) &&
      now < expiresAt
      ? 1
      : undefined
  }
  const sourceWindow =
    result.readiness.reason === DecisionReadinessReason.SnapshotUnavailable ||
    result.readiness.reason === DecisionReadinessReason.SnapshotStale
  if (
    (result.readiness.reason !== DecisionReadinessReason.LookbackWarmup &&
      result.readiness.reason !== DecisionReadinessReason.SignalWindowObserved &&
      result.readiness.reason !== DecisionReadinessReason.DecisionPending &&
      result.readiness.reason !== DecisionReadinessReason.InferenceUnavailable &&
      !sourceWindow) ||
    result.readiness.availableAt === undefined
  )
    return undefined
  const availableAt = Date.parse(result.readiness.availableAt)
  const now = Date.parse(observedAt)
  const cycle = result.cycle
  if (
    sourceWindow &&
    (cycle.state !== CycleState.Active ||
      cycle.bindings.snapshotId !== undefined ||
      cycle.bindings.decisionHash !== undefined ||
      now < Math.max(Date.parse(cycle.createdAt), Date.parse(cycle.window.submissionOpenAt)) ||
      availableAt >= unusedEntryExpiresAt(cycle))
  )
    return undefined
  const remainingMs = availableAt - now
  return Number.isSafeInteger(remainingMs) &&
    remainingMs > 0 &&
    remainingMs < normalDelayMs &&
    availableAt < Date.parse(result.cycle.window.submissionCutoffAt)
    ? remainingMs
    : undefined
}

/** Price protection wakes independently of signal windows; the first-fill deadline still caps each wait. */
export const maximumHoldContinuationDelayMs = (
  result: CycleRunResult,
  normalDelayMs: number,
  observedAt: string,
): number | undefined => {
  if (result.outcome !== 'RECOVERED' || result.action !== 'WAITING' || result.maximumHoldDueAt === undefined)
    return undefined
  const dueAt = Date.parse(result.maximumHoldDueAt)
  const remainingMs = dueAt - Date.parse(observedAt)
  const closeRemainingMs = Date.parse(result.cycle.window.executionCloseAt) - Date.parse(observedAt)
  if (!Number.isSafeInteger(remainingMs) || !Number.isSafeInteger(closeRemainingMs) || closeRemainingMs <= 0)
    return undefined
  if (remainingMs > 0) return Math.min(remainingMs, closeRemainingMs, normalDelayMs, positionProtectionIntervalMs)
  // Slow management work may cross a deadline that was still future when evaluated. Recheck once; the next
  // fresh management pass takes the maximum-hold exit path and cannot emit this pre-eligibility wait again.
  const evaluatedAt = Date.parse(result.maximumHoldEvaluatedAt ?? '')
  return evaluatedAt < dueAt && evaluatedAt <= Date.parse(observedAt) ? 1 : undefined
}

export enum ExecutionDeadlineReason {
  Eligibility = 'Eligibility',
  Expiry = 'Expiry',
  Protection = 'Protection',
  Close = 'Close',
  FinancialFreshness = 'FinancialFreshness',
  Recovery = 'Recovery',
  UnknownMutation = 'UnknownMutation',
  StateTransition = 'StateTransition',
}

export interface ExecutionAdvanceDeadline {
  readonly at: string
  readonly reason: ExecutionDeadlineReason
}

/** Stream events discover new work. Timers only discharge a previously established obligation. */
export const executionAdvanceDeadline = (
  advanced: RecoveryFirstCycleAdvance,
  observedAt: string,
  policy: {
    readonly recoveryDelayMs: number
    readonly financialFreshnessMs: number
    readonly sessionCloseStartLeadMs: number
  },
): ExecutionAdvanceDeadline | undefined => {
  const now = Date.parse(observedAt)
  const deadlines: { readonly at: number; readonly reason: ExecutionDeadlineReason }[] = []
  const add = (at: number, reason: ExecutionDeadlineReason) => {
    if (Number.isSafeInteger(at)) deadlines.push({ at: Math.max(now + 1, at), reason })
  }
  const after = (delay: number, reason: ExecutionDeadlineReason) => add(now + Math.max(1, delay), reason)
  if (!Number.isSafeInteger(now)) return undefined
  if (advanced.nextWakeAt !== undefined) add(Date.parse(advanced.nextWakeAt), ExecutionDeadlineReason.Recovery)
  if (advanced.observation.result === 'FAILURE') {
    after(advanced.nextDelayMs ?? policy.recoveryDelayMs, ExecutionDeadlineReason.Recovery)
  } else if (advanced.result === undefined) {
    if (advanced.observation.waitReason === 'BROKER_OBSERVATION_PENDING')
      after(policy.financialFreshnessMs, ExecutionDeadlineReason.FinancialFreshness)
  } else {
    const result = advanced.result
    if (result.outcome === 'WINDOW_CLOSED' && result.closedEntryWindow !== undefined) {
      const evidence = result.closedEntryWindow
      const session = selectIntradayExecutionSession(evidence.calendar, evidence.executionPolicy, observedAt)
      if (session !== undefined) {
        const eligibleAt = firstIntradayObservationAtMs(session, evidence.executionPolicy)
        if (eligibleAt > now) add(eligibleAt, ExecutionDeadlineReason.Eligibility)
      }
    } else if (result.outcome === 'ADMISSION_WAITING') {
      const validUntil = Date.parse(result.admissionProtection.validUntil)
      add(validUntil > now ? validUntil : now + policy.financialFreshnessMs, ExecutionDeadlineReason.FinancialFreshness)
    } else if (result.outcome === 'ACQUIRED' || result.outcome === 'REACQUIRED') {
      after(1, ExecutionDeadlineReason.StateTransition)
    } else if (result.outcome === 'RECOVERED') {
      const handoff = unusedEntryHandoffDelayMs(result, Number.MAX_SAFE_INTEGER, observedAt)
      if (handoff !== undefined) after(handoff, ExecutionDeadlineReason.StateTransition)
      if (result.action === 'ACTIVATED' || result.action === 'BOUND_DECISION')
        after(1, ExecutionDeadlineReason.StateTransition)
      if (result.action === 'WAITING') {
        const cycle = result.cycle
        const closeAt = Date.parse(cycle.window.executionCloseAt)
        const bound = cycle.bindings.snapshotId !== undefined || cycle.bindings.decisionHash !== undefined
        if (!bound && cycle.state === CycleState.Active)
          add(unusedEntryExpiresAt(cycle), ExecutionDeadlineReason.Expiry)
        const eligibility = decisionReadinessContinuationDelayMs(result, Number.MAX_SAFE_INTEGER, observedAt)
        if (eligibility !== undefined) after(eligibility, ExecutionDeadlineReason.Eligibility)
        const hold = maximumHoldContinuationDelayMs(result, Number.MAX_SAFE_INTEGER, observedAt)
        if (hold !== undefined) after(hold, ExecutionDeadlineReason.Protection)
        const protection = executionEvidenceContinuationDelayMs(result, Number.MAX_SAFE_INTEGER, observedAt)
        if (protection !== undefined) after(protection, ExecutionDeadlineReason.Protection)
        if (bound) {
          const closeStartAt =
            closeAt -
            (cycle.window.executionCalendarSchemaVersion === 'bayn.continuous-market-hours.v1'
              ? continuousExecutionPolicy.closeRecoveryMs
              : policy.sessionCloseStartLeadMs)
          if (closeStartAt > now) add(closeStartAt, ExecutionDeadlineReason.Close)
          if (closeAt > now) add(closeAt, ExecutionDeadlineReason.Close)
        }
        const reason = result.waitReason
        if (reason === 'AWAITING_SUBMISSION_OPEN')
          add(Date.parse(cycle.window.submissionOpenAt), ExecutionDeadlineReason.Eligibility)
        if (reason === 'BROKER_OBSERVATION_PENDING')
          after(policy.financialFreshnessMs, ExecutionDeadlineReason.FinancialFreshness)
        if (
          reason === 'JEV_POSITION_HELD' ||
          reason === 'JEV_POSITION_AWAITING_RECONCILIATION' ||
          reason === 'open-position' ||
          reason === 'CLOSE_QUOTE_PENDING' ||
          reason === 'CLOSE_MARKET_DATA_UNAVAILABLE' ||
          (reason !== undefined && reason.startsWith('PROTECTION_'))
        )
          after(positionProtectionIntervalMs, ExecutionDeadlineReason.Protection)
        if (reason === 'POST_MUTATION_RECONCILIATION')
          after(advanced.nextDelayMs ?? mutationConsistencyDelayMs, ExecutionDeadlineReason.FinancialFreshness)
        if (
          reason === 'MUTATION_RECOVERY_BACKOFF' ||
          reason === 'MUTATION_EVIDENCE_PENDING' ||
          reason === 'COMPLETION_EVIDENCE_PENDING' ||
          reason === 'unknown-mutation' ||
          reason === 'unknown-order' ||
          reason === 'intent-unsuccessful' ||
          reason === 'intent-nonterminal'
        )
          after(advanced.nextDelayMs ?? policy.recoveryDelayMs, ExecutionDeadlineReason.UnknownMutation)
        if (
          reason === 'CLOSE_STORE_UNAVAILABLE' ||
          reason === 'CLOSE_RECONCILIATION_PENDING' ||
          reason === 'MUTATION_NOT_ADVANCED' ||
          reason === 'accounting-inexact' ||
          reason === 'reconciliation-not-later' ||
          reason === 'reconciliation-not-exact'
        )
          after(advanced.nextDelayMs ?? policy.recoveryDelayMs, ExecutionDeadlineReason.Recovery)
      }
    }
  }
  const selected = deadlines.reduce<(typeof deadlines)[number] | undefined>(
    (earliest, candidate) => (earliest === undefined || candidate.at < earliest.at ? candidate : earliest),
    undefined,
  )
  return selected === undefined ? undefined : { at: new Date(selected.at).toISOString(), reason: selected.reason }
}

/** Projection health is checked after the pass; a later failure owns its continuation timing. */
export const checkAdvancedMarketProjection = <R>(
  advanced: RecoveryFirstCycleAdvance,
  check: IntradayMarketDataService['check'],
  observeFailure: (cause: CycleRunnerError) => Effect.Effect<RecoveryFirstCycleAdvance, CycleRunnerError, R>,
): Effect.Effect<RecoveryFirstCycleAdvance, CycleRunnerError, R> =>
  check.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        observeFailure(
          new CycleRunnerError({
            operation: 'build-decision',
            failure: 'market-data',
            message: 'Execution worker market projection is unavailable',
            cause,
          }),
        ).pipe(
          Effect.map((failed) => {
            const { nextDelayMs: _nextDelayMs, nextWakeAt: _nextWakeAt, ...completed } = advanced
            return { ...completed, ...failed }
          }),
        ),
      onSuccess: () => Effect.succeed(advanced),
    }),
  )

const makeRecoveryFirstCycleDriverEffect = (
  input: ObserveAutonomousCycleInput,
  startup: AutonomousCycleStartupInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: ExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
): Effect.Effect<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const cadence = yield* Ref.make<MutationReconciliationCadenceState>({})
    // A local continuation hint, not evidence or mutation authority. Restarting loses only acceleration.
    const postExitCloseAt = yield* Ref.make<string | undefined>(undefined)
    // This hint only accelerates lookup-only confirmation. A restart retains normal durable recovery.
    const cancellationContinuation = yield* Ref.make<PostMutationReconciliation | undefined>(undefined)
    // The generation deadline can interrupt reconciliation before its own timeout is reported.
    // Clear this marker before entering any cycle work; only the serialized preflight may retry without restriction.
    const preflightOnly = yield* Ref.make(false)
    const operationPermit = yield* Semaphore.make(1)
    const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
    const nextDelayMs = recoveryFirstCycleNextDelayMs(input)
    const reconcile = boundedReconciliationPass(input.reconciliationPassTimeoutMs).pipe(
      Effect.tap((result) =>
        capability._tag === 'RecoveryOnly' ? Effect.void : capability.executionProgram.recordReconciliation(result),
      ),
      Effect.tap((result) => markMutationReconciliationCompleted(cadence, result)),
      Effect.tap(() => Ref.set(postExitCloseAt, undefined)),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && capability._tag !== 'RecoveryOnly'
          ? capability.executionProgram.invalidateBrokerState
          : Effect.void,
      ),
    )
    const observeReconciliationFailure = (error: CycleRunnerError) => {
      if (isPendingBrokerReconciliation(error))
        return currentUtcInstant.pipe(
          Effect.flatMap((observedAt) =>
            observeMutationPass(startup, { outcome: 'WAITING', observedAt, waitReason: 'BROKER_OBSERVATION_PENDING' }),
          ),
          Effect.map((observation) => ({
            observation,
            nextDelayMs: Math.min(mutationConsistencyDelayMs, nextDelayMs),
          })),
        )
      return Effect.gen(function* () {
        const observedAt = yield* currentUtcInstant
        const closeAt = yield* Ref.get(postExitCloseAt)
        const remaining = closeAt === undefined ? 0 : Date.parse(closeAt) - Date.parse(observedAt)
        const missingPostExitCut =
          remaining > 0 &&
          error.operation === 'reconcile' &&
          error.cause instanceof OperationalError &&
          error.cause.operation === 'reconciliation' &&
          error.cause.cause instanceof BrokerReadError &&
          error.cause.cause.operation === 'preflight' &&
          error.cause.cause.kind === BrokerReadErrorKind.Timeout &&
          error.cause.cause.observationFailure === 'NO_ADMISSIBLE_CUT'
        if (missingPostExitCut) yield* Ref.set(cadence, {})
        else yield* Ref.set(postExitCloseAt, undefined)
        const observation = yield* observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })
        return {
          observation,
          ...(missingPostExitCut ? { nextDelayMs: Math.min(mutationConsistencyDelayMs, nextDelayMs, remaining) } : {}),
        }
      })
    }
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
        Effect.andThen(observeReconciliationFailure(error)),
      )
    const observeTimeout = (error: CycleRunnerError) =>
      Ref.get(preflightOnly).pipe(
        Effect.flatMap((preflight) =>
          preflight
            ? Ref.set(cadence, {}).pipe(
                Effect.andThen(
                  observeReconciliationFailure(
                    reconciliationRunnerError(
                      new ReconciliationPassTimeoutError({
                        timeoutMs: cyclePassTimeoutMs,
                        message: `broker reconciliation preflight interrupted: ${error.message}`,
                      }),
                    ),
                  ),
                ),
              )
            : observeCycleFailure(error),
        ),
      )
    const completeCycleAdvance = (result: RecoveryFirstCyclePassResult) =>
      Effect.gen(function* () {
        if (isPostMutationReconciliation(result)) {
          yield* Ref.set(
            cancellationContinuation,
            result.cancellationConfirmationIntentId !== undefined ? result : undefined,
          )
          // The broker mutation is already durably journaled. Do not hold this Restate command open while waiting for
          // broker consistency. Reset the in-process cadence so the next command performs a reconciliation preflight;
          // after a process restart cadence also starts empty and therefore reconciles. Restate persists the shorter
          // one-shot due time in controller state, so the continuation survives worker replacement without duplicating I/O.
          yield* Ref.set(cadence, {})
          yield* Ref.set(
            postExitCloseAt,
            result.logContext.mutationPhase === 'CLOSE' ? result.cycle.window.executionCloseAt : undefined,
          )
          return {
            result: deferPostMutationReconciliation(result),
            nextDelayMs: recoveryFirstCycleNextDelayMs({ ...input, postMutationDelayMs: result.delayMs }),
          }
        }
        return { result }
      }).pipe(
        Effect.flatMap(({ result, nextDelayMs }) =>
          observeMutationCycleResult(startup, cadence, result).pipe(
            Effect.map((observation) => ({
              observation,
              result,
              ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
            })),
          ),
        ),
      )
    const advanceCycle = (
      preflight: ReconciliationPassResult | undefined,
      unfinished?: { readonly cycle: AutonomousCycle | undefined },
    ) =>
      Effect.gen(function* () {
        const authorityStore = yield* AuthorityGenerationStore
        const {
          read: reconcileForAdvance,
          refresh: refreshForAdvance,
          readForPricing,
        } = yield* reconciliationForPreparation(
          preflight,
          reconcile,
          authorityStore.readAuthorityState,
          policy.maxBrokerStateAgeMs,
        )
        const context: CycleRunContext<ObserveDecisionRuntime> = {
          cycleBindingId: startup.cycleBindingId,
          strategyName: 'jev',
          strategyProtocolHash: preparation.strategyProtocolHash,
          accountId: input.accountId,
          authorityGenerationHash: input.authorityGenerationHash,
          executionPolicy: preparation.executionPolicy,
          buildDecision: (cycle) => buildDecision(cycle, reconcileForAdvance, readForPricing),
          buildDecisionEvidence: (document) => verifyDecisionBindingEvidence(input.intradayMarketData, document),
        }
        const result = yield* runMutationPassWithinTimeout(
          runRecoveryFirstCyclePass(
            input,
            policy,
            context,
            { read: reconcileForAdvance, refresh: refreshForAdvance },
            capability,
            preflight,
            unfinished,
          ),
          cyclePassTimeoutMs,
        )
        return result
      }).pipe(Effect.matchEffect({ onFailure: observeCycleFailure, onSuccess: completeCycleAdvance }))
    const reconciliationPreflight = reconcileMutationBeforeExternallyDrivenAdvance(
      input,
      policy.maxBrokerStateAgeMs,
      cadence,
      reconcile,
    )
    const reconcileAndAdvance = (unfinished?: { readonly cycle: AutonomousCycle | undefined }) =>
      Ref.set(preflightOnly, true).pipe(
        Effect.andThen(reconciliationPreflight),
        Effect.matchEffect({
          onFailure: observeReconciliationFailure,
          onSuccess: (preflight) =>
            Ref.set(preflightOnly, false).pipe(
              Effect.andThen(advanceCycle(preflight, unfinished)),
              Effect.flatMap((advanced) =>
                capability._tag !== 'Mutation' ||
                input.intradayMarketData === undefined ||
                advanced.observation.result === 'FAILURE'
                  ? Effect.succeed(advanced)
                  : checkAdvancedMarketProjection(advanced, input.intradayMarketData.check, observeCycleFailure),
              ),
            ),
        }),
      )
    const runCycleAdvance = Effect.gen(function* () {
      // Confirmation can persist recovery evidence, so its failures keep the cycle-phase restriction policy.
      yield* Ref.set(preflightOnly, false)
      const pending = yield* Ref.getAndSet(cancellationContinuation, undefined)
      if (pending?.cancellationConfirmationIntentId !== undefined) {
        const confirmation = yield* confirmAcceptedCancellation(pending.cancellationConfirmationIntentId, {
          recover: capability._tag === 'RecoveryOnly' ? recoverMutation : capability.executionProgram.recover,
        }).pipe(Effect.result)
        if (Result.isFailure(confirmation)) return yield* observeCycleFailure(confirmation.failure)
        if (confirmation.success.delayMs > 0) {
          yield* Ref.set(cancellationContinuation, pending)
          const result = deferPostMutationReconciliation(pending)
          const observation = yield* observeMutationPass(startup, {
            outcome: 'SUCCEEDED',
            observedAt: yield* currentUtcInstant,
            result,
          })
          return { observation, result, nextDelayMs: Math.min(nextDelayMs, confirmation.success.delayMs) }
        }
        // Confirmation never replaces fresh, post-recovery reconciliation or grants submission authority.
        yield* Ref.set(cadence, {})
      }
      const lookup =
        capability._tag === 'RecoveryOnly'
          ? Result.succeed(undefined)
          : yield* readUnfinishedMutationCycle({
              cycleBindingId: startup.cycleBindingId,
              accountId: input.accountId,
            }).pipe(Effect.result)
      if (Result.isFailure(lookup)) return yield* observeCycleFailure(lookup.failure)
      const unfinished = capability._tag === 'RecoveryOnly' ? undefined : { cycle: lookup.success }
      const containment = yield* recoverExpiredEntryBeforeReconciliation(
        input,
        unfinished?.cycle,
        policy,
        capability,
      ).pipe(Effect.result)
      if (Result.isFailure(containment)) return yield* observeCycleFailure(containment.failure)
      if (containment.success !== undefined) return yield* completeCycleAdvance(containment.success)
      return yield* reconcileAndAdvance(unfinished)
    }).pipe(Effect.map((advanced): RecoveryFirstCycleAdvance => advanced))
    const selectDeadline = (advanced: RecoveryFirstCycleAdvance) =>
      currentUtcInstant.pipe(
        Effect.map((observedAt) => {
          const deadline = executionAdvanceDeadline(advanced, observedAt, {
            recoveryDelayMs: input.reconciliationIntervalMs,
            financialFreshnessMs: input.reconciliationIntervalMs,
            sessionCloseStartLeadMs: strategyTradingProtocol(input.strategy).flattenBeforeCloseMinutes * 60_000,
          })
          if (deadline === undefined) return advanced
          return {
            ...advanced,
            nextDelayMs: Math.max(1, Date.parse(deadline.at) - Date.parse(observedAt)),
            nextWakeAt: deadline.at,
          }
        }),
      )
    const advance = runRestateAdvanceWithinTimeout(
      operationPermit,
      runCycleAdvance.pipe(
        Effect.tap((advanced) => {
          const result = 'result' in advanced ? advanced.result : undefined
          // Only an unbound source wait may reuse a flat, exact preflight after its next stream event.
          // Every mutation, terminal/bound cycle, failure or other recovery path discards it.
          if (
            advanced.observation.result !== 'FAILURE' &&
            result?.outcome === 'RECOVERED' &&
            result.action === 'WAITING' &&
            result.readiness !== undefined &&
            [
              DecisionReadinessReason.SnapshotUnavailable,
              DecisionReadinessReason.SnapshotCoverage,
              DecisionReadinessReason.SnapshotStale,
              DecisionReadinessReason.ArchiveWatermark,
              DecisionReadinessReason.LookbackWarmup,
              DecisionReadinessReason.SignalWindowObserved,
            ].includes(result.readiness.reason) &&
            result.cycle.state === CycleState.Active &&
            result.cycle.bindings.snapshotId === undefined &&
            result.cycle.bindings.decisionHash === undefined
          )
            return Effect.void
          return Ref.update(cadence, ({ lastResult: _lastResult, ...state }) => state)
        }),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(cadence, {}) : Effect.void)),
        withObservedStage('bayn.execution.cycle-pass'),
      ),
      cyclePassTimeoutMs,
      observeTimeout,
    ).pipe(Effect.flatMap(selectDeadline))
    return {
      advance,
      timeoutMs: cyclePassTimeoutMs,
      onTimeout: (error) => observeTimeout(error).pipe(Effect.flatMap(selectDeadline)),
      nextDelayMs,
    }
  })

export const makeRecoveryFirstCycleDriver = (
  input: ObserveAutonomousCycleInput,
  startup: AutonomousCycleStartupInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: ExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
  operation: 'autonomous cycle loop' | 'mutation autonomous cycle loop',
): Result.Result<Effect.Effect<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime>, OperationalError> => {
  const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
  return Result.mapError(
    validateReconciliationInterval(input.reconciliationIntervalMs).pipe(
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
  (cycle, reconcile, reconcileForPricing) =>
    buildObserveCycleDecision({
      authorityGenerationHash: input.authorityGenerationHash,
      cycle,
      executionModel: preparation.executionModel,
      policy,
      reconcile,
      ...(reconcileForPricing === undefined ? {} : { reconcileForPricing }),
      strategy: input.strategy,
      decisionFinalizationHeadroomMs: executionDecisionFinalizationHeadroomMs(input),
      ...(input.intradayMarketData === undefined ? {} : { intradayMarketData: input.intradayMarketData }),
    }).pipe(Effect.mapError(decisionBuildError))

export const mutationDecisionBuilder =
  (
    input: ObserveAutonomousCycleInput,
    preparation: ObserveStartupPreparation,
    policy: Policy,
    buildDecision: typeof buildMutationShadowCycleDecision,
  ): RecoveryFirstDecisionBuilder =>
  (cycle, reconcile, reconcileForPricing) =>
    buildDecision({
      ...mutationDecisionInput(input, preparation, policy, cycle, reconcile),
      ...(reconcileForPricing === undefined ? {} : { reconcileForPricing }),
    }).pipe(Effect.mapError(decisionBuildError))
