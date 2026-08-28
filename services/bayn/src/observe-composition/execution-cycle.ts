import { Effect, Option, Result } from 'effect'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../cycle'
import { CycleRunnerError, runAutonomousCyclePass, type CycleRunContext, type CycleRunResult } from '../cycle/runner'
import { CycleStore } from '../cycle/store'
import {
  makeExecutionCycleClosure,
  type ExecutionCycleClosure,
  type ExecutionCycleClosureStoreShape,
} from '../db/execution-cycle-closure'
import { AuthorityRestrictionStore } from '../db/execution-store'
import { WriterFence } from '../execution/writer-fence'
import { MutationOperation } from '../broker/alpaca-mutations'
import { recover as recoverMutation } from '../execution/coordinator'
import { BrokerAccess } from '../execution/authority'
import { IntentStore, type BlockedCycleIntentStoreShape } from '../execution/intents'
import { MutationStore } from '../execution/mutations'
import { OperationalError, operationalError } from '../errors'
import {
  decideExecutionMandateCycleTerminalization,
  executionCycleRestrictionSubject,
  executionMandateFailureRestrictionPrefix,
} from '../execution/mandate'
import { legacyCycleClosureSchemaVersion } from '../execution/legacy-wire'
import { IntentState, OrderStatus, ReconciliationStatus } from '../execution/contracts'
import { type ReconciliationPassResult } from '../reconciler'
import { type Policy } from '../risk'
import type { CycleDecisionDocument, ExecutionDecisionDocument } from '../shadow-decision-contract'
import { currentUtcInstant } from '../time'
import { TargetPlanStatus } from '../target-planner'
import { decodeIntradayMomentumProtocol, decodeOpeningDriveProtocol, strategyDefinition } from '../strategy'
import { isQuoteBoundExecutionModel } from '../execution-model-contract'
import {
  countOpenPositions,
  decideExecutionIntentTerminalDisposition,
  mutationIntentReconciliationDelayMs,
  executionClosePlanNeedsResidualReplan,
  type BoundMutationCycleOutcome,
  type PreparedMutationCycleStep,
} from './mutation-decisions'
import {
  executeMutationIntent,
  executeMutationIntentWithExecutor,
  mutationRunnerError,
  restrictMutationAuthority,
} from './mutation-interpreter'
import {
  prepareMutationIntent,
  type MutationPreparationFacts,
  type MutationPreparationFactsRequest,
} from './mutation-intent-interpreter'
import type {
  BoundExecutionCycleOutcome,
  ExecutionCapability,
  ExecutionMutationLogContext,
  MutationAutonomousCycleInput,
  ObserveAutonomousCycleInput,
  ObserveDecisionRuntime,
  ObserveStartupPreparation,
  PostMutationReconciliation,
  RecoveryFirstCyclePassResult,
  RecoveryFirstRuntime,
} from './model'
import { executionDecisionFinalizationHeadroomMs } from './model'
import {
  buildClosingExecutionCycleDecision,
  decisionBuildError,
  prepareObserveDecisionReads,
  readObserveDecisionFacts,
  requireMutationAuthorityGeneration,
  type ObserveDecisionInput,
  type ReconciliationPassError,
} from './decision-builder'
import { resolveExecutionCycleCloseWindow, type ExecutionCycleCloseWindow } from './execution-window'
import { strategyAllowsMutationCadence } from './strategy-cadence'

export const isPostMutationReconciliation = (
  result: RecoveryFirstCyclePassResult,
): result is PostMutationReconciliation => '_tag' in result && result._tag === 'PostMutationReconciliation'

export const executionMutationSubmissionAllowed = (input: {
  readonly capability: ExecutionCapability['_tag']
  readonly closeOnly: boolean
  readonly executionMandateCutoffAt?: string
  readonly executionMandateCloseSubmitCutoffAt?: string
  readonly observedAt: string
}): boolean =>
  input.capability === 'Mutation' &&
  (input.closeOnly
    ? input.executionMandateCloseSubmitCutoffAt === undefined ||
      input.observedAt < input.executionMandateCloseSubmitCutoffAt
    : input.executionMandateCutoffAt === undefined || input.observedAt < input.executionMandateCutoffAt)

const configuredMutationGeneration = (input: MutationAutonomousCycleInput): string | undefined => {
  return input.executionProgram.authority.capitalAuthority.authorityGenerationHash
}

export const validateMutationExecutionProgram = (
  input: MutationAutonomousCycleInput,
): Result.Result<void, OperationalError> => {
  const authority = input.executionProgram.authority
  const generationHash = configuredMutationGeneration(input)
  const strategy = input.strategy.provenance.strategy
  return authority.brokerAccess !== BrokerAccess.Mutation ||
    generationHash === undefined ||
    generationHash !== input.authorityGenerationHash ||
    authority.brokerIdentity.accountId !== input.accountId ||
    authority.strategy.name !== strategy.name ||
    authority.strategy.behaviorHash !== strategy.behaviorHash ||
    authority.strategy.parameterHash !== strategy.parameterHash ||
    authority.strategy.parameterSchemaVersion !== strategy.parameterSchemaVersion
    ? Result.fail(
        operationalError({
          component: 'config',
          operation: 'cycle-loop',
          message: 'mutation cycle execution program does not match its account, authority generation, and strategy',
        }),
      )
    : Result.succeed(undefined)
}

const readBoundMutationDocument = (
  cycle: AutonomousCycle,
): Effect.Effect<CycleDecisionDocument, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) => store.readDecisionDocument(cycle.identity.cycleId)),
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'durable mutation-cycle shadow plan read failed', cause, failure: 'store' }),
    ),
    Effect.flatMap((document) =>
      Option.match(document, {
        onNone: () =>
          Effect.fail(
            mutationRunnerError({
              message: 'decision-bound mutation cycle is missing its durable shadow plan',
              cause: undefined,
              failure: 'store',
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )

const readExecutionCycleClosure = (
  cycleId: string,
  store: ExecutionCycleClosureStoreShape,
): Effect.Effect<ExecutionCycleClosure | undefined, CycleRunnerError> =>
  store.read(cycleId).pipe(
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'durable execution close plan read failed', cause, failure: 'store' }),
    ),
    Effect.map(Option.getOrUndefined),
  )

const readLatestExecutionCycleCloseReplan = (
  cycleId: string,
  store: ExecutionCycleClosureStoreShape,
): Effect.Effect<ExecutionCycleClosure | undefined, CycleRunnerError> =>
  store.readLatestReplan(cycleId).pipe(
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'durable execution close replan read failed', cause, failure: 'store' }),
    ),
    Effect.map(Option.getOrUndefined),
  )

const closePlanNeedsResidualReplan = (
  document: ExecutionDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<boolean, CycleRunnerError, ObserveDecisionRuntime | IntentStore> =>
  Effect.gen(function* () {
    const intentStore = yield* IntentStore
    const records = yield* Effect.forEach(
      document.orderedIntentIds,
      (intentId) =>
        intentStore
          .read(intentId)
          .pipe(
            Effect.mapError((cause) =>
              mutationRunnerError({ message: 'execution close intent recovery read failed', cause, failure: 'store' }),
            ),
          ),
      { concurrency: 1 },
    )
    if (
      records.length === 0 ||
      records.some(Option.isNone) ||
      records.some((record) => Option.isSome(record) && record.value.intent.state !== IntentState.Terminal)
    ) {
      return false
    }
    const facts = yield* reconcile.pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({ message: 'execution residual close reconciliation failed', cause }),
      ),
    )
    return executionClosePlanNeedsResidualReplan(
      records
        .map((record) => (Option.isSome(record) ? record.value.intent : undefined))
        .filter((intent): intent is NonNullable<typeof intent> => intent !== undefined),
      countOpenPositions(facts.brokerState.positions),
    )
  })

export type ExecutionCycleCloseDocumentDecision =
  | { readonly _tag: 'Bind'; readonly document: ExecutionDecisionDocument }
  | { readonly _tag: 'Complete' }
  | { readonly _tag: 'Block' }

export const decideExecutionCycleCloseDocument = (
  document: ExecutionDecisionDocument,
): ExecutionCycleCloseDocumentDecision => {
  if (document.targetPlan.status === TargetPlanStatus.NoTrade) return { _tag: 'Complete' }
  if (!document.dispatchable || document.targetPlan.status !== TargetPlanStatus.Planned) return { _tag: 'Block' }
  return { _tag: 'Bind', document }
}

const terminalOrderStatuses = new Set<OrderStatus>([
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Rejected,
])

export const isExecutionCycleReconciledFlat = (facts: {
  readonly report: {
    readonly reconciliation: { readonly status: ReconciliationStatus }
    readonly metrics: { readonly accountingExact: boolean }
  }
  readonly brokerState: {
    readonly positions: readonly { readonly quantityMicros: string }[]
    readonly orders: readonly { readonly status: OrderStatus }[]
    readonly unknownOrderCount: number
  }
  readonly riskContext: { readonly unknownMutationCount: number }
}): boolean =>
  facts.report.reconciliation.status === ReconciliationStatus.Exact &&
  facts.report.metrics.accountingExact &&
  facts.riskContext.unknownMutationCount === 0 &&
  facts.brokerState.unknownOrderCount === 0 &&
  countOpenPositions(facts.brokerState.positions) === 0 &&
  facts.brokerState.orders.every(({ status }) => terminalOrderStatuses.has(status))

export const decideReconciledExecutionCycleCompletion = (
  facts: ReconciliationPassResult,
): { readonly _tag: 'Complete'; readonly observedAt: string } | undefined =>
  isExecutionCycleReconciledFlat(facts)
    ? { _tag: 'Complete', observedAt: facts.report.reconciliation.reconciledAt }
    : undefined

export const decideReconciledExecutionCycleTerminalization = (
  facts: ReconciliationPassResult,
  entryHasUnsuccessfulIntent: boolean,
):
  | { readonly _tag: 'Complete'; readonly observedAt: string }
  | { readonly _tag: 'Block'; readonly reason: CycleTerminalReason.Risk; readonly observedAt: string }
  | undefined => {
  const completion = decideReconciledExecutionCycleCompletion(facts)
  if (completion === undefined || !entryHasUnsuccessfulIntent) return completion
  return { _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt: completion.observedAt }
}

const entryExecutionCycleHasUnsuccessfulIntent = (
  document: ExecutionDecisionDocument,
  orders: ReconciliationPassResult['brokerState']['orders'],
): Effect.Effect<boolean, CycleRunnerError, IntentStore | MutationStore> =>
  Effect.gen(function* () {
    const intentStore = yield* IntentStore
    const mutationStore = yield* MutationStore
    const records = yield* Effect.forEach(
      document.orderedIntentIds,
      (intentId) =>
        Effect.all({
          intent: intentStore.read(intentId),
          latestSubmit: mutationStore.latest(intentId, MutationOperation.Submit),
        }).pipe(
          Effect.mapError((cause) =>
            mutationRunnerError({ message: 'entry execution terminal evidence read failed', cause, failure: 'store' }),
          ),
        ),
      { concurrency: 1 },
    )
    return records.some(({ intent: maybeIntent, latestSubmit }) => {
      const record = Option.getOrUndefined(maybeIntent)
      return (
        record !== undefined &&
        decideExecutionIntentTerminalDisposition({
          phase: 'ENTRY',
          intent: record.intent,
          ...(latestSubmit?.brokerOrderId === undefined ? {} : { acceptedBrokerOrderId: latestSubmit.brokerOrderId }),
          orders,
        }) === 'UNSUCCESSFUL'
      )
    })
  })

type ExecutionCycleClosureResult =
  | { readonly _tag: 'Close'; readonly document: ExecutionDecisionDocument }
  | Extract<PreparedMutationCycleStep, { readonly _tag: 'Block' | 'Complete' | 'Wait' }>

const ensureExecutionCycleClosure = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  entryDocument: ExecutionDecisionDocument,
  closeWindow: ExecutionCycleCloseWindow | undefined,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<ExecutionCycleClosureResult, CycleRunnerError, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const store = input.executionCycleClosureStore
    const observedAt = yield* currentUtcInstant
    if (closeWindow === undefined || store === undefined || observedAt < closeWindow.startAt) {
      return { _tag: 'Wait', observedAt } as const
    }
    const existing = yield* readExecutionCycleClosure(cycle.identity.cycleId, store)
    const entryDecisionHash = cycle.bindings.decisionHash
    if (entryDecisionHash === undefined) {
      return yield* mutationRunnerError({
        message: 'active execution cycle has no immutable entry decision hash for its close plan',
        cause: undefined,
        failure: 'contract',
      })
    }
    if (existing === undefined) {
      const closeReconciliation = yield* reconcile.pipe(
        Effect.mapError((cause) => mutationRunnerError({ message: 'execution close reconciliation failed', cause })),
      )
      const completion = decideReconciledExecutionCycleCompletion(closeReconciliation)
      if (completion !== undefined) {
        const terminalization = decideReconciledExecutionCycleTerminalization(
          closeReconciliation,
          yield* entryExecutionCycleHasUnsuccessfulIntent(entryDocument, closeReconciliation.brokerState.orders),
        )
        if (terminalization !== undefined) return terminalization
      }
      const reconciledAt = closeReconciliation.report.reconciliation.reconciledAt
      const document = yield* buildClosingExecutionCycleDecision({
        input,
        preparation,
        policy,
        cycle,
        entryDocument,
        reconcile: Effect.succeed(closeReconciliation),
        closeExpiresAt: closeWindow.expiresAt,
      })
      const decision = decideExecutionCycleCloseDocument(document)
      if (decision._tag === 'Complete') return { _tag: 'Complete', observedAt: reconciledAt } as const
      if (decision._tag === 'Block') {
        return { _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt: reconciledAt } as const
      }
      const closure = yield* Effect.fromResult(
        makeExecutionCycleClosure({
          schemaVersion: legacyCycleClosureSchemaVersion,
          cycleId: cycle.identity.cycleId,
          entryDecisionHash,
          document,
          createdAt: document.createdAt,
          expiresAt: closeWindow.expiresAt,
        }),
      ).pipe(
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'execution close plan canonical binding failed', cause, failure: 'contract' }),
        ),
      )
      const stored = yield* store
        .bind(closure)
        .pipe(
          Effect.mapError((cause) =>
            mutationRunnerError({ message: 'execution close plan durable bind failed', cause, failure: 'store' }),
          ),
        )
      return { _tag: 'Close', document: stored.document } as const
    }

    const latestReplan = yield* readLatestExecutionCycleCloseReplan(cycle.identity.cycleId, store)
    const active = latestReplan ?? existing
    if (!(yield* closePlanNeedsResidualReplan(active.document, reconcile))) {
      return { _tag: 'Close', document: active.document } as const
    }

    const document = yield* buildClosingExecutionCycleDecision({
      input,
      preparation,
      policy,
      cycle,
      entryDocument,
      reconcile,
      closeExpiresAt: closeWindow.expiresAt,
      replanGenerationHash: active.contentHash,
    })
    const decision = decideExecutionCycleCloseDocument(document)
    if (decision._tag !== 'Bind') {
      return { _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt } as const
    }
    const closure = yield* Effect.fromResult(
      makeExecutionCycleClosure({
        schemaVersion: legacyCycleClosureSchemaVersion,
        cycleId: cycle.identity.cycleId,
        entryDecisionHash,
        document: decision.document,
        createdAt: decision.document.createdAt,
        expiresAt: closeWindow.expiresAt,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({
          message: 'execution residual close plan canonical binding failed',
          cause,
          failure: 'contract',
        }),
      ),
    )
    const stored = yield* store.bindReplan(closure).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({
          message: 'execution residual close plan durable bind failed',
          cause,
          failure: 'store',
        }),
      ),
    )
    return { _tag: 'Close', document: stored.document } as const
  }).pipe(
    Effect.catchTag('ExecutionCloseAwaitingMarketData', ({ observedAt }) =>
      Effect.succeed<ExecutionCycleClosureResult>({ _tag: 'Wait', observedAt }),
    ),
  )

export const mutationDecisionInput = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): ObserveDecisionInput<ObserveDecisionRuntime> => ({
  authorityGenerationHash: input.authorityGenerationHash,
  cycle,
  executionModel: preparation.executionModel,
  policy,
  reconcile,
  strategy: input.strategy,
  decisionFinalizationHeadroomMs: executionDecisionFinalizationHeadroomMs(input),
  ...(input.intradayMarketData === undefined ? {} : { intradayMarketData: input.intradayMarketData }),
})

const readMutationPreparationFacts = (
  request: MutationPreparationFactsRequest<
    ObserveDecisionRuntime,
    ReconciliationPassError,
    ObserveAutonomousCycleInput,
    ObserveStartupPreparation
  >,
): Effect.Effect<MutationPreparationFacts, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const decisionInput = mutationDecisionInput(
      request.input,
      request.preparation,
      request.policy,
      request.cycle,
      request.reconcile,
    )
    const reads = yield* Effect.fromResult(prepareObserveDecisionReads(decisionInput)).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({ message: 'mutation cycle decision reads are invalid', cause, failure: 'contract' }),
      ),
    )
    const facts = yield* readObserveDecisionFacts(decisionInput, reads).pipe(
      Effect.mapError((cause) => {
        const converted = decisionBuildError(cause)
        return mutationRunnerError({
          message: converted.message,
          cause,
          failure: converted.failure === 'not-ready' ? 'contract' : converted.failure,
        })
      }),
    )
    const authority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(facts.reconciliation, request.policy, request.input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const snapshot =
      facts.schemaVersion === 'bayn.observe-decision-facts.v1'
        ? facts.snapshot.manifest.finalizedSnapshot
        : {
            snapshotId: request.document.bindings.snapshotId,
            contentHash: request.document.bindings.snapshotContentHash,
            finalizedAt: request.document.bindings.snapshotFinalizedAt,
          }
    return {
      snapshot,
      reconciliation: facts.reconciliation,
      authority: authority.authority,
      evaluatedAt: facts.evaluatedAt,
    }
  })

const readCloseMutationPreparationFacts = (
  request: MutationPreparationFactsRequest<
    ObserveDecisionRuntime,
    ReconciliationPassError,
    ObserveAutonomousCycleInput,
    ObserveStartupPreparation
  >,
): Effect.Effect<MutationPreparationFacts, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const reconciliation = yield* request.reconcile.pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: 'execution close reconciliation failed', cause })),
    )
    const evaluatedAt = yield* currentUtcInstant
    const authority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(reconciliation, request.policy, request.input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    return {
      snapshot: {
        contentHash: request.document.bindings.snapshotContentHash,
        finalizedAt: request.document.bindings.snapshotFinalizedAt,
      },
      reconciliation,
      authority: authority.authority,
      evaluatedAt,
    }
  })

export interface PrepareNextMutationIntentInput {
  readonly input: ObserveAutonomousCycleInput
  readonly preparation: ObserveStartupPreparation
  readonly policy: Policy
  readonly cycle: AutonomousCycle
  readonly document: ExecutionDecisionDocument
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>
  readonly allowSubmit?: boolean
  readonly drainOpenOrders?: boolean
}

export const prepareNextMutationIntent = (
  request: PrepareNextMutationIntentInput,
): Effect.Effect<PreparedMutationCycleStep, CycleRunnerError, ObserveDecisionRuntime | IntentStore | MutationStore> =>
  prepareMutationIntent(
    request.input,
    request.preparation,
    request.policy,
    request.cycle,
    request.document,
    request.reconcile,
    request.allowSubmit ?? true,
    request.drainOpenOrders ?? false,
    {
      now: currentUtcInstant,
      readFacts:
        request.input.mutationPhase === 'CLOSE' ? readCloseMutationPreparationFacts : readMutationPreparationFacts,
      restrictAuthority: restrictMutationAuthority,
    },
  )

const executeBoundExecutionCycle = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  document: ExecutionDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: ExecutionCapability,
): Effect.Effect<BoundExecutionCycleOutcome, CycleRunnerError, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    let sessionCloseLeads:
      | { readonly sessionCloseStartLeadMs: number; readonly sessionCloseSubmitLeadMs: number }
      | undefined
    if (isQuoteBoundExecutionModel(preparation.executionModel)) {
      if (preparation.executionModel.schemaVersion === 'bayn.execution-model.v5') {
        const protocol = yield* Effect.fromResult(
          decodeIntradayMomentumProtocol(strategyDefinition(input.strategy).parameters),
        ).pipe(
          Effect.mapError((cause) =>
            mutationRunnerError({
              message: 'intraday close window protocol is invalid',
              cause,
              failure: 'contract',
            }),
          ),
        )
        sessionCloseLeads = {
          sessionCloseStartLeadMs: protocol.flattenBeforeCloseMinutes * 60_000,
          sessionCloseSubmitLeadMs: protocol.hardFlatBeforeCloseMinutes * 60_000,
        }
      } else {
        const protocol = yield* Effect.fromResult(
          decodeOpeningDriveProtocol(strategyDefinition(input.strategy).parameters),
        ).pipe(
          Effect.mapError((cause) =>
            mutationRunnerError({
              message: 'intraday close window protocol is invalid',
              cause,
              failure: 'contract',
            }),
          ),
        )
        sessionCloseLeads = {
          sessionCloseStartLeadMs: protocol.flattenBeforeCloseMinutes * 60_000,
          sessionCloseSubmitLeadMs: protocol.hardFlatBeforeCloseMinutes * 60_000,
        }
      }
    }
    const closeWindow = yield* Effect.fromResult(
      resolveExecutionCycleCloseWindow({
        ...(input.cycleCadence === undefined ? {} : { cadence: input.cycleCadence }),
        executionCloseAt: cycle.window.executionCloseAt,
        ...sessionCloseLeads,
        ...(input.executionMandateCutoffAt === undefined
          ? {}
          : { mandateForceCloseAt: input.executionMandateCutoffAt }),
        ...(input.executionMandateCloseSubmitCutoffAt === undefined
          ? {}
          : { mandateCloseSubmitCutoffAt: input.executionMandateCloseSubmitCutoffAt }),
        ...(input.executionMandateExpiresAt === undefined
          ? {}
          : { mandateCloseExpiresAt: input.executionMandateExpiresAt }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({
          message: 'execution cycle close window is invalid',
          cause,
          failure: 'contract',
        }),
      ),
    )
    const entrySubmissionCutoffAt =
      closeWindow === undefined ||
      (input.executionMandateCutoffAt !== undefined && input.executionMandateCutoffAt < closeWindow.startAt)
        ? input.executionMandateCutoffAt
        : closeWindow.startAt
    const entryPhaseInput: ObserveAutonomousCycleInput = {
      ...input,
      mutationPhase: 'ENTRY',
      ...(entrySubmissionCutoffAt === undefined ? {} : { executionMandateCutoffAt: entrySubmissionCutoffAt }),
    }
    const closeDue = closeWindow !== undefined && observedAt >= closeWindow.startAt
    const drainIncompatibleEntry =
      capability._tag === 'Mutation' && !strategyAllowsMutationCadence(input.strategy, input.cycleCadence)
    let closeOnly = false
    let phaseInput = entryPhaseInput
    let step: PreparedMutationCycleStep | undefined

    if (drainIncompatibleEntry && !closeDue) {
      const entryDrain = yield* prepareNextMutationIntent({
        input: entryPhaseInput,
        preparation,
        policy,
        cycle,
        document,
        reconcile,
        allowSubmit: false,
        drainOpenOrders: true,
      })
      if (entryDrain._tag === 'Execute') {
        step = entryDrain
      } else if (entryDrain._tag !== 'Complete') {
        return entryDrain
      } else {
        return { _tag: 'Wait', observedAt: entryDrain.observedAt }
      }
    }

    if (step === undefined && closeDue) {
      const entryDrain = yield* prepareNextMutationIntent({
        input: entryPhaseInput,
        preparation,
        policy,
        cycle,
        document,
        reconcile,
        allowSubmit: false,
        drainOpenOrders: capability._tag === 'Mutation',
      })
      if (entryDrain._tag === 'Execute') {
        step = entryDrain
      } else if (entryDrain._tag !== 'Complete') {
        return entryDrain
      }
    }

    if (step === undefined) {
      let closeDocument: ExecutionDecisionDocument | undefined
      if (closeDue) {
        const closure = yield* ensureExecutionCycleClosure(
          input,
          preparation,
          policy,
          cycle,
          document,
          closeWindow,
          reconcile,
        )
        if (closure._tag !== 'Close') return closure
        closeDocument = closure.document
      }
      closeOnly = closeDocument !== undefined
      phaseInput =
        closeOnly && closeWindow !== undefined
          ? {
              ...input,
              mutationPhase: 'CLOSE',
              executionMandateCloseSubmitCutoffAt: closeWindow.submitCutoffAt,
              executionMandateExpiresAt: closeWindow.expiresAt,
            }
          : entryPhaseInput
      step = yield* prepareNextMutationIntent({
        input: phaseInput,
        preparation,
        policy,
        cycle,
        document: closeDocument ?? document,
        reconcile,
        allowSubmit: executionMutationSubmissionAllowed({
          capability: capability._tag,
          closeOnly,
          ...(phaseInput.executionMandateCutoffAt === undefined
            ? {}
            : { executionMandateCutoffAt: phaseInput.executionMandateCutoffAt }),
          ...(phaseInput.executionMandateCloseSubmitCutoffAt === undefined
            ? {}
            : { executionMandateCloseSubmitCutoffAt: phaseInput.executionMandateCloseSubmitCutoffAt }),
          observedAt,
        }),
      })
    }
    if (step._tag !== 'Execute') {
      if (step._tag !== 'Complete') return step
      const entryCutoffAt = closeWindow?.startAt
      const entryHasUnsuccessfulIntent =
        closeOnly || (entryCutoffAt !== undefined && observedAt >= entryCutoffAt)
          ? yield* reconcile.pipe(
              Effect.mapError((cause) =>
                mutationRunnerError({ message: 'entry execution terminal reconciliation failed', cause }),
              ),
              Effect.flatMap((facts) => entryExecutionCycleHasUnsuccessfulIntent(document, facts.brokerState.orders)),
            )
          : false
      const terminalization = decideExecutionMandateCycleTerminalization({
        closeOnly,
        observedAt,
        ...(entryCutoffAt === undefined ? {} : { entryCutoffAt }),
        entryHasUnsuccessfulIntent,
      })
      switch (terminalization._tag) {
        case 'WaitForClose':
          return { _tag: 'Wait', observedAt: step.observedAt }
        case 'Block':
          return { _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt: step.observedAt }
        case 'Complete':
          return step
      }
    }
    const logContext: ExecutionMutationLogContext = {
      cycleId: cycle.identity.cycleId,
      intentId: step.intentId,
      mutationAction: step.action,
      mutationPhase: closeOnly ? 'CLOSE' : 'ENTRY',
    }
    yield* Effect.logInfo('Execution mutation selected').pipe(Effect.annotateLogs(logContext))
    const execute =
      capability._tag === 'Mutation'
        ? executeMutationIntent(
            capability.executionProgram,
            step.intentId,
            step.action,
            step.action === 'SUBMIT' ? step.submitExpiresAt : undefined,
          )
        : executeMutationIntentWithExecutor({
            executor: { recover: recoverMutation },
            intentId: step.intentId,
            action: step.action,
            submitExpiresAt: step.action === 'SUBMIT' ? step.submitExpiresAt : undefined,
          })
    const executed = yield* execute.pipe(
      Effect.tapError((error) =>
        Effect.logError('Execution mutation failed').pipe(
          Effect.annotateLogs({ ...logContext, failure: error.failure }),
        ),
      ),
    )
    yield* Effect.logInfo('Execution mutation settled').pipe(
      Effect.annotateLogs({
        ...logContext,
        mutationOperation: executed.operation,
        mutationAdvanced: executed.mutationAdvanced,
        settlement: executed.settlement.outcome,
      }),
    )
    if (executed.operation === MutationOperation.Submit && executed.settlement.outcome !== 'accepted') {
      yield* restrictMutationAuthority(
        executionCycleRestrictionSubject,
        `bound cycle ${cycle.identity.cycleId}: intent ${step.intentId} submit settled ${executed.settlement.outcome}`,
      )
    }
    if (executed.mutationAdvanced)
      return {
        _tag: 'PostMutationReconciliation',
        cycle,
        delayMs: mutationIntentReconciliationDelayMs(executed),
        logContext,
        observedAt: step.observedAt,
      }
    return { _tag: 'Wait' as const, observedAt: step.observedAt }
  })

export const deferPostMutationReconciliation = (pending: PostMutationReconciliation): CycleRunResult => ({
  outcome: 'RECOVERED' as const,
  action: 'WAITING' as const,
  observedAt: pending.observedAt,
  cycle: pending.cycle,
})

const readUnfinishedMutationCycle = (
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<AutonomousCycle | undefined, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) =>
      store.readOldestUnfinished({
        qualificationRunId: context.qualificationRunId,
        accountId: context.accountId,
      }),
    ),
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'oldest unfinished mutation cycle read failed', cause, failure: 'store' }),
    ),
    Effect.map(Option.getOrUndefined),
  )

const mutationBound = (cycle: AutonomousCycle | undefined): cycle is AutonomousCycle =>
  cycle !== undefined && cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined

const terminalizeUnboundMutationCycleAtCutoff = (
  cycle: AutonomousCycle,
  observedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) => store.block(cycle.identity.cycleId, CycleTerminalReason.Authority, observedAt)),
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'expired execution cycle finalization failed', cause, failure: 'store' }),
    ),
    Effect.map((receipt) => ({
      outcome: 'RECOVERED' as const,
      action: 'BLOCKED' as const,
      observedAt,
      cycle: receipt.cycle,
    })),
  )

const terminalizeBlockedExecutionCycleDataFirst = (
  cycle: AutonomousCycle,
  outcome: Extract<BoundMutationCycleOutcome, { readonly _tag: 'Block' }>,
  authorityGenerationHash: string,
  blockedIntents: BlockedCycleIntentStoreShape,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore | AuthorityRestrictionStore | WriterFence> =>
  Effect.gen(function* () {
    const store = yield* CycleStore
    const restrictionStore = yield* AuthorityRestrictionStore
    const fence = yield* WriterFence
    const restrictionReason = `bound cycle ${cycle.identity.cycleId} blocked: ${outcome.reason}`
    const { cycleReceipt, intentReceipt } = yield* fence.transaction(
      store.block(cycle.identity.cycleId, outcome.reason, outcome.observedAt).pipe(
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'blocked execution cycle finalization failed', cause, failure: 'store' }),
        ),
        Effect.tap(() =>
          restrictionStore
            .restrictAuthority(`${executionMandateFailureRestrictionPrefix} ${restrictionReason}`, outcome.observedAt)
            .pipe(
              Effect.mapError((cause) =>
                mutationRunnerError({
                  message: 'authority restriction failed after a bound execution cycle failure',
                  cause: { subject: 'Bayn execution cycle loop', reason: restrictionReason, cause },
                  failure: 'store',
                }),
              ),
            ),
        ),
        Effect.bindTo('cycleReceipt'),
        Effect.bind('intentReceipt', () =>
          blockedIntents
            .terminalizeUntouchedApproved({
              authorityGenerationHash,
              cycleId: cycle.identity.cycleId,
              observedAt: outcome.observedAt,
            })
            .pipe(
              Effect.mapError((cause) =>
                mutationRunnerError({
                  message: 'untouched approved intents could not be terminalized with their blocked execution cycle',
                  cause,
                  failure: 'store',
                }),
              ),
            ),
        ),
      ),
    )
    yield* Effect.logWarning('Bayn execution cycle terminalized with restricted mutation authority').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        cycleId: cycle.identity.cycleId,
        terminalReason: outcome.reason,
        blockedIntentCount: intentReceipt.blockedIntentCount,
        expiredIntentCount: intentReceipt.expiredIntentCount,
        terminalIntentCount: intentReceipt.terminalIntentCount,
        observedAt: outcome.observedAt,
      }),
    )
    return {
      outcome: 'RECOVERED' as const,
      action: 'BLOCKED' as const,
      observedAt: outcome.observedAt,
      cycle: cycleReceipt.cycle,
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof CycleRunnerError
        ? cause
        : mutationRunnerError({ message: 'blocked execution cycle transaction failed', cause, failure: 'store' }),
    ),
  )

export const terminalizeBlockedExecutionCycle = terminalizeBlockedExecutionCycleDataFirst

const interpretBoundMutationCycleOutcome = (
  input: ObserveAutonomousCycleInput,
  outcome: BoundMutationCycleOutcome,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore | ObserveDecisionRuntime> => {
  switch (outcome._tag) {
    case 'RunCycle':
      return runAutonomousCyclePass(context)
    case 'Wait':
      return Effect.succeed({
        outcome: 'RECOVERED',
        action: 'WAITING',
        observedAt: outcome.observedAt,
        cycle,
      })
    case 'Block':
      return input.blockedCycleIntentStore === undefined
        ? Effect.fail(
            mutationRunnerError({
              message: 'blocked execution cycle terminalization store is unavailable',
              failure: 'contract',
            }),
          )
        : terminalizeBlockedExecutionCycle(cycle, outcome, input.authorityGenerationHash, input.blockedCycleIntentStore)
    case 'Complete':
      return CycleStore.pipe(
        Effect.flatMap((store) => store.finish(cycle.identity.cycleId, CycleState.Completed, outcome.observedAt)),
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'completed execution cycle finalization failed', cause, failure: 'store' }),
        ),
        Effect.tap((receipt) =>
          receipt.changed && input.onClosedCycle !== undefined
            ? input.onClosedCycle(cycle.identity.cycleId, outcome.observedAt)
            : Effect.void,
        ),
        Effect.map((receipt) => ({
          outcome: 'RECOVERED' as const,
          action: 'COMPLETED' as const,
          observedAt: outcome.observedAt,
          cycle: receipt.cycle,
        })),
      )
  }
}

const interpretBoundExecutionCycleOutcome = (
  input: ObserveAutonomousCycleInput,
  outcome: BoundExecutionCycleOutcome,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<RecoveryFirstCyclePassResult, CycleRunnerError, CycleStore | ObserveDecisionRuntime> => {
  if (outcome._tag === 'PostMutationReconciliation') {
    return Effect.succeed<RecoveryFirstCyclePassResult>(outcome)
  }
  return interpretBoundMutationCycleOutcome(input, outcome, cycle, context)
}

const recoverBoundMutationCycle = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: ExecutionCapability,
): Effect.Effect<RecoveryFirstCyclePassResult, CycleRunnerError, RecoveryFirstRuntime> =>
  readBoundMutationDocument(cycle).pipe(
    Effect.flatMap((document) =>
      document.mode === 'OBSERVE'
        ? runAutonomousCyclePass(context)
        : executeBoundExecutionCycle(input, preparation, policy, cycle, document, reconcile, capability).pipe(
            Effect.flatMap((outcome) => interpretBoundExecutionCycleOutcome(input, outcome, cycle, context)),
          ),
    ),
  )

export const runRecoveryFirstCyclePass = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  context: CycleRunContext<ObserveDecisionRuntime>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: ExecutionCapability,
): Effect.Effect<RecoveryFirstCyclePassResult, CycleRunnerError, RecoveryFirstRuntime> =>
  readUnfinishedMutationCycle(context).pipe(
    Effect.flatMap((unfinished) => {
      if (mutationBound(unfinished)) {
        return recoverBoundMutationCycle(input, preparation, policy, unfinished, context, reconcile, capability)
      }
      return currentUtcInstant.pipe(
        Effect.flatMap((observedAt) => {
          if (
            input.executionMandateCutoffAt !== undefined &&
            observedAt >= input.executionMandateCutoffAt &&
            unfinished !== undefined
          ) {
            return terminalizeUnboundMutationCycleAtCutoff(unfinished, observedAt)
          }
          if (input.executionMandateCutoffAt !== undefined && observedAt >= input.executionMandateCutoffAt) {
            return Effect.succeed({ outcome: 'NO_PUBLICATION' as const, observedAt })
          }
          return runAutonomousCyclePass(context).pipe(
            Effect.flatMap((result) =>
              result.outcome === 'RECOVERED' && result.action === 'BOUND_DECISION'
                ? recoverBoundMutationCycle(input, preparation, policy, result.cycle, context, reconcile, capability)
                : Effect.succeed(result),
            ),
          )
        }),
      )
    }),
  )
