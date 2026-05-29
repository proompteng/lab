import type { AutotraderOrder, AutotraderSessionDetail, AutotraderTradeTicket } from '~/server/autotrader-schema'

export type AutotraderRuntimeAlert = {
  key: string
  severity: 'warning' | 'critical'
  title: string
  message: string
}

const staleHeartbeatMs = 90_000
const unreconciledOrderMs = 30_000

const terminalOrderStatuses = new Set<AutotraderOrder['status']>([
  'filled',
  'canceled',
  'rejected',
  'expired',
  'reconciled',
])

const protectiveOrderClasses = new Set(['bracket', 'oco', 'oto'])

const ageMs = (value: string | null | undefined, now: Date) => {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return now.getTime() - parsed
}

const isNonZeroQuantity = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && Math.abs(parsed) > 0
}

const normalizeSymbol = (value: string | null | undefined) => value?.trim().toUpperCase() ?? ''

const stringify = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

const truthyRuntimeFlag = (value: unknown) => {
  if (value === true) return true
  const normalized = stringify(value)
  return normalized === 'true' || normalized === 'active' || normalized === 'managed_loop'
}

const payloadHasManagedLoop = (payload: Record<string, unknown>, symbol: string): boolean => {
  const normalizedSymbol = normalizeSymbol(symbol)
  const stack: unknown[] = [payload]

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    let recordSymbolValue: string | undefined
    if (typeof record.symbol === 'string') {
      recordSymbolValue = record.symbol
    } else if (typeof record.ticker === 'string') {
      recordSymbolValue = record.ticker
    }
    const recordSymbol = normalizeSymbol(recordSymbolValue)
    const symbolMatches = !recordSymbol || recordSymbol === normalizedSymbol
    if (!symbolMatches) continue

    if (
      truthyRuntimeFlag(record.managedLoopActive) ||
      truthyRuntimeFlag(record.managed_loop_active) ||
      truthyRuntimeFlag(record.activeManagedLoop) ||
      truthyRuntimeFlag(record.protectiveManagedLoop) ||
      stringify(record.protectionType) === 'managed_loop' ||
      stringify(record.protection_type) === 'managed_loop'
    ) {
      return true
    }

    stack.push(...Object.values(record).filter((value) => value && typeof value === 'object'))
  }

  return false
}

export const isMarketSessionActive = (detail: AutotraderSessionDetail, now = new Date()) => {
  if (detail.session.finalizedAt) return false
  const marketOpen = Date.parse(detail.session.marketOpenAt)
  const marketClose = Date.parse(detail.session.marketCloseAt)
  if (!Number.isFinite(marketOpen) || !Number.isFinite(marketClose)) return false
  const current = now.getTime()
  return current >= marketOpen && current <= marketClose
}

export const isAutotraderOrderUnreconciled = (order: AutotraderOrder, now = new Date()) => {
  if (terminalOrderStatuses.has(order.status)) return false
  const orderAgeMs = ageMs(order.updatedAt, now)
  return orderAgeMs == null || orderAgeMs > unreconciledOrderMs
}

export const hasBrokerAttachedProtection = (order: AutotraderOrder) => {
  if (order.status === 'rejected' || order.status === 'canceled' || order.status === 'expired') return false
  if (order.orderClass && protectiveOrderClasses.has(order.orderClass.toLowerCase())) return true
  return Boolean(order.stopPrice || order.takeProfitLimitPrice || order.stopLossStopPrice || order.stopLossLimitPrice)
}

const ticketHasManagedLoopFallback = (ticket: AutotraderTradeTicket) =>
  ticket.protectionType.toLowerCase() === 'managed_loop' && ticket.status !== 'blocked' && ticket.status !== 'candidate'

const hasManagedLoopFallback = (detail: AutotraderSessionDetail, symbol: string) => {
  const normalizedSymbol = normalizeSymbol(symbol)
  if (detail.status?.payload && payloadHasManagedLoop(detail.status.payload, normalizedSymbol)) return true

  return detail.tradeTickets.some(
    (ticket) => normalizeSymbol(ticket.symbol) === normalizedSymbol && ticketHasManagedLoopFallback(ticket),
  )
}

const latestPositionSnapshots = (detail: AutotraderSessionDetail) => {
  const snapshotsBySymbol = new Map<string, AutotraderSessionDetail['positionSnapshots'][number]>()

  for (const snapshot of detail.positionSnapshots) {
    const symbol = normalizeSymbol(snapshot.symbol)
    const existing = snapshotsBySymbol.get(symbol)
    if (!existing || Date.parse(snapshot.capturedAt) > Date.parse(existing.capturedAt)) {
      snapshotsBySymbol.set(symbol, snapshot)
    }
  }

  return [...snapshotsBySymbol.values()]
}

const positionHasProtection = (
  detail: AutotraderSessionDetail,
  snapshot: AutotraderSessionDetail['positionSnapshots'][number],
) => {
  const symbol = normalizeSymbol(snapshot.symbol)
  if (!isNonZeroQuantity(snapshot.quantity)) return true
  if (payloadHasManagedLoop(snapshot.brokerPayload, symbol)) return true
  if (hasManagedLoopFallback(detail, symbol)) return true

  return detail.orders.some((order) => normalizeSymbol(order.symbol) === symbol && hasBrokerAttachedProtection(order))
}

export const getAutotraderRuntimeAlerts = (detail: AutotraderSessionDetail, now = new Date()) => {
  const alerts: AutotraderRuntimeAlert[] = []

  if (isMarketSessionActive(detail, now)) {
    const heartbeatAgeMs = ageMs(detail.status?.updatedAt, now)
    if (heartbeatAgeMs == null || heartbeatAgeMs > staleHeartbeatMs) {
      alerts.push({
        key: 'stale-heartbeat',
        severity: 'critical',
        title: 'Stale heartbeat',
        message: 'No fresh status heartbeat has been written in the last 90 seconds during market hours.',
      })
    }
  }

  for (const order of detail.orders) {
    if (!isAutotraderOrderUnreconciled(order, now)) continue
    alerts.push({
      key: `unreconciled-order:${order.clientOrderId}`,
      severity: 'critical',
      title: 'Unreconciled order',
      message: `${order.symbol} order ${order.clientOrderId} is still ${order.status} after 30 seconds.`,
    })
  }

  for (const snapshot of latestPositionSnapshots(detail)) {
    if (positionHasProtection(detail, snapshot)) continue
    alerts.push({
      key: `unprotected-position:${snapshot.symbol}`,
      severity: 'warning',
      title: 'Position protection missing',
      message: `${snapshot.symbol} has a non-zero position without broker-attached protection or an active managed-loop fallback.`,
    })
  }

  return alerts
}
