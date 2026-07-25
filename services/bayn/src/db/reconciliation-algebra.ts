import { Result, Schema } from 'effect'

import { rebuildAccountingLedger, type AccountingTransaction } from '../accounting'
import { MutationOperation } from '../broker/alpaca-mutations'
import type { RuntimeConfig } from '../config'
import { MutationEventType } from '../execution/mutations'
import { canonicalHashV1 } from '../hash'
import {
  Authority,
  AuthorityStateSchema,
  IntentState,
  KillState,
  OrderSide,
  OrderType,
  ReconciliationSchema,
  ReconciliationStatus,
  TerminalOutcome,
  TimeInForce,
  type AccountSnapshot,
  type AccountingReceipt,
  type Discrepancy,
  type Fill,
  type Order,
  type Position,
  type Reconciliation,
  type Valuation,
} from '../paper'
import {
  compareReconciliation,
  reconciledStateHash,
  type DurableFill,
  type IntentExpectation,
  type ProjectedPosition,
  type ReconciliationComparison,
  type ReconciliationRiskContext,
} from '../reconciliation'
import { strictParseOptions, type IsoDate } from '../schemas'

export interface IntentProjectionRow {
  readonly intent_id: string
  readonly client_order_id: string
  readonly symbol: string
  readonly side: OrderSide
  readonly order_type: OrderType
  readonly time_in_force: TimeInForce
  readonly quantity_micros: string
  readonly state: IntentState
  readonly terminal_outcome: TerminalOutcome | null
  readonly broker_order_id: string | null
  readonly mutation_operation: MutationOperation | null
  readonly mutation_event_type: MutationEventType | null
  readonly mutation_occurred_at: string | null
}

export interface IntentProjection {
  readonly intents: readonly IntentExpectation[]
  readonly unknownMutationCount: number
}

export interface OpeningCashRow {
  readonly cash_micros: string
  readonly observed_at: string
}

export interface ReconciliationSnapshotMaterial {
  readonly account: AccountSnapshot
  readonly positions: readonly Position[]
  readonly positionsObservedAt: string
  readonly orders: readonly Order[]
  readonly ordersObservedAt: string
  readonly fills: readonly Fill[]
  readonly valuation: Valuation
  readonly reconciledAt: string
}

export interface AccountingVerification {
  readonly exactReceipts: ReadonlyMap<string, boolean>
  readonly plans: readonly ReturnType<typeof rebuildAccountingLedger>[]
}

type AccountingLedgerIdentity = {
  readonly tigerBeetle: Pick<RuntimeConfig['tigerBeetle'], 'clusterId' | 'ledger'>
}

export interface AccountingComparison {
  readonly accountingHash: string
  readonly comparison: ReconciliationComparison
}

export interface AgedDiscrepancies {
  readonly discrepancies: readonly Discrepancy[]
  readonly status: ReconciliationStatus
}

export interface RiskContextRow {
  readonly trading_date: IsoDate
  readonly authority_schema_version: 'bayn.paper-authority.v1' | null
  readonly authority_generation_hash: string | null
  readonly authority_maximum: Authority | null
  readonly authority_effective: Authority | null
  readonly authority_kill: KillState | null
  readonly authority_reason: string | null
  readonly authority_version: string | null
  readonly authority_updated_at: Date | null
  readonly authority_observed_at: Date | null
  readonly daily_traded_notional_micros: string
  readonly day_start_equity_micros: string
  readonly peak_equity_micros: string
}

type AccountingProjectionOperation =
  | 'accounting-hash'
  | 'expected-cash'
  | 'reconciliation-comparison'
  | 'reconciled-state-hash'

type ReconciliationIdentityOperation = 'content-hash' | 'decode' | 'reconciliation-id'

export type ReconciliationAlgebraFailure =
  | {
      readonly _tag: 'AccountingPlanFailed'
      readonly transactionId: string
      readonly brokerEventId: string
      readonly cause: unknown
    }
  | { readonly _tag: 'DuplicateReceiptBrokerEvent'; readonly brokerEventId: string }
  | { readonly _tag: 'ReceiptVerificationFailed'; readonly brokerEventId: string; readonly cause: unknown }
  | {
      readonly _tag: 'AccountingPredatesOpeningCash'
      readonly transactionId: string
      readonly transactionOccurredAt: string
      readonly openingObservedAt: string
    }
  | {
      readonly _tag: 'AccountingProjectionFailed'
      readonly operation: AccountingProjectionOperation
      readonly cause: unknown
    }
  | {
      readonly _tag: 'DuplicateReconciliationDiscrepancy'
      readonly source: 'current' | 'previous'
      readonly discrepancyId: string
    }
  | {
      readonly _tag: 'ReconciliationIdentityFailed'
      readonly operation: ReconciliationIdentityOperation
      readonly cause: unknown
    }
  | {
      readonly _tag: 'StoredReconciliationMismatch'
      readonly reconciliationId: string
      readonly expectedContentHash: string
      readonly storedContentHash: string
    }
  | {
      readonly _tag: 'InvalidRiskContext'
      readonly reason:
        | 'authority-evidence-without-state'
        | 'authority-state-incomplete'
        | 'authority-update-after-observation'
        | 'authority-version-invalid'
      readonly details: Readonly<Record<string, unknown>>
    }
  | { readonly _tag: 'AuthorityStateDecodeFailed'; readonly cause: unknown }
  | {
      readonly _tag: 'RiskContextTimestampFailed'
      readonly field: 'authority_observed_at' | 'authority_updated_at'
      readonly cause: unknown
    }

const unresolvedEvents = new Set<MutationEventType>([
  MutationEventType.SubmitStarted,
  MutationEventType.SubmitUnknown,
  MutationEventType.RecoveryNotFound,
  MutationEventType.RecoveryUnknown,
  MutationEventType.CancelStarted,
  MutationEventType.CancelAccepted,
  MutationEventType.CancelUnknown,
])

const decodeAuthorityState = Schema.decodeUnknownResult(AuthorityStateSchema, strictParseOptions)
const decodeReconciliation = Schema.decodeUnknownResult(ReconciliationSchema, strictParseOptions)

const fail = (failure: ReconciliationAlgebraFailure): Result.Result<never, ReconciliationAlgebraFailure> =>
  Result.fail(failure)

export const projectIntentExpectations = (
  rows: readonly IntentProjectionRow[],
): Result.Result<IntentProjection, ReconciliationAlgebraFailure> => {
  const intents: readonly IntentExpectation[] = rows.map((row) => ({
    intentId: row.intent_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side,
    orderType: row.order_type,
    timeInForce: row.time_in_force,
    quantityMicros: row.quantity_micros,
    state: row.state,
    ...(row.terminal_outcome === null ? {} : { terminalOutcome: row.terminal_outcome }),
    expectsBrokerOrder: row.broker_order_id !== null,
    ...(row.broker_order_id === null ? {} : { brokerOrderId: row.broker_order_id }),
    ...(row.mutation_event_type !== null &&
    (unresolvedEvents.has(row.mutation_event_type) ||
      (row.mutation_operation === MutationOperation.Cancel &&
        row.mutation_event_type === MutationEventType.RecoveryFound &&
        row.state !== IntentState.Terminal)) &&
    row.mutation_occurred_at !== null
      ? { unknownSince: row.mutation_occurred_at }
      : {}),
  }))
  return Result.succeed({
    intents,
    unknownMutationCount: intents.filter((intent) => intent.unknownSince !== undefined).length,
  })
}

export const canonicalAccountingReceiptMaterial = (receipt: AccountingReceipt) => ({
  schemaVersion: receipt.schemaVersion,
  ...(receipt.intentId === undefined ? {} : { intentId: receipt.intentId }),
  brokerEventId: receipt.brokerEventId,
  tigerBeetleClusterId: receipt.tigerBeetleClusterId,
  tigerBeetleLedger: receipt.tigerBeetleLedger,
  accountIds: receipt.accountIds,
  transferIds: receipt.transferIds,
  debitMicros: receipt.debitMicros,
  creditMicros: receipt.creditMicros,
})

const receiptMatches = (
  transaction: AccountingTransaction,
  receipt: AccountingReceipt | undefined,
  plan: ReturnType<typeof rebuildAccountingLedger>,
  config: AccountingLedgerIdentity,
): Result.Result<boolean, ReconciliationAlgebraFailure> => {
  if (receipt === undefined) return Result.succeed(false)
  return Result.try({
    try: () => {
      const accountIds = plan.accounts.map((account) => account.id.toString())
      const transferIds = plan.transfers.map((transfer) => transfer.id.toString())
      const posted = plan.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n).toString()
      return (
        receipt.brokerEventId === transaction.brokerEventId &&
        receipt.intentId === transaction.intentId &&
        receipt.tigerBeetleClusterId === config.tigerBeetle.clusterId.toString() &&
        receipt.tigerBeetleLedger === config.tigerBeetle.ledger &&
        receipt.debitMicros === posted &&
        receipt.creditMicros === posted &&
        receipt.accountIds.length === accountIds.length &&
        receipt.accountIds.every((value, index) => value === accountIds[index]) &&
        receipt.transferIds.length === transferIds.length &&
        receipt.transferIds.every((value, index) => value === transferIds[index]) &&
        canonicalHashV1(canonicalAccountingReceiptMaterial(receipt)) === receipt.contentHash
      )
    },
    catch: (cause): ReconciliationAlgebraFailure => ({
      _tag: 'ReceiptVerificationFailed',
      brokerEventId: transaction.brokerEventId,
      cause,
    }),
  })
}

export const verifyAccountingReceipts = (
  transactions: readonly AccountingTransaction[],
  receipts: readonly AccountingReceipt[],
  config: AccountingLedgerIdentity,
): Result.Result<AccountingVerification, ReconciliationAlgebraFailure> =>
  Result.gen(function* () {
    const receiptBrokerEvents = new Set<string>()
    for (const receipt of receipts) {
      if (receiptBrokerEvents.has(receipt.brokerEventId)) {
        return yield* fail({ _tag: 'DuplicateReceiptBrokerEvent', brokerEventId: receipt.brokerEventId })
      }
      receiptBrokerEvents.add(receipt.brokerEventId)
    }
    const receiptsByEvent = new Map(receipts.map((receipt) => [receipt.brokerEventId, receipt]))
    const planned: {
      readonly transaction: AccountingTransaction
      readonly plan: ReturnType<typeof rebuildAccountingLedger>
    }[] = []
    for (const transaction of transactions) {
      planned.push({
        transaction,
        plan: yield* Result.try({
          try: () => rebuildAccountingLedger(transaction, config.tigerBeetle.ledger),
          catch: (cause): ReconciliationAlgebraFailure => ({
            _tag: 'AccountingPlanFailed',
            transactionId: transaction.transactionId,
            brokerEventId: transaction.brokerEventId,
            cause,
          }),
        }),
      })
    }

    const exactReceipts = new Map<string, boolean>()
    for (const { transaction, plan } of planned) {
      exactReceipts.set(
        transaction.brokerEventId,
        yield* receiptMatches(transaction, receiptsByEvent.get(transaction.brokerEventId), plan, config),
      )
    }
    return { exactReceipts, plans: planned.map(({ plan }) => plan) }
  })

const accountingProjection = <A>(
  operation: AccountingProjectionOperation,
  evaluate: () => A,
): Result.Result<A, ReconciliationAlgebraFailure> =>
  Result.try({
    try: evaluate,
    catch: (cause): ReconciliationAlgebraFailure => ({ _tag: 'AccountingProjectionFailed', operation, cause }),
  })

export const compareOpeningCash = (input: {
  readonly accountId: string
  readonly openingCash: OpeningCashRow
  readonly transactions: readonly AccountingTransaction[]
  readonly receipts: readonly AccountingReceipt[]
  readonly ledgerExact: boolean
  readonly snapshot: ReconciliationSnapshotMaterial
  readonly intents: readonly IntentExpectation[]
  readonly durableFills: readonly DurableFill[]
  readonly projectedPositions: readonly ProjectedPosition[]
}): Result.Result<AccountingComparison, ReconciliationAlgebraFailure> =>
  Result.gen(function* () {
    const predecessor = input.transactions.find((transaction) => transaction.occurredAt < input.openingCash.observed_at)
    if (predecessor !== undefined) {
      return yield* fail({
        _tag: 'AccountingPredatesOpeningCash',
        transactionId: predecessor.transactionId,
        transactionOccurredAt: predecessor.occurredAt,
        openingObservedAt: input.openingCash.observed_at,
      })
    }
    const expectedCashMicros = yield* accountingProjection('expected-cash', () =>
      input.transactions
        .reduce(
          (cash, transaction) => cash + BigInt(transaction.cashDeltaMicros),
          BigInt(input.openingCash.cash_micros),
        )
        .toString(),
    )
    const accountingHash = yield* accountingProjection('accounting-hash', () =>
      canonicalHashV1({
        schemaVersion: 'bayn.paper-accounting-state.v1',
        accountId: input.accountId,
        openingCash: input.openingCash,
        transactions: input.transactions,
        receipts: input.receipts,
        ledgerExact: input.ledgerExact,
      }),
    )
    const stateHash = yield* accountingProjection('reconciled-state-hash', () =>
      reconciledStateHash({
        account: input.snapshot.account,
        positions: input.snapshot.positions,
        positionsObservedAt: input.snapshot.positionsObservedAt,
        orders: input.snapshot.orders,
        ordersObservedAt: input.snapshot.ordersObservedAt,
        accountingHash,
      }),
    )
    const comparison = yield* accountingProjection('reconciliation-comparison', () =>
      compareReconciliation({
        accountId: input.accountId,
        stateHash,
        account: input.snapshot.account,
        positions: input.snapshot.positions,
        orders: input.snapshot.orders,
        fills: input.snapshot.fills,
        intents: input.intents,
        durableFills: input.durableFills,
        projectedPositions: input.projectedPositions,
        expectedCashMicros,
        valuation: input.snapshot.valuation,
        accountingHash,
        ledgerExact: input.ledgerExact,
        reconciledAt: input.snapshot.reconciledAt,
      }),
    )
    return { accountingHash, comparison }
  })

export const ageDiscrepancies = (
  comparison: ReconciliationComparison,
  previous: readonly Discrepancy[],
  reconciledAt: string,
): Result.Result<AgedDiscrepancies, ReconciliationAlgebraFailure> => {
  const prior = new Map<string, Discrepancy>()
  for (const discrepancy of previous) {
    if (prior.has(discrepancy.discrepancyId)) {
      return fail({
        _tag: 'DuplicateReconciliationDiscrepancy',
        source: 'previous',
        discrepancyId: discrepancy.discrepancyId,
      })
    }
    prior.set(discrepancy.discrepancyId, discrepancy)
  }

  const current = new Set<string>()
  const discrepancies: Discrepancy[] = []
  for (const discrepancy of comparison.discrepancies) {
    if (current.has(discrepancy.discrepancyId)) {
      return fail({
        _tag: 'DuplicateReconciliationDiscrepancy',
        source: 'current',
        discrepancyId: discrepancy.discrepancyId,
      })
    }
    current.add(discrepancy.discrepancyId)
    discrepancies.push({
      ...discrepancy,
      firstObservedAt: prior.get(discrepancy.discrepancyId)?.firstObservedAt ?? reconciledAt,
      lastObservedAt: reconciledAt,
    })
  }
  return Result.succeed({
    discrepancies,
    status: discrepancies.length === 0 ? ReconciliationStatus.Exact : ReconciliationStatus.Discrepancy,
  })
}

const reconciliationIdentity = <A>(
  operation: ReconciliationIdentityOperation,
  evaluate: () => A,
): Result.Result<A, ReconciliationAlgebraFailure> =>
  Result.try({
    try: evaluate,
    catch: (cause): ReconciliationAlgebraFailure => ({ _tag: 'ReconciliationIdentityFailed', operation, cause }),
  })

export const makeReconciliationIdentity = (input: {
  readonly accountId: string
  readonly comparison: ReconciliationComparison
  readonly aged: AgedDiscrepancies
  readonly reconciledAt: string
}): Result.Result<Reconciliation, ReconciliationAlgebraFailure> =>
  Result.gen(function* () {
    const material = {
      schemaVersion: 'bayn.paper-reconciliation.v1' as const,
      accountId: input.accountId,
      expectedHash: input.comparison.expectedHash,
      observedHash: input.comparison.observedHash,
      status: input.aged.status,
      discrepancies: input.aged.discrepancies,
      reconciledAt: input.reconciledAt,
    }
    const reconciliationId = yield* reconciliationIdentity('reconciliation-id', () =>
      canonicalHashV1({
        schemaVersion: 'bayn.paper-reconciliation-id.v1',
        material,
      }),
    )
    const contentHash = yield* reconciliationIdentity('content-hash', () =>
      canonicalHashV1({ ...material, reconciliationId }),
    )
    const decoded = decodeReconciliation({ ...material, reconciliationId, contentHash })
    if (Result.isFailure(decoded)) {
      return yield* fail({
        _tag: 'ReconciliationIdentityFailed',
        operation: 'decode',
        cause: decoded.failure,
      })
    }
    return decoded.success
  })

export const decideReconciliation = (input: {
  readonly accountId: string
  readonly comparison: ReconciliationComparison
  readonly previous: readonly Discrepancy[]
  readonly reconciledAt: string
}): Result.Result<Reconciliation, ReconciliationAlgebraFailure> =>
  Result.gen(function* () {
    const aged = yield* ageDiscrepancies(input.comparison, input.previous, input.reconciledAt)
    return yield* makeReconciliationIdentity({ ...input, aged })
  })

export const validateReconciliationReadback = (
  reconciliation: Reconciliation,
  storedContentHash: string,
): Result.Result<void, ReconciliationAlgebraFailure> =>
  storedContentHash === reconciliation.contentHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'StoredReconciliationMismatch',
        reconciliationId: reconciliation.reconciliationId,
        expectedContentHash: reconciliation.contentHash,
        storedContentHash,
      })

const timestamp = (
  field: 'authority_observed_at' | 'authority_updated_at',
  value: Date,
): Result.Result<string, ReconciliationAlgebraFailure> =>
  Result.try({
    try: () => value.toISOString(),
    catch: (cause): ReconciliationAlgebraFailure => ({ _tag: 'RiskContextTimestampFailed', field, cause }),
  })

const riskMaterial = (row: RiskContextRow, unknownMutationCount: number) => ({
  tradingDate: row.trading_date,
  unknownMutationCount,
  dailyTradedNotionalMicros: row.daily_traded_notional_micros,
  dayStartEquityMicros: row.day_start_equity_micros,
  peakEquityMicros: row.peak_equity_micros,
})

export const riskContextFromRow = (
  row: RiskContextRow,
  unknownMutationCount: number,
): Result.Result<ReconciliationRiskContext, ReconciliationAlgebraFailure> =>
  Result.gen(function* () {
    const authorityMissing =
      row.authority_schema_version === null &&
      row.authority_generation_hash === null &&
      row.authority_maximum === null &&
      row.authority_effective === null &&
      row.authority_kill === null &&
      row.authority_version === null &&
      row.authority_updated_at === null
    if (authorityMissing) {
      if (row.authority_reason !== null || row.authority_observed_at !== null) {
        return yield* fail({
          _tag: 'InvalidRiskContext',
          reason: 'authority-evidence-without-state',
          details: {
            authorityReasonPresent: row.authority_reason !== null,
            authorityObservedAtPresent: row.authority_observed_at !== null,
          },
        })
      }
      return { ...riskMaterial(row, unknownMutationCount), authority: null, authorityObservedAt: null }
    }

    const missingFields: string[] = []
    if (row.authority_schema_version === null) missingFields.push('authority_schema_version')
    if (row.authority_generation_hash === null) missingFields.push('authority_generation_hash')
    if (row.authority_maximum === null) missingFields.push('authority_maximum')
    if (row.authority_effective === null) missingFields.push('authority_effective')
    if (row.authority_kill === null) missingFields.push('authority_kill')
    if (row.authority_version === null) missingFields.push('authority_version')
    if (row.authority_updated_at === null) missingFields.push('authority_updated_at')
    if (row.authority_observed_at === null) missingFields.push('authority_observed_at')
    if (
      row.authority_schema_version === null ||
      row.authority_generation_hash === null ||
      row.authority_maximum === null ||
      row.authority_effective === null ||
      row.authority_kill === null ||
      row.authority_version === null ||
      row.authority_updated_at === null ||
      row.authority_observed_at === null
    ) {
      return yield* fail({
        _tag: 'InvalidRiskContext',
        reason: 'authority-state-incomplete',
        details: { missingFields },
      })
    }

    const version = Number(row.authority_version)
    if (!Number.isSafeInteger(version) || version <= 0) {
      return yield* fail({
        _tag: 'InvalidRiskContext',
        reason: 'authority-version-invalid',
        details: { authorityVersion: row.authority_version },
      })
    }

    const authorityUpdatedAt = yield* timestamp('authority_updated_at', row.authority_updated_at)
    const decodedAuthority = decodeAuthorityState({
      schemaVersion: row.authority_schema_version,
      generationHash: row.authority_generation_hash,
      maximum: row.authority_maximum,
      effective: row.authority_effective,
      kill: row.authority_kill,
      ...(row.authority_reason === null ? {} : { reason: row.authority_reason }),
      version,
      updatedAt: authorityUpdatedAt,
    })
    if (Result.isFailure(decodedAuthority)) {
      return yield* fail({ _tag: 'AuthorityStateDecodeFailed', cause: decodedAuthority.failure })
    }
    const authorityObservedAt = yield* timestamp('authority_observed_at', row.authority_observed_at)
    if (decodedAuthority.success.updatedAt > authorityObservedAt) {
      return yield* fail({
        _tag: 'InvalidRiskContext',
        reason: 'authority-update-after-observation',
        details: { authorityUpdatedAt: decodedAuthority.success.updatedAt, authorityObservedAt },
      })
    }
    return {
      ...riskMaterial(row, unknownMutationCount),
      authority: decodedAuthority.success,
      authorityObservedAt,
    }
  })

interface ReconciliationAlgebraFailureDetails {
  readonly failure: 'decode' | 'invariant'
  readonly message: string
  readonly cause: unknown
}

export const reconciliationAlgebraFailureDetails = (
  failure: ReconciliationAlgebraFailure,
): ReconciliationAlgebraFailureDetails => {
  switch (failure._tag) {
    case 'AccountingPlanFailed':
      return {
        failure: 'invariant',
        message: `accounting ledger plan verification failed for transaction ${failure.transactionId}`,
        cause: failure.cause,
      }
    case 'DuplicateReceiptBrokerEvent':
      return {
        failure: 'invariant',
        message: `duplicate accounting receipt broker event ${failure.brokerEventId}`,
        cause: failure,
      }
    case 'ReceiptVerificationFailed':
      return {
        failure: 'invariant',
        message: `accounting receipt verification failed for broker event ${failure.brokerEventId}`,
        cause: failure.cause,
      }
    case 'AccountingPredatesOpeningCash':
      return {
        failure: 'invariant',
        message: `accounting transaction ${failure.transactionId} predates the opening cash snapshot`,
        cause: failure,
      }
    case 'AccountingProjectionFailed':
      return {
        failure: 'invariant',
        message: `paper accounting ${failure.operation} computation failed`,
        cause: failure.cause,
      }
    case 'DuplicateReconciliationDiscrepancy':
      return {
        failure: 'invariant',
        message: `duplicate ${failure.source} reconciliation discrepancy ${failure.discrepancyId}`,
        cause: failure,
      }
    case 'ReconciliationIdentityFailed':
      return {
        failure: failure.operation === 'decode' ? 'decode' : 'invariant',
        message: `reconciliation ${failure.operation} computation failed`,
        cause: failure.cause,
      }
    case 'StoredReconciliationMismatch':
      return {
        failure: 'invariant',
        message: `stored reconciliation ${failure.reconciliationId} differs from deterministic replay`,
        cause: failure,
      }
    case 'InvalidRiskContext':
      return {
        failure: 'invariant',
        message: `reconciliation risk context is invalid: ${failure.reason}`,
        cause: failure,
      }
    case 'AuthorityStateDecodeFailed':
      return {
        failure: 'decode',
        message: 'durable reconciliation authority state is invalid',
        cause: failure.cause,
      }
    case 'RiskContextTimestampFailed':
      return {
        failure: 'invariant',
        message: `reconciliation risk context timestamp ${failure.field} is invalid`,
        cause: failure.cause,
      }
  }
}
