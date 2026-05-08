import { randomUUID } from 'node:crypto'

import { sql } from 'kysely'

import type { Db } from '~/server/db'
import { createKubernetesClient } from '~/server/primitives-kube'
import type { MarketContextProviderDomain } from '~/server/torghut-market-context-agents'

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

export const resolveMarketContextDispatchDecisionFromRows = (params: {
  enabled: boolean
  snapshotState: MarketContextSnapshotState
  activeRun: ActiveRunRow | null
  dispatchState: DispatchStateRow | null
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
        tradingStatusUrl: params.settings.batchTradingStatusUrl,
        repository: params.settings.onDemandDispatchRepository,
        base: params.settings.onDemandDispatchBaseBranch,
        head: params.settings.onDemandDispatchHeadBranch,
      },
    },
  }
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
  const cooldownCutoff = new Date(params.now.getTime() - cooldownSeconds * 1000)
  const [activeRun, dispatchState] = await Promise.all([
    readActiveMarketContextRun({
      db: params.db,
      symbol: params.symbol,
      domain: params.domain,
      activeCutoff,
    }),
    readMarketContextDispatchState({ db: params.db, symbol: params.symbol, domain: params.domain }),
  ])
  const decision = resolveMarketContextDispatchDecisionFromRows({
    enabled: params.settings.onDemandDispatchEnabled,
    snapshotState: params.snapshotState,
    activeRun,
    dispatchState,
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
    const applied = await createKubernetesClient().apply(
      buildMarketContextAgentRun({
        symbol: params.symbol,
        domain: params.domain,
        snapshotState: params.snapshotState,
        provider,
        requestId,
        now: params.now,
        settings: params.settings,
      }),
    )
    const metadata = coercePayload(applied.metadata)
    const runName = parseNonEmptyString(metadata.name) ?? requestId
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
