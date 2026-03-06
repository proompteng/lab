import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'

import { AuthenticationV1Api, KubeConfig, type V1TokenReview } from '@kubernetes/client-node'
import { sql } from 'kysely'

import { getDb } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'
import {
  recordTorghutMarketContextBatchFreshnessLagSeconds,
  recordTorghutMarketContextBatchRun,
  recordTorghutMarketContextBatchRunDurationMs,
  recordTorghutMarketContextBatchRunSymbols,
} from '~/server/metrics'
import { clearMarketContextCache } from '~/server/torghut-market-context'
import { normalizeTorghutSymbol } from '~/server/torghut-symbols'

export type MarketContextProviderDomain = 'fundamentals' | 'news'

export type MarketContextProviderCitation = {
  source: string
  publishedAt: string
  url: string | null
}

export type MarketContextDispatchResult = {
  attempted: boolean
  dispatched: boolean
  reason: string | null
  runName: string | null
  error: string | null
}

export type MarketContextProviderResult = {
  symbol: string
  domain: MarketContextProviderDomain
  snapshotState: 'missing' | 'stale' | 'fresh'
  context: {
    asOfUtc: string
    sourceCount: number
    qualityScore: number
    payload: Record<string, unknown>
    citations: MarketContextProviderCitation[]
    riskFlags: string[]
  }
  dispatch: MarketContextDispatchResult
}

type SnapshotRow = {
  symbol: string
  domain: MarketContextProviderDomain
  asOf: Date
  sourceCount: number
  qualityScore: number
  payload: Record<string, unknown>
  citations: MarketContextProviderCitation[]
  riskFlags: string[]
  provider: string | null
  runName: string | null
  updatedAt: Date | null
}

type LatestRunRow = {
  symbol: string
  domain: MarketContextProviderDomain
  provider: string
  status: string
  metadata: Record<string, unknown>
  error: string | null
  updatedAt: Date
  finishedAt: Date | null
}

export type MarketContextFailureCategory =
  | 'provider_circuit_open'
  | 'provider_bootstrap_failure'
  | 'provider_attempt_timeout'
  | 'provider_turn_failed'
  | 'payload_validation_failure'
  | 'finalize_callback_failure'
  | 'attempt_budget_exhausted'
  | 'unknown_failure'

type ProviderCircuitState = {
  provider: string
  consecutiveFailures: number
  threshold: number
  cooldownSeconds: number
  cooldownOpen: boolean
  cooldownRemainingSeconds: number
  lastFailureAt: Date | null
  lastError: string | null
}

class MarketContextRunStartRejectedError extends Error {
  readonly statusCode: number
  readonly errorCode: string
  readonly details: Record<string, unknown>

  constructor(params: { message: string; statusCode: number; errorCode: string; details?: Record<string, unknown> }) {
    super(params.message)
    this.name = 'MarketContextRunStartRejectedError'
    this.statusCode = params.statusCode
    this.errorCode = params.errorCode
    this.details = params.details ?? {}
  }
}

type IngestPayload = {
  symbol?: unknown
  domain?: unknown
  asOfUtc?: unknown
  asOf?: unknown
  publishedAt?: unknown
  sourceCount?: unknown
  itemCount?: unknown
  qualityScore?: unknown
  payload?: unknown
  context?: unknown
  citations?: unknown
  riskFlags?: unknown
  provider?: unknown
  runName?: unknown
  runStatus?: unknown
  error?: unknown
  requestId?: unknown
  metadata?: unknown
  items?: unknown
}

type IngestBatchItem = {
  symbol: string
  asOf: Date
  sourceCount: number
  qualityScore: number
  payload: Record<string, unknown>
  citations: MarketContextProviderCitation[]
  riskFlags: string[]
  error: string | null
}

type RunStartPayload = {
  requestId?: unknown
  symbol?: unknown
  domain?: unknown
  runName?: unknown
  reason?: unknown
  provider?: unknown
  metadata?: unknown
}

type RunProgressPayload = {
  requestId?: unknown
  seq?: unknown
  status?: unknown
  message?: unknown
  metadata?: unknown
}

type RunEvidenceItem = {
  source: string
  publishedAt: string | null
  url: string | null
  headline: string | null
  summary: string | null
  sentiment: string | null
  payload: Record<string, unknown>
}

type RunEvidencePayload = {
  requestId?: unknown
  seq?: unknown
  symbol?: unknown
  domain?: unknown
  evidence?: unknown
  items?: unknown
  metadata?: unknown
}

type MarketContextRunStatusPayload = {
  ok: true
  requestId: string
  symbol: string
  domain: MarketContextProviderDomain
  runName: string | null
  provider: string
  reason: string | null
  status: string
  metadata: Record<string, unknown>
  error: string | null
  startedAt: string
  lastHeartbeatAt: string | null
  finishedAt: string | null
  updatedAt: string
  events: Array<{
    seq: number
    eventType: string
    payload: Record<string, unknown>
    createdAt: string
  }>
}

const DEFAULT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS = 24 * 60 * 60
const DEFAULT_NEWS_MAX_FRESHNESS_SECONDS = 5 * 60
const DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX = 'system:serviceaccount:agents:'
const IN_CLUSTER_SERVICE_ACCOUNT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const IN_CLUSTER_SERVICE_ACCOUNT_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const parseProviderChain = (value: string | undefined, fallback: string[]) => {
  if (!value) return fallback
  const providers = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return providers.length > 0 ? providers : fallback
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

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const parseNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseSeq = (value: unknown): number | null => {
  const parsed = parseNumber(value)
  if (parsed === null) return null
  if (!Number.isInteger(parsed) || parsed < 0) return null
  return parsed
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const toIso = (value: Date) => value.toISOString()

const coerceRiskFlags = (value: unknown) => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item): item is string => item.length > 0)
}

const coercePayload = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const createEvidenceDigest = (params: {
  domain: MarketContextProviderDomain
  source: string
  publishedAt: string | null
  url: string | null
  headline: string | null
  summary: string | null
  sentiment: string | null
  payload: Record<string, unknown>
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        domain: params.domain,
        source: params.source,
        publishedAt: params.publishedAt,
        url: params.url,
        headline: params.headline,
        summary: params.summary,
        sentiment: params.sentiment,
        payload: params.payload,
      }),
    )
    .digest('hex')

const coerceCitations = (value: unknown): MarketContextProviderCitation[] => {
  if (!Array.isArray(value)) return []
  const citations: MarketContextProviderCitation[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const source = typeof row.source === 'string' ? row.source.trim() : ''
    const publishedAt = parseTimestamp(row.publishedAt)
    if (!source || !publishedAt) continue
    citations.push({
      source,
      publishedAt: toIso(publishedAt),
      url: typeof row.url === 'string' && row.url.trim().length > 0 ? row.url.trim() : null,
    })
  }
  return citations
}

const coerceEvidenceItems = (value: unknown): RunEvidenceItem[] => {
  if (!Array.isArray(value)) return []
  const items: RunEvidenceItem[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const source = parseNonEmptyString(row.source)
    if (!source) continue
    const publishedAtTimestamp = parseTimestamp(row.publishedAt)
    const publishedAt = publishedAtTimestamp ? toIso(publishedAtTimestamp) : null
    items.push({
      source,
      publishedAt,
      url: parseNonEmptyString(row.url),
      headline: parseNonEmptyString(row.headline ?? row.title),
      summary: parseNonEmptyString(row.summary),
      sentiment: parseNonEmptyString(row.sentiment),
      payload: coercePayload(row.payload),
    })
  }
  return items
}

const resolveSettings = () => {
  return {
    fundamentalsMaxFreshnessSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS,
      DEFAULT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS,
    ),
    newsMaxFreshnessSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_NEWS_MAX_FRESHNESS_SECONDS,
      DEFAULT_NEWS_MAX_FRESHNESS_SECONDS,
    ),
    batchRequireOpenSession: parseBoolean(process.env.JANGAR_MARKET_CONTEXT_BATCH_REQUIRE_OPEN_SESSION, true),
    batchTradingStatusUrl:
      process.env.JANGAR_MARKET_CONTEXT_BATCH_TRADING_STATUS_URL?.trim() ||
      'http://torghut.torghut.svc.cluster.local/trading/status',
    batchTradingStatusTimeoutMs: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_BATCH_TRADING_STATUS_TIMEOUT_MS,
      2000,
    ),
    providerChain: parseProviderChain(process.env.JANGAR_MARKET_CONTEXT_PROVIDER_CHAIN, ['codex-spark', 'codex']),
    providerFailureThreshold: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_PROVIDER_FAILURE_THRESHOLD, 3),
    providerCooldownSeconds: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_PROVIDER_COOLDOWN_SECONDS, 900),
  }
}

const resolveDomainMaxFreshness = (domain: MarketContextProviderDomain, settings: ReturnType<typeof resolveSettings>) =>
  domain === 'fundamentals' ? settings.fundamentalsMaxFreshnessSeconds : settings.newsMaxFreshnessSeconds

const resolveFreshnessSeconds = (now: Date, asOf: Date) =>
  Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 1000))

const buildMissingContext = (params: { domain: MarketContextProviderDomain; symbol: string }) => {
  const riskFlags = [`${params.domain}_missing`]
  return {
    asOfUtc: '',
    sourceCount: 0,
    qualityScore: 0,
    payload: {
      symbol: params.symbol,
      domain: params.domain,
      provider: resolveSettings().providerChain[0] ?? 'codex-spark',
      status: 'missing',
    },
    citations: [] as MarketContextProviderCitation[],
    riskFlags,
  }
}

const asDomain = (value: unknown): MarketContextProviderDomain | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'fundamentals' || normalized === 'news') return normalized
  return null
}

const resolveDbWithMigrations = async () => {
  const db = getDb()
  if (!db) return null
  await ensureMigrations(db)
  return db
}

type MarketContextDb = NonNullable<Awaited<ReturnType<typeof resolveDbWithMigrations>>>

const executeDbTransaction = async <T>(db: MarketContextDb | null, callback: (trx: MarketContextDb) => Promise<T>) => {
  if (!db) throw new Error('DATABASE_URL is not configured')
  if (
    typeof (db as { transaction?: () => { execute: (fn: (trx: MarketContextDb) => Promise<T>) => Promise<T> } })
      .transaction === 'function'
  ) {
    return db.transaction().execute((trx) => callback(trx))
  }
  return callback(db)
}

const readLatestSnapshot = async (params: {
  symbol: string
  domain: MarketContextProviderDomain
}): Promise<SnapshotRow | null> => {
  const db = await resolveDbWithMigrations()
  if (!db) return null

  const result = await sql<{
    symbol: string
    domain: string
    as_of: unknown
    source_count: unknown
    quality_score: unknown
    payload: unknown
    citations: unknown
    risk_flags: unknown
    provider: string | null
    run_name: string | null
    updated_at: unknown
  }>`
    SELECT symbol, domain, as_of, source_count, quality_score, payload, citations, risk_flags, provider, run_name, updated_at
    FROM torghut_market_context_snapshots
    WHERE symbol = ${params.symbol}
      AND domain = ${params.domain}
    LIMIT 1
  `.execute(db)

  const row = result.rows[0]
  if (!row) return null
  const asOf = parseTimestamp(row.as_of)
  const domain = asDomain(row.domain)
  if (!asOf || !domain) return null

  return {
    symbol: row.symbol,
    domain,
    asOf,
    sourceCount: Math.max(0, Math.trunc(parseNumber(row.source_count) ?? 0)),
    qualityScore: clamp01(parseNumber(row.quality_score) ?? 0),
    payload: coercePayload(row.payload),
    citations: coerceCitations(row.citations),
    riskFlags: coerceRiskFlags(row.risk_flags),
    provider: parseNonEmptyString(row.provider),
    runName: parseNonEmptyString(row.run_name),
    updatedAt: parseTimestamp(row.updated_at),
  }
}

const readLatestRun = async (params: {
  symbol: string
  domain: MarketContextProviderDomain
}): Promise<LatestRunRow | null> => {
  const db = await resolveDbWithMigrations()
  if (!db) return null

  const result = await sql<{
    symbol: string
    domain: string
    provider: string
    status: string
    metadata: unknown
    error: string | null
    updated_at: Date
    finished_at: Date | null
  }>`
    SELECT symbol, domain, provider, status, metadata, error, updated_at, finished_at
    FROM torghut_market_context_runs
    WHERE domain = ${params.domain}
      AND symbol IN (${params.symbol}, '*')
    ORDER BY updated_at DESC
    LIMIT 1
  `.execute(db)

  const row = result.rows[0]
  if (!row) return null
  const domain = asDomain(row.domain)
  if (!domain) return null
  return {
    symbol: row.symbol,
    domain,
    provider: row.provider,
    status: row.status,
    metadata: coercePayload(row.metadata),
    error: row.error,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}

const parseFailureCategory = (value: unknown): MarketContextFailureCategory | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized === 'provider_circuit_open' ||
    normalized === 'provider_bootstrap_failure' ||
    normalized === 'provider_attempt_timeout' ||
    normalized === 'provider_turn_failed' ||
    normalized === 'payload_validation_failure' ||
    normalized === 'finalize_callback_failure' ||
    normalized === 'attempt_budget_exhausted' ||
    normalized === 'unknown_failure'
  ) {
    return normalized
  }
  return null
}

const resolveFailureCategoryFromMetadata = (metadata: Record<string, unknown>): MarketContextFailureCategory | null => {
  const direct = parseFailureCategory(metadata.failureCategory)
  if (direct) return direct
  const attempts = Array.isArray(metadata.providerAttempts) ? metadata.providerAttempts : []
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) continue
    const category = parseFailureCategory((attempt as Record<string, unknown>).failureCategory)
    if (category) return category
  }
  return null
}

export const resolveFailureSignal = (params: {
  metadata: Record<string, unknown>
  message?: string | null
  error?: string | null
}): { category: MarketContextFailureCategory | null; error: string | null; message: string | null } => {
  const category = resolveFailureCategoryFromMetadata(params.metadata)
  const message = parseNonEmptyString(params.message ?? params.error)
  return {
    category,
    error: category ?? message,
    message,
  }
}

const readProviderCircuitState = async (params: {
  db: MarketContextDb
  domain: MarketContextProviderDomain
  provider: string
  threshold: number
  cooldownSeconds: number
  now: Date
}): Promise<ProviderCircuitState> => {
  const threshold = Math.max(1, params.threshold)
  const cooldownSeconds = Math.max(1, params.cooldownSeconds)
  const result = await sql<{
    status: string
    error: string | null
    updated_at: Date
  }>`
    SELECT status, error, updated_at
    FROM torghut_market_context_runs
    WHERE domain = ${params.domain}
      AND provider = ${params.provider}
      AND status IN ('succeeded', 'partial', 'failed', 'cancelled')
      AND COALESCE(error, '') <> 'provider_circuit_open'
    ORDER BY updated_at DESC
    LIMIT ${threshold};
  `.execute(params.db)

  return resolveProviderCircuitStateFromRows({
    provider: params.provider,
    rows: result.rows.map((row) => ({
      status: row.status,
      error: row.error,
      updatedAt: row.updated_at,
    })),
    threshold,
    cooldownSeconds,
    now: params.now,
  })
}

export const resolveProviderCircuitStateFromRows = (params: {
  provider: string
  rows: Array<{ status: string; error: string | null; updatedAt: Date }>
  threshold: number
  cooldownSeconds: number
  now: Date
}): ProviderCircuitState => {
  const threshold = Math.max(1, params.threshold)
  const cooldownSeconds = Math.max(1, params.cooldownSeconds)
  let consecutiveFailures = 0
  let lastFailureAt: Date | null = null
  let lastError: string | null = null

  for (const row of params.rows) {
    const status = row.status.trim().toLowerCase()
    if (status === 'succeeded' || status === 'partial') break
    if (status !== 'failed' && status !== 'cancelled') break
    consecutiveFailures += 1
    if (!lastFailureAt) {
      lastFailureAt = row.updatedAt
      lastError = parseNonEmptyString(row.error)
    }
  }

  let cooldownRemainingSeconds = 0
  let cooldownOpen = false
  if (consecutiveFailures >= threshold && lastFailureAt) {
    const elapsedSeconds = Math.max(0, Math.floor((params.now.getTime() - lastFailureAt.getTime()) / 1000))
    cooldownRemainingSeconds = Math.max(0, cooldownSeconds - elapsedSeconds)
    cooldownOpen = cooldownRemainingSeconds > 0
  }

  return {
    provider: params.provider,
    consecutiveFailures,
    threshold,
    cooldownSeconds,
    cooldownOpen,
    cooldownRemainingSeconds,
    lastFailureAt,
    lastError,
  }
}

const buildDegradedSnapshotMetadata = (params: {
  domain: MarketContextProviderDomain
  snapshot: SnapshotRow
  latestRun: LatestRunRow | null
  providerChain: string[]
}) => {
  const payload = { ...params.snapshot.payload }
  const riskFlags = new Set(params.snapshot.riskFlags)
  const preferredProvider = params.providerChain[0] ?? 'codex-spark'
  payload.provider = params.snapshot.provider ?? payload.provider ?? preferredProvider
  payload.providerChain = params.providerChain
  payload.lastSuccessfulAsOfUtc = toIso(params.snapshot.asOf)
  payload.runName = params.snapshot.runName
  if (!params.latestRun) {
    payload.fallbackUsed = payload.provider !== preferredProvider
    return { payload, riskFlags: Array.from(riskFlags) }
  }

  payload.lastRunStatus = params.latestRun.status
  payload.lastRunProvider = params.latestRun.provider
  payload.lastRunUpdatedAt = toIso(params.latestRun.updatedAt)
  payload.lastRunError = params.latestRun.error
  payload.lastFailureCategory = resolveFailureCategoryFromMetadata(params.latestRun.metadata)
  payload.providerCircuit = coercePayload(params.latestRun.metadata.providerCircuit)
  payload.fallbackUsed = payload.provider !== preferredProvider

  if (params.latestRun.status === 'failed' || params.latestRun.status === 'cancelled') {
    payload.generationFailed = true
    payload.degradedReason =
      payload.lastFailureCategory ?? params.latestRun.error ?? `${params.domain}_generation_failed_all_models`
    riskFlags.add(`${params.domain}_generation_failed_all_models`)
    riskFlags.add('market_context_degraded_last_good')
  }

  return { payload, riskFlags: Array.from(riskFlags) }
}

export const getMarketContextProviderResult = async (params: {
  domain: MarketContextProviderDomain
  symbolInput: string
}): Promise<MarketContextProviderResult> => {
  const symbol = normalizeTorghutSymbol(params.symbolInput)
  const now = new Date()
  const settings = resolveSettings()
  const maxFreshnessSeconds = resolveDomainMaxFreshness(params.domain, settings)
  const db = await resolveDbWithMigrations()
  const latestRun = await readLatestRun({ symbol, domain: params.domain })

  if (!db) {
    const riskFlags = [`${params.domain}_missing`, `${params.domain}_database_unavailable`]
    if (latestRun?.status === 'failed' || latestRun?.status === 'cancelled') {
      riskFlags.push(`${params.domain}_generation_failed_all_models`, 'market_context_degraded_last_good')
    }
    return {
      symbol,
      domain: params.domain,
      snapshotState: 'missing',
      context: {
        ...buildMissingContext({ domain: params.domain, symbol }),
        payload: {
          ...buildMissingContext({ domain: params.domain, symbol }).payload,
          providerChain: settings.providerChain,
          lastRunStatus: latestRun?.status ?? null,
          lastRunProvider: latestRun?.provider ?? null,
          lastRunError: latestRun?.error ?? null,
          lastFailureCategory: latestRun ? resolveFailureCategoryFromMetadata(latestRun.metadata) : null,
          providerCircuit: latestRun ? coercePayload(latestRun.metadata.providerCircuit) : {},
        },
        riskFlags,
      },
      dispatch: {
        attempted: false,
        dispatched: false,
        reason: null,
        runName: null,
        error: null,
      },
    }
  }

  const snapshot = await readLatestSnapshot({ symbol, domain: params.domain })
  if (!snapshot) {
    const missingContext = buildMissingContext({ domain: params.domain, symbol })
    const riskFlags = new Set(missingContext.riskFlags)
    if (latestRun?.status === 'failed' || latestRun?.status === 'cancelled') {
      riskFlags.add(`${params.domain}_generation_failed_all_models`)
      riskFlags.add('market_context_degraded_last_good')
    }
    return {
      symbol,
      domain: params.domain,
      snapshotState: 'missing',
      context: {
        ...missingContext,
        payload: {
          ...missingContext.payload,
          providerChain: settings.providerChain,
          lastRunStatus: latestRun?.status ?? null,
          lastRunProvider: latestRun?.provider ?? null,
          lastRunError: latestRun?.error ?? null,
          lastFailureCategory: latestRun ? resolveFailureCategoryFromMetadata(latestRun.metadata) : null,
          providerCircuit: latestRun ? coercePayload(latestRun.metadata.providerCircuit) : {},
        },
        riskFlags: Array.from(riskFlags),
      },
      dispatch: {
        attempted: false,
        dispatched: false,
        reason: null,
        runName: null,
        error: null,
      },
    }
  }

  const freshnessSeconds = resolveFreshnessSeconds(now, snapshot.asOf)
  const isStale = freshnessSeconds > maxFreshnessSeconds

  const riskFlags = new Set(snapshot.riskFlags)
  if (isStale) riskFlags.add(`${params.domain}_stale`)
  const degradedSnapshot = buildDegradedSnapshotMetadata({
    domain: params.domain,
    snapshot,
    latestRun,
    providerChain: settings.providerChain,
  })
  degradedSnapshot.riskFlags.forEach((flag) => riskFlags.add(flag))

  return {
    symbol,
    domain: params.domain,
    snapshotState: isStale ? 'stale' : 'fresh',
    context: {
      asOfUtc: toIso(snapshot.asOf),
      sourceCount: snapshot.sourceCount,
      qualityScore: snapshot.qualityScore,
      payload: degradedSnapshot.payload,
      citations: snapshot.citations,
      riskFlags: Array.from(riskFlags),
    },
    dispatch: {
      attempted: false,
      dispatched: false,
      reason: null,
      runName: null,
      error: null,
    },
  }
}

const coerceRunStatus = (value: unknown): 'succeeded' | 'failed' | 'submitted' | 'partial' => {
  if (typeof value !== 'string') return 'failed'
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 'failed'
  if (normalized === 'succeeded' || normalized === 'success' || normalized === 'ok') return 'succeeded'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'submitted' || normalized === 'queued') return 'submitted'
  if (normalized === 'partial') return 'partial'
  return 'failed'
}

const coerceSourceCount = (value: unknown) => Math.max(0, Math.trunc(parseNumber(value) ?? 0))
const coerceQualityScore = (value: unknown) => clamp01(parseNumber(value) ?? 0)

const coerceLifecycleStatus = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === 'started') return 'started'
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'progress') return 'running'
  if (normalized === 'submitted' || normalized === 'queued') return 'submitted'
  if (normalized === 'succeeded' || normalized === 'success' || normalized === 'ok') return 'succeeded'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'partial') return 'partial'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  return fallback
}

const isLifecycleStatusTerminal = (status: string) =>
  status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'cancelled'

const parseRunIdentifier = (value: unknown) => {
  const requestId = parseNonEmptyString(value)
  if (!requestId) throw new Error('requestId is required')
  return requestId
}

const loadRunContext = async (params: { requestId: string }) => {
  const db = await resolveDbWithMigrations()
  if (!db) throw new Error('DATABASE_URL is not configured')

  const row = await sql<{
    request_id: string
    symbol: string
    domain: string
    status: string
  }>`
    SELECT request_id, symbol, domain, status
    FROM torghut_market_context_runs
    WHERE request_id = ${params.requestId}
    LIMIT 1
  `.execute(db)

  const run = row.rows[0]
  if (!run) throw new Error(`run not found for requestId ${params.requestId}`)
  const domain = asDomain(run.domain)
  if (!domain) throw new Error(`run domain is invalid for requestId ${params.requestId}`)
  return {
    db,
    symbol: run.symbol,
    domain,
    status: run.status,
  }
}

const insertRunEvent = async (params: {
  db: MarketContextDb
  requestId: string
  seq: number
  eventType: string
  payload: Record<string, unknown>
}) => {
  const result = await sql<{ request_id: string }>`
    INSERT INTO torghut_market_context_run_events (
      request_id,
      seq,
      event_type,
      payload,
      created_at
    )
    VALUES (
      ${params.requestId},
      ${params.seq},
      ${params.eventType},
      ${params.payload},
      now()
    )
    ON CONFLICT (request_id, seq) DO NOTHING
    RETURNING request_id;
  `.execute(params.db)

  return result.rows.length > 0
}

const upsertRunLifecycle = async (params: {
  db: MarketContextDb
  requestId: string
  symbol: string
  domain: MarketContextProviderDomain
  runName: string | null
  provider: string
  reason: string | null
  status: string
  error: string | null
  metadata: Record<string, unknown>
  now: Date
}) => {
  const finishedAt = isLifecycleStatusTerminal(params.status) ? params.now : null
  await sql`
    INSERT INTO torghut_market_context_runs (
      request_id,
      symbol,
      domain,
      run_name,
      provider,
      reason,
      status,
      metadata,
      error,
      started_at,
      last_heartbeat_at,
      finished_at,
      updated_at
    )
    VALUES (
      ${params.requestId},
      ${params.symbol},
      ${params.domain},
      ${params.runName},
      ${params.provider},
      ${params.reason},
      ${params.status},
      ${params.metadata},
      ${params.error},
      ${params.now},
      ${params.now},
      ${finishedAt},
      ${params.now}
    )
    ON CONFLICT (request_id) DO UPDATE
      SET
        symbol = EXCLUDED.symbol,
        domain = EXCLUDED.domain,
        run_name = COALESCE(EXCLUDED.run_name, torghut_market_context_runs.run_name),
        provider = COALESCE(EXCLUDED.provider, torghut_market_context_runs.provider),
        reason = COALESCE(EXCLUDED.reason, torghut_market_context_runs.reason),
        status = EXCLUDED.status,
        metadata = torghut_market_context_runs.metadata || EXCLUDED.metadata,
        error = EXCLUDED.error,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        finished_at = COALESCE(EXCLUDED.finished_at, torghut_market_context_runs.finished_at),
        updated_at = EXCLUDED.updated_at;
  `.execute(params.db)
}

export const startMarketContextProviderRun = async (input: RunStartPayload) => {
  const db = await resolveDbWithMigrations()
  if (!db) throw new Error('DATABASE_URL is not configured')

  const domain = asDomain(input.domain)
  if (!domain) throw new Error('domain must be fundamentals or news')
  const symbol = normalizeTorghutSymbol(parseNonEmptyString(input.symbol) ?? '')
  if (!symbol) throw new Error('symbol is required')
  const requestId = parseNonEmptyString(input.requestId) ?? randomUUID()
  const runName = parseNonEmptyString(input.runName)
  const provider = parseNonEmptyString(input.provider) ?? 'codex-spark'
  const reason = parseNonEmptyString(input.reason)
  const metadata = coercePayload(input.metadata)
  const status = coerceLifecycleStatus('started', 'started')
  const now = new Date()
  const settings = resolveSettings()

  if (settings.providerFailureThreshold > 0 && settings.providerCooldownSeconds > 0) {
    const circuitState = await readProviderCircuitState({
      db,
      domain,
      provider,
      threshold: settings.providerFailureThreshold,
      cooldownSeconds: settings.providerCooldownSeconds,
      now,
    })
    if (circuitState.cooldownOpen) {
      await upsertRunLifecycle({
        db,
        requestId,
        symbol,
        domain,
        runName,
        provider,
        reason,
        status: 'cancelled',
        error: 'provider_circuit_open',
        metadata: {
          ...metadata,
          failureCategory: 'provider_circuit_open',
          providerCircuit: {
            consecutiveFailures: circuitState.consecutiveFailures,
            threshold: circuitState.threshold,
            cooldownSeconds: circuitState.cooldownSeconds,
            cooldownRemainingSeconds: circuitState.cooldownRemainingSeconds,
            lastFailureAt: circuitState.lastFailureAt ? toIso(circuitState.lastFailureAt) : null,
            lastError: circuitState.lastError,
          },
        },
        now,
      })
      throw new MarketContextRunStartRejectedError({
        message: `provider circuit open for ${provider}`,
        statusCode: 409,
        errorCode: 'provider_circuit_open',
        details: {
          domain,
          provider,
          consecutiveFailures: circuitState.consecutiveFailures,
          threshold: circuitState.threshold,
          cooldownSeconds: circuitState.cooldownSeconds,
          cooldownRemainingSeconds: circuitState.cooldownRemainingSeconds,
          lastFailureAt: circuitState.lastFailureAt ? toIso(circuitState.lastFailureAt) : null,
          lastError: circuitState.lastError,
        },
      })
    }
  }

  await upsertRunLifecycle({
    db,
    requestId,
    symbol,
    domain,
    runName,
    provider,
    reason,
    status,
    error: null,
    metadata,
    now,
  })

  const seq = parseSeq((input as { seq?: unknown }).seq) ?? 0
  await insertRunEvent({
    db,
    requestId,
    seq,
    eventType: 'start',
    payload: {
      symbol,
      domain,
      runName,
      reason,
      provider,
      metadata,
    },
  })

  return {
    ok: true as const,
    requestId,
    symbol,
    domain,
    status,
  }
}

export const recordMarketContextProviderRunProgress = async (input: RunProgressPayload) => {
  const requestId = parseRunIdentifier(input.requestId)
  const seq = parseSeq(input.seq)
  if (seq === null) throw new Error('seq must be a non-negative integer')
  const status = coerceLifecycleStatus(input.status, 'running')
  const message = parseNonEmptyString(input.message)
  const metadata = coercePayload(input.metadata)
  const now = new Date()

  const context = await loadRunContext({ requestId })
  const failureSignal = status === 'failed' ? resolveFailureSignal({ metadata, message }) : null
  const runError = failureSignal?.error ?? null
  const finishedAt = isLifecycleStatusTerminal(status) ? now : null

  await sql`
    UPDATE torghut_market_context_runs
    SET
      status = ${status},
      metadata = torghut_market_context_runs.metadata || ${metadata},
      error = ${runError},
      last_heartbeat_at = ${now},
      finished_at = ${finishedAt},
      updated_at = ${now}
    WHERE request_id = ${requestId};
  `.execute(context.db)

  const inserted = await insertRunEvent({
    db: context.db,
    requestId,
    seq,
    eventType: 'progress',
    payload: {
      status,
      message,
      metadata,
    },
  })

  return {
    ok: true as const,
    requestId,
    symbol: context.symbol,
    domain: context.domain,
    status,
    inserted,
  }
}

export const recordMarketContextProviderEvidence = async (input: RunEvidencePayload) => {
  const requestId = parseRunIdentifier(input.requestId)
  const seq = parseSeq(input.seq)
  if (seq === null) throw new Error('seq must be a non-negative integer')
  const metadata = coercePayload(input.metadata)
  const evidence = coerceEvidenceItems(input.evidence ?? input.items)
  if (evidence.length === 0) throw new Error('evidence items are required')

  const context = await loadRunContext({ requestId })
  const symbol = normalizeTorghutSymbol(parseNonEmptyString(input.symbol) ?? context.symbol)
  if (!symbol) throw new Error('symbol is required')
  const payloadDomain = asDomain(input.domain)
  const domain = payloadDomain ?? context.domain
  if (!domain) throw new Error('domain must be fundamentals or news')
  const now = new Date()

  await sql`
    UPDATE torghut_market_context_runs
    SET
      status = 'running',
      metadata = torghut_market_context_runs.metadata || ${metadata},
      last_heartbeat_at = ${now},
      updated_at = ${now}
    WHERE request_id = ${requestId};
  `.execute(context.db)

  let insertedEvidence = 0
  for (const item of evidence) {
    const digest = createEvidenceDigest({
      domain,
      source: item.source,
      publishedAt: item.publishedAt,
      url: item.url,
      headline: item.headline,
      summary: item.summary,
      sentiment: item.sentiment,
      payload: item.payload,
    })
    const inserted = await sql<{ id: string }>`
      INSERT INTO torghut_market_context_evidence (
        request_id,
        symbol,
        domain,
        seq,
        source,
        published_at,
        url,
        headline,
        summary,
        sentiment,
        payload,
        digest,
        created_at,
        updated_at
      )
      VALUES (
        ${requestId},
        ${symbol},
        ${domain},
        ${seq},
        ${item.source},
        ${item.publishedAt ? new Date(item.publishedAt) : null},
        ${item.url},
        ${item.headline},
        ${item.summary},
        ${item.sentiment},
        ${item.payload},
        ${digest},
        ${now},
        ${now}
      )
      ON CONFLICT (request_id, digest) DO NOTHING
      RETURNING id;
    `.execute(context.db)
    if (inserted.rows.length > 0) insertedEvidence += 1
  }

  const eventInserted = await insertRunEvent({
    db: context.db,
    requestId,
    seq,
    eventType: 'evidence',
    payload: {
      evidenceCount: evidence.length,
      insertedEvidence,
      metadata,
    },
  })

  return {
    ok: true as const,
    requestId,
    symbol,
    domain,
    evidenceCount: evidence.length,
    insertedEvidence,
    inserted: eventInserted,
  }
}

export const getMarketContextProviderRunStatus = async (
  requestIdInput: string,
): Promise<MarketContextRunStatusPayload> => {
  const requestId = parseRunIdentifier(requestIdInput)
  const db = await resolveDbWithMigrations()
  if (!db) throw new Error('DATABASE_URL is not configured')

  const runResult = await sql<{
    request_id: string
    symbol: string
    domain: string
    run_name: string | null
    provider: string
    reason: string | null
    status: string
    metadata: unknown
    error: string | null
    started_at: Date
    last_heartbeat_at: Date | null
    finished_at: Date | null
    updated_at: Date
  }>`
    SELECT
      request_id,
      symbol,
      domain,
      run_name,
      provider,
      reason,
      status,
      metadata,
      error,
      started_at,
      last_heartbeat_at,
      finished_at,
      updated_at
    FROM torghut_market_context_runs
    WHERE request_id = ${requestId}
    LIMIT 1;
  `.execute(db)

  const run = runResult.rows[0]
  if (!run) throw new Error(`run not found for requestId ${requestId}`)
  const domain = asDomain(run.domain)
  if (!domain) throw new Error(`run domain is invalid for requestId ${requestId}`)

  const eventsResult = await sql<{
    seq: number
    event_type: string
    payload: unknown
    created_at: Date
  }>`
    SELECT seq, event_type, payload, created_at
    FROM torghut_market_context_run_events
    WHERE request_id = ${requestId}
    ORDER BY seq DESC, created_at DESC
    LIMIT 100;
  `.execute(db)

  return {
    ok: true,
    requestId,
    symbol: run.symbol,
    domain,
    runName: run.run_name,
    provider: run.provider,
    reason: run.reason,
    status: run.status,
    metadata: coercePayload(run.metadata),
    error: run.error,
    startedAt: toIso(run.started_at),
    lastHeartbeatAt: run.last_heartbeat_at ? toIso(run.last_heartbeat_at) : null,
    finishedAt: run.finished_at ? toIso(run.finished_at) : null,
    updatedAt: toIso(run.updated_at),
    events: eventsResult.rows
      .slice()
      .reverse()
      .map((event) => ({
        seq: event.seq,
        eventType: event.event_type,
        payload: coercePayload(event.payload),
        createdAt: toIso(event.created_at),
      })),
  }
}

const upsertSnapshotFromIngest = async (params: {
  trx: MarketContextDb
  symbol: string
  domain: MarketContextProviderDomain
  asOf: Date
  sourceCount: number
  qualityScore: number
  payload: Record<string, unknown>
  citations: MarketContextProviderCitation[]
  riskFlags: string[]
  provider: string
  runName: string | null
  now: Date
}) => {
  const citationsValue = sql`${JSON.stringify(params.citations)}::jsonb` as unknown as MarketContextProviderCitation[]
  await params.trx
    .insertInto('torghut_market_context_snapshots')
    .values({
      symbol: params.symbol,
      domain: params.domain,
      as_of: params.asOf,
      source_count: params.sourceCount,
      quality_score: params.qualityScore,
      payload: params.payload,
      citations: citationsValue,
      risk_flags: params.riskFlags,
      provider: params.provider,
      run_name: params.runName,
      updated_at: params.now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['symbol', 'domain'])
        .doUpdateSet({
          as_of: params.asOf,
          source_count: params.sourceCount,
          quality_score: params.qualityScore,
          payload: params.payload,
          citations: citationsValue,
          risk_flags: params.riskFlags,
          provider: params.provider,
          run_name: params.runName,
          updated_at: params.now,
        })
        .where('torghut_market_context_snapshots.as_of', '<=', params.asOf),
    )
    .execute()
}

const upsertRunLifecycleFromIngest = async (params: {
  trx: MarketContextDb
  requestId: string
  symbol: string
  domain: MarketContextProviderDomain
  runName: string | null
  provider: string
  lifecycleStatus: string
  metadata: Record<string, unknown>
  runError: string | null
  now: Date
}) => {
  const finishedAt = isLifecycleStatusTerminal(params.lifecycleStatus) ? params.now : null
  await params.trx
    .insertInto('torghut_market_context_runs')
    .values({
      request_id: params.requestId,
      symbol: params.symbol,
      domain: params.domain,
      run_name: params.runName,
      provider: params.provider,
      reason: null,
      status: params.lifecycleStatus,
      metadata: params.metadata,
      error: params.runError,
      started_at: params.now,
      last_heartbeat_at: params.now,
      finished_at: finishedAt,
      updated_at: params.now,
    })
    .onConflict((conflict) =>
      conflict.columns(['request_id']).doUpdateSet({
        symbol: params.symbol,
        domain: params.domain,
        run_name: params.runName,
        provider: params.provider,
        status: params.lifecycleStatus,
        metadata: sql`torghut_market_context_runs.metadata || ${params.metadata}`,
        error: params.runError,
        last_heartbeat_at: params.now,
        finished_at: finishedAt,
        updated_at: params.now,
      }),
    )
    .execute()
}

const upsertFinalizeEventFromIngest = async (params: {
  trx: MarketContextDb
  requestId: string
  now: Date
  payload: Record<string, unknown>
}) => {
  await params.trx
    .insertInto('torghut_market_context_run_events')
    .values({
      request_id: params.requestId,
      seq: Math.max(1, Math.floor(params.now.getTime() / 1000)),
      event_type: 'finalize',
      payload: params.payload,
    })
    .onConflict((conflict) =>
      conflict.columns(['request_id', 'seq']).doUpdateSet({
        event_type: 'finalize',
        payload: params.payload,
      }),
    )
    .execute()
}

const coerceBatchIngestItems = (input: IngestPayload): IngestBatchItem[] | null => {
  if (!Array.isArray(input.items)) return null
  if (input.items.length === 0) throw new Error('items must contain at least one symbol entry')

  const defaultAsOf = parseTimestamp(input.asOfUtc ?? input.asOf ?? input.publishedAt)

  return input.items.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`items[${index}] must be an object`)
    }
    const entry = row as Record<string, unknown>
    const symbolRaw = parseNonEmptyString(entry.symbol)
    if (!symbolRaw) throw new Error(`items[${index}].symbol is required`)
    const symbol = normalizeTorghutSymbol(symbolRaw)
    if (!symbol) throw new Error(`items[${index}].symbol is invalid`)

    const asOf = parseTimestamp(entry.asOfUtc ?? entry.asOf) ?? defaultAsOf
    if (!asOf) {
      throw new Error(`items[${index}].asOfUtc is required and must be a valid timestamp`)
    }

    const sourceCountRaw = parseNumber(entry.sourceCount ?? entry.itemCount)
    if (sourceCountRaw === null || !Number.isInteger(sourceCountRaw) || sourceCountRaw < 0) {
      throw new Error(`items[${index}].sourceCount must be a non-negative integer`)
    }

    const qualityScoreRaw = parseNumber(entry.qualityScore)
    if (qualityScoreRaw === null || qualityScoreRaw < 0 || qualityScoreRaw > 1) {
      throw new Error(`items[${index}].qualityScore must be a number between 0 and 1`)
    }

    const payloadCandidate = entry.payload ?? entry.context
    if (!payloadCandidate || typeof payloadCandidate !== 'object' || Array.isArray(payloadCandidate)) {
      throw new Error(`items[${index}].payload must be an object`)
    }

    if (entry.citations !== undefined && !Array.isArray(entry.citations)) {
      throw new Error(`items[${index}].citations must be an array`)
    }
    const citations = (entry.citations ?? []) as unknown[]
    const normalizedCitations: MarketContextProviderCitation[] = citations.map((citation, citationIndex) => {
      if (!citation || typeof citation !== 'object' || Array.isArray(citation)) {
        throw new Error(`items[${index}].citations[${citationIndex}] must be an object`)
      }
      const citationRow = citation as Record<string, unknown>
      const source = parseNonEmptyString(citationRow.source)
      if (!source) {
        throw new Error(`items[${index}].citations[${citationIndex}].source is required`)
      }
      const publishedAt = parseTimestamp(citationRow.publishedAt)
      if (!publishedAt) {
        throw new Error(`items[${index}].citations[${citationIndex}].publishedAt must be a valid timestamp`)
      }
      const rawUrl = citationRow.url
      if (rawUrl !== undefined && rawUrl !== null && typeof rawUrl !== 'string') {
        throw new Error(`items[${index}].citations[${citationIndex}].url must be a string or null`)
      }
      return {
        source,
        publishedAt: toIso(publishedAt),
        url: typeof rawUrl === 'string' && rawUrl.trim().length > 0 ? rawUrl.trim() : null,
      }
    })

    if (entry.riskFlags !== undefined && !Array.isArray(entry.riskFlags)) {
      throw new Error(`items[${index}].riskFlags must be an array`)
    }
    const riskFlags = (entry.riskFlags ?? []) as unknown[]
    const normalizedRiskFlags = riskFlags.map((flag, flagIndex) => {
      const normalized = parseNonEmptyString(flag)
      if (!normalized) {
        throw new Error(`items[${index}].riskFlags[${flagIndex}] must be a non-empty string`)
      }
      return normalized
    })

    const rawError = entry.error
    if (rawError !== undefined && rawError !== null && typeof rawError !== 'string') {
      throw new Error(`items[${index}].error must be a string when provided`)
    }
    const error = parseNonEmptyString(rawError)

    return {
      symbol,
      asOf,
      sourceCount: sourceCountRaw,
      qualityScore: qualityScoreRaw,
      payload: payloadCandidate as Record<string, unknown>,
      citations: normalizedCitations,
      riskFlags: normalizedRiskFlags,
      error,
    }
  })
}

const parseMarketOpenValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', 'open'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', 'closed'].includes(normalized)) return false
  }
  return null
}

const resolveMarketSessionOpenFromPayload = (value: unknown): boolean | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const direct = parseMarketOpenValue(row.market_session_open)
  if (direct !== null) return direct
  const continuity =
    row.signal_continuity && typeof row.signal_continuity === 'object' && !Array.isArray(row.signal_continuity)
      ? (row.signal_continuity as Record<string, unknown>)
      : null
  if (!continuity) return null
  return parseMarketOpenValue(continuity.market_session_open)
}

const resolveTradingSessionOpen = async (settings: ReturnType<typeof resolveSettings>): Promise<boolean | null> => {
  const url = settings.batchTradingStatusUrl.trim()
  if (!url) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), settings.batchTradingStatusTimeoutMs)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as unknown
    return resolveMarketSessionOpenFromPayload(payload)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export const ingestMarketContextProviderResult = async (input: IngestPayload) => {
  const db = await resolveDbWithMigrations()
  if (!db) throw new Error('DATABASE_URL is not configured')

  const settings = resolveSettings()
  const domain = asDomain(input.domain)
  if (!domain) throw new Error('domain must be fundamentals or news')

  const provider =
    typeof input.provider === 'string' && input.provider.trim().length > 0 ? input.provider.trim() : 'codex-spark'
  const runName = typeof input.runName === 'string' && input.runName.trim().length > 0 ? input.runName.trim() : null
  const runStatus = coerceRunStatus(input.runStatus)
  const lifecycleStatus = coerceLifecycleStatus(input.runStatus, runStatus)
  const requestId = parseNonEmptyString(input.requestId) ?? randomUUID()
  const metadata = coercePayload(input.metadata)
  const failureSignal =
    lifecycleStatus === 'failed' || lifecycleStatus === 'cancelled'
      ? resolveFailureSignal({ metadata, error: parseNonEmptyString(input.error) })
      : null
  const runError = failureSignal?.error ?? null
  const now = new Date()
  const batchStartMs = Date.now()

  const batchItems = coerceBatchIngestItems(input)
  if (batchItems) {
    if (settings.batchRequireOpenSession) {
      const marketOpen = await resolveTradingSessionOpen(settings)
      if (marketOpen === false) {
        await executeDbTransaction(db, async (trx) => {
          await upsertRunLifecycleFromIngest({
            trx,
            requestId,
            symbol: '*',
            domain,
            runName,
            provider,
            lifecycleStatus: 'cancelled',
            metadata: {
              ...metadata,
              batch: {
                processedSymbols: 0,
                updatedSymbols: 0,
                failedSymbols: 0,
              },
              skipped: 'market_closed',
            },
            runError: null,
            now,
          })

          await upsertFinalizeEventFromIngest({
            trx,
            requestId,
            now,
            payload: {
              runStatus: 'cancelled',
              batch: {
                processedSymbols: 0,
                updatedSymbols: 0,
                failedSymbols: 0,
              },
              skipped: 'market_closed',
              metadata,
            },
          })
        })

        recordTorghutMarketContextBatchRun({ domain, outcome: 'skipped_market_closed' })
        recordTorghutMarketContextBatchRunDurationMs(Date.now() - batchStartMs, { domain })
        recordTorghutMarketContextBatchRunSymbols(0, { domain, category: 'processed' })
        recordTorghutMarketContextBatchRunSymbols(0, { domain, category: 'updated' })
        recordTorghutMarketContextBatchRunSymbols(0, { domain, category: 'failed' })

        return {
          ok: true,
          domain,
          runStatus,
          requestId,
          batch: {
            processedSymbols: 0,
            updatedSymbols: 0,
            failedSymbols: 0,
          },
          skipped: 'market_closed',
        }
      }
    }

    const shouldPersistBatchSnapshot = runStatus === 'succeeded' || runStatus === 'partial'
    let processedSymbols = 0
    let updatedSymbols = 0
    let failedSymbols = 0
    const freshnessLagsSeconds: number[] = []

    await executeDbTransaction(db, async (trx) => {
      for (const item of batchItems) {
        processedSymbols += 1
        const itemShouldPersist = shouldPersistBatchSnapshot && !item.error

        if (itemShouldPersist) {
          await upsertSnapshotFromIngest({
            trx,
            symbol: item.symbol,
            domain,
            asOf: item.asOf,
            sourceCount: item.sourceCount,
            qualityScore: item.qualityScore,
            payload: item.payload,
            citations: item.citations,
            riskFlags: item.riskFlags,
            provider,
            runName,
            now,
          })
          updatedSymbols += 1
          freshnessLagsSeconds.push(resolveFreshnessSeconds(now, item.asOf))
        } else {
          failedSymbols += 1
        }
      }

      await upsertRunLifecycleFromIngest({
        trx,
        requestId,
        symbol: '*',
        domain,
        runName,
        provider,
        lifecycleStatus,
        metadata: {
          ...metadata,
          batch: {
            processedSymbols,
            updatedSymbols,
            failedSymbols,
          },
        },
        runError,
        now,
      })

      await upsertFinalizeEventFromIngest({
        trx,
        requestId,
        now,
        payload: {
          runStatus: lifecycleStatus,
          batch: {
            processedSymbols,
            updatedSymbols,
            failedSymbols,
          },
          metadata,
        },
      })
    })

    if (updatedSymbols > 0) {
      clearMarketContextCache()
    }

    const outcome: 'succeeded' | 'partial' | 'failed' =
      failedSymbols === 0 ? 'succeeded' : updatedSymbols > 0 ? 'partial' : 'failed'
    recordTorghutMarketContextBatchRun({ domain, outcome })
    recordTorghutMarketContextBatchRunDurationMs(Date.now() - batchStartMs, { domain })
    recordTorghutMarketContextBatchRunSymbols(processedSymbols, { domain, category: 'processed' })
    recordTorghutMarketContextBatchRunSymbols(updatedSymbols, { domain, category: 'updated' })
    recordTorghutMarketContextBatchRunSymbols(failedSymbols, { domain, category: 'failed' })
    for (const lagSeconds of freshnessLagsSeconds) {
      recordTorghutMarketContextBatchFreshnessLagSeconds(lagSeconds, { domain })
    }

    return {
      ok: true,
      domain,
      runStatus,
      requestId,
      batch: {
        processedSymbols,
        updatedSymbols,
        failedSymbols,
      },
    }
  }

  const symbolRaw = typeof input.symbol === 'string' ? input.symbol.trim() : ''
  if (!symbolRaw) throw new Error('symbol is required')

  const symbol = normalizeTorghutSymbol(symbolRaw)
  const asOf = parseTimestamp(input.asOfUtc ?? input.asOf ?? input.publishedAt) ?? new Date()
  const sourceCount = coerceSourceCount(input.sourceCount ?? input.itemCount)
  const qualityScore = coerceQualityScore(input.qualityScore)
  const payload = coercePayload(input.payload ?? input.context)
  const citations = coerceCitations(input.citations)
  const riskFlags = coerceRiskFlags(input.riskFlags)
  const shouldPersistSnapshot = runStatus === 'succeeded' || runStatus === 'partial'

  await executeDbTransaction(db, async (trx) => {
    if (shouldPersistSnapshot) {
      await upsertSnapshotFromIngest({
        trx,
        symbol,
        domain,
        asOf,
        sourceCount,
        qualityScore,
        payload,
        citations,
        riskFlags,
        provider,
        runName,
        now,
      })
    }

    await upsertRunLifecycleFromIngest({
      trx,
      requestId,
      symbol,
      domain,
      runName,
      provider,
      lifecycleStatus,
      metadata,
      runError,
      now,
    })

    await upsertFinalizeEventFromIngest({
      trx,
      requestId,
      now,
      payload: {
        runStatus: lifecycleStatus,
        sourceCount,
        qualityScore,
        shouldPersistSnapshot,
        metadata,
      },
    })
  })

  if (shouldPersistSnapshot) {
    clearMarketContextCache()
  }

  return {
    ok: true,
    symbol,
    domain,
    runStatus,
    requestId,
    context: {
      asOfUtc: toIso(asOf),
      sourceCount,
      qualityScore,
      payload,
      citations,
      riskFlags,
    },
  }
}

let authApi: AuthenticationV1Api | null | undefined

const resolveAllowedServiceAccountPrefixes = () => {
  const raw = process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES?.trim()
  if (!raw) return [DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX]
  const prefixes = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return prefixes.length > 0 ? prefixes : [DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX]
}

const resolveAuthApi = () => {
  if (authApi) return authApi
  try {
    const kubeConfig = new KubeConfig()
    kubeConfig.loadFromCluster()
    authApi = kubeConfig.makeApiClient(AuthenticationV1Api)
    return authApi
  } catch {
    authApi = null
    return null
  }
}

const logIngestAuth = (payload: Record<string, unknown>) => {
  console.info('[jangar] market_context_ingest_auth', payload)
}

const buildTokenReviewRequest = (token: string): V1TokenReview => ({
  apiVersion: 'authentication.k8s.io/v1',
  kind: 'TokenReview',
  spec: { token },
})

const parseTokenReviewResponse = (response: unknown) => {
  const responseRecord = response && typeof response === 'object' ? (response as Record<string, unknown>) : null
  const maybeBody =
    responseRecord && responseRecord.body && typeof responseRecord.body === 'object'
      ? (responseRecord.body as Record<string, unknown>)
      : responseRecord

  const status =
    maybeBody && maybeBody.status && typeof maybeBody.status === 'object'
      ? (maybeBody.status as Record<string, unknown>)
      : null
  if (!status) return { authenticated: false, username: '' }

  const user = status.user && typeof status.user === 'object' ? (status.user as Record<string, unknown>) : null
  const username = user && typeof user.username === 'string' ? user.username : ''

  return {
    authenticated: status.authenticated === true,
    username,
  }
}

const resolveTokenReviewAuthorization = (response: unknown, method: string) => {
  const { authenticated, username } = parseTokenReviewResponse(response)
  if (!authenticated) {
    logIngestAuth({ method, authenticated: false })
    return false
  }
  if (!username) {
    logIngestAuth({ method, authenticated: false, reason: 'missing_username' })
    return false
  }

  const allowedPrefixes = resolveAllowedServiceAccountPrefixes()
  const allowed = allowedPrefixes.some((prefix) => username.startsWith(prefix))
  logIngestAuth({ method, authenticated: true, username, allowed })
  return allowed
}

const createTokenReviewWithInClusterHttps = async (body: V1TokenReview): Promise<unknown | null> => {
  const host = process.env.KUBERNETES_SERVICE_HOST?.trim()
  if (!host) return null
  const port = process.env.KUBERNETES_SERVICE_PORT?.trim() || '443'

  let reviewerToken = ''
  let caCertificate = ''
  try {
    reviewerToken = readFileSync(IN_CLUSTER_SERVICE_ACCOUNT_TOKEN_PATH, 'utf8').trim()
    caCertificate = readFileSync(IN_CLUSTER_SERVICE_ACCOUNT_CA_PATH, 'utf8')
  } catch {
    return null
  }
  if (!reviewerToken || !caCertificate.trim()) return null

  const payload = JSON.stringify(body)

  return await new Promise<unknown>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: host,
        port,
        path: '/apis/authentication.k8s.io/v1/tokenreviews',
        method: 'POST',
        headers: {
          authorization: `Bearer ${reviewerToken}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString(),
        },
        ca: caCertificate,
      },
      (response) => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          raw += chunk
        })
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`tokenreview_http_${statusCode}`))
            return
          }
          if (!raw.trim()) {
            resolve({})
            return
          }
          try {
            resolve(JSON.parse(raw) as Record<string, unknown>)
          } catch (error) {
            reject(new Error(`invalid_tokenreview_json: ${error instanceof Error ? error.message : String(error)}`))
          }
        })
      },
    )

    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}

const verifyServiceAccountTokenWithHttpsTokenReview = async (body: V1TokenReview) => {
  try {
    const response = await createTokenReviewWithInClusterHttps(body)
    if (!response) {
      logIngestAuth({
        method: 'service_account_token_review_https',
        authenticated: false,
        reason: 'in_cluster_reviewer_credentials_unavailable',
      })
      return false
    }
    return resolveTokenReviewAuthorization(response, 'service_account_token_review_https')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logIngestAuth({
      method: 'service_account_token_review_https',
      authenticated: false,
      error: message.slice(0, 200),
    })
    return false
  }
}

const verifyServiceAccountTokenWithTokenReview = async (token: string) => {
  const body = buildTokenReviewRequest(token)
  const api = resolveAuthApi()
  if (!api) return verifyServiceAccountTokenWithHttpsTokenReview(body)

  try {
    // @kubernetes/client-node v1 expects `createTokenReview({ body })`.
    const response = await (api.createTokenReview as unknown as (arg: { body: V1TokenReview }) => Promise<unknown>)({
      body,
    })
    return resolveTokenReviewAuthorization(response, 'service_account_token_review')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logIngestAuth({ method: 'service_account_token_review', authenticated: false, error: message.slice(0, 200) })
    return verifyServiceAccountTokenWithHttpsTokenReview(body)
  }
}

const resolveSharedIngestToken = () => {
  const token = process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN?.trim()
  return token && token.length > 0 ? token : null
}

const resolveServiceAccountTokenAuthEnabled = () =>
  parseBoolean(process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN, true)

const safeEquals = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

const resolveBearerToken = (request: Request) => {
  const raw = request.headers.get('authorization')?.trim()
  if (!raw) return null
  const [scheme, ...rest] = raw.split(/\s+/g)
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

export const isMarketContextIngestAuthorized = async (request: Request) => {
  const actual = resolveBearerToken(request)
  if (!actual) {
    logIngestAuth({ method: 'none', authorized: false, reason: 'missing_bearer_token' })
    return false
  }

  const expected = resolveSharedIngestToken()
  if (expected) {
    if (safeEquals(actual, expected)) {
      logIngestAuth({ method: 'shared_token', authorized: true })
      return true
    }

    logIngestAuth({ method: 'shared_token', authorized: false, reason: 'token_mismatch' })
    if (!resolveServiceAccountTokenAuthEnabled()) {
      logIngestAuth({ method: 'service_account_token', authorized: false, reason: 'service_account_auth_disabled' })
      return false
    }

    const authorized = await verifyServiceAccountTokenWithTokenReview(actual)
    logIngestAuth({ method: 'service_account_token', authorized, reason: 'shared_token_mismatch_fallback' })
    return authorized
  }

  if (!resolveServiceAccountTokenAuthEnabled()) {
    logIngestAuth({ method: 'service_account_token', authorized: false, reason: 'service_account_auth_disabled' })
    return false
  }

  const authorized = await verifyServiceAccountTokenWithTokenReview(actual)
  logIngestAuth({ method: 'service_account_token', authorized })
  return authorized
}
