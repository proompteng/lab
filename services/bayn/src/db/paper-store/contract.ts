import { Context, Data, Effect } from 'effect'

import type { BrokerEventInput, FillEventInput, PositionSnapshotInput, ValuationInput } from '../../broker/observations'
import type { RuntimeConfig } from '../../config'
import type { WriterFence } from '../../execution/writer-fence'
import type {
  AccountingReceipt,
  Authority,
  AuthorityState,
  PaperAuthorityGeneration,
  PaperAuthorityProofBinding,
  Valuation,
} from '../../paper'
import type { BrokerSnapshot, IntentBinding, ReconciliationWriteResult } from '../reconciliation'

export const VALUATION_SNAPSHOT_MAX_SKEW_MS = 30_000

export interface EventReceipt {
  readonly eventId: string
  readonly sourceSequence: string
  readonly deduplicated: boolean
}

export interface PositionSnapshotReceipt {
  readonly snapshotId: string
  readonly eventIds: readonly string[]
  readonly deduplicated: boolean
}

export interface EnsureAuthorityGenerationInput {
  readonly generationHash: string
  readonly maximum: Authority
}

export class PaperStoreError extends Data.TaggedError('PaperStoreError')<{
  readonly operation:
    | 'ingest'
    | 'positions'
    | 'account'
    | 'receipt'
    | 'valuation'
    | 'baseline'
    | 'bindings'
    | 'reconciliation'
    | 'authority'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'ledger' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PaperStoreShape {
  readonly ingest: (input: BrokerEventInput) => Effect.Effect<EventReceipt, PaperStoreError>
  readonly ingestPositions: (input: PositionSnapshotInput) => Effect.Effect<PositionSnapshotReceipt, PaperStoreError>
  readonly account: (input: FillEventInput) => Effect.Effect<AccountingReceipt, PaperStoreError>
  readonly value: (input: ValuationInput) => Effect.Effect<Valuation, PaperStoreError>
  readonly hasAccountBaseline: (accountId: string) => Effect.Effect<boolean, PaperStoreError>
  readonly bindings: (accountId: string) => Effect.Effect<readonly IntentBinding[], PaperStoreError>
  readonly reconcile: (snapshot: BrokerSnapshot) => Effect.Effect<ReconciliationWriteResult, PaperStoreError>
  readonly ensureAuthorityGeneration: (
    input: EnsureAuthorityGenerationInput,
  ) => Effect.Effect<AuthorityState, PaperStoreError>
  /**
   * PREPARE operation: under configured OBSERVE, transactionally derives the stable canonical PAPER generation
   * identity plus the current reconciliation evidence without writing authority state or history. Commit only its
   * generationHash to the later PAPER configuration.
   */
  readonly preparePaperGeneration: (
    proof: PaperAuthorityProofBinding,
  ) => Effect.Effect<PaperAuthorityGeneration, PaperStoreError, WriterFence>
  /**
   * SUBMIT activation operation: under configured PAPER, transactionally re-derives the stable generation identity
   * from the same proof binding, requires its hash to equal the configured generationHash, and records the latest
   * fresh exact reconciliation as immutable activation evidence. This is the sole supported cross-generation PAPER
   * writer; application code and operators must not issue direct DML against authority_state or
   * authority_generations.
   */
  readonly activatePaperGeneration: (
    proof: PaperAuthorityProofBinding,
  ) => Effect.Effect<AuthorityState, PaperStoreError, WriterFence>
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, PaperStoreError>
}

export class PaperStore extends Context.Service<PaperStore, PaperStoreShape>()('bayn/PaperStore') {}

export type PaperStoreRuntimeConfig = Pick<
  RuntimeConfig,
  'build' | 'maximumAuthority' | 'qualificationRunId' | 'reconciliationStaleThresholdMs' | 'tigerBeetle'
> & {
  readonly alpaca?: Pick<NonNullable<RuntimeConfig['alpaca']>, 'expectedAccountId' | 'authorityGenerationHash'>
}
