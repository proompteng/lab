import { sql } from 'kysely'

import type { Db } from '~/server/db'
import type { MarketContextProviderDomain } from '~/server/torghut-market-context-agents'
import { isProviderCapacityMessage, resolveFailureCategoryFromMetadata } from '~/server/torghut-market-context-failures'

export type MarketContextSnapshotState = 'missing' | 'stale' | 'fresh'

export type MarketContextDispatchResult = {
  attempted: boolean
  dispatched: boolean
  reason: string | null
  runName: string | null
  error: string | null
}

export type MarketContextDispatchSettings = {
  providerChain: string[]
  onDemandDispatchEnabled: boolean
  onDemandDispatchCooldownSeconds: number
  onDemandDispatchActiveRunSeconds: number
  onDemandDispatchNamespace: string
  onDemandDispatchServiceAccountName: string
  onDemandDispatchPriorityClassName: string
  onDemandDispatchCallbackUrl: string
  onDemandDispatchTtlSeconds: number
  batchTradingStatusUrl: string
  onDemandDispatchRepository: string
  onDemandDispatchBaseBranch: string
  onDemandDispatchHeadBranch: string
  onDemandDispatchVcsRefName: string
}

type DispatchStateRow = {
  lastDispatchedAt: Date | null
  lastRunName: string | null
}

type ActiveRunRow = {
  requestId: string
  runName: string | null
}

type ProviderCapacityHold = {
  active: boolean
  runName: string | null
  provider: string | null
  until: Date
  error: string | null
}

type ProviderCapacityRunRow = {
  requestId: string
  runName: string | null
  provider: string | null
  status: string
  error: string | null
  metadata: Record<string, unknown>
  updatedAt: Date
}

const parseTimestamp = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
  const parsed = new Date(withZone)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

const parseNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const coercePayload = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const asStringArray = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

const providerCapacityMessages = (row: ProviderCapacityRunRow) => {
  const messages: unknown[] = [row.error, row.metadata.failureMessage, row.metadata.error]
  const attempts = Array.isArray(row.metadata.providerAttempts) ? row.metadata.providerAttempts : []
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) continue
    const record = attempt as Record<string, unknown>
    messages.push(record.error, record.message, record.failureMessage)
  }
  return asStringArray(messages)
}

const isProviderCapacityRow = (row: ProviderCapacityRunRow) => {
  if (resolveFailureCategoryFromMetadata(row.metadata) === 'provider_capacity_exhausted') return true
  return providerCapacityMessages(row).some(isProviderCapacityMessage)
}

const parseProviderCapacityResetAt = (row: ProviderCapacityRunRow): Date | null => {
  for (const message of providerCapacityMessages(row)) {
    const match = /try again at ([^.]+)\.?/i.exec(message)
    const raw = match?.[1]?.replace(/\b(\d+)(st|nd|rd|th)\b/gi, '$1').trim()
    if (!raw) continue
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

export const resolveProviderCapacityDispatchHoldFromRows = (params: {
  rows: ProviderCapacityRunRow[]
  now: Date
  fallbackCooldownSeconds: number
}): ProviderCapacityHold | null => {
  const fallbackCooldownSeconds = Math.max(1, params.fallbackCooldownSeconds)
  for (const row of params.rows) {
    const status = row.status.trim().toLowerCase()
    if (status === 'succeeded' || status === 'partial') return null
    if (status !== 'failed' && status !== 'cancelled') continue
    if (!isProviderCapacityRow(row)) continue

    const resetAt = parseProviderCapacityResetAt(row)
    const fallbackUntil = new Date(row.updatedAt.getTime() + fallbackCooldownSeconds * 1000)
    const until = resetAt && resetAt.getTime() > fallbackUntil.getTime() ? resetAt : fallbackUntil
    if (until.getTime() <= params.now.getTime()) return null
    return {
      active: true,
      runName: row.runName ?? row.requestId,
      provider: row.provider,
      until,
      error: row.error,
    }
  }
  return null
}

export const resolveMarketContextDispatchDecisionFromRows = (params: {
  enabled: boolean
  snapshotState: MarketContextSnapshotState
  activeRun: ActiveRunRow | null
  dispatchState: DispatchStateRow | null
  providerCapacityHold?: ProviderCapacityHold | null
  cooldownSeconds: number
  now: Date
}): MarketContextDispatchResult & { shouldDispatch: boolean } => {
  if (params.snapshotState === 'fresh') {
    return {
      attempted: false,
      dispatched: false,
      shouldDispatch: false,
      reason: null,
      runName: null,
      error: null,
    }
  }

  if (!params.enabled) {
    return {
      attempted: false,
      dispatched: false,
      shouldDispatch: false,
      reason: 'on_demand_dispatch_disabled',
      runName: null,
      error: null,
    }
  }

  if (params.providerCapacityHold?.active) {
    return {
      attempted: true,
      dispatched: false,
      shouldDispatch: false,
      reason: 'provider_capacity_cooldown',
      runName: params.providerCapacityHold.runName,
      error: params.providerCapacityHold.error,
    }
  }

  if (params.activeRun) {
    return {
      attempted: true,
      dispatched: false,
      shouldDispatch: false,
      reason: 'active_run_in_progress',
      runName: params.activeRun.runName ?? params.activeRun.requestId,
      error: null,
    }
  }

  const lastDispatchedAt = params.dispatchState?.lastDispatchedAt ?? null
  if (lastDispatchedAt) {
    const cooldownSeconds = Math.max(1, params.cooldownSeconds)
    const elapsedSeconds = Math.max(0, Math.floor((params.now.getTime() - lastDispatchedAt.getTime()) / 1000))
    if (elapsedSeconds < cooldownSeconds) {
      return {
        attempted: true,
        dispatched: false,
        shouldDispatch: false,
        reason: 'dispatch_cooldown',
        runName: params.dispatchState?.lastRunName ?? null,
        error: null,
      }
    }
  }

  return {
    attempted: true,
    dispatched: false,
    shouldDispatch: false,
    reason: 'per_symbol_market_context_dispatch_removed',
    runName: null,
    error: null,
  }
}

const readActiveMarketContextRun = async (params: {
  db: Db
  symbol: string
  domain: MarketContextProviderDomain
  activeCutoff: Date
}): Promise<ActiveRunRow | null> => {
  const result = await sql<{
    request_id: string
    run_name: string | null
  }>`
    SELECT request_id, run_name
    FROM torghut_market_context_runs
    WHERE domain = ${params.domain}
      AND symbol IN (${params.symbol}, '*')
      AND status IN ('started', 'running', 'submitted')
      AND updated_at >= ${params.activeCutoff}
    ORDER BY updated_at DESC
    LIMIT 1;
  `.execute(params.db)

  const row = result.rows[0]
  if (!row) return null
  return {
    requestId: row.request_id,
    runName: parseNonEmptyString(row.run_name),
  }
}

const readMarketContextDispatchState = async (params: {
  db: Db
  symbol: string
  domain: MarketContextProviderDomain
}): Promise<DispatchStateRow | null> => {
  const result = await sql<{
    last_dispatched_at: unknown
    last_run_name: string | null
  }>`
    SELECT last_dispatched_at, last_run_name
    FROM torghut_market_context_dispatch_state
    WHERE symbol = ${params.symbol}
      AND domain = ${params.domain}
    LIMIT 1;
  `.execute(params.db)

  const row = result.rows[0]
  if (!row) return null
  return {
    lastDispatchedAt: parseTimestamp(row.last_dispatched_at),
    lastRunName: parseNonEmptyString(row.last_run_name),
  }
}

const readProviderCapacityDispatchHold = async (params: {
  db: Db
  now: Date
  fallbackCooldownSeconds: number
}): Promise<ProviderCapacityHold | null> => {
  const result = await sql<{
    request_id: string
    run_name: string | null
    provider: string | null
    status: string
    error: string | null
    metadata: unknown
    updated_at: Date
  }>`
    SELECT request_id, run_name, provider, status, error, metadata, updated_at
    FROM torghut_market_context_runs
    WHERE status IN ('succeeded', 'partial', 'failed', 'cancelled')
    ORDER BY updated_at DESC
    LIMIT 20;
  `.execute(params.db)

  return resolveProviderCapacityDispatchHoldFromRows({
    rows: result.rows.map((row) => ({
      requestId: row.request_id,
      runName: parseNonEmptyString(row.run_name),
      provider: parseNonEmptyString(row.provider),
      status: row.status,
      error: parseNonEmptyString(row.error),
      metadata: coercePayload(row.metadata),
      updatedAt: row.updated_at,
    })),
    now: params.now,
    fallbackCooldownSeconds: params.fallbackCooldownSeconds,
  })
}

export const dispatchMarketContextRefreshIfNeeded = async (params: {
  db: Db
  symbol: string
  domain: MarketContextProviderDomain
  snapshotState: MarketContextSnapshotState
  settings: MarketContextDispatchSettings
  now: Date
}): Promise<MarketContextDispatchResult> => {
  if (params.snapshotState === 'fresh') {
    return {
      attempted: false,
      dispatched: false,
      reason: null,
      runName: null,
      error: null,
    }
  }

  if (!params.settings.onDemandDispatchEnabled) {
    return {
      attempted: false,
      dispatched: false,
      reason: 'on_demand_dispatch_disabled',
      runName: null,
      error: null,
    }
  }

  const activeCutoff = new Date(
    params.now.getTime() - Math.max(1, params.settings.onDemandDispatchActiveRunSeconds) * 1000,
  )
  const cooldownSeconds = Math.max(1, params.settings.onDemandDispatchCooldownSeconds)
  const [activeRun, dispatchState, providerCapacityHold] = await Promise.all([
    readActiveMarketContextRun({
      db: params.db,
      symbol: params.symbol,
      domain: params.domain,
      activeCutoff,
    }),
    readMarketContextDispatchState({ db: params.db, symbol: params.symbol, domain: params.domain }),
    readProviderCapacityDispatchHold({
      db: params.db,
      now: params.now,
      fallbackCooldownSeconds: cooldownSeconds,
    }),
  ])
  const decision = resolveMarketContextDispatchDecisionFromRows({
    enabled: params.settings.onDemandDispatchEnabled,
    snapshotState: params.snapshotState,
    activeRun,
    dispatchState,
    providerCapacityHold,
    cooldownSeconds,
    now: params.now,
  })
  if (!decision.shouldDispatch) {
    return {
      attempted: decision.attempted,
      dispatched: decision.dispatched,
      reason: decision.reason,
      runName: decision.runName,
      error: decision.error,
    }
  }

  return {
    attempted: decision.attempted,
    dispatched: false,
    reason: decision.reason,
    runName: decision.runName,
    error: decision.error,
  }
}
