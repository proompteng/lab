import { Context, Data, Effect } from 'effect'

export interface BlockedCycleIntentTerminalizationInput {
  readonly authorityGenerationHash: string
  readonly cycleId: string
  readonly observedAt: string
}

export interface BlockedCycleIntentTerminalizationReceipt {
  readonly blockedIntentCount: number
  readonly expiredIntentCount: number
  readonly terminalIntentCount: number
}

export interface CurrentTerminalGenerationSettlementInput {
  readonly accountId: string
  readonly observedAt: string
}

export type CurrentTerminalGenerationSettlementReceipt =
  | { readonly _tag: 'NoTerminalGeneration' }
  | {
      readonly _tag: 'TerminalGenerationSettled'
      readonly authorityGenerationHash: string
      readonly blockedCycleCount: number
      readonly blockedIntentCount: number
      readonly expiredIntentCount: number
      readonly intentCount: number
      readonly terminalIntentCount: number
    }

export class BlockedCycleIntentStoreError extends Data.TaggedError('BlockedCycleIntentStoreError')<{
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Terminalizes untouched approved intents after their bound cycle has durably blocked.
 *
 * The live interpreter deliberately does not open its own transaction. Its only caller composes this operation with
 * cycle terminalization and authority restriction inside one WriterFence transaction.
 */
export interface BlockedCycleIntentStoreShape {
  readonly terminalizeUntouchedApproved: (
    input: BlockedCycleIntentTerminalizationInput,
  ) => Effect.Effect<BlockedCycleIntentTerminalizationReceipt, BlockedCycleIntentStoreError>
  /**
   * Repairs a generation that was already kill-restricted and terminal when this process started. The caller must
   * run this operation inside the caller's WriterFence transaction. A later, separate exact reconciliation is
   * deliberately required before OBSERVE generation rollover can clear the kill.
   */
  readonly settleCurrentTerminalGeneration: (
    input: CurrentTerminalGenerationSettlementInput,
  ) => Effect.Effect<CurrentTerminalGenerationSettlementReceipt, BlockedCycleIntentStoreError>
}

export class BlockedCycleIntentStore extends Context.Service<BlockedCycleIntentStore, BlockedCycleIntentStoreShape>()(
  '@proompteng/bayn/execution/intents/blocked-cycle/BlockedCycleIntentStore',
) {}
