import { Result, Schema, type Effect } from 'effect'

import { brokerFeeCashDeltaMicros } from '../accounting/broker-fees'
import { decimalToMicrosResult } from '../broker/alpaca/normalizers'
import type { make } from '../broker/alpaca/http'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import type { ExecutionModel } from '../execution-model-contract'
import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import { canonicalHashV1Result } from '../hash'
import { instrumentMarket, MarketKind } from '../instruments'
import { IsoDateSchema, Sha256Schema, SignedMicrosSchema, UtcInstantSchema, UnsignedMicrosSchema } from '../schemas'
import { calculateSessionFees, equityTafRate } from '../strategy/execution-model/fees'
import { accountTradingDate } from '../time'
import { cashSettlementMatches } from './cash-settlements'
import type { readSystemFeeSettlementAnchors } from './capture-queries'
import type { AccountMarkSchema } from './valuation'

type ActivityStatement = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof make>>['nonTradeActivityStatement']>
>
type SettlementAnchors = Effect.Success<ReturnType<typeof readSystemFeeSettlementAnchors>>

export const FeeAdjustedCashSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.fee-adjusted-cash.v1'),
  sourceHash: Sha256Schema,
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  openAt: UtcInstantSchema,
  closeAt: UtcInstantSchema,
  availableAt: UtcInstantSchema,
  openingCashMicros: SignedMicrosSchema,
  points: Schema.Array(
    Schema.Struct({
      at: UtcInstantSchema,
      tradeCashDeltaMicros: SignedMicrosSchema,
      incurredFeesMicros: UnsignedMicrosSchema,
    }),
  ),
})
type FeeAdjustedCash = typeof FeeAdjustedCashSchema.Type

const timestamp = (at: string) => at.slice(0, 19) + '.' + at.slice(20, -1).padEnd(9, '0')
const isDate = Schema.is(IsoDateSchema)

/** Verify the flat-equity, late-posted fee case. Other movements and fee schedules need their own accounting proof. */
export const confirmEquityFeeCash = (
  session: { readonly sessionDate: FeeAdjustedCash['sessionDate']; readonly openAt: string; readonly closeAt: string },
  accountBindingHash: string,
  model: Pick<ExecutionModel, 'fees'>,
  forward: ForwardPerformanceEvidenceInput,
  evidence: {
    readonly asOf: string
    readonly accountIdentityHash: string
    readonly anchors: SettlementAnchors
    readonly statement: ActivityStatement
  },
) =>
  Result.gen(function* () {
    const { sessionDate, openAt, closeAt } = session
    const { anchors, asOf, statement } = evidence
    const opening = anchors.find((row) => row.phase === 'OPENING' && row.sessionDate === sessionDate)?.observation
    const recovery = anchors.find((row) => row.phase === 'RECOVERY' && row.sessionDate === sessionDate)
    const reconciled = anchors.find((row) => row.phase === 'RECONCILED' && row.sessionDate === sessionDate)
    const settled = reconciled?.observation
    const history = forward.accountTransactions
    const postingCut = forward.accountPositionCounts?.reconciledAt
    if (
      opening === undefined ||
      opening === null ||
      recovery?.observation == null ||
      recovery.cutAt === null ||
      reconciled === undefined ||
      settled === undefined ||
      settled === null ||
      reconciled.cutAt === null ||
      reconciled.reconciliationHash === null ||
      statement.accountIdentityHash !== evidence.accountIdentityHash ||
      statement.observedAt > asOf ||
      timestamp(statement.window.after) >= timestamp(opening.at) ||
      timestamp(statement.window.until) <= timestamp(reconciled.cutAt) ||
      timestamp(opening.availableAt) > timestamp(openAt) ||
      timestamp(opening.at) > timestamp(opening.availableAt) ||
      timestamp(recovery.observation.at) < timestamp(closeAt) ||
      timestamp(recovery.observation.at) > timestamp(recovery.observation.availableAt) ||
      timestamp(recovery.observation.availableAt) > timestamp(recovery.cutAt) ||
      timestamp(recovery.cutAt) > timestamp(settled.at) ||
      timestamp(settled.at) > timestamp(settled.availableAt) ||
      timestamp(settled.availableAt) > timestamp(reconciled.cutAt) ||
      accountTradingDate(settled.at) < sessionDate ||
      history === undefined ||
      forward.accountCashSettlements === undefined ||
      forward.accountFeeAccruals === undefined ||
      forward.accountBrokerFees === undefined ||
      postingCut === undefined ||
      !forward.ledgerExact ||
      !forward.accountingReceiptsExact ||
      forward.accountPositionCounts?.exact !== true ||
      timestamp(postingCut) < timestamp(reconciled.cutAt) ||
      forward.missingLedgerAccountCount !== 0 ||
      forward.unresolvedMutationCount !== 0 ||
      sessionDate < '2026-10-01' ||
      sessionDate >= '2027-01-01' ||
      Result.getOrElse(equityTafRate(model, sessionDate), () => -1n) !== 0n ||
      [opening, recovery.observation].some(
        (row) =>
          row.positions?.count !== 0 ||
          timestamp(row.positions.at) > timestamp(row.at) ||
          Date.parse(row.at) - Date.parse(row.positions.at) > maximumBrokerObservationAgeMs,
      ) ||
      settled.positions?.count !== 0 ||
      timestamp(settled.positions.at) > timestamp(reconciled.cutAt) ||
      Math.abs(Date.parse(settled.at) - Date.parse(settled.positions.at)) > maximumBrokerObservationAgeMs ||
      Date.parse(openAt) - Date.parse(opening.at) > maximumBrokerObservationAgeMs ||
      forward.accountFeeAccruals.some(
        (a) =>
          a.data.date === sessionDate ||
          (a.data.date < sessionDate &&
            (!a.posted ||
              (a.data.kind === 'CASH'
                ? a.cash_debit_micros !== a.matched_cash_micros
                : a.coin_quantity_atoms !== a.matched_coin_quantity_atoms))),
      ) ||
      forward.accountBrokerFees.some(
        (fee) =>
          fee.data.date < sessionDate &&
          (!fee.posted || timestamp(fee.read_evidence.observedAt) > timestamp(opening.at)),
      )
    )
      return null

    const period = history.filter(
      (trade) =>
        timestamp(trade.occurredAt) > timestamp(opening.at) && timestamp(trade.occurredAt) <= timestamp(settled.at),
    )
    const fills = history
      .filter((trade) => accountTradingDate(trade.occurredAt) === sessionDate)
      .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    const settlements = new Map(forward.accountCashSettlements.map((row) => [row.data.transactionId, row]))
    if (
      period.length !== fills.length ||
      settlements.size !== forward.accountCashSettlements.length ||
      new Set(fills.map((row) => row.transactionId)).size !== fills.length ||
      new Set(fills.map((row) => row.brokerEventId)).size !== fills.length ||
      fills.some(
        (row) =>
          row.occurredAt <= openAt ||
          row.occurredAt > closeAt ||
          instrumentMarket(row.symbol) !== MarketKind.Equity ||
          row.feeMicros !== '0' ||
          !cashSettlementMatches(row, settlements.get(row.transactionId), forward.account.accountId, postingCut),
      )
    )
      return null

    const recorded = new Map(forward.accountBrokerFees.map((fee) => [fee.data.activityId, fee]))
    const posted = new Map(reconciled.fees.map((fee) => [fee.activityId, fee]))
    const paidAmounts = []
    if (
      recorded.size !== forward.accountBrokerFees.length ||
      posted.size !== reconciled.fees.length ||
      new Set(statement.activities.map((row) => row.activityId)).size !== statement.activities.length
    )
      return null
    for (const row of statement.activities) {
      if (row.activityType !== 'FEE' || !isDate(row.date) || row.netAmount === null) return null
      const amount = decimalToMicrosResult(row.netAmount, true, 'fee amount')
      const receipt = recorded.get(row.activityId)
      if (
        Result.isFailure(amount) ||
        BigInt(amount.success) >= 0n ||
        receipt === undefined ||
        !receipt.posted ||
        receipt.data.accountId !== forward.account.accountId ||
        receipt.data.date !== row.date ||
        receipt.data.coinDebit !== undefined ||
        receipt.data.cryptoCashFee === true ||
        receipt.data.netAmountMicros !== amount.success ||
        brokerFeeCashDeltaMicros(receipt) !== amount.success ||
        receipt.matched_cash_micros !== '0' ||
        receipt.cash_match_corrections.length !== 0
      )
        return null
      if (row.date !== sessionDate) {
        if (
          timestamp(receipt.read_evidence.observedAt) > timestamp(opening.at) &&
          timestamp(receipt.read_evidence.observedAt) <= timestamp(reconciled.cutAt)
        )
          return null
        continue
      }
      const posting = posted.get(row.activityId)
      if (
        posting === undefined ||
        posting.postedAt === null ||
        posting.sourceHash !== receipt.content_hash ||
        timestamp(posting.availableAt) !== timestamp(receipt.read_evidence.observedAt) ||
        timestamp(posting.availableAt) <= timestamp(recovery.cutAt) ||
        timestamp(posting.availableAt) > timestamp(posting.postedAt) ||
        timestamp(posting.postedAt) > timestamp(settled.at)
      )
        return null
      paidAmounts.push(amount.success)
    }
    if (paidAmounts.length !== posted.size) return null

    // With zero TAF, all supported equity charges are linear in quantity or notional before account-level rounding.
    const symbol = fills[0]?.symbol ?? 'AAPL'
    const buy = { symbol, side: 'buy' as const, quantityAtoms: 0n, notionalMicros: 0n }
    const sell = { symbol, side: 'sell' as const, quantityAtoms: 0n, notionalMicros: 0n }
    const totals = [buy, sell]
    const points: FeeAdjustedCash['points'][number][] = []
    let tradeCash = 0n
    let fees = 0n
    let expectedAmounts: string[] = []
    for (const [index, fill] of fills.entries()) {
      const side = fill.side === 'BUY' ? buy : sell
      side.quantityAtoms += BigInt(fill.quantityAtoms)
      side.notionalMicros += BigInt(fill.notionalMicros)
      tradeCash +=
        BigInt(fill.cashDeltaMicros) + BigInt(settlements.get(fill.transactionId)?.rounding_delta_micros ?? '0')
      if (fills[index + 1]?.occurredAt === fill.occurredAt) continue
      const priced = calculateSessionFees(totals, model, 1_000_000n, cryptoMaximumTakerFeeBps, sessionDate)
      if (Result.isFailure(priced)) return null
      fees = priced.success.totalMicros
      expectedAmounts = [priced.success.commissionMicros, priced.success.secMicros, priced.success.catMicros]
        .filter((amount) => amount > 0n)
        .map((amount) => String(-amount))
      points.push({ at: fill.occurredAt, tradeCashDeltaMicros: String(tradeCash), incurredFeesMicros: String(fees) })
    }
    const openingCash = BigInt(opening.cashMicros)
    if (
      expectedAmounts.sort().join(',') !== paidAmounts.sort().join(',') ||
      BigInt(recovery.observation.cashMicros) !== openingCash + tradeCash ||
      BigInt(settled.cashMicros) !== openingCash + tradeCash - fees
    )
      return null
    return {
      schemaVersion: 'bayn.fee-adjusted-cash.v1' as const,
      sourceHash: yield* canonicalHashV1Result({
        schemaVersion: 'bayn.fee-adjusted-cash.v1',
        session,
        accountBindingHash,
        model,
        asOf,
        anchors,
        statement,
        fills,
        cashSettlements: fills.map((fill) => settlements.get(fill.transactionId) ?? null),
        fees: reconciled.fees.map((fee) => recorded.get(fee.activityId) ?? null),
        points,
      }),
      accountBindingHash,
      sessionDate,
      openAt,
      closeAt,
      availableAt: statement.observedAt,
      openingCashMicros: opening.cashMicros,
      points,
    }
  })

/** Use the confirmed economic cash path for assessment. Retain the physical marks in the source cut. */
export const projectFeeAdjustedCash = (marks: readonly (typeof AccountMarkSchema.Type)[], proof: FeeAdjustedCash) =>
  Result.gen(function* () {
    const opening = BigInt(proof.openingCashMicros)
    let cursor = 0
    let tradeCash = 0n
    let fees = 0n
    const projected = []
    if (
      proof.points.some(
        (point, index) =>
          point.at <= (proof.points[index - 1]?.at ?? proof.openAt) ||
          point.at > proof.closeAt ||
          BigInt(point.incurredFeesMicros) < BigInt(proof.points[index - 1]?.incurredFeesMicros ?? '0'),
      )
    )
      return []
    for (const [index, mark] of marks.entries()) {
      if (
        mark.at < (marks[index - 1]?.at ?? proof.openAt) ||
        mark.at > proof.closeAt ||
        mark.accountBindingHash !== proof.accountBindingHash
      )
        return []
      while (cursor < proof.points.length) {
        const point = proof.points[cursor]
        if (point === undefined || point.at > mark.at) break
        tradeCash = BigInt(point.tradeCashDeltaMicros)
        fees = BigInt(point.incurredFeesMicros)
        cursor++
      }
      const physicalCash = opening + tradeCash
      if (mark.cashMicros !== null && BigInt(mark.cashMicros) !== physicalCash) return []
      const cashMicros = String(physicalCash - fees)
      projected.push({
        ...mark,
        availableAt: mark.availableAt > proof.availableAt ? mark.availableAt : proof.availableAt,
        cashMicros,
        sourceHash: yield* canonicalHashV1Result({ mark, feeAdjustedCash: proof.sourceHash, cashMicros }),
      })
    }
    return projected
  })
