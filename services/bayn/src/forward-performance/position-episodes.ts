import { Result, Schema } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import { instrumentMarket, MarketKind } from '../instruments'
import { FeeReadEvidenceSchema } from '../accounting/broker-fees'
import type { AccountingTransaction } from '../accounting/schema'
import { IsoDateSchema, NonNegativeIntegerSchema, Sha256Schema } from '../schemas'
import type { ForwardPerformanceEvidenceInput } from './model'
import { PositionOutcomeSchema, PositionSymbolOutcomesSchema, summarizePositionOutcomes } from './position-outcomes'

export enum PositionEpisodeReason {
  HistoryUnavailable = 'HISTORY_UNAVAILABLE',
  ReconciliationGap = 'RECONCILIATION_GAP',
  InvalidHistory = 'INVALID_HISTORY',
  ScopeMismatch = 'SCOPE_MISMATCH',
  AmbiguousFillOrder = 'AMBIGUOUS_FILL_ORDER',
  FeeHistoryUnavailable = 'FEE_HISTORY_UNAVAILABLE',
  AmbiguousFeeOrder = 'AMBIGUOUS_FEE_ORDER',
}

const schemaVersion = 'bayn.position-episode-evidence.v4'

export const PositionEpisodeEvidenceSchema = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(schemaVersion),
    status: Schema.Literal('MEASURED'),
    evidenceHash: Sha256Schema,
    completedCount: NonNegativeIntegerSchema,
    openCount: NonNegativeIntegerSchema,
    crossScopeCount: NonNegativeIntegerSchema,
    completed: Schema.Array(PositionOutcomeSchema),
    bySymbol: Schema.Array(PositionSymbolOutcomesSchema),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(schemaVersion),
    status: Schema.Literal('UNDETERMINED'),
    evidenceHash: Schema.NullOr(Sha256Schema),
    reason: Schema.Enum(PositionEpisodeReason),
  }),
])

export type PositionEpisodeEvidence = typeof PositionEpisodeEvidenceSchema.Type

interface PositionEpisode {
  readonly quantity: bigint
  readonly openedAt: string
  readonly touchesScope: boolean
  readonly whollyInScope: boolean
  readonly trades: readonly AccountingTransaction[]
}

type CoinAccrual = NonNullable<ForwardPerformanceEvidenceInput['accountFeeAccruals']>[number]
type EpisodeEvent =
  | { readonly kind: 'FILL'; readonly occurredAt: string; readonly transaction: AccountingTransaction }
  | { readonly kind: 'COIN_FEE'; readonly occurredAt: string; readonly accrual: CoinAccrual }

const feeCohort = (symbol: string, date: string): string => JSON.stringify([symbol, date])

export const measurePositionEpisodes = (
  input: ForwardPerformanceEvidenceInput,
): Result.Result<PositionEpisodeEvidence, CanonicalHashFailure> =>
  Result.gen(function* () {
    const history = input.accountTransactions
    const unavailable = (
      reason: PositionEpisodeReason,
      evidenceHash: string | null = null,
    ): PositionEpisodeEvidence => ({
      schemaVersion,
      status: 'UNDETERMINED',
      evidenceHash,
      reason,
    })
    if (history === undefined) return unavailable(PositionEpisodeReason.HistoryUnavailable)

    const ordered = [...history].sort((left, right) =>
      left.occurredAt < right.occurredAt
        ? -1
        : left.occurredAt > right.occurredAt
          ? 1
          : left.transactionId < right.transactionId
            ? -1
            : left.transactionId > right.transactionId
              ? 1
              : 0,
    )
    const evidenceHash = yield* canonicalHashV1Result({
      schemaVersion,
      account: input.account,
      reconciliation: input.reconciliation ?? null,
      accountingReceiptsExact: input.accountingReceiptsExact,
      ledgerExact: input.ledgerExact,
      missingLedgerAccountCount: input.missingLedgerAccountCount,
      unresolvedMutationCount: input.unresolvedMutationCount,
      openPositionCount: input.openPositionCount,
      accountPositionCounts: input.accountPositionCounts ?? null,
      history: ordered,
      accountFeeAccruals:
        input.accountFeeAccruals === undefined
          ? null
          : [...input.accountFeeAccruals].sort((a, b) =>
              a.accrual_id < b.accrual_id ? -1 : a.accrual_id > b.accrual_id ? 1 : 0,
            ),
      accountBrokerFees:
        input.accountBrokerFees === undefined
          ? null
          : [...input.accountBrokerFees].sort((a, b) =>
              a.data.activityId < b.data.activityId ? -1 : a.data.activityId > b.data.activityId ? 1 : 0,
            ),
      selectedTransactions: [...input.transactions].sort((left, right) =>
        left.transactionId < right.transactionId ? -1 : left.transactionId > right.transactionId ? 1 : 0,
      ),
    })
    const reconciliation = input.reconciliation
    const accountCut = input.accountPositionCounts?.reconciledAt
    if (
      accountCut === undefined ||
      !Number.isFinite(Date.parse(accountCut)) ||
      input.accountPositionCounts?.exact !== true ||
      !input.accountingReceiptsExact ||
      !input.ledgerExact ||
      input.missingLedgerAccountCount !== 0 ||
      input.unresolvedMutationCount !== 0 ||
      reconciliation === undefined ||
      !reconciliation.performanceExact
    )
      return unavailable(PositionEpisodeReason.ReconciliationGap, evidenceHash)

    const historyById = new Map<string, (typeof history)[number]>()
    const brokerEvents = new Set<string>()
    const sidesByInstant = new Map<string, string>()
    for (const transaction of ordered) {
      if (
        transaction.accountId !== input.account.accountId ||
        historyById.has(transaction.transactionId) ||
        brokerEvents.has(transaction.brokerEventId) ||
        transaction.occurredAt > accountCut ||
        !/^[1-9][0-9]*$/.test(transaction.quantityAtoms) ||
        !/^-?[1-9][0-9]*$/.test(transaction.quantityDeltaAtoms) ||
        BigInt(transaction.quantityDeltaAtoms) !==
          BigInt(transaction.quantityAtoms) * (transaction.side === 'BUY' ? 1n : -1n)
      )
        return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
      const instantKey = JSON.stringify([transaction.symbol, transaction.occurredAt])
      const previousSide = sidesByInstant.get(instantKey)
      if (previousSide !== undefined && previousSide !== transaction.side) {
        return unavailable(PositionEpisodeReason.AmbiguousFillOrder, evidenceHash)
      }
      sidesByInstant.set(instantKey, transaction.side)
      historyById.set(transaction.transactionId, transaction)
      brokerEvents.add(transaction.brokerEventId)
    }

    const selectedIds = new Set<string>()
    for (const selected of input.transactions) {
      const transaction = historyById.get(selected.transactionId)
      if (
        selectedIds.has(selected.transactionId) ||
        transaction === undefined ||
        selected.brokerEventId !== transaction.brokerEventId ||
        selected.symbol !== transaction.symbol ||
        selected.side !== transaction.side ||
        selected.quantityAtoms !== transaction.quantityAtoms ||
        (selected.priceAtoms !== undefined && selected.priceAtoms !== transaction.priceAtoms) ||
        (selected.notionalMicros !== undefined && selected.notionalMicros !== transaction.notionalMicros) ||
        selected.feeMicros !== transaction.feeMicros ||
        selected.realizedPnlMicros !== transaction.realizedPnlMicros ||
        selected.occurredAt !== transaction.occurredAt
      )
        return unavailable(PositionEpisodeReason.ScopeMismatch, evidenceHash)
      selectedIds.add(selected.transactionId)
    }

    const events: EpisodeEvent[] = ordered.map((transaction) => ({
      kind: 'FILL',
      occurredAt: transaction.occurredAt,
      transaction,
    }))
    const hasCrypto = ordered.some((transaction) => instrumentMarket(transaction.symbol) === MarketKind.Crypto)
    if (hasCrypto && (input.accountFeeAccruals === undefined || input.accountBrokerFees === undefined))
      return unavailable(PositionEpisodeReason.FeeHistoryUnavailable, evidenceHash)

    const accrualIds = new Set<string>()
    const feeSources = new Set<string>()
    const feeInstants = new Set<string>()
    const matchedByCohort = new Map<string, bigint>()
    for (const accrual of input.accountFeeAccruals ?? []) {
      const data = accrual.data
      if (data.kind !== 'COIN') continue
      const settlementDate = Schema.decodeUnknownResult(IsoDateSchema)(accrual.settlement_date)
      if (
        Result.isFailure(settlementDate) ||
        data.accountId !== input.account.accountId ||
        !accrual.posted ||
        accrualIds.has(accrual.accrual_id) ||
        data.observedAt > accountCut ||
        accrual.coin_quantity_atoms === null ||
        !/^[1-9][0-9]*$/.test(accrual.coin_quantity_atoms) ||
        !/^(?:0|[1-9][0-9]*)$/.test(accrual.matched_coin_quantity_atoms) ||
        BigInt(accrual.matched_coin_quantity_atoms) > BigInt(accrual.coin_quantity_atoms) ||
        BigInt(data.projectedQuantityAtoms) - BigInt(data.observedQuantityAtoms) !==
          BigInt(accrual.coin_quantity_atoms) ||
        data.sourceTrades.length === 0
      )
        return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
      accrualIds.add(accrual.accrual_id)
      for (const source of data.sourceTrades) {
        const trade = historyById.get(source.transactionId)
        if (
          trade === undefined ||
          feeSources.has(source.transactionId) ||
          trade.side !== 'BUY' ||
          trade.symbol !== data.symbol ||
          trade.quantityAtoms !== source.quantityAtoms ||
          trade.priceAtoms !== source.priceAtoms ||
          trade.occurredAt.slice(0, 10) !== settlementDate.success ||
          trade.occurredAt > data.observedAt
        )
          return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
        feeSources.add(source.transactionId)
      }
      const instant = JSON.stringify([data.symbol, data.observedAt])
      if (sidesByInstant.has(instant) || feeInstants.has(instant))
        return unavailable(PositionEpisodeReason.AmbiguousFeeOrder, evidenceHash)
      feeInstants.add(instant)
      const cohort = feeCohort(data.symbol, settlementDate.success)
      matchedByCohort.set(cohort, (matchedByCohort.get(cohort) ?? 0n) + BigInt(accrual.matched_coin_quantity_atoms))
      events.push({ kind: 'COIN_FEE', occurredAt: data.observedAt, accrual })
    }
    const activityIds = new Set<string>()
    const activitiesByCohort = new Map<string, bigint>()
    for (const fee of input.accountBrokerFees ?? []) {
      const coin = fee.data.coinDebit
      if (coin === undefined) continue
      const readEvidence = Schema.decodeUnknownResult(FeeReadEvidenceSchema)(fee.read_evidence)
      if (
        Result.isFailure(readEvidence) ||
        fee.data.accountId !== input.account.accountId ||
        !fee.posted ||
        activityIds.has(fee.data.activityId) ||
        readEvidence.success.observedAt > accountCut ||
        !/^[1-9][0-9]*$/.test(coin.quantityAtoms)
      )
        return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
      activityIds.add(fee.data.activityId)
      const cohort = feeCohort(coin.symbol, readEvidence.success.sourceCreatedAt?.slice(0, 10) ?? fee.data.date)
      activitiesByCohort.set(cohort, (activitiesByCohort.get(cohort) ?? 0n) + BigInt(coin.quantityAtoms))
    }
    for (const cohort of new Set([...matchedByCohort.keys(), ...activitiesByCohort.keys()])) {
      // Source-day receipts settle accrual cohorts without supplying individual fee event times.
      // An unmatched activity cannot be assigned to an episode, even if its account total is known.
      const matched = matchedByCohort.get(cohort) ?? 0n
      const received = activitiesByCohort.get(cohort) ?? 0n
      if (received < matched) return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
      if (received > matched) return unavailable(PositionEpisodeReason.AmbiguousFeeOrder, evidenceHash)
    }

    const positions = new Map<string, PositionEpisode>()
    const completed: AccountingTransaction[][] = []
    let completedCount = 0
    let crossScopeCount = 0
    for (const event of events.sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
    )) {
      if (event.kind === 'COIN_FEE') {
        const data = event.accrual.data
        if (data.kind !== 'COIN') return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
        const previous = positions.get(data.symbol)
        if (
          previous === undefined ||
          previous.quantity !== BigInt(data.projectedQuantityAtoms) ||
          data.sourceTrades.some(
            (source) => (historyById.get(source.transactionId)?.occurredAt ?? '') < previous.openedAt,
          )
        )
          return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
        positions.set(data.symbol, { ...previous, quantity: BigInt(data.observedQuantityAtoms) })
        continue
      }
      const transaction = event.transaction
      const previous = positions.get(transaction.symbol)
      const selected = selectedIds.has(transaction.transactionId)
      const quantity = (previous?.quantity ?? 0n) + BigInt(transaction.quantityDeltaAtoms)
      if (quantity < 0n) return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
      const touchesScope = (previous?.touchesScope ?? false) || selected
      const whollyInScope = (previous?.whollyInScope ?? true) && selected
      const trades = [...(previous?.trades ?? []), transaction]
      if (quantity === 0n) {
        if (touchesScope) {
          if (whollyInScope) {
            completedCount += 1
            completed.push(trades)
          } else crossScopeCount += 1
        }
        positions.delete(transaction.symbol)
      } else
        positions.set(transaction.symbol, {
          quantity,
          openedAt: previous?.openedAt ?? transaction.occurredAt,
          touchesScope,
          whollyInScope,
          trades,
        })
    }
    const positionCounts = input.accountPositionCounts
    if (
      positionCounts === undefined ||
      positions.size !== positionCounts.postgres ||
      positions.size !== positionCounts.ledger
    )
      return unavailable(PositionEpisodeReason.ReconciliationGap, evidenceHash)
    let openCount = 0
    for (const position of positions.values()) {
      if (!position.touchesScope) continue
      openCount += 1
      if (!position.whollyInScope) crossScopeCount += 1
    }
    return {
      schemaVersion,
      status: 'MEASURED',
      evidenceHash,
      completedCount,
      openCount,
      crossScopeCount,
      ...summarizePositionOutcomes(completed, input),
    }
  })
