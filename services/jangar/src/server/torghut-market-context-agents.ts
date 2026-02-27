import { randomUUID, timingSafeEqual } from 'node:crypto'

import { AuthenticationV1Api, KubeConfig, type V1TokenReview } from '@kubernetes/client-node'
import { sql } from 'kysely'

import { getDb } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'
import { createKubernetesClient } from '~/server/primitives-kube'
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
}

const DEFAULT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS = 24 * 60 * 60
const DEFAULT_NEWS_MAX_FRESHNESS_SECONDS = 5 * 60
const DEFAULT_FUNDAMENTALS_DISPATCH_COOLDOWN_SECONDS = 30 * 60
const DEFAULT_NEWS_DISPATCH_COOLDOWN_SECONDS = 2 * 60
const DEFAULT_AGENT_RUN_TTL_SECONDS = 30 * 60
const DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX = 'system:serviceaccount:agents:'

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

const KUBERNETES_LABEL_MAX_LENGTH = 63
const toKubernetesLabelValue = (raw: string, fallback = 'unknown') => {
  const normalized = raw
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
  if (!normalized) return fallback
  const truncated = normalized.slice(0, KUBERNETES_LABEL_MAX_LENGTH).replace(/[^A-Za-z0-9]+$/, '')
  return truncated || fallback
}

const resolveSettings = () => {
  const callbackBaseUrl =
    process.env.JANGAR_MARKET_CONTEXT_AGENT_CALLBACK_BASE_URL?.trim() || 'http://jangar.jangar.svc.cluster.local'
  const callbackIngestUrl = `${callbackBaseUrl.replace(/\/+$/, '')}/api/torghut/market-context/ingest`
  return {
    dispatchEnabled: parseBoolean(process.env.JANGAR_MARKET_CONTEXT_AGENT_DISPATCH_ENABLED, true),
    dispatchNamespace: process.env.JANGAR_MARKET_CONTEXT_AGENT_NAMESPACE?.trim() || 'agents',
    fundamentalsAgentName:
      process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_AGENT_NAME?.trim() || 'torghut-fundamentals-agent',
    newsAgentName: process.env.JANGAR_MARKET_CONTEXT_NEWS_AGENT_NAME?.trim() || 'torghut-news-agent',
    fundamentalsImplementationSpec:
      process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_IMPLEMENTATION_SPEC?.trim() ||
      'torghut-market-context-fundamentals-v1',
    newsImplementationSpec:
      process.env.JANGAR_MARKET_CONTEXT_NEWS_IMPLEMENTATION_SPEC?.trim() || 'torghut-market-context-news-v1',
    runtimeType: process.env.JANGAR_MARKET_CONTEXT_AGENT_RUNTIME_TYPE?.trim() || 'job',
    runtimeServiceAccount: process.env.JANGAR_MARKET_CONTEXT_AGENT_SERVICE_ACCOUNT?.trim() || '',
    fundamentalsMaxFreshnessSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS,
      DEFAULT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS,
    ),
    newsMaxFreshnessSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_NEWS_MAX_FRESHNESS_SECONDS,
      DEFAULT_NEWS_MAX_FRESHNESS_SECONDS,
    ),
    fundamentalsDispatchCooldownSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_DISPATCH_COOLDOWN_SECONDS,
      DEFAULT_FUNDAMENTALS_DISPATCH_COOLDOWN_SECONDS,
    ),
    newsDispatchCooldownSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_NEWS_DISPATCH_COOLDOWN_SECONDS,
      DEFAULT_NEWS_DISPATCH_COOLDOWN_SECONDS,
    ),
    callbackIngestUrl,
    agentRunTtlSeconds: parsePositiveInt(
      process.env.JANGAR_MARKET_CONTEXT_AGENT_TTL_SECONDS,
      DEFAULT_AGENT_RUN_TTL_SECONDS,
    ),
  }
}

const resolveDomainMaxFreshness = (domain: MarketContextProviderDomain, settings: ReturnType<typeof resolveSettings>) =>
  domain === 'fundamentals' ? settings.fundamentalsMaxFreshnessSeconds : settings.newsMaxFreshnessSeconds

const resolveDomainCooldown = (domain: MarketContextProviderDomain, settings: ReturnType<typeof resolveSettings>) =>
  domain === 'fundamentals' ? settings.fundamentalsDispatchCooldownSeconds : settings.newsDispatchCooldownSeconds

const resolveAgentName = (domain: MarketContextProviderDomain, settings: ReturnType<typeof resolveSettings>) =>
  domain === 'fundamentals' ? settings.fundamentalsAgentName : settings.newsAgentName

const resolveImplementationSpec = (domain: MarketContextProviderDomain, settings: ReturnType<typeof resolveSettings>) =>
  domain === 'fundamentals' ? settings.fundamentalsImplementationSpec : settings.newsImplementationSpec

const resolveFreshnessSeconds = (now: Date, asOf: Date) =>
  Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 1000))

const buildMissingContext = (params: {
  domain: MarketContextProviderDomain
  symbol: string
  dispatchQueued: boolean
  dispatchError: string | null
}) => {
  const riskFlags = [`${params.domain}_missing`]
  if (params.dispatchQueued) riskFlags.push(`${params.domain}_dispatch_queued`)
  if (params.dispatchError) riskFlags.push(`${params.domain}_dispatch_error`)
  return {
    asOfUtc: '',
    sourceCount: 0,
    qualityScore: 0,
    payload: {
      symbol: params.symbol,
      domain: params.domain,
      provider: 'codex-spark',
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
  }>`
    SELECT symbol, domain, as_of, source_count, quality_score, payload, citations, risk_flags
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
  }
}

const reserveDispatchSlot = async (params: {
  symbol: string
  domain: MarketContextProviderDomain
  now: Date
  cooldownSeconds: number
}) => {
  const db = await resolveDbWithMigrations()
  if (!db) return false

  const threshold = new Date(params.now.getTime() - params.cooldownSeconds * 1000)
  const result = await sql<{
    symbol: string
  }>`
    INSERT INTO torghut_market_context_dispatch_state (
      symbol,
      domain,
      last_dispatched_at,
      last_status,
      last_error,
      updated_at
    )
    VALUES (${params.symbol}, ${params.domain}, ${params.now}, 'queued', NULL, now())
    ON CONFLICT (symbol, domain) DO UPDATE
      SET
        last_dispatched_at = EXCLUDED.last_dispatched_at,
        last_status = 'queued',
        last_error = NULL,
        updated_at = now()
    WHERE
      torghut_market_context_dispatch_state.last_dispatched_at IS NULL OR
      torghut_market_context_dispatch_state.last_dispatched_at < ${threshold}
    RETURNING symbol;
  `.execute(db)

  return result.rows.length > 0
}

const updateDispatchState = async (params: {
  symbol: string
  domain: MarketContextProviderDomain
  status: string
  runName: string | null
  error: string | null
  now: Date
}) => {
  const db = await resolveDbWithMigrations()
  if (!db) return

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
        last_dispatched_at = EXCLUDED.last_dispatched_at,
        last_run_name = EXCLUDED.last_run_name,
        last_status = EXCLUDED.last_status,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at;
  `.execute(db)
}

export const buildMarketContextAgentRunRuntime = (params: { runtimeType: string; runtimeServiceAccount: string }) => {
  const runtimeConfig: Record<string, string> = {}
  if (params.runtimeServiceAccount.trim()) {
    runtimeConfig.serviceAccount = params.runtimeServiceAccount.trim()
  }
  return Object.keys(runtimeConfig).length > 0
    ? { type: params.runtimeType, config: runtimeConfig }
    : { type: params.runtimeType }
}

const dispatchDomainAgentRun = async (params: {
  domain: MarketContextProviderDomain
  symbol: string
  now: Date
  reason: string
}): Promise<MarketContextDispatchResult> => {
  const settings = resolveSettings()
  const cooldownSeconds = resolveDomainCooldown(params.domain, settings)
  const reserved = await reserveDispatchSlot({
    symbol: params.symbol,
    domain: params.domain,
    now: params.now,
    cooldownSeconds,
  })

  if (!reserved) {
    return {
      attempted: true,
      dispatched: false,
      reason: 'dispatch_cooldown_active',
      runName: null,
      error: null,
    }
  }

  const windowBucket = Math.floor(params.now.getTime() / (cooldownSeconds * 1000))
  const idempotencyKey = `torghut-market-context:${params.domain}:${params.symbol}:${windowBucket}`

  const resource: Record<string, unknown> = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      generateName: `torghut-market-context-${params.domain}-`,
      namespace: settings.dispatchNamespace,
      labels: {
        'torghut.proompteng.ai/symbol': toKubernetesLabelValue(params.symbol),
        'torghut.proompteng.ai/domain': params.domain,
        'jangar.proompteng.ai/source': 'torghut-market-context',
      },
    },
    spec: {
      agentRef: { name: resolveAgentName(params.domain, settings) },
      implementationSpecRef: { name: resolveImplementationSpec(params.domain, settings) },
      parameters: {
        symbol: params.symbol,
        domain: params.domain,
        asOfUtc: toIso(params.now),
        reason: params.reason,
        callbackUrl: settings.callbackIngestUrl,
        requestId: randomUUID(),
      },
      runtime: buildMarketContextAgentRunRuntime({
        runtimeType: settings.runtimeType,
        runtimeServiceAccount: settings.runtimeServiceAccount,
      }),
      ttlSecondsAfterFinished: settings.agentRunTtlSeconds,
      idempotencyKey,
    },
  }

  try {
    const kube = createKubernetesClient()
    const applied = await kube.apply(resource)
    const metadata =
      applied.metadata && typeof applied.metadata === 'object'
        ? (applied.metadata as Record<string, unknown>)
        : ({} as Record<string, unknown>)
    const runName = typeof metadata.name === 'string' ? metadata.name : null

    await updateDispatchState({
      symbol: params.symbol,
      domain: params.domain,
      status: 'submitted',
      runName,
      error: null,
      now: params.now,
    })

    return {
      attempted: true,
      dispatched: true,
      reason: null,
      runName,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDispatchState({
      symbol: params.symbol,
      domain: params.domain,
      status: 'dispatch_error',
      runName: null,
      error: message.slice(0, 500),
      now: params.now,
    })

    return {
      attempted: true,
      dispatched: false,
      reason: 'dispatch_failed',
      runName: null,
      error: message,
    }
  }
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

  if (!db) {
    return {
      symbol,
      domain: params.domain,
      snapshotState: 'missing',
      context: {
        ...buildMissingContext({
          domain: params.domain,
          symbol,
          dispatchQueued: false,
          dispatchError: null,
        }),
        riskFlags: [`${params.domain}_missing`, `${params.domain}_database_unavailable`],
      },
      dispatch: {
        attempted: false,
        dispatched: false,
        reason: 'database_unavailable',
        runName: null,
        error: null,
      },
    }
  }

  const snapshot = await readLatestSnapshot({ symbol, domain: params.domain })
  if (!snapshot) {
    const dispatch = settings.dispatchEnabled
      ? await dispatchDomainAgentRun({
          domain: params.domain,
          symbol,
          now,
          reason: 'missing_snapshot',
        })
      : {
          attempted: false,
          dispatched: false,
          reason: 'dispatch_disabled',
          runName: null,
          error: null,
        }

    return {
      symbol,
      domain: params.domain,
      snapshotState: 'missing',
      context: buildMissingContext({
        domain: params.domain,
        symbol,
        dispatchQueued: dispatch.dispatched,
        dispatchError: dispatch.error,
      }),
      dispatch,
    }
  }

  const freshnessSeconds = resolveFreshnessSeconds(now, snapshot.asOf)
  const isStale = freshnessSeconds > maxFreshnessSeconds

  const dispatch =
    settings.dispatchEnabled && isStale
      ? await dispatchDomainAgentRun({
          domain: params.domain,
          symbol,
          now,
          reason: 'stale_snapshot',
        })
      : {
          attempted: false,
          dispatched: false,
          reason: isStale ? 'dispatch_disabled' : null,
          runName: null,
          error: null,
        }

  const riskFlags = new Set(snapshot.riskFlags)
  if (isStale) riskFlags.add(`${params.domain}_stale`)
  if (dispatch.dispatched) riskFlags.add(`${params.domain}_dispatch_queued`)
  if (dispatch.error) riskFlags.add(`${params.domain}_dispatch_error`)

  return {
    symbol,
    domain: params.domain,
    snapshotState: isStale ? 'stale' : 'fresh',
    context: {
      asOfUtc: toIso(snapshot.asOf),
      sourceCount: snapshot.sourceCount,
      qualityScore: snapshot.qualityScore,
      payload: snapshot.payload,
      citations: snapshot.citations,
      riskFlags: Array.from(riskFlags),
    },
    dispatch,
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

export const ingestMarketContextProviderResult = async (input: IngestPayload) => {
  const db = await resolveDbWithMigrations()
  if (!db) throw new Error('DATABASE_URL is not configured')

  const domain = asDomain(input.domain)
  if (!domain) throw new Error('domain must be fundamentals or news')

  const symbolRaw = typeof input.symbol === 'string' ? input.symbol.trim() : ''
  if (!symbolRaw) throw new Error('symbol is required')

  const symbol = normalizeTorghutSymbol(symbolRaw)
  const asOf = parseTimestamp(input.asOfUtc ?? input.asOf ?? input.publishedAt) ?? new Date()
  const sourceCount = coerceSourceCount(input.sourceCount ?? input.itemCount)
  const qualityScore = coerceQualityScore(input.qualityScore)
  const payload = coercePayload(input.payload ?? input.context)
  const citations = coerceCitations(input.citations)
  const riskFlags = coerceRiskFlags(input.riskFlags)
  const provider =
    typeof input.provider === 'string' && input.provider.trim().length > 0 ? input.provider.trim() : 'codex-spark'
  const runName = typeof input.runName === 'string' && input.runName.trim().length > 0 ? input.runName.trim() : null
  const runStatus = coerceRunStatus(input.runStatus)
  const runError = typeof input.error === 'string' && input.error.trim().length > 0 ? input.error.trim() : null
  const now = new Date()

  const shouldPersistSnapshot = runStatus === 'succeeded' || runStatus === 'partial'
  if (shouldPersistSnapshot) {
    await db
      .insertInto('torghut_market_context_snapshots')
      .values({
        symbol,
        domain,
        as_of: asOf,
        source_count: sourceCount,
        quality_score: qualityScore,
        payload,
        citations,
        risk_flags: riskFlags,
        provider,
        run_name: runName,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['symbol', 'domain'])
          .doUpdateSet({
            as_of: asOf,
            source_count: sourceCount,
            quality_score: qualityScore,
            payload,
            citations,
            risk_flags: riskFlags,
            provider,
            run_name: runName,
            updated_at: now,
          })
          .where('torghut_market_context_snapshots.as_of', '<=', asOf),
      )
      .execute()
  }

  await db
    .insertInto('torghut_market_context_dispatch_state')
    .values({
      symbol,
      domain,
      last_dispatched_at: now,
      last_run_name: runName,
      last_status: runStatus,
      last_error: runError,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(['symbol', 'domain']).doUpdateSet({
        last_dispatched_at: now,
        last_run_name: runName,
        last_status: runStatus,
        last_error: runError,
        updated_at: now,
      }),
    )
    .execute()

  if (shouldPersistSnapshot) {
    clearMarketContextCache()
  }

  return {
    ok: true,
    symbol,
    domain,
    runStatus,
    requestId: typeof input.requestId === 'string' ? input.requestId : randomUUID(),
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
  if (authApi !== undefined) return authApi
  try {
    const kubeConfig = new KubeConfig()
    kubeConfig.loadFromCluster()
    authApi = kubeConfig.makeApiClient(AuthenticationV1Api)
  } catch {
    authApi = null
  }
  return authApi
}

const logIngestAuth = (payload: Record<string, unknown>) => {
  console.info('[jangar] market_context_ingest_auth', payload)
}

const verifyServiceAccountTokenWithTokenReview = async (token: string) => {
  const api = resolveAuthApi()
  if (!api) return false

  const body: V1TokenReview = {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    spec: { token },
  }

  try {
    // @kubernetes/client-node v1 expects `createTokenReview({ body })`.
    const response = await (api.createTokenReview as unknown as (arg: { body: V1TokenReview }) => Promise<unknown>)({
      body,
    })
    const responseRecord = response && typeof response === 'object' ? (response as Record<string, unknown>) : null
    const maybeBody =
      responseRecord && responseRecord.body && typeof responseRecord.body === 'object'
        ? (responseRecord.body as Record<string, unknown>)
        : responseRecord

    const status =
      maybeBody && maybeBody.status && typeof maybeBody.status === 'object'
        ? (maybeBody.status as Record<string, unknown>)
        : null
    if (!status || status.authenticated !== true) return false

    const user = status.user && typeof status.user === 'object' ? (status.user as Record<string, unknown>) : null
    const username = user && typeof user.username === 'string' ? user.username : ''
    if (!username) return false

    const allowedPrefixes = resolveAllowedServiceAccountPrefixes()
    const allowed = allowedPrefixes.some((prefix) => username.startsWith(prefix))
    logIngestAuth({ method: 'service_account_token_review', authenticated: true, username, allowed })
    return allowed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logIngestAuth({ method: 'service_account_token_review', authenticated: false, error: message.slice(0, 200) })
    return false
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
    const authorized = safeEquals(actual, expected)
    logIngestAuth({ method: 'shared_token', authorized })
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
