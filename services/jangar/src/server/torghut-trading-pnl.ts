export type FilledExecutionForPnl = {
  executionId: string
  tradeDecisionId: string | null
  strategyId: string
  strategyName: string | null
  createdAt: string
  symbol: string
  side: string
  filledQty: number
  avgFillPrice: number | null
}

export type RealizedPnlPoint = {
  ts: string
  realizedPnl: number
}

export type RealizedPnlSummary = {
  realizedPnl: number
  closedQty: number
  winCount: number
  lossCount: number
  winRate: number | null
  bySymbol: Record<string, { realizedPnl: number; closedQty: number }>
  series: RealizedPnlPoint[]
  warnings: string[]
}

type PositionState = {
  qty: number
  avgCost: number
}

const normalizeSide = (value: string) => {
  const side = value.trim().toLowerCase()
  if (side === 'buy') return 'buy'
  if (side === 'sell') return 'sell'
  return null
}

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export const computeRealizedPnlAverageCostLongOnly = (executions: FilledExecutionForPnl[]): RealizedPnlSummary => {
  const sorted = [...executions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const positions = new Map<string, PositionState>()

  let realizedPnl = 0
  let closedQty = 0
  let winCount = 0
  let lossCount = 0
  const bySymbol: Record<string, { realizedPnl: number; closedQty: number }> = {}
  const series: RealizedPnlPoint[] = []
  const warnings: string[] = []

  for (const execution of sorted) {
    const side = normalizeSide(execution.side)
    if (!side) {
      warnings.push(`Unknown side for execution ${execution.executionId}`)
      continue
    }

    const qty = toFiniteNumber(execution.filledQty)
    if (!qty || qty <= 0) continue

    const price = execution.avgFillPrice === null ? null : toFiniteNumber(execution.avgFillPrice)
    if (price === null || price <= 0) {
      warnings.push(`Missing avgFillPrice for execution ${execution.executionId}`)
      continue
    }

    const symbol = execution.symbol.trim().toUpperCase()
    if (!symbol) continue

    const key = `${execution.strategyId}:${symbol}`
    const current = positions.get(key) ?? { qty: 0, avgCost: 0 }

    if (side === 'buy') {
      const nextQty = current.qty + qty
      const nextCostBasis = current.avgCost * current.qty + price * qty
      const nextAvgCost = nextQty > 0 ? nextCostBasis / nextQty : 0
      positions.set(key, { qty: nextQty, avgCost: nextAvgCost })
      series.push({ ts: execution.createdAt, realizedPnl })
      continue
    }

    if (current.qty <= 0) {
      warnings.push(`Sell without long position for ${symbol} (execution ${execution.executionId})`)
      series.push({ ts: execution.createdAt, realizedPnl })
      continue
    }

    const realizedQty = Math.min(qty, current.qty)
    if (realizedQty < qty) {
      warnings.push(`Sell qty exceeds position for ${symbol} (execution ${execution.executionId})`)
    }

    const pnlForFill = (price - current.avgCost) * realizedQty
    realizedPnl += pnlForFill
    closedQty += realizedQty

    if (pnlForFill > 0) winCount += 1
    else if (pnlForFill < 0) lossCount += 1

    const existing = bySymbol[symbol] ?? { realizedPnl: 0, closedQty: 0 }
    existing.realizedPnl += pnlForFill
    existing.closedQty += realizedQty
    bySymbol[symbol] = existing

    const nextQty = current.qty - realizedQty
    positions.set(key, { qty: nextQty, avgCost: nextQty > 0 ? current.avgCost : 0 })
    series.push({ ts: execution.createdAt, realizedPnl })
  }

  const totalClosedTrades = winCount + lossCount
  const winRate = totalClosedTrades > 0 ? winCount / totalClosedTrades : null

  return {
    realizedPnl,
    closedQty,
    winCount,
    lossCount,
    winRate,
    bySymbol,
    series,
    warnings,
  }
}
