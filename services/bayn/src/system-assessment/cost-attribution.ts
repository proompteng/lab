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

export const indexOperatingCosts = (
  costs: OperatingCostReport,
  inference: InferenceCostReport,
  session: { readonly openAt: string; readonly closeAt: string },
  actualCostsOnly = false,
) => {
  if (
    costs.totalOperatingCostMicros === null ||
    (!actualCostsOnly && costs.qualificationPremiumMicros === null) ||
    inference.estimatedTotalCostMicros === null
  )
    return null
  const opening = Date.parse(session.openAt)
  const closing = Date.parse(session.closeAt)
  if (![opening, closing].every(Number.isSafeInteger) || closing <= opening) return null
  const invoice = costs.categories.find((category) => category.category === OperatingCostCategory.Inference)
  if (invoice === undefined || costs.inferenceReportHash !== inference.reportHash) return null
  const invoiceAmount = BigInt(invoice.knownInvoicedCostMicros)
  const nonInference = BigInt(costs.totalOperatingCostMicros) - invoiceAmount
  const premiumAmount = actualCostsOnly ? 0n : BigInt(costs.qualificationPremiumMicros ?? '0')
  if (invoiceAmount < 0n || nonInference < 0n || premiumAmount < 0n) return null
  let totalWeight = 0n
  const points: { readonly at: number; weight: bigint }[] = []
  const lines = new Map(inference.requests.map((line) => [inferenceStageKey(line), line]))
  const seen = new Set<string>()
  const asOf = Date.parse(inference.asOf)
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
    if (!Number.isSafeInteger(startedAt) || startedAt > asOf) return null
    totalWeight += weight
    points.push({ at: Math.max(opening, Math.min(closing, startedAt)), weight })
  }
  if (seen.size !== lines.size || totalWeight.toString() !== inference.knownEstimatedCostPicoUsd) return null
  points.sort((a, b) => a.at - b.at)
  let cumulative = 0n
  for (const point of points) {
    cumulative += point.weight
    point.weight = cumulative
  }
  const duration = BigInt(closing) - BigInt(opening)
  const basis = totalWeight === 0n ? duration : totalWeight
  return (at: string) => {
    const time = Date.parse(at)
    if (!Number.isSafeInteger(time) || time < opening || time > closing) return null
    let lower = 0
    let upper = points.length
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      const point = points[middle]
      if (point !== undefined && point.at <= time) lower = middle + 1
      else upper = middle
    }
    const elapsed = BigInt(time) - BigInt(opening)
    const weight = totalWeight === 0n ? elapsed : (points[lower - 1]?.weight ?? 0n)
    const fixed = proportionalCost(nonInference, elapsed, duration)
    const metered = proportionalCost(invoiceAmount, weight, basis)
    const premium = proportionalCost(premiumAmount, weight, basis)
    if (fixed === null || metered === null || premium === null) return null
    return { operatingCostMicros: (fixed + metered).toString(), qualificationPremiumMicros: premium.toString() }
  }
}
