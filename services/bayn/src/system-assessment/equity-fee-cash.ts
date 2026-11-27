import { Result, Schema } from 'effect'

import { brokerFeeCashDeltaMicros, StoredFeeSchema } from '../accounting/broker-fees'
import { StoredCashSettlementSchema } from '../accounting/cash-settlement'
import { verifyAccountingTransactionContent } from '../accounting/domain'
import { AccountingTransactionSchema } from '../accounting/schema'
import { NonTradeActivityStatementSchema, type verifyNonTradeActivityStatement } from '../broker/alpaca/model'
import { decimalToMicrosResult } from '../broker/alpaca/normalizers'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { BrokerEnvironment, BrokerIdentitySchema } from '../broker/identity'
import { StoredAccrual } from '../db/fee-accruals'
import type { ExecutionModel } from '../execution-model-contract'
import { canonicalHashV1Result } from '../hash'
import { instrumentMarket, MarketKind } from '../instruments'
import { JevResearchPolicy } from '../jev/acceptance'
import { quantityScale } from '../quantity'
import { IsoDateSchema, NonNegativeIntegerSchema, StrictNonEmptyStringSchema, UtcInstantSchema } from '../schemas'
import { calculateSessionFees, equityTafRate } from '../strategy/execution-model/fees'
import { accountTradingDate } from '../time'
import { cashSettlementMatches, FeeSettlementAnchorsSchema } from './cash-settlements'
import { SystemAssessmentError } from './economics'
import type { SystemRegistration } from './policy'
import type { SystemSourceCut } from './source-cut'
import type { AccountMarkSchema } from './valuation'

const RetainedCashLedger = Schema.Struct({
  account: Schema.Struct({ accountId: StrictNonEmptyStringSchema }),
  accountTransactions: Schema.optionalKey(Schema.Array(AccountingTransactionSchema)),
  accountCashSettlements: Schema.optionalKey(Schema.Array(StoredCashSettlementSchema)),
  accountFeeAccruals: Schema.optionalKey(Schema.Array(StoredAccrual)),
  accountBrokerFees: Schema.optionalKey(Schema.Array(StoredFeeSchema)),
  accountPositionCounts: Schema.optionalKey(
    Schema.Struct({
      reconciledAt: UtcInstantSchema,
      exact: Schema.Boolean,
    }),
  ),
  ledgerExact: Schema.Boolean,
  accountingReceiptsExact: Schema.Boolean,
  missingLedgerAccountCount: NonNegativeIntegerSchema,
  unresolvedMutationCount: NonNegativeIntegerSchema,
})

const RetainedCashAccount = Schema.Struct({
  policy: Schema.Enum(JevResearchPolicy),
  identity: BrokerIdentitySchema,
  capturedAt: Schema.optionalKey(UtcInstantSchema),
  forward: RetainedCashLedger,
  settlementAnchors: Schema.optionalKey(FeeSettlementAnchorsSchema),
  brokerNonTradeActivity: Schema.optionalKey(NonTradeActivityStatementSchema),
})

const decodeRetainedCashEvidence = Schema.decodeUnknownResult(
  Schema.Struct({
    accounts: Schema.optionalKey(Schema.Array(RetainedCashAccount).check(Schema.isMaxLength(4))),
  }),
)

export const registeredNativeCashAccounts = (
  registration: Pick<SystemRegistration, 'policies'>,
  cut: Pick<SystemSourceCut, 'asOf' | 'sourceMaterial'>,
) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const retained = yield* decodeRetainedCashEvidence(cut.sourceMaterial)
    const accounts = new Map<JevResearchPolicy, typeof RetainedCashAccount.Type>()
    for (const account of retained.accounts ?? []) {
      const definition = registration.policies.find((p) => p.policy === account.policy)
      const accountBindingHash = yield* canonicalHashV1Result({
        schemaVersion: 'bayn.inference-cost-account.v1',
        accountId: account.identity.accountId,
      })
      if (
        definition === undefined ||
        accounts.has(account.policy) ||
        account.identity.environment !== BrokerEnvironment.Sandbox ||
        account.forward.account.accountId !== account.identity.accountId ||
        accountBindingHash !== definition.accountBindingHash
      )
        return yield* fail('Native cash witnesses belong to a different registered account')
      const statement = account.brokerNonTradeActivity
      const observedAt = account.capturedAt ?? cut.asOf
      if (observedAt > cut.asOf) return yield* fail('Account snapshot occurs after its immutable source cut')
      if (
        statement !== undefined &&
        (statement.accountIdentityHash !== account.identity.identityHash || statement.observedAt > observedAt)
      )
        return yield* fail('Broker activity statement differs from its account or evidence cut')
      accounts.set(account.policy, account)
    }
    return accounts
  })

type CashPoint = {
  readonly at: string
  readonly tradeCashDeltaMicros: string
  readonly incurredFeesMicros: string
}

const timestamp = (at: string) => at.slice(0, 19) + '.' + at.slice(20, -1).padEnd(9, '0')
const isDate = Schema.is(IsoDateSchema)

/** Verify the flat-equity, late-posted fee case. Other movements and fee schedules need their own accounting proof. */
export const confirmEquityFeeCash = (
  session: {
    readonly sessionDate: typeof IsoDateSchema.Type
    readonly openAt: string
    readonly closeAt: string
    readonly recoveryCloseAt: string
  },
  accountBindingHash: string,
  model: Pick<ExecutionModel, 'fees'>,
  forward: typeof RetainedCashLedger.Type,
  evidence: {
    readonly asOf: string
    readonly accountIdentityHash: string
    readonly anchors: typeof FeeSettlementAnchorsSchema.Type
    readonly statement: Result.Result.Success<ReturnType<typeof verifyNonTradeActivityStatement>>
  },
) =>
  Result.gen(function* () {
    const { sessionDate, openAt, closeAt, recoveryCloseAt } = session
    const { anchors, asOf, statement } = evidence
    const rows = anchors.filter((row) => row.sessionDate === sessionDate)
    const sessionAnchors = new Map(rows.map((row) => [row.phase, row]))
    const openingAnchor = sessionAnchors.get('OPENING')
    const opening = openingAnchor?.observation
    const recovery = sessionAnchors.get('RECOVERY')
    const reconciled = sessionAnchors.get('RECONCILED')
    const settled = reconciled?.observation
    const history = forward.accountTransactions
    const postingCut = forward.accountPositionCounts?.reconciledAt
    const tafRate = equityTafRate(model, sessionDate)
    if (
      rows.length !== 3 ||
      openingAnchor?.cutAt == null ||
      timestamp(openingAnchor.cutAt) !== timestamp(openAt) ||
      opening === undefined ||
      opening === null ||
      recovery?.observation == null ||
      recovery.cutAt === null ||
      timestamp(recovery.cutAt) !== timestamp(recoveryCloseAt) ||
      reconciled === undefined ||
      settled === undefined ||
      settled === null ||
      reconciled.cutAt === null ||
      reconciled.reconciliationHash === null ||
      statement.accountIdentityHash !== evidence.accountIdentityHash ||
      statement.observedAt > asOf ||
      statement.observedAt < closeAt ||
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
      model.fees.scheduleVersion !== 'alpaca-brokerage-effective-dated-2026-10-12' ||
      Result.isFailure(tafRate) ||
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

    const tafMinimumPriceAtoms = tafRate.success * 1_000n
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
          (row.side === 'SELL' && BigInt(row.priceAtoms) < tafMinimumPriceAtoms) ||
          row.feeMicros !== '0' ||
          Result.isFailure(verifyAccountingTransactionContent(row)) ||
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

    const symbol = fills[0]?.symbol ?? 'AAPL'
    const buy = { symbol, side: 'buy' as const, quantityAtoms: 0n, notionalMicros: 0n }
    const sell = { symbol, side: 'sell' as const, quantityAtoms: 0n, notionalMicros: 0n }
    const totals = [buy, sell]
    const tafCap = BigInt(model.fees.tafMaximumPerOrderMicros) * quantityScale
    const points: CashPoint[] = []
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
      // When even the combined sells fit under the cap, allocating partial fills to trades cannot affect TAF.
      if (sell.quantityAtoms * tafRate.success > tafCap) return null
      const priced = calculateSessionFees(totals, model, 1_000_000n, cryptoMaximumTakerFeeBps, sessionDate)
      if (Result.isFailure(priced)) return null
      fees = priced.success.totalMicros
      expectedAmounts = [
        priced.success.commissionMicros,
        priced.success.secMicros,
        priced.success.tafMicros,
        priced.success.catMicros,
      ]
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

type FeeAdjustedCash = Exclude<Result.Result.Success<ReturnType<typeof confirmEquityFeeCash>>, null>

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
