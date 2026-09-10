import { createHash } from 'node:crypto'

import { resolveTorghutEndpointsConfig } from './torghut-config'
import type {
  QuantPipelineHealth,
  QuantPipelineHealthStage,
  QuantLatestStoreStatus,
} from './torghut-quant-metrics-store'

export const QUANT_ACCOUNT_WITNESS_SCHEMA_VERSION = 'jangar.quant-account-witness.v1'

const DESIGN_REF = 'docs/agents/designs/189-jangar-account-scoped-quant-witness-custody-and-route-reentry-2026-05-13.md'
const DEFAULT_TIMEOUT_MS = 2_000
const MARKET_HOURS_TTL_SECONDS = 60
const OFF_HOURS_TTL_SECONDS = 300
const REQUIRED_PIPELINE_STAGES: QuantPipelineHealthStage[] = ['ingestion', 'compute', 'materialization']
const TARGET_VALUE_GATES = ['zero_notional_or_stale_evidence_rate', 'routeable_candidate_count', 'capital_gate_safety']

export type QuantAccountWitnessRouteState = 'current' | 'stale' | 'empty' | 'timeout' | 'not_scoped'

export type QuantAccountWitnessStoreState = 'current' | 'stale' | 'empty' | 'timeout' | 'unavailable'

export type QuantAccountWitnessPipelineStage = {
  stage: QuantPipelineHealthStage
  status: 'current' | 'stale' | 'missing'
  ok: boolean
  lag_seconds: number | null
  as_of: string | null
  recorded_at: string | null
  reason_codes: string[]
}

export type QuantAccountWitnessPayload = {
  schema_version: typeof QUANT_ACCOUNT_WITNESS_SCHEMA_VERSION
  design_ref: typeof DESIGN_REF
  witness_id: string
  generated_at: string
  fresh_until: string
  account: string
  account_aliases: string[]
  window: string
  strategy_scope: {
    strategy_id: string | null
    scope: 'strategy' | 'all_strategies'
  }
  service_budget_ms: number
  elapsed_ms: number
  aggregate_latest_store: {
    status: Exclude<QuantAccountWitnessStoreState, 'timeout'>
    latest_metrics_count: number
    latest_metrics_updated_at: string | null
    metrics_pipeline_lag_seconds: number | null
    reason_codes: string[]
  }
  account_latest_store: {
    status: QuantAccountWitnessStoreState
    latest_metrics_count: number
    latest_metrics_updated_at: string | null
    metrics_pipeline_lag_seconds: number | null
    timeout_observed: boolean
    reason_codes: string[]
  }
  pipeline_health: {
    status: 'current' | 'stale' | 'missing' | 'timeout'
    stages: QuantAccountWitnessPipelineStage[]
    missing_stages: QuantPipelineHealthStage[]
    timeout_observed: boolean
    reason_codes: string[]
  }
  route_warrant_usability: {
    state: QuantAccountWitnessRouteState
    reason_codes: string[]
    target_value_gates: string[]
  }
  capital_safety: {
    max_notional: '0'
    can_clear_routeability: boolean
    reason_codes: string[]
  }
}

type QueryInput = {
  strategyId?: string
  account: string
  accountAliases?: string[]
  window: string
  now?: Date
  timeoutMs?: number
  getLatestStoreStatus: (params?: {
    strategyId?: string
    account?: string
    window?: string
  }) => Promise<QuantLatestStoreStatus>
  listLatestPipelineHealth: (params: {
    strategyId?: string
    account?: string
    window?: string
    minCreatedAt?: string
  }) => Promise<QuantPipelineHealth[]>
  env?: NodeJS.ProcessEnv
}

type TimeoutResult = {
  timedOut: true
}

const isTimedOut = <T>(result: T | TimeoutResult): result is TimeoutResult =>
  typeof result === 'object' && result !== null && 'timedOut' in result

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | TimeoutResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TimeoutResult>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const uniqueValues = (values: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

const lagSeconds = (now: Date, updatedAt: string | null) =>
  updatedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(updatedAt)) / 1000)) : null

const isMarketHoursNy = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const record: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type] = part.value
  }
  const weekday = record.weekday ?? ''
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hour = Number(record.hour ?? '0')
  const minute = Number(record.minute ?? '0')
  const minutes = hour * 60 + minute
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60
}

const classifyLatestStore = (params: {
  status: QuantLatestStoreStatus
  now: Date
  staleAfterSeconds: number
  marketHours: boolean
}) => {
  const lag = lagSeconds(params.now, params.status.updatedAt)
  const reasonCodes: string[] = []
  let state: Exclude<QuantAccountWitnessStoreState, 'timeout' | 'unavailable'> = 'current'

  if (params.status.count === 0) {
    state = 'empty'
    reasonCodes.push('quant_account_witness_latest_store_empty')
  } else if (params.marketHours && lag !== null && lag > params.staleAfterSeconds) {
    state = 'stale'
    reasonCodes.push('quant_account_witness_latest_store_stale')
  }

  return {
    status: state,
    latest_metrics_count: params.status.count,
    latest_metrics_updated_at: params.status.updatedAt,
    metrics_pipeline_lag_seconds: lag,
    reason_codes: reasonCodes,
  }
}

const buildPipelineStage = (
  stage: QuantPipelineHealthStage,
  receipt: QuantPipelineHealth | undefined,
): QuantAccountWitnessPipelineStage => {
  if (!receipt) {
    return {
      stage,
      status: 'missing',
      ok: false,
      lag_seconds: null,
      as_of: null,
      recorded_at: null,
      reason_codes: [`quant_pipeline_${stage}_missing`],
    }
  }

  return {
    stage,
    status: receipt.ok ? 'current' : 'stale',
    ok: receipt.ok,
    lag_seconds: receipt.lagSeconds,
    as_of: receipt.asOf,
    recorded_at: receipt.recordedAt ?? null,
    reason_codes: receipt.ok ? [] : [`quant_pipeline_${stage}_degraded`],
  }
}

const witnessId = (params: {
  generatedAt: string
  account: string
  window: string
  strategyId?: string
  accountStoreStatus: QuantAccountWitnessStoreState
  pipelineStatus: QuantAccountWitnessPayload['pipeline_health']['status']
}) => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        generatedAt: params.generatedAt,
        account: params.account,
        window: params.window,
        strategyId: params.strategyId ?? null,
        accountStoreStatus: params.accountStoreStatus,
        pipelineStatus: params.pipelineStatus,
      }),
    )
    .digest('hex')
    .slice(0, 16)
  return `quant-account-witness:${params.account}:${params.window}:${digest}`
}

export const buildQuantAccountWitness = async (input: QueryInput): Promise<QuantAccountWitnessPayload> => {
  const startedAt = Date.now()
  const now = input.now ?? new Date()
  const generatedAt = now.toISOString()
  const marketHours = isMarketHoursNy(now)
  const ttlSeconds = marketHours ? MARKET_HOURS_TTL_SECONDS : OFF_HOURS_TTL_SECONDS
  const freshUntil = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
  const endpointConfig = resolveTorghutEndpointsConfig(input.env ?? process.env)
  const staleAfterSeconds = Number.isFinite(endpointConfig.quantHealthMissingUpdateSeconds)
    ? endpointConfig.quantHealthMissingUpdateSeconds
    : 15
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))
  const stageLookbackSeconds = Math.max(60, staleAfterSeconds * 4)
  const stageMinRecordedAt = new Date(now.getTime() - stageLookbackSeconds * 1000).toISOString()
  const aliases = uniqueValues([input.account, ...(input.accountAliases ?? [])])
  const strategyScopeParams = input.strategyId ? { strategyId: input.strategyId } : {}

  const [aggregateResult, accountResult, pipelineResult] = await Promise.all([
    withTimeout(input.getLatestStoreStatus(strategyScopeParams), timeoutMs),
    withTimeout(
      input.getLatestStoreStatus({
        ...strategyScopeParams,
        account: input.account,
        window: input.window,
      }),
      timeoutMs,
    ),
    withTimeout(
      input.listLatestPipelineHealth({
        ...strategyScopeParams,
        account: input.account,
        window: input.window,
        minCreatedAt: stageMinRecordedAt,
      }),
      timeoutMs,
    ),
  ])

  const aggregateStore = isTimedOut(aggregateResult)
    ? {
        status: 'unavailable' as const,
        latest_metrics_count: 0,
        latest_metrics_updated_at: null,
        metrics_pipeline_lag_seconds: null,
        reason_codes: ['quant_aggregate_latest_store_timeout'],
      }
    : classifyLatestStore({
        status: aggregateResult,
        now,
        staleAfterSeconds,
        marketHours,
      })

  const accountStore = isTimedOut(accountResult)
    ? {
        status: 'timeout' as const,
        latest_metrics_count: 0,
        latest_metrics_updated_at: null,
        metrics_pipeline_lag_seconds: null,
        timeout_observed: true,
        reason_codes: ['quant_account_witness_timeout'],
      }
    : {
        ...classifyLatestStore({
          status: accountResult,
          now,
          staleAfterSeconds,
          marketHours,
        }),
        timeout_observed: false,
      }

  const pipelineStages = isTimedOut(pipelineResult)
    ? REQUIRED_PIPELINE_STAGES.map((stage) => ({
        stage,
        status: 'missing' as const,
        ok: false,
        lag_seconds: null,
        as_of: null,
        recorded_at: null,
        reason_codes: ['quant_account_witness_timeout'],
      }))
    : REQUIRED_PIPELINE_STAGES.map((stage) =>
        buildPipelineStage(
          stage,
          pipelineResult.find((receipt) => receipt.stage === stage),
        ),
      )
  const missingStages = pipelineStages.filter((stage) => stage.status === 'missing').map((stage) => stage.stage)
  const pipelineReasonCodes = uniqueValues(pipelineStages.flatMap((stage) => stage.reason_codes))
  const pipelineStatus = isTimedOut(pipelineResult)
    ? 'timeout'
    : missingStages.length > 0
      ? 'missing'
      : pipelineStages.some((stage) => !stage.ok)
        ? 'stale'
        : 'current'

  const routeReasonCodes = uniqueValues([
    ...accountStore.reason_codes,
    ...pipelineReasonCodes,
    ...(accountStore.status === 'current' && pipelineStatus === 'current' ? [] : ['quant_account_witness_not_current']),
  ])
  const routeState: QuantAccountWitnessRouteState =
    accountStore.status === 'timeout' || pipelineStatus === 'timeout'
      ? 'timeout'
      : accountStore.status === 'empty'
        ? 'empty'
        : accountStore.status === 'current' && pipelineStatus === 'current'
          ? 'current'
          : 'stale'

  const witness = {
    schema_version: QUANT_ACCOUNT_WITNESS_SCHEMA_VERSION,
    design_ref: DESIGN_REF,
    witness_id: witnessId({
      generatedAt,
      account: input.account,
      window: input.window,
      strategyId: input.strategyId,
      accountStoreStatus: accountStore.status,
      pipelineStatus,
    }),
    generated_at: generatedAt,
    fresh_until: freshUntil,
    account: input.account,
    account_aliases: aliases,
    window: input.window,
    strategy_scope: {
      strategy_id: input.strategyId ?? null,
      scope: input.strategyId ? 'strategy' : 'all_strategies',
    },
    service_budget_ms: timeoutMs,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    aggregate_latest_store: {
      ...aggregateStore,
      status: aggregateStore.status,
    },
    account_latest_store: accountStore,
    pipeline_health: {
      status: pipelineStatus,
      stages: pipelineStages,
      missing_stages: missingStages,
      timeout_observed: isTimedOut(pipelineResult),
      reason_codes: pipelineReasonCodes,
    },
    route_warrant_usability: {
      state: routeState,
      reason_codes: routeReasonCodes,
      target_value_gates: TARGET_VALUE_GATES,
    },
    capital_safety: {
      max_notional: '0',
      can_clear_routeability: routeState === 'current',
      reason_codes:
        routeState === 'current'
          ? ['zero_notional_quant_witness_only']
          : ['zero_notional_safe', 'quant_account_witness_not_current'],
    },
  } satisfies QuantAccountWitnessPayload

  return witness
}
