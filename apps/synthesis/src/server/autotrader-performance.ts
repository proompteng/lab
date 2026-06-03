import type { AutotraderSession, AutotraderSessionPerformance } from './autotrader-schema'

export type AutotraderSessionPerformanceCounts = {
  tradeTicketCount: number
  orderCount: number
  fillCount: number
  filledOrderCount?: number
  realizedRObservationCount?: number
  totalRealizedR?: string | number | null
}

const parseFiniteNumber = (value: string | number | null | undefined) => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const compactNumber = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return null
  const rounded = Number(value.toFixed(6))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const ratioPercent = (numerator: number, denominator: number) => {
  if (denominator <= 0) return null
  return compactNumber((numerator / denominator) * 100)
}

const boundedRatioPercent = (numerator: number, denominator: number) => {
  if (denominator <= 0) return null
  return ratioPercent(Math.min(Math.max(numerator, 0), denominator), denominator)
}

const summaryText = (summary: Record<string, unknown>, key: string) => {
  const value = summary[key]
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

const summaryBoolean = (summary: Record<string, unknown>, key: string) => {
  const value = summary[key]
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return null
}

const resultVerdict = (
  session: AutotraderSession,
  realizedPnl: number | null,
  equityDelta: number | null,
): AutotraderSessionPerformance['verdict'] => {
  if (!session.finalizedAt) return 'running'
  const result = realizedPnl ?? equityDelta
  if (result == null) return 'unproven'
  if (result > 0) return 'profitable'
  if (result < 0) return 'loss'
  return 'flat'
}

export const buildAutotraderSessionPerformance = (
  session: AutotraderSession,
  counts: AutotraderSessionPerformanceCounts,
): AutotraderSessionPerformance => {
  const openingEquity = parseFiniteNumber(session.openingEquity)
  const closingEquity = parseFiniteNumber(session.closingEquity)
  const goalEquity = parseFiniteNumber(session.goalEquity)
  const realizedPnl = parseFiniteNumber(session.realizedPnl)
  const equityDelta = openingEquity == null || closingEquity == null ? null : closingEquity - openingEquity
  const goalRemaining = goalEquity == null || closingEquity == null ? null : goalEquity - closingEquity
  const goalDenominator = goalEquity != null && openingEquity != null ? goalEquity - openingEquity : null
  const filledOrderCount = counts.filledOrderCount ?? counts.fillCount
  const realizedRObservationCount = counts.realizedRObservationCount ?? 0
  const totalRealizedR = parseFiniteNumber(counts.totalRealizedR)
  const avgRealizedR =
    totalRealizedR == null || realizedRObservationCount <= 0 ? null : totalRealizedR / realizedRObservationCount

  return {
    verdict: resultVerdict(session, realizedPnl, equityDelta),
    realizedPnl: compactNumber(realizedPnl),
    totalRealizedR: compactNumber(totalRealizedR),
    avgRealizedR: compactNumber(avgRealizedR),
    realizedRObservationCount,
    equityDelta: compactNumber(equityDelta),
    equityDeltaPercent:
      equityDelta == null || openingEquity == null || openingEquity === 0
        ? null
        : compactNumber((equityDelta / openingEquity) * 100),
    goalRemaining: compactNumber(goalRemaining),
    goalProgressPercent:
      equityDelta == null || goalDenominator == null || goalDenominator === 0
        ? null
        : compactNumber((equityDelta / goalDenominator) * 100),
    filledOrderCount,
    orderFillRate: boundedRatioPercent(filledOrderCount, counts.orderCount),
    ticketOrderRate: ratioPercent(counts.orderCount, counts.tradeTicketCount),
    ticketFillRate: boundedRatioPercent(filledOrderCount, counts.tradeTicketCount),
    brokerFlat: summaryBoolean(session.summary, 'brokerFlat'),
    reconciledBy: summaryText(session.summary, 'reconciledBy'),
    reconcileReason: summaryText(session.summary, 'reconcileReason'),
  }
}
