import { Result, Schema } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import { NonNegativeIntegerSchema, Sha256Schema } from '../schemas'
import type { ForwardPerformanceEvidenceInput } from './model'

export enum PositionEpisodeReason {
  HistoryUnavailable = 'HISTORY_UNAVAILABLE',
  ReconciliationGap = 'RECONCILIATION_GAP',
  InvalidHistory = 'INVALID_HISTORY',
  ScopeMismatch = 'SCOPE_MISMATCH',
  AmbiguousFillOrder = 'AMBIGUOUS_FILL_ORDER',
}

const schemaVersion = 'bayn.position-episode-evidence.v1'

export const PositionEpisodeEvidenceSchema = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(schemaVersion),
    status: Schema.Literal('MEASURED'),
    evidenceHash: Sha256Schema,
    completedCount: NonNegativeIntegerSchema,
    openCount: NonNegativeIntegerSchema,
    crossScopeCount: NonNegativeIntegerSchema,
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
  readonly touchesScope: boolean
  readonly whollyInScope: boolean
}

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
      history: ordered,
      selectedTransactions: [...input.transactions].sort((left, right) =>
        left.transactionId < right.transactionId ? -1 : left.transactionId > right.transactionId ? 1 : 0,
      ),
    })
    const reconciliation = input.reconciliation
    if (
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
        transaction.occurredAt > reconciliation.reconciledAt ||
        !/^[1-9][0-9]*$/.test(transaction.quantityMicros) ||
        !/^-?[1-9][0-9]*$/.test(transaction.quantityDeltaMicros) ||
        BigInt(transaction.quantityDeltaMicros) !==
          BigInt(transaction.quantityMicros) * (transaction.side === 'BUY' ? 1n : -1n)
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
        selected.quantityMicros !== transaction.quantityMicros ||
        selected.occurredAt !== transaction.occurredAt
      )
        return unavailable(PositionEpisodeReason.ScopeMismatch, evidenceHash)
      selectedIds.add(selected.transactionId)
    }

    const positions = new Map<string, PositionEpisode>()
    let completedCount = 0
    let crossScopeCount = 0
    for (const transaction of ordered) {
      const previous = positions.get(transaction.symbol)
      const selected = selectedIds.has(transaction.transactionId)
      const quantity = (previous?.quantity ?? 0n) + BigInt(transaction.quantityDeltaMicros)
      if (quantity < 0n) return unavailable(PositionEpisodeReason.InvalidHistory, evidenceHash)
      const touchesScope = (previous?.touchesScope ?? false) || selected
      const whollyInScope = (previous?.whollyInScope ?? true) && selected
      if (quantity === 0n) {
        if (touchesScope) {
          if (whollyInScope) completedCount += 1
          else crossScopeCount += 1
        }
        positions.delete(transaction.symbol)
      } else positions.set(transaction.symbol, { quantity, touchesScope, whollyInScope })
    }
    if (positions.size !== input.openPositionCount)
      return unavailable(PositionEpisodeReason.ReconciliationGap, evidenceHash)
    let openCount = 0
    for (const position of positions.values()) {
      if (!position.touchesScope) continue
      openCount += 1
      if (!position.whollyInScope) crossScopeCount += 1
    }
    return { schemaVersion, status: 'MEASURED', evidenceHash, completedCount, openCount, crossScopeCount }
  })
