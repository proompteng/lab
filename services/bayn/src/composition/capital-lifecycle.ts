import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Ref } from 'effect'

import type { LoadedRuntimeConfig } from '../config'
import { CycleRunnerError } from '../cycle/runner'
import {
  type ForwardPerformanceReceiptStoreShape,
  makeForwardPerformanceReceiptEnvelope,
} from '../db/forward-performance-receipt'
import { AuthorityRestrictionStore, type AuthorityRestrictionStoreShape } from '../db/execution-store'
import type { ResearchCapitalActivationRequest } from '../execution/configuration'
import { WriterFence, type WriterFenceService } from '../execution/writer-fence'
import type { OperationalError } from '../errors'
import { runForwardPerformance } from '../forward-performance'
import {
  executionActivationRestrictionSubject,
  executionMandateCompletionPersistenceSubject,
} from '../execution/mandate'
import {
  executionMandateCloseExpiresAt,
  executionMandateReceiptFinalizationExpiresAt,
  type LifecycleAdvanceDisposition,
  type LifecycleAdvanceMaintenance,
} from '../observe-composition'
import { restrictMutationAuthority } from '../observe-composition/mutation-interpreter'
import { Pipeable } from '../pipeable'
import type { RuntimeState } from '../runtime-state'
import { currentUtcInstant } from '../time'
import { completedCapitalActivation } from './capital-activation'

export type ExecutionLifecycleMaintenanceDecision = {
  readonly restrictExpiredAuthority: boolean
  readonly attemptReceiptFinalization: boolean
}

export const decideExecutionLifecycleMaintenance = (input: {
  readonly cutoffAt: string
  readonly closeExpiresAt: string
  readonly finalizationExpiresAt: string
  readonly observedAt: string
}): ExecutionLifecycleMaintenanceDecision => {
  const observedMs = Date.parse(input.observedAt)
  const cutoffMs = Date.parse(input.cutoffAt)
  const closeExpiresMs = Date.parse(input.closeExpiresAt)
  const finalizationExpiresMs = Date.parse(input.finalizationExpiresAt)
  if (
    !Number.isFinite(observedMs) ||
    !Number.isFinite(cutoffMs) ||
    !Number.isFinite(closeExpiresMs) ||
    !Number.isFinite(finalizationExpiresMs)
  ) {
    return { restrictExpiredAuthority: true, attemptReceiptFinalization: false }
  }
  return {
    restrictExpiredAuthority: observedMs >= closeExpiresMs,
    attemptReceiptFinalization: observedMs >= cutoffMs && observedMs <= finalizationExpiresMs,
  }
}

export const runExecutionLifecycleMaintenance = (
  request: ResearchCapitalActivationRequest,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
  finalizeReceipt: (cycleId: string | undefined, observedAt: string) => Effect.Effect<boolean, CycleRunnerError>,
): LifecycleAdvanceMaintenance => {
  const restrictExpiredAuthority = (
    decision: ExecutionLifecycleMaintenanceDecision,
  ): Effect.Effect<void, CycleRunnerError> =>
    decision.restrictExpiredAuthority
      ? restrictMutationAuthority(executionActivationRestrictionSubject, 'immutable activation request expired').pipe(
          Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
          Effect.provideService(WriterFence, writerFence),
        )
      : Effect.void
  const currentDecision = currentUtcInstant.pipe(
    Effect.map((observedAt) => ({
      observedAt,
      decision: decideExecutionLifecycleMaintenance({
        cutoffAt: request.cutoffAt,
        closeExpiresAt: executionMandateCloseExpiresAt(request.expiresAt),
        finalizationExpiresAt: executionMandateReceiptFinalizationExpiresAt(request.expiresAt),
        observedAt,
      }),
    })),
  )
  return {
    beforeReconciliation: currentDecision.pipe(Effect.flatMap(({ decision }) => restrictExpiredAuthority(decision))),
    afterReconciliation: currentDecision.pipe(
      Effect.flatMap(({ decision, observedAt }) =>
        restrictExpiredAuthority(decision).pipe(
          Effect.andThen(
            decision.attemptReceiptFinalization
              ? finalizeReceipt(undefined, observedAt).pipe(
                  Effect.map((completed): LifecycleAdvanceDisposition => (completed ? 'COMPLETED' : 'CONTINUE')),
                )
              : Effect.succeed('CONTINUE' as const),
          ),
        ),
      ),
    ),
  }
}

export const completeExecutionLifecycle = <A, E, R, RolloverR>(
  finalization: Effect.Effect<boolean, E, R>,
  rollover: Effect.Effect<A, OperationalError, RolloverR>,
): Effect.Effect<boolean, E | CycleRunnerError, R | RolloverR> =>
  finalization.pipe(
    Effect.flatMap((finalized) =>
      finalized
        ? rollover.pipe(
            Effect.mapError(
              (cause) =>
                new CycleRunnerError({
                  operation: 'recover-cycle',
                  failure: 'operational',
                  message: 'terminal execution generation rollover failed',
                  cause,
                }),
            ),
            Effect.as(true),
          )
        : Effect.succeed(false),
    ),
  )

export const signedMicros = (value: string | null): bigint | undefined =>
  value !== null && /^-?(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined

export const makeClosedCycleReceiptEmitter =
  (
    config: LoadedRuntimeConfig,
    sql: PgClient.PgClient,
    authorityGenerationHash: string,
    receiptStore: ForwardPerformanceReceiptStoreShape,
  ): ((cycleId: string | undefined, observedAt: string) => Effect.Effect<string | undefined>) =>
  (cycleId, observedAt) =>
    Effect.gen(function* () {
      const existing = yield* receiptStore.read(authorityGenerationHash)
      if (Option.isSome(existing)) return existing.value.receiptHash
      const receipt = yield* Effect.scoped(
        runForwardPerformance(config, undefined, { authorityGenerationHash }).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
      )
      const netRealizedPnl = signedMicros(receipt.totals.netRealizedPnlAfterCostsMicros)
      const reconciliationExact =
        receipt.window.reconciliationStatus === 'EXACT' || receipt.window.cashYieldAdjustedExact === true
      const exactClosedEvidence =
        receipt.evidence.status === 'SUFFICIENT' &&
        reconciliationExact &&
        receipt.window.reconciliationId !== null &&
        receipt.window.reconciliationContentHash !== null &&
        receipt.reconciliationProof.accountingReceiptsExact &&
        receipt.reconciliationProof.ledgerExact &&
        receipt.reconciliationProof.missingLedgerAccountCount === 0 &&
        receipt.reconciliationProof.unresolvedMutationCount === 0 &&
        receipt.reconciliationProof.unclosedCycleCount === 0 &&
        receipt.reconciliationProof.openPositionCount === 0 &&
        receipt.executionQuality.status === 'MEASURED' &&
        netRealizedPnl !== undefined
      if (!exactClosedEvidence) {
        yield* Effect.logWarning('Bayn forward-performance receipt withheld: closed exact evidence is incomplete').pipe(
          Effect.annotateLogs({
            service: 'bayn',
            cycleId,
            observedAt,
            evidenceStatus: receipt.evidence.status,
            accountingReceiptsExact: receipt.reconciliationProof.accountingReceiptsExact,
            ledgerExact: receipt.reconciliationProof.ledgerExact,
            unclosedCycleCount: receipt.reconciliationProof.unclosedCycleCount,
            openPositionCount: receipt.reconciliationProof.openPositionCount,
          }),
        )
        return undefined
      }
      if (receipt.profitability === 'PROFITABLE' && netRealizedPnl <= 0n) {
        yield* Effect.logError('Bayn forward-performance receipt rejected an unsupported positive claim').pipe(
          Effect.annotateLogs({ service: 'bayn', cycleId, receiptHash: receipt.receiptHash }),
        )
        return undefined
      }
      const receiptCycleId = cycleId ?? receipt.window.lastCycleId
      if (receiptCycleId === null || receiptCycleId === undefined) {
        yield* Effect.logWarning(
          'Bayn forward-performance receipt withheld: no closed cycle identity was observed',
        ).pipe(Effect.annotateLogs({ service: 'bayn', observedAt }))
        return undefined
      }
      const envelope = yield* Effect.fromResult(
        makeForwardPerformanceReceiptEnvelope({
          schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
          authorityGenerationHash,
          cycleId: receiptCycleId,
          receiptHash: receipt.receiptHash,
          receipt,
          createdAt: observedAt,
        }),
      )
      const stored = yield* receiptStore.bind(envelope)
      yield* Effect.logInfo('Bayn forward-performance receipt emitted').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          cycleId,
          receiptHash: stored.receiptHash,
          evidenceStatus: stored.receipt.evidence.status,
          profitability: stored.receipt.profitability,
          netRealizedPnlAfterCostsMicros: stored.receipt.totals.netRealizedPnlAfterCostsMicros,
        }),
      )
      return stored.receiptHash
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError('Bayn forward-performance receipt emission failed').pipe(
          Effect.annotateLogs({
            service: 'bayn',
            cycleId,
            observedAt,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
          Effect.as(undefined),
        ),
      ),
    )

export const finalizeExecutionMandateDataFirst = (
  state: Ref.Ref<RuntimeState>,
  request: ResearchCapitalActivationRequest,
  generationHash: string,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
  emit: (cycleId: string | undefined, observedAt: string) => Effect.Effect<string | undefined>,
  cycleId: string | undefined,
  observedAt: string,
): Effect.Effect<boolean> =>
  emit(cycleId, observedAt).pipe(
    Effect.flatMap((receiptHash) =>
      receiptHash === undefined
        ? Effect.succeed(false)
        : restrictMutationAuthority(executionMandateCompletionPersistenceSubject, 'flat exact receipt finalized').pipe(
            Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.andThen(completedCapitalActivation(state, request, generationHash, receiptHash)),
            Effect.as(true),
          ),
    ),
    Effect.catch((cause) =>
      Effect.logError('Bayn execution mandate finalization failed').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          cycleId,
          observedAt,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
        Effect.as(false),
      ),
    ),
  )

export const finalizeExecutionMandate = Pipeable.dual(8, finalizeExecutionMandateDataFirst)

export const closedCycleReceiptEmissionAllowedDataFirst = (cutoffAt: string, observedAt: string): boolean =>
  Date.parse(observedAt) >= Date.parse(cutoffAt)

export const closedCycleReceiptEmissionAllowed = Pipeable.dual(2, closedCycleReceiptEmissionAllowedDataFirst)

export const capitalReceiptFinalizationWindowOpenDataFirst = (
  authorityExpiresAt: string,
  observedAt: string,
): boolean => {
  const observedMs = Date.parse(observedAt)
  const closeExpiresMs = Date.parse(executionMandateCloseExpiresAt(authorityExpiresAt))
  const finalizationExpiresMs = Date.parse(executionMandateReceiptFinalizationExpiresAt(authorityExpiresAt))
  return Number.isFinite(observedMs) && observedMs >= closeExpiresMs && observedMs < finalizationExpiresMs
}

export const capitalReceiptFinalizationWindowOpen = Pipeable.dual(2, capitalReceiptFinalizationWindowOpenDataFirst)
