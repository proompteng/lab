import { inferenceStageKey, type InferenceCostReport } from '../inference-costs'
import { OperatingCostCategory, type OperatingCostReport } from '../operating-costs'

export const costAttributionRule = {
  schemaVersion: 'bayn.system-cost-attribution.v2',
  sessionAllocations: 'PROSPECTIVELY_REGISTERED_SERVICE_PERIOD_WEIGHTS',
  allocationRounding: 'CANONICAL_SCOPE_CUMULATIVE_FLOOR_WITH_EXACT_TERMINAL_TOTAL',
  fixedCosts: 'LINEAR_REGISTERED_SESSION_TIME',
  inferenceInvoice: 'PROPORTIONAL_FROZEN_TARIFF_AT_REQUEST_START',
  qualificationPremium: 'PROPORTIONAL_FROZEN_TARIFF_AT_REQUEST_START',
  zeroUsageInvoice: 'LINEAR_REGISTERED_SESSION_TIME',
  outsideSessionRequest: 'CLAMP_TO_REGISTERED_SESSION_BOUNDARY',
  rounding: 'FLOOR_CUMULATIVE_WITH_EXACT_TERMINAL_TOTAL',
} as const

export const proportionalCost = (amount: bigint, weight: bigint, totalWeight: bigint): bigint | null =>
  amount < 0n || weight < 0n || totalWeight <= 0n || weight > totalWeight ? null : (amount * weight) / totalWeight

export const recognizeOperatingCosts = (
  costs: OperatingCostReport,
  inference: InferenceCostReport,
  session: { readonly openAt: string; readonly closeAt: string },
  at: string,
) => {
  if (
    costs.totalOperatingCostMicros === null ||
    costs.qualificationPremiumMicros === null ||
    inference.estimatedTotalCostMicros === null
  )
    return null
  const opening = Date.parse(session.openAt)
  const closing = Date.parse(session.closeAt)
  const time = Date.parse(at)
  if (![opening, closing, time].every(Number.isSafeInteger) || closing <= opening || time < opening || time > closing)
    return null
  const invoice = costs.categories.find((category) => category.category === OperatingCostCategory.Inference)
  if (invoice === undefined || costs.inferenceReportHash !== inference.reportHash) return null
  const invoiceAmount = BigInt(invoice.knownInvoicedCostMicros)
  const nonInference = BigInt(costs.totalOperatingCostMicros) - invoiceAmount
  let totalWeight = 0n
  let recognizedWeight = 0n
  const lines = new Map(inference.requests.map((line) => [inferenceStageKey(line), line]))
  const seen = new Set<string>()
  for (const timing of inference.requestTimings) {
    const line = lines.get(timing.requestKey)
    if (
      line === undefined ||
      seen.has(timing.requestKey) ||
      timing.estimatedCostPicoUsd === null ||
      timing.estimatedCostPicoUsd !== line.estimatedCostPicoUsd
    )
      return null
    seen.add(timing.requestKey)
    const weight = BigInt(timing.estimatedCostPicoUsd)
    if (weight < 0n) return null
    if (weight === 0n) continue
    const startedAt = timing.startedAt === null ? NaN : Date.parse(timing.startedAt)
    if (!Number.isSafeInteger(startedAt) || startedAt > Date.parse(inference.asOf)) return null
    totalWeight += weight
    if (Math.max(opening, Math.min(closing, startedAt)) <= time) recognizedWeight += weight
  }
  if (seen.size !== lines.size || totalWeight.toString() !== inference.knownEstimatedCostPicoUsd) return null
  const elapsed = BigInt(time) - BigInt(opening)
  const duration = BigInt(closing) - BigInt(opening)
  const weight = totalWeight === 0n ? elapsed : recognizedWeight
  const basis = totalWeight === 0n ? duration : totalWeight
  const fixed = proportionalCost(nonInference, elapsed, duration)
  const metered = proportionalCost(invoiceAmount, weight, basis)
  const premium = proportionalCost(BigInt(costs.qualificationPremiumMicros), weight, basis)
  if (fixed === null || metered === null || premium === null) return null
  return { operatingCostMicros: (fixed + metered).toString(), qualificationPremiumMicros: premium.toString() }
}
