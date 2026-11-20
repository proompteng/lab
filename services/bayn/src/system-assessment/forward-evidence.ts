import { prepareValuationInventory } from './valuation'
import { captureCashHistory, CashHistorySchema } from './cash-history'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import { SystemAssessmentError } from './economics'

import { CapturedTradingFactsSchema } from './session'
import { nativeBrokerRecoveryClose, type ScheduledEvaluation } from './policy'
import { researchCapitalGenerationIsBoundToBuildLineage } from '../execution/configuration'
import type { SystemSourceCut } from './source-cut'
import { IsoDateSchema, Sha256Schema } from '../schemas'
import { cashSettlementMatches } from './cash-settlements'
import { brokerFeeCashDeltaMicros } from '../accounting/broker-fees'
import type { AccountingTransaction } from '../accounting/schema'
import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { instrumentMarket, MarketKind } from '../instruments'
import { calculateSessionFees } from '../strategy/execution-model/fees'
import { accountTradingDate } from '../time'

export const retainedFinancialMarks = (
  marks: SystemSourceCut['accountMarks'],
  scope: {
    readonly accountBindingHash: string
    readonly openAt: string
    readonly closeAt: string
    readonly asOf: string
  },
) =>
  marks
    .filter(
      (mark) =>
        mark.accountBindingHash === scope.accountBindingHash &&
        mark.at >= scope.openAt &&
        mark.at <= scope.closeAt &&
        mark.availableAt <= scope.asOf,
    )
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.sourceHash.localeCompare(b.sourceHash))

export const CapturedFinancialEvidenceSchema = Schema.Struct({
  policy: Schema.Enum(JevResearchPolicy),
  sourceHash: Sha256Schema,
  accountBindingHash: Sha256Schema,
  definitionHash: Sha256Schema,
  cashHistory: Schema.NullOr(CashHistorySchema),
  sessions: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      evidenceHash: Sha256Schema,
      facts: Schema.NullOr(CapturedTradingFactsSchema),
    }),
  ),
})

export const registeredFinancialAccounts = (
  registration: ScheduledEvaluation,
  captured: readonly (typeof CapturedFinancialEvidenceSchema.Type)[],
) =>
  Result.gen(function* () {
    const accounts = new Map<JevResearchPolicy, typeof CapturedFinancialEvidenceSchema.Type>()
    for (const account of captured) {
      const definition = registration.policies.find((p) => p.policy === account.policy)
      if (
        definition === undefined ||
        accounts.has(account.policy) ||
        definition.accountBindingHash !== account.accountBindingHash ||
        (yield* canonicalHashV1Result(definition)) !== account.definitionHash
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Captured financial policy differs from the registration' }),
        )
      if (
        account.sessions.length !== registration.calendar.sessions.length ||
        account.sessions.some(
          (session, index) => session.sessionDate !== registration.calendar.sessions[index]?.sessionDate,
        )
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Captured financial sessions differ from the registered calendar' }),
        )
      accounts.set(account.policy, account)
    }
    return accounts
  })

export type DecisionSessionBinding = { readonly decisionHash: string; readonly sessionDate: string }

const isEquityFee = (fee: { readonly coinDebit?: unknown; readonly cryptoCashFee?: true }) =>
  fee.coinDebit === undefined && fee.cryptoCashFee !== true

const hasExpectedEquityFeeReceipts = (
  registration: ScheduledEvaluation,
  forward: ForwardPerformanceEvidenceInput,
  fills: readonly AccountingTransaction[],
  sessionDate: string,
) => {
  const recorded = forward.accountBrokerFees?.filter(({ data }) => data.date === sessionDate && isEquityFee(data))
  const scoped = forward.brokerFees?.filter((fee) => fee.date === sessionDate && isEquityFee(fee))
  const reconciledAt = forward.accountPositionCounts?.reconciledAt
  if (recorded === undefined || scoped === undefined || reconciledAt === undefined || recorded.length !== scoped.length)
    return false
  const priced = calculateSessionFees(
    fills.map((fill) => ({
      symbol: fill.symbol,
      side: fill.side === 'BUY' ? 'buy' : 'sell',
      quantityAtoms: BigInt(fill.quantityAtoms),
      notionalMicros: BigInt(fill.notionalMicros),
    })),
    registration.obligations.configuration.protocol.executionModel,
    1_000_000n,
    cryptoMaximumTakerFeeBps,
    sessionDate,
  )
  if (Result.isFailure(priced)) return false
  const { commissionMicros, secMicros, tafMicros, catMicros } = priced.success
  const expected = [commissionMicros, secMicros, tafMicros, catMicros]
    .filter((amount) => amount > 0n)
    .map((amount) => String(-amount))
    .sort()
  const actual = recorded.map(({ data }) => data.netAmountMicros).sort()
  const byId = new Map(scoped.map((fee) => [fee.activityId, fee]))
  return (
    expected.length === actual.length &&
    expected.every((amount, index) => amount === actual[index]) &&
    byId.size === scoped.length &&
    new Set(recorded.map(({ data }) => data.activityId)).size === recorded.length &&
    recorded.every((record) => {
      const fee = byId.get(record.data.activityId)
      return (
        record.posted &&
        record.read_evidence.observedAt <= reconciledAt &&
        record.cash_match_corrections.every(
          (correction) => correction.posted && correction.data.readEvidence.observedAt <= reconciledAt,
        ) &&
        record.data.accountId === forward.account.accountId &&
        fee?.accountId === forward.account.accountId &&
        fee.netAmountMicros === brokerFeeCashDeltaMicros(record)
      )
    })
  )
}

/** Only financial facts read and independently checked by the existing PostgreSQL/TigerBeetle reader replace packet amounts. */
export const captureForwardFinancialEvidence = (
  registration: ScheduledEvaluation,
  policy: JevResearchPolicy,
  forward: ForwardPerformanceEvidenceInput,
  execution: {
    readonly decisions: readonly DecisionSessionBinding[]
    readonly fills: readonly Pick<SystemSourceCut['fills'][number], 'fillId' | 'occurredAt'>[]
  },
) =>
  Result.gen(function* () {
    const definition = registration.policies.find((p) => p.policy === policy)
    if (definition === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Registered financial policy is missing' }))
    const accountHash = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.inference-cost-account.v1',
      accountId: forward.account.accountId,
    })
    if (accountHash !== definition.accountBindingHash)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Forward evidence belongs to a different registered account' }),
      )
    const authorization = definition.capitalAuthorization
    if (authorization !== undefined) {
      const { request, buildLineage, generation } = authorization
      const bound = researchCapitalGenerationIsBoundToBuildLineage(
        buildLineage,
        request,
        {
          sourceRevision: definition.sourceRevision,
          imageRepository: buildLineage.activation.imageRepository,
          imageDigest: `sha256:${definition.imageDigest}`,
        },
        generation.previousGenerationHash,
        generation,
      )
      if (Result.isFailure(bound) || generation.generationHash !== definition.authorityGenerationHash)
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Forward authorization lineage differs from registration' }),
        )
    }
    if (
      forward.durableExecutionBindings.some(
        (binding) =>
          binding.sourceRevision !==
            (authorization?.generation.activationSourceRevision ?? definition.sourceRevision) ||
          binding.imageDigest.replace(/^sha256:/, '') !==
            (authorization?.generation.activationImageDigest.replace(/^sha256:/, '') ?? definition.imageDigest) ||
          (authorization !== undefined &&
            (binding.imageRepository !== authorization.generation.activationImageRepository ||
              binding.qualificationRunId !== authorization.generation.grant.planHash)) ||
          binding.accountId !== forward.account.accountId ||
          binding.accountReferenceHash !== forward.account.accountReferenceHash ||
          binding.provider !== forward.account.provider ||
          binding.environment !== forward.account.environment ||
          binding.strategyBehaviorHash !== definition.strategyHash ||
          binding.strategyParameterHash !== definition.parametersHash ||
          binding.strategyProtocolHash !== definition.protocolHash,
      )
    )
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Forward source, image, strategy or parameters differ from registration',
        }),
      )
    const history = forward.accountTransactions
    const selectedTransactionIds = new Set(forward.transactions.map((t) => t.transactionId))
    const inventory = yield* prepareValuationInventory(forward)
    const episodeEvidence = inventory.episodes
    const settlements = forward.accountCashSettlements
    const financialProofComplete =
      history !== undefined &&
      settlements !== undefined &&
      new Set(settlements.map((s) => s.data.transactionId)).size === settlements.length &&
      episodeEvidence.status === 'MEASURED' &&
      forward.accountingReceiptsExact &&
      forward.ledgerExact &&
      forward.missingLedgerAccountCount === 0 &&
      forward.reconciliation?.performanceExact === true &&
      forward.brokerFees !== undefined &&
      forward.brokerFeeAccruals !== undefined &&
      forward.accountFeeAccruals !== undefined
    const sourceHash = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.system-forward-source.v1',
      forward,
      execution,
    })
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (first === undefined || last === undefined)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Financial capture requires the registered calendar' }),
      )
    const dates = new Set<string>(registration.calendar.sessions.map((s) => s.sessionDate))
    const recoveryClose = nativeBrokerRecoveryClose(registration)
    const equityFillsByDate = new Map<string, AccountingTransaction[]>()
    if (recoveryClose !== undefined)
      for (const fill of history ?? []) {
        if (instrumentMarket(fill.symbol) !== MarketKind.Equity) continue
        const day = accountTradingDate(fill.occurredAt)
        if (!dates.has(day)) continue
        const entries = equityFillsByDate.get(day)
        if (entries === undefined) equityFillsByDate.set(day, [fill])
        else entries.push(fill)
      }
    const financialEnd = recoveryClose ?? last.closeAt
    const recoveryCovered =
      recoveryClose === undefined ||
      (forward.reconciliation !== null &&
        forward.reconciliation !== undefined &&
        Date.parse(forward.reconciliation.reconciledAt) >= Date.parse(recoveryClose))
    const windowTransactionIds = new Set(
      forward.transactions
        .filter((t) => t.occurredAt >= first.openAt && t.occurredAt <= financialEnd)
        .map((t) => t.transactionId),
    )
    const outsideSession =
      forward.transactions.some(
        (transaction) =>
          transaction.occurredAt >= first.openAt &&
          transaction.occurredAt <= financialEnd &&
          !registration.calendar.sessions.some(
            (s) => transaction.occurredAt >= s.openAt && transaction.occurredAt <= s.closeAt,
          ),
      ) ||
      (forward.brokerFees?.some(
        (fee) => fee.date >= first.sessionDate && fee.date <= last.sessionDate && !dates.has(fee.date),
      ) ??
        false) ||
      (forward.accountFeeAccruals?.some(
        (a) =>
          !dates.has(a.data.date) && a.data.sourceTrades.some((trade) => windowTransactionIds.has(trade.transactionId)),
      ) ??
        false)
    const sessions = []
    for (const calendar of registration.calendar.sessions) {
      const session = calendar
      const inSession = (at: string) =>
        Date.parse(at) >= Date.parse(calendar.openAt) && Date.parse(at) <= Date.parse(calendar.closeAt)
      const transactions = forward.transactions.filter((t) => inSession(t.occurredAt))
      const ids = new Set(transactions.map((t) => t.transactionId))
      const native = history?.filter((t) => ids.has(t.transactionId)) ?? []
      const accruals = forward.accountFeeAccruals?.filter((a) => a.data.date === session.sessionDate) ?? []
      const fees = forward.brokerFees?.filter((fee) => fee.date === session.sessionDate) ?? []
      const remainingAccruals =
        forward.brokerFeeAccruals?.filter((a) => accruals.some((row) => row.accrual_id === a.accrualId)) ?? []
      const rawFills = execution.fills.filter((fill) => inSession(fill.occurredAt))
      const equityFills = equityFillsByDate.get(session.sessionDate) ?? []
      const openingPositions = inventory.at(calendar.openAt)
      const closingPositions = inventory.at(calendar.closeAt)
      const openingPositionCount = openingPositions?.length
      const closingPositionCount = closingPositions?.length
      const settled = settlements?.filter((s) => ids.has(s.data.transactionId)) ?? []
      const rounding = settled.reduce((sum, s) => sum + BigInt(s.rounding_delta_micros), 0n)
      const gross = native.reduce((sum, t) => sum + BigInt(t.realizedPnlMicros), 0n)
      const cost =
        native.reduce((sum, t) => sum + BigInt(t.feeMicros), 0n) +
        fees.reduce((sum, fee) => sum - BigInt(fee.netAmountMicros) + BigInt(fee.inventoryCostMicros ?? '0'), 0n) +
        remainingAccruals.reduce((sum, a) => sum + BigInt(a.expenseMicros), 0n)
      const evidenceHash = yield* canonicalHashV1Result({
        sourceHash,
        sessionDate: session.sessionDate,
        transactions: native,
        fees,
        remainingAccruals,
        settlements: settled,
      })
      const complete =
        financialProofComplete &&
        recoveryCovered &&
        (recoveryClose === undefined ||
          (equityFills.every((fill) => inSession(fill.occurredAt) && ids.has(fill.transactionId)) &&
            hasExpectedEquityFeeReceipts(registration, forward, equityFills, session.sessionDate))) &&
        !outsideSession &&
        accruals.every(
          (a) =>
            a.data.sourceTrades.every((trade) => selectedTransactionIds.has(trade.transactionId)) &&
            remainingAccruals.some((summary) => summary.accrualId === a.accrual_id),
        ) &&
        native.length === transactions.length &&
        fees.every((fee) => fee.coinDebit === undefined || fee.inventoryCostMicros !== undefined) &&
        native.every((trade) =>
          cashSettlementMatches(
            trade,
            settled.find((settlement) => settlement.data.transactionId === trade.transactionId),
            forward.account.accountId,
            forward.accountPositionCounts?.reconciledAt ?? '',
          ),
        ) &&
        openingPositionCount !== undefined &&
        closingPositionCount !== undefined &&
        native.every((t) => t.occurredAt > calendar.openAt && rawFills.some((fill) => fill.fillId === t.brokerEventId))
      const financial = complete
        ? {
            grossRealizedPnlMicros: gross.toString(),
            executionCostMicros: cost.toString(),
            cashSettlementRoundingMicros: rounding.toString(),
            openingPositionCount,
            closingPositionCount,
            unsettledFillCount:
              rawFills.filter((fill) => !native.some((t) => t.brokerEventId === fill.fillId)).length +
              remainingAccruals.filter((a) => !a.settled).length,
            uncertainMutationCount: forward.unresolvedMutationCount,
            completedEpisodes:
              episodeEvidence.status === 'MEASURED'
                ? episodeEvidence.completed.filter((e) => inSession(e.openedAt) && inSession(e.closedAt)).length
                : 0,
            filledNotionalMicros: native.reduce((sum, t) => sum + BigInt(t.notionalMicros), 0n).toString(),
            decisionIds: execution.decisions
              .filter((d) => d.sessionDate === session.sessionDate)
              .map((d) => d.decisionHash),
            fillIds: rawFills.map((fill) => fill.fillId),
          }
        : null
      sessions.push({
        sessionDate: session.sessionDate,
        evidenceHash,
        facts: financial,
      })
    }
    return {
      policy,
      sourceHash,
      accountBindingHash: accountHash,
      definitionHash: yield* canonicalHashV1Result(definition),
      cashHistory: yield* captureCashHistory(forward, first.openAt),
      sessions,
    }
  })
