import { BigDecimal, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { decodeInferenceCostEvidence, makeInferenceCostReport, prepareInferenceRateCard } from '../inference-costs'
import { makeOperatingCostReport, OperatingCostEvidenceSchema } from '../operating-costs'
import { IsoDateSchema, Sha256Schema, SignedMicrosSchema, UnsignedMicrosSchema, UtcInstantSchema } from '../schemas'
import {
  cashInventoryTradingPnl,
  netTradingPnl,
  CashInventoryBridgeSchema,
  markedRisk,
  SystemAssessmentError,
} from './economics'
import { CashFlowEvidenceSchema, cashFlowTotals, cashFlowsSupported, cashFlowsMatchSession } from './cash-flows'
import type { SystemRegistration } from './policy'
import { costAttributionRule, indexOperatingCosts } from './cost-attribution'
import { validateFrozenCostAllocations } from './cost-allocation'

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))

export const CapturedTradingFactsSchema = Schema.Struct({
  grossRealizedPnlMicros: SignedMicrosSchema,
  executionCostMicros: SignedMicrosSchema,
  cashSettlementRoundingMicros: SignedMicrosSchema,
  openingPositionCount: Count,
  closingPositionCount: Count,
  unsettledFillCount: Count,
  uncertainMutationCount: Count,
  completedEpisodes: Count,
  filledNotionalMicros: UnsignedMicrosSchema,
  decisionIds: Schema.Array(Sha256Schema),
  fillIds: Schema.Array(Sha256Schema),
})

export const FinancialFactsSchema = Schema.Struct({
  ...CapturedTradingFactsSchema.fields,
  openingUnrealizedPnlMicros: SignedMicrosSchema,
  closingUnrealizedPnlMicros: SignedMicrosSchema,
})

export const SessionEvidenceSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  definitionHash: Sha256Schema,
  cashFlows: Schema.NullOr(CashFlowEvidenceSchema),
  financial: Schema.NullOr(
    Schema.Struct({
      ...FinancialFactsSchema.fields,
      sourceHash: Sha256Schema,
      cashInventory: CashInventoryBridgeSchema,
    }),
  ),
  inferenceEvidence: Schema.Unknown,
  inferenceRateCard: Schema.Unknown,
  operatingCosts: OperatingCostEvidenceSchema,
  marks: Schema.Array(
    Schema.Struct({
      at: UtcInstantSchema,
      sourceHash: Sha256Schema,
      cashFlowAdjustedTradingEquityMicros: SignedMicrosSchema,
    }),
  ),
  p95LatencyStress: Schema.NullOr(
    Schema.Struct({
      protocolHash: Sha256Schema,
      sourceHash: Sha256Schema,
      qualificationPnlMicros: SignedMicrosSchema,
      image: ReplayImageReceiptSchema,
      executionReceiptHash: Sha256Schema,
    }),
  ),
})

export type SessionEvidence = typeof SessionEvidenceSchema.Type

/** Reject conversion rather than silently changing a microdollar at the frozen estimator boundary. */
export const exactUsd = (micros: bigint) => {
  const value = Number(micros) / 1_000_000
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000)
    return Result.fail(new SystemAssessmentError({ message: 'Amount exceeds the frozen estimator domain' }))
  const roundtrip = BigDecimal.multiply(BigDecimal.fromNumberUnsafe(value), BigDecimal.fromBigInt(1_000_000n))
  if (!BigDecimal.equals(roundtrip, BigDecimal.fromBigInt(micros)))
    return Result.fail(new SystemAssessmentError({ message: 'Amount cannot cross the estimator boundary exactly' }))
  return Result.succeed(value)
}

export const assessSession = (
  session: SessionEvidence,
  registration: SystemRegistration,
  definition: SystemRegistration['policies'][number],
  asOf: string,
  verifiedSources: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const missing: string[] = []
    const violations: string[] = []
    const requireSource = (hash: string) => {
      if (!verifiedSources.has(hash)) missing.push(`UNVERIFIED_SOURCE:${hash}`)
    }
    const definitionHash = yield* canonicalHashV1Result(definition)
    if (session.definitionHash !== definitionHash) violations.push('POLICY_IDENTITY_MISMATCH')
    if (definition.costAllocationRuleHash !== (yield* canonicalHashV1Result(costAttributionRule)))
      violations.push('COST_ATTRIBUTION_RULE_MISMATCH')
    const calendar = registration.calendar.sessions.find((s) => s.sessionDate === session.sessionDate)
    if (calendar === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Session is outside the registered calendar' }))
    if (Date.parse(asOf) < Date.parse(calendar.closeAt)) {
      const evidenceHash = yield* canonicalHashV1Result({ session, asOf })
      return {
        sessionDate: session.sessionDate,
        evidenceHash,
        costs: null,
        netEconomicPnlMicros: null,
        qualificationPnlMicros: null,
        economicEvidenceComplete: false,
        missing: ['SESSION_NOT_CLOSED'],
        violations,
        numerical: { status: 'UNRESOLVED' as const, sessionDate: session.sessionDate, evidenceHash },
      }
    }
    const inference =
      session.inferenceEvidence === null
        ? null
        : yield* decodeInferenceCostEvidence(session.inferenceEvidence).pipe(
            Result.flatMap((evidence) => makeInferenceCostReport(evidence, session.inferenceRateCard)),
          )
    if (inference === null) missing.push('MISSING_INFERENCE_EVIDENCE')
    else {
      requireSource(inference.evidenceHash)
      requireSource(inference.rateCardHash)
      const registeredRates = yield* prepareInferenceRateCard(definition.inferenceRateCard)
      if (inference.rateCardHash !== registeredRates.rateCardHash)
        violations.push('INFERENCE_TARIFF_REGISTRATION_MISMATCH')
      if (
        inference.accountBindingHash !== definition.accountBindingHash ||
        inference.sessionDate !== session.sessionDate
      )
        violations.push('INFERENCE_SCOPE_MISMATCH')
    }
    if (Date.parse(session.operatingCosts.asOf) > Date.parse(asOf)) violations.push('FUTURE_COST_EVIDENCE')
    for (const source of yield* validateFrozenCostAllocations(registration.costAllocationPlans, session.operatingCosts))
      requireSource(source)
    const costs =
      inference === null ? null : yield* makeOperatingCostReport(inference, session.operatingCosts, verifiedSources)
    if (costs === null || !costs.fullyCosted) missing.push('INCOMPLETE_OPERATING_COSTS')
    if (costs === null || costs.qualificationInferenceCostMicros === null) missing.push('INCOMPLETE_INFERENCE_USAGE')
    const financial = session.financial
    if (session.cashFlows === null || !(yield* cashFlowsSupported(session.cashFlows, verifiedSources)))
      missing.push('INCOMPLETE_CASH_FLOW_EVIDENCE')
    else {
      if (
        !cashFlowsMatchSession(session.cashFlows, {
          ...calendar,
          accountBindingHash: definition.accountBindingHash,
          asOf,
        })
      )
        violations.push('CASH_FLOW_SCOPE_MISMATCH')
      const totals = cashFlowTotals(session.cashFlows, calendar.closeAt)
      if (
        financial !== null &&
        (totals.external.toString() !== financial.cashInventory.netExternalFlowsMicros ||
          totals.yieldAmount.toString() !== financial.cashInventory.passiveCashYieldMicros ||
          totals.paidOperating.toString() !== financial.cashInventory.operatingCostsPaidFromAccountMicros)
      )
        violations.push('CASH_FLOW_TOTAL_MISMATCH')
    }
    let trading: bigint | null = null
    if (financial === null) missing.push('MISSING_FINANCIAL_EVIDENCE')
    else {
      requireSource(financial.sourceHash)
      trading = netTradingPnl(financial)
      if (trading.toString() !== cashInventoryTradingPnl(financial.cashInventory))
        violations.push('CASH_INVENTORY_MISMATCH')
      if (
        costs !== null &&
        (costs.tradingSourceHash !== financial.sourceHash || costs.netTradingPnlMicros !== trading.toString())
      )
        violations.push('OPERATING_COST_TRADING_SCOPE_MISMATCH')
      if (financial.unsettledFillCount !== 0) missing.push('UNSETTLED_FILLS')
      if (financial.uncertainMutationCount !== 0) missing.push('UNCERTAIN_MUTATIONS')
      if (
        new Set(financial.decisionIds).size !== financial.decisionIds.length ||
        new Set(financial.fillIds).size !== financial.fillIds.length
      )
        violations.push('DUPLICATE_ECONOMIC_EVIDENCE')
      if (
        financial.fillIds.length === 0 &&
        (BigInt(financial.filledNotionalMicros) !== 0n || financial.completedEpisodes !== 0)
      )
        violations.push('ACTIVITY_WITHOUT_FILLS')
    }
    const economics =
      financial !== null &&
      costs !== null &&
      costs.tradingSourceHash === financial.sourceHash &&
      costs.netTradingPnlMicros === trading?.toString()
        ? costs
        : null
    const actual = economics?.netEconomicPnlMicros == null ? null : BigInt(economics.netEconomicPnlMicros)
    const qualification = economics?.qualificationPnlMicros == null ? null : BigInt(economics.qualificationPnlMicros)
    const economicEvidenceComplete = missing.length === 0 && violations.length === 0 && actual !== null
    if (financial !== null && (financial.openingPositionCount !== 0 || financial.closingPositionCount !== 0))
      missing.push('NONFLAT_SESSION')
    let previousAt: number | undefined
    let maximumMarkGapMs = 0
    const first = session.marks[0]
    const equity: bigint[] = first === undefined ? [] : [BigInt(first.cashFlowAdjustedTradingEquityMicros)]
    const costsAt = costs === null || inference === null ? null : indexOperatingCosts(costs, inference, calendar)
    let completeCostPath = costsAt !== null
    for (const mark of session.marks) {
      requireSource(mark.sourceHash)
      const at = Date.parse(mark.at)
      if (
        at < Date.parse(calendar.openAt) ||
        at > Date.parse(calendar.closeAt) ||
        (previousAt !== undefined && at <= previousAt)
      )
        violations.push('INVALID_MARK_ORDER')
      if (previousAt !== undefined) maximumMarkGapMs = Math.max(maximumMarkGapMs, at - previousAt)
      previousAt = at
      const accrued = costsAt?.(mark.at) ?? null
      if (accrued === null) completeCostPath = false
      else
        equity.push(
          BigInt(mark.cashFlowAdjustedTradingEquityMicros) -
            BigInt(accrued.operatingCostMicros) -
            BigInt(accrued.qualificationPremiumMicros),
        )
    }
    if (!completeCostPath) missing.push('INCOMPLETE_COST_ATTRIBUTION')
    const last = session.marks.at(-1)
    if (
      first === undefined ||
      last === undefined ||
      Date.parse(first.at) !== Date.parse(calendar.openAt) ||
      Date.parse(last.at) !== Date.parse(calendar.closeAt) ||
      maximumMarkGapMs > 60_000
    )
      missing.push('INCOMPLETE_MARK_COVERAGE')
    const opening = equity[0]
    const closing = equity.at(-1)
    if (
      completeCostPath &&
      opening !== undefined &&
      closing !== undefined &&
      qualification !== null &&
      closing - opening !== qualification
    )
      violations.push('MARK_PROFIT_MISMATCH')
    if (equity.some((mark) => mark < 0n)) violations.push('NEGATIVE_REGISTERED_EQUITY')
    const stress = session.p95LatencyStress
    if (stress === null) missing.push('MISSING_FULL_DECISION_LATENCY_STRESS')
    else {
      requireSource(stress.sourceHash)
      requireSource(stress.executionReceiptHash)
      if (stress.protocolHash !== registration.latencyStressProtocolHash) violations.push('LATENCY_PROTOCOL_MISMATCH')
      if (stress.image.policyDefinitionHash !== session.definitionHash) violations.push('LATENCY_IMAGE_POLICY_MISMATCH')
    }
    const evidenceHash = yield* canonicalHashV1Result(session)
    const complete =
      missing.length === 0 &&
      violations.length === 0 &&
      qualification !== null &&
      financial !== null &&
      opening !== undefined &&
      closing !== undefined &&
      stress !== null
    const numerical = complete
      ? {
          status: 'COMPLETE' as const,
          sessionDate: session.sessionDate,
          evidenceHash,
          completedEpisodes: financial.completedEpisodes,
          filledNotionalUsd: yield* exactUsd(BigInt(financial.filledNotionalMicros)),
          netPnlUsd: yield* exactUsd(qualification),
          openingEquityUsd: yield* exactUsd(opening),
          closingEquityUsd: yield* exactUsd(closing),
          minimumEquityUsd: yield* exactUsd(equity.reduce((a, b) => (a < b ? a : b))),
          maximumEquityUsd: yield* exactUsd(equity.reduce((a, b) => (a > b ? a : b))),
          maximumDrawdownUsd: yield* exactUsd(BigInt(markedRisk(equity).maximumDrawdownMicros)),
          maximumMarkGapMs,
          p95LatencyStress: {
            status: 'COMPLETE' as const,
            netPnlUsd: yield* exactUsd(BigInt(stress.qualificationPnlMicros)),
            evidenceHash: stress.sourceHash,
          },
        }
      : { status: 'UNRESOLVED' as const, sessionDate: session.sessionDate, evidenceHash }
    return {
      sessionDate: session.sessionDate,
      evidenceHash,
      costs,
      netEconomicPnlMicros: actual?.toString() ?? null,
      qualificationPnlMicros: qualification?.toString() ?? null,
      economicEvidenceComplete,
      missing,
      violations,
      numerical,
    }
  })
import { ReplayImageReceiptSchema } from './replay-image'
