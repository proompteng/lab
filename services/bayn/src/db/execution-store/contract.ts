import { Context, Data, Effect } from 'effect'

import type { BrokerEventInput, FillEventInput, PositionSnapshotInput, ValuationInput } from '../../broker/observations'
import type { RuntimeConfig } from '../../config'
import type {
  AccountingReceipt,
  Authority,
  AuthorityState,
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
  readonly preserveCyclePlanHash?: string
}

export interface AuthorityGenerationLineage {
  readonly generationHash: string
  readonly previousGenerationHash: string | null
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
  /** Initializes the configured OBSERVE root only when no authority state exists; otherwise returns the current state. */
  readonly readOrInitializeObserveAuthority?: (
    input: EnsureAuthorityGenerationInput,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
  /** Read-only recovery view used to resume a durable execution close lease after process restart. */
  readonly readAuthorityState?: Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly readResearchAuthorityGeneration?: (
    generationHash: string,
  ) => Effect.Effect<ResearchCapitalGrantGeneration | undefined, ExecutionStoreError>
  readonly readAuthorityGenerationLineage?: (
    generationHash: string,
  ) => Effect.Effect<AuthorityGenerationLineage | undefined, ExecutionStoreError>
}

/** Domain operations; the live Layer captures the transaction-scoped PostgreSQL writer fence. */
export interface CapitalGrantLifecycleStoreShape {
  /**
   * Atomically derives a reconciliation-bound research generation, records it, and activates execution authority. The
   * static request intentionally cannot predict this generation hash because reconciliation continues until the
   * activation transaction acquires its fence. The source hash is the durable OBSERVE generation validated by the
   * caller and is checked again under the activation transaction lock. The immutable request cutoff is also checked
   * against the transaction-scoped activation instant immediately before any authority history/state write.
   */
  readonly activateResearchCapitalGrant: (
    proof: ResearchCapitalGrantProofBinding,
    sourceGenerationHash: string,
    cutoffAt: string,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
}

export interface AuthorityRestrictionStoreShape {
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, ExecutionStoreError>
}

export class BrokerEventStore extends Context.Service<BrokerEventStore, BrokerEventStoreShape>()(
  '@proompteng/bayn/db/execution-store/contract/BrokerEventStore',
) {}
export class FillAccountingStore extends Context.Service<FillAccountingStore, FillAccountingStoreShape>()(
  '@proompteng/bayn/db/execution-store/contract/FillAccountingStore',
) {}
export class ValuationStore extends Context.Service<ValuationStore, ValuationStoreShape>()(
  '@proompteng/bayn/db/execution-store/contract/ValuationStore',
) {}
export class ReconciliationStore extends Context.Service<ReconciliationStore, ReconciliationStoreShape>()(
  '@proompteng/bayn/db/execution-store/contract/ReconciliationStore',
) {}
export class AuthorityGenerationStore extends Context.Service<
  AuthorityGenerationStore,
  AuthorityGenerationStoreShape
>()('@proompteng/bayn/db/execution-store/contract/AuthorityGenerationStore') {}
export class CapitalGrantLifecycleStore extends Context.Service<
  CapitalGrantLifecycleStore,
  CapitalGrantLifecycleStoreShape
>()('@proompteng/bayn/db/execution-store/contract/CapitalGrantLifecycleStore') {}
export class AuthorityRestrictionStore extends Context.Service<
  AuthorityRestrictionStore,
  AuthorityRestrictionStoreShape
>()('@proompteng/bayn/db/execution-store/contract/AuthorityRestrictionStore') {}

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
  'build' | 'execution' | 'reconciliationStaleThresholdMs' | 'tigerBeetle'
> & {
  readonly alpaca?:
    | Pick<NonNullable<RuntimeConfig['alpaca']>, 'expectedAccountId' | 'authorityGenerationHash'>
    | undefined
}
