import { randomUUID } from 'node:crypto'

import { sql } from 'kysely'

import type { Db } from '~/server/db'
import { submitAgentRunToAgentsService } from '~/server/agents-service-proxy'
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

type AgentsServiceSubmitResult = Awaited<ReturnType<typeof submitAgentRunToAgentsService>>
type MarketContextAgentRunSubmitter = typeof submitAgentRunToAgentsService

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

const toIso = (value: Date) => value.toISOString()

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
    shouldDispatch: true,
    reason: `${params.snapshotState}_snapshot_refresh`,
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

const reserveMarketContextDispatch = async (params: {
  db: Db
  symbol: string
  domain: MarketContextProviderDomain
  requestId: string
  now: Date
  cooldownCutoff: Date
}) => {
  const result = await sql<{ last_run_name: string | null }>`
    INSERT INTO torghut_market_context_dispatch_state (
      symbol,
      domain,
      last_dispatched_at,
      last_run_name,
      last_status,
      last_error,
      updated_at
    )
    VALUES (
      ${params.symbol},
      ${params.domain},
      ${params.now},
      ${params.requestId},
      'reserved',
      NULL,
      ${params.now}
    )
    ON CONFLICT (symbol, domain) DO UPDATE
      SET
        last_dispatched_at = EXCLUDED.last_dispatched_at,
        last_run_name = EXCLUDED.last_run_name,
        last_status = EXCLUDED.last_status,
        last_error = NULL,
        updated_at = EXCLUDED.updated_at
      WHERE torghut_market_context_dispatch_state.last_dispatched_at IS NULL
        OR torghut_market_context_dispatch_state.last_dispatched_at <= ${params.cooldownCutoff}
    RETURNING last_run_name;
  `.execute(params.db)

  return result.rows.length > 0
}

const updateMarketContextDispatchState = async (params: {
  db: Db
  symbol: string
  domain: MarketContextProviderDomain
  runName: string
  status: string
  error: string | null
  now: Date
}) => {
  await sql`
    INSERT INTO torghut_market_context_dispatch_state (
      symbol,
      domain,
      last_dispatched_at,
      last_run_name,
      last_status,
      last_error,
      updated_at
    )
    VALUES (
      ${params.symbol},
      ${params.domain},
      ${params.now},
      ${params.runName},
      ${params.status},
      ${params.error},
      ${params.now}
    )
    ON CONFLICT (symbol, domain) DO UPDATE
      SET
        last_run_name = EXCLUDED.last_run_name,
        last_status = EXCLUDED.last_status,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at;
  `.execute(params.db)
}

const resolveAgentRunReferences = (domain: MarketContextProviderDomain) =>
  domain === 'fundamentals'
    ? {
        agentName: 'torghut-fundamentals-agent',
        implementationSpecName: 'torghut-market-context-fundamentals-v1',
      }
    : {
        agentName: 'torghut-news-agent',
        implementationSpecName: 'torghut-market-context-news-v1',
      }

export const buildMarketContextAgentRun = (params: {
  symbol: string
  domain: MarketContextProviderDomain
  snapshotState: MarketContextSnapshotState
  provider: string
  requestId: string
  now: Date
  settings: MarketContextDispatchSettings
}) => {
  const refs = resolveAgentRunReferences(params.domain)
  const symbolName = params.symbol.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      generateName: `torghut-market-context-${params.domain}-${symbolName}-`,
      namespace: params.settings.onDemandDispatchNamespace,
      labels: {
        'torghut.proompteng.ai/purpose': 'market-context-on-demand',
        'torghut.proompteng.ai/domain': params.domain,
        'torghut.proompteng.ai/symbol': symbolName,
      },
    },
    spec: {
      agentRef: { name: refs.agentName },
      implementationSpecRef: { name: refs.implementationSpecName },
      runtime: {
        type: 'job',
        config: {
          serviceAccountName: params.settings.onDemandDispatchServiceAccountName,
          priorityClassName: params.settings.onDemandDispatchPriorityClassName,
        },
      },
      ttlSecondsAfterFinished: params.settings.onDemandDispatchTtlSeconds,
      vcsRef: {
        name: params.settings.onDemandDispatchVcsRefName,
      },
      vcsPolicy: {
        required: true,
        mode: 'read-only',
      },
      workload: {
        resources: {
          requests: {
            cpu: '100m',
            memory: '256Mi',
          },
          limits: {
            cpu: '750m',
            memory: '1Gi',
          },
        },
      },
      parameters: {
        executionMode: 'batch_task',
        symbol: params.symbol,
        domain: params.domain,
        asOfUtc: toIso(params.now),
        reason: `on_demand_${params.snapshotState}_snapshot_refresh`,
        provider: params.provider,
        callbackUrl: params.settings.onDemandDispatchCallbackUrl,
        requestId: params.requestId,
        repository: params.settings.onDemandDispatchRepository,
        base: params.settings.onDemandDispatchBaseBranch,
        head: params.settings.onDemandDispatchHeadBranch,
      },
    },
  }
}

export const buildMarketContextAgentRunPayload = (params: Parameters<typeof buildMarketContextAgentRun>[0]) => {
  const resource = buildMarketContextAgentRun(params)
  const metadata = coercePayload(resource.metadata)
  const spec = coercePayload(resource.spec)
  return {
    namespace: parseNonEmptyString(metadata.namespace) ?? params.settings.onDemandDispatchNamespace,
    metadata: {
      generateName: parseNonEmptyString(metadata.generateName) ?? undefined,
      labels: coercePayload(metadata.labels),
    },
    agentRef: coercePayload(spec.agentRef),
    implementationSpecRef: coercePayload(spec.implementationSpecRef),
    runtime: coercePayload(spec.runtime),
    ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished,
    vcsRef: coercePayload(spec.vcsRef),
    vcsPolicy: coercePayload(spec.vcsPolicy),
    workload: coercePayload(spec.workload),
    parameters: coercePayload(spec.parameters),
  }
}

export const resolveSubmittedMarketContextAgentRunName = (result: AgentsServiceSubmitResult): string | null => {
  if (!result.ok || !result.body) return null
  const resource = coercePayload(result.body.resource)
  const resourceMetadata = coercePayload(resource.metadata)
  const resourceName = parseNonEmptyString(resourceMetadata.name)
  if (resourceName) return resourceName

  const agentRun = coercePayload(result.body.agentRun)
  const externalRunId = parseNonEmptyString(agentRun.externalRunId)
  if (externalRunId) return externalRunId

  return parseNonEmptyString(result.body.existingAgentRunName)
}

export const submitMarketContextAgentRun = async (params: {
  symbol: string
  domain: MarketContextProviderDomain
  snapshotState: MarketContextSnapshotState
  provider: string
  requestId: string
  now: Date
  settings: MarketContextDispatchSettings
  submitAgentRun?: MarketContextAgentRunSubmitter
}) => {
  const submitAgentRun = params.submitAgentRun ?? submitAgentRunToAgentsService
  const result = await submitAgentRun({
    deliveryId: params.requestId,
    payload: buildMarketContextAgentRunPayload(params),
  })
  if (!result.ok) {
    const status = result.status > 0 ? ` (${result.status})` : ''
    throw new Error(result.error ?? `Agents service AgentRun submission failed${status}`)
  }
  return resolveSubmittedMarketContextAgentRunName(result) ?? params.requestId
}

export const dispatchMarketContextRefreshIfNeeded = async (params: {
  db: Db
  symbol: string
  domain: MarketContextProviderDomain
  snapshotState: MarketContextSnapshotState
  settings: MarketContextDispatchSettings
  now: Date
  submitAgentRun?: MarketContextAgentRunSubmitter
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
  const cooldownCutoff = new Date(params.now.getTime() - cooldownSeconds * 1000)
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

  const provider = params.settings.providerChain[0] ?? 'codex-spark'
  const requestId = `market-context-${params.domain}-${params.symbol.toLowerCase()}-${randomUUID()}`
  const reserved = await reserveMarketContextDispatch({
    db: params.db,
    symbol: params.symbol,
    domain: params.domain,
    requestId,
    now: params.now,
    cooldownCutoff,
  })
  if (!reserved) {
    const nextState = await readMarketContextDispatchState({
      db: params.db,
      symbol: params.symbol,
      domain: params.domain,
    })
    return {
      attempted: true,
      dispatched: false,
      reason: 'dispatch_cooldown',
      runName: nextState?.lastRunName ?? null,
      error: null,
    }
  }

  try {
    const runName = await submitMarketContextAgentRun({
      symbol: params.symbol,
      domain: params.domain,
      snapshotState: params.snapshotState,
      provider,
      requestId,
      now: params.now,
      settings: params.settings,
      submitAgentRun: params.submitAgentRun,
    })
    await updateMarketContextDispatchState({
      db: params.db,
      symbol: params.symbol,
      domain: params.domain,
      runName,
      status: 'dispatched',
      error: null,
      now: new Date(),
    })
    return {
      attempted: true,
      dispatched: true,
      reason: decision.reason,
      runName,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateMarketContextDispatchState({
      db: params.db,
      symbol: params.symbol,
      domain: params.domain,
      runName: requestId,
      status: 'dispatch_failed',
      error: message,
      now: new Date(),
    })
    return {
      attempted: true,
      dispatched: false,
      reason: 'dispatch_failed',
      runName: requestId,
      error: message,
    }
  }
}
