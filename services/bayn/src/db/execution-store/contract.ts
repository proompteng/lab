import { Context, Data, Effect } from 'effect'

import type { BrokerEventInput, FillEventInput, PositionSnapshotInput, ValuationInput } from '../../broker/observations'
import type { RuntimeConfig } from '../../config'
import type { WriterFence } from '../../execution/writer-fence'
import type {
  AccountingReceipt,
  Authority,
  AuthorityState,
  CapitalGrantGeneration,
  CapitalGrantProofBinding,
  ResearchCapitalGrantGeneration,
  ResearchCapitalGrantProofBinding,
  Valuation,
} from '../../execution/contracts'
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

export class ExecutionStoreError extends Data.TaggedError('ExecutionStoreError')<{
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

/**
 * The capital-grant lifecycle is the execution store's writer-fenced interpreter boundary. Its operations acquire the
 * process-wide WriterFence at invocation time; all other execution-store capabilities remain fence-free because they
 * do not own the authority-generation transaction.
 */
export type WriterFencedExecutionStoreOperation<A> = Effect.Effect<A, ExecutionStoreError, WriterFence>

export interface BrokerEventStoreShape {
  readonly ingest: (input: BrokerEventInput) => Effect.Effect<EventReceipt, ExecutionStoreError>
  readonly ingestPositions: (
    input: PositionSnapshotInput,
  ) => Effect.Effect<PositionSnapshotReceipt, ExecutionStoreError>
}

export interface FillAccountingStoreShape {
  readonly account: (input: FillEventInput) => Effect.Effect<AccountingReceipt, ExecutionStoreError>
}

export interface ValuationStoreShape {
  readonly value: (input: ValuationInput) => Effect.Effect<Valuation, ExecutionStoreError>
  readonly hasAccountBaseline: (accountId: string) => Effect.Effect<boolean, ExecutionStoreError>
}

export interface ReconciliationStoreShape {
  readonly bindings: (accountId: string) => Effect.Effect<readonly IntentBinding[], ExecutionStoreError>
  readonly reconcile: (snapshot: BrokerSnapshot) => Effect.Effect<ReconciliationWriteResult, ExecutionStoreError>
}

export interface AuthorityGenerationStoreShape {
  readonly ensureAuthorityGeneration: (
    input: EnsureAuthorityGenerationInput,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
  /** Read-only recovery view used to resume a durable PAPER close lease after process restart. */
  readonly readAuthorityState?: () => Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly readAuthorityGeneration?: (
    generationHash: string,
  ) => Effect.Effect<CapitalGrantGeneration | undefined, ExecutionStoreError>
  readonly readResearchAuthorityGeneration?: (
    generationHash: string,
  ) => Effect.Effect<ResearchCapitalGrantGeneration | undefined, ExecutionStoreError>
}

export interface CapitalGrantLifecycleStoreShape {
  /**
   * PREPARE operation: transactionally derives the stable canonical capital-grant generation identity plus current
   * reconciliation evidence without writing authority state or history. Commit only its generationHash to the later
   * capital-access configuration.
   */
  readonly prepareCapitalGrant: (
    proof: CapitalGrantProofBinding,
  ) => WriterFencedExecutionStoreOperation<CapitalGrantGeneration>
  /**
   * SUBMIT activation operation: transactionally re-derives the stable generation identity
   * from the same proof binding, requires its hash to equal the configured generationHash, and records the latest
   * fresh exact reconciliation as immutable activation evidence. This is the sole supported cross-generation
   * writer; application code and operators must not issue direct DML against authority_state or
   * authority_generations.
   */
  readonly activateCapitalGrant: (
    proof: CapitalGrantProofBinding,
  ) => WriterFencedExecutionStoreOperation<AuthorityState>
  /**
   * Atomically derives a reconciliation-bound research generation, records it, and activates PAPER authority. The
   * static request intentionally cannot predict this generation hash because reconciliation continues until the
   * activation transaction acquires its fence.
   */
  readonly activateResearchCapitalGrant: (
    proof: ResearchCapitalGrantProofBinding,
  ) => WriterFencedExecutionStoreOperation<AuthorityState>
}

export interface AuthorityRestrictionStoreShape {
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, ExecutionStoreError>
}

export class BrokerEventStore extends Context.Service<BrokerEventStore, BrokerEventStoreShape>()(
  'bayn/BrokerEventStore',
) {}
export class FillAccountingStore extends Context.Service<FillAccountingStore, FillAccountingStoreShape>()(
  'bayn/FillAccountingStore',
) {}
export class ValuationStore extends Context.Service<ValuationStore, ValuationStoreShape>()('bayn/ValuationStore') {}
export class ReconciliationStore extends Context.Service<ReconciliationStore, ReconciliationStoreShape>()(
  'bayn/ReconciliationStore',
) {}
export class AuthorityGenerationStore extends Context.Service<
  AuthorityGenerationStore,
  AuthorityGenerationStoreShape
>()('bayn/AuthorityGenerationStore') {}
export class CapitalGrantLifecycleStore extends Context.Service<
  CapitalGrantLifecycleStore,
  CapitalGrantLifecycleStoreShape
>()('bayn/CapitalGrantLifecycleStore') {}
export class AuthorityRestrictionStore extends Context.Service<
  AuthorityRestrictionStore,
  AuthorityRestrictionStoreShape
>()('bayn/AuthorityRestrictionStore') {}

export interface ReconciliationPersistence {
  readonly events: BrokerEventStoreShape
  readonly accounting: FillAccountingStoreShape
  readonly valuation: ValuationStoreShape
  readonly reconciliation: ReconciliationStoreShape
  readonly authorityRestriction: AuthorityRestrictionStoreShape
}

export interface ExecutionPersistence extends ReconciliationPersistence {
  readonly authorityGeneration: AuthorityGenerationStoreShape
  readonly capitalGrantLifecycle: CapitalGrantLifecycleStoreShape
}

export type ExecutionStoreRuntimeConfig = Pick<
  RuntimeConfig,
  'build' | 'execution' | 'qualificationRunId' | 'reconciliationStaleThresholdMs' | 'tigerBeetle'
> & {
  readonly alpaca?:
    | Pick<NonNullable<RuntimeConfig['alpaca']>, 'expectedAccountId' | 'authorityGenerationHash'>
    | undefined
}
