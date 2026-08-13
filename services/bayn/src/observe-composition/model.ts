import type { Effect } from 'effect'
import { BrokerRead } from '../broker/alpaca'
import type { CycleExecutionPolicy } from '../cycle'
import type { CycleRunnerError, CycleRunResult } from '../cycle/runner'
import { CycleStore } from '../cycle/store'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from '../db/execution-store'
import type { ExecutionCycleClosureStoreShape } from '../db/execution-cycle-closure'
import { IntentStore, type BlockedCycleIntentStoreShape } from '../execution/intents'
import { MutationStore } from '../execution/mutations'
import type { ExecutionProgram } from '../execution/runtime-program'
import { WriterFence } from '../execution/writer-fence'
import { MarketData } from '../market-data'
import type { CausalProtocol } from '../protocol'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import type { StrategyRuntime } from '../strategy'
import type { BoundMutationCycleOutcome } from './mutation-decisions'
import { utcInstantFromEpochMillis } from '../time'

export type LifecycleAdvanceDisposition = 'CONTINUE' | 'COMPLETED'

export type LifecycleAdvanceMaintenance = {
  /** Restricts expired authority before any reconciliation or cycle work can reach broker mutation. */
  readonly beforeReconciliation: Effect.Effect<void, CycleRunnerError>
  /** Finalizes a receipt only after the same advance has reconciled successfully. */
  readonly afterReconciliation: Effect.Effect<LifecycleAdvanceDisposition, CycleRunnerError>
}

export const executionEpisodeCloseGraceMs = 15 * 60_000

export const executionEpisodeCloseExpiresAt = (authorityExpiresAt: string): string =>
  utcInstantFromEpochMillis(Date.parse(authorityExpiresAt) + executionEpisodeCloseGraceMs)

/** Receipt finalization remains bounded, but survives late close settlement and transient read failures. */
export const executionEpisodeReceiptFinalizationGraceMs = 15 * 60_000

export const executionEpisodeReceiptFinalizationExpiresAt = (authorityExpiresAt: string): string =>
  utcInstantFromEpochMillis(
    Date.parse(executionEpisodeCloseExpiresAt(authorityExpiresAt)) + executionEpisodeReceiptFinalizationGraceMs,
  )

export type ObserveDecisionRuntime =
  | BrokerRead
  | MarketData
  | BrokerEventStore
  | FillAccountingStore
  | ValuationStore
  | ReconciliationStore
  | AuthorityGenerationStore
  | AuthorityRestrictionStore
  | WriterFence

type ObserveRuntime = CycleStore | ObserveDecisionRuntime

export type RecoveryFirstRuntime = ObserveRuntime | IntentStore | MutationStore

export type ObserveStartupPreparation = {
  readonly executionModel: CausalProtocol['executionModel']
  readonly executionPolicy: CycleExecutionPolicy
  readonly strategyProtocolHash: string
}

export type RecoveryFirstCycleAdvance = {
  readonly observation: AutonomousCyclePassObservation
  readonly result?: CycleRunResult
}

export type RecoveryFirstCycleDriver = {
  readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, CycleRunnerError, RecoveryFirstRuntime>
  /** Keeps broker/accounting truth fresh while an external lifecycle owner is delayed between commands. */
  readonly maintainReconciliation: Effect.Effect<void, never, RecoveryFirstRuntime>
  /** The external owner must not delay the next command beyond either the cycle or reconciliation cadence. */
  readonly nextDelayMs: number
  readonly wait: (advance: RecoveryFirstCycleAdvance) => Effect.Effect<void, never, RecoveryFirstRuntime>
}

export type RecoveryFirstCycleDriverInterpreter = (
  driver: RecoveryFirstCycleDriver,
) => Effect.Effect<void, never, RecoveryFirstRuntime>

export type ObserveAutonomousCycleInput = {
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
  readonly reconciliationPassTimeoutMs: number
  readonly strategy: StrategyRuntime
  readonly cycleCadence?: 'MONTHLY' | 'CAPITAL_BOOTSTRAP'
  readonly mutationPhase?: 'ENTRY' | 'CLOSE'
  readonly executionCycleClosureStore?: ExecutionCycleClosureStoreShape
  readonly blockedCycleIntentStore?: BlockedCycleIntentStoreShape
  readonly executionEpisodeCutoffAt?: string
  readonly executionEpisodeCloseSubmitCutoffAt?: string
  readonly executionEpisodeExpiresAt?: string
  readonly onClosedCycle?: (cycleId: string, observedAt: string) => Effect.Effect<void>
  /** Runs phased lifecycle maintenance inside the same serialized command as reconciliation and the cycle pass. */
  readonly lifecycleMaintenance?: LifecycleAdvanceMaintenance
  readonly interpretCycleDriver?: RecoveryFirstCycleDriverInterpreter
}

export type MutationAutonomousCycleInput = ObserveAutonomousCycleInput & {
  readonly executionProgram: ExecutionProgram
}

export type ExecutionCapability =
  | { readonly _tag: 'RecoveryOnly' }
  | { readonly _tag: 'Mutation'; readonly executionProgram: ExecutionProgram }

export type ExecutionMutationLogContext = {
  readonly cycleId: string
  readonly intentId: string
  readonly mutationAction: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT'
  readonly mutationPhase: 'CLOSE' | 'ENTRY'
}

export type PostMutationReconciliation = {
  readonly _tag: 'PostMutationReconciliation'
  readonly cycle: import('../cycle').AutonomousCycle
  readonly delayMs: number
  readonly logContext: ExecutionMutationLogContext
  readonly observedAt: string
}

export type BoundExecutionCycleOutcome = BoundMutationCycleOutcome | PostMutationReconciliation

export type RecoveryFirstCyclePassResult = CycleRunResult | PostMutationReconciliation
