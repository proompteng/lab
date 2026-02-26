import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

type NullableString = string | null

type WhitepaperStorageConfig = {
  endpoint: string
  accessKey: string
  secretKey: string
  region: string
}

export type TorghutWhitepaperListFilters = {
  limit?: number
  offset?: number
  query?: string
  status?: string
  verdict?: string
}

export type TorghutWhitepaperListItem = {
  runId: string
  status: string
  triggerSource: string
  triggerActor: NullableString
  failureReason: NullableString
  createdAt: NullableString
  startedAt: NullableString
  completedAt: NullableString
  document: {
    key: NullableString
    title: NullableString
    source: NullableString
    sourceIdentifier: NullableString
    status: NullableString
    lastProcessedAt: NullableString
  }
  version: {
    versionNumber: number | null
    parseStatus: NullableString
    fileName: NullableString
    fileSizeBytes: number | null
    checksumSha256: NullableString
    cephBucket: NullableString
    cephObjectKey: NullableString
    sourceAttachmentUrl: NullableString
  }
  latestAgentrun: {
    name: NullableString
    status: NullableString
    headBranch: NullableString
    startedAt: NullableString
    completedAt: NullableString
  } | null
  verdict: {
    verdict: NullableString
    score: number | null
    confidence: number | null
    requiresFollowup: boolean
  } | null
  designPullRequest: {
    status: NullableString
    prNumber: number | null
    prUrl: NullableString
    isMerged: boolean
  } | null
  engineeringTrigger: {
    implementationGrade: NullableString
    decision: NullableString
    rolloutProfile: NullableString
    approvalSource: NullableString
    dispatchedAgentrunName: NullableString
  } | null
}

export type TorghutWhitepaperListResult = {
  items: TorghutWhitepaperListItem[]
  total: number
  limit: number
  offset: number
}

export type TorghutWhitepaperSemanticSearchFilters = {
  query: string
  limit?: number
  offset?: number
  status?: string
  scope?: 'all' | 'full_text' | 'synthesis'
  subject?: string
}

export type TorghutWhitepaperSemanticSearchItem = {
  runId: string
  runStatus: string
  runCreatedAt: NullableString
  runCompletedAt: NullableString
  document: {
    documentKey: NullableString
    title: NullableString
    sourceIdentifier: NullableString
  }
  chunk: {
    sourceScope: string
    sectionKey: NullableString
    chunkIndex: number
    snippet: string
  }
  semanticDistance: number | null
  lexicalScore: number | null
  hybridScore: number | null
}

export type TorghutWhitepaperSemanticSearchResult = {
  items: TorghutWhitepaperSemanticSearchItem[]
  total: number
  limit: number
  offset: number
  query: string
  scope: 'all' | 'full_text' | 'synthesis'
  status: string
  subject: NullableString
}

export type TorghutWhitepaperAgentRun = {
  id: string
  name: string
  status: string
  requestedBy: NullableString
  namespace: NullableString
  vcsRepository: NullableString
  vcsBaseBranch: NullableString
  vcsHeadBranch: NullableString
  startedAt: NullableString
  completedAt: NullableString
  failureReason: NullableString
  logArtifactRef: NullableString
  patchArtifactRef: NullableString
  createdAt: NullableString
}

export type TorghutWhitepaperDesignPullRequest = {
  id: string
  attempt: number | null
  status: string
  repository: NullableString
  baseBranch: NullableString
  headBranch: NullableString
  prNumber: number | null
  prUrl: NullableString
  title: NullableString
  ciStatus: NullableString
  isMerged: boolean
  mergedAt: NullableString
  createdAt: NullableString
}

export type TorghutWhitepaperAnalysisStep = {
  id: string
  stepName: string
  attempt: number | null
  status: string
  executor: NullableString
  startedAt: NullableString
  completedAt: NullableString
  durationMs: number | null
  error: unknown
  output: unknown
  createdAt: NullableString
}

export type TorghutWhitepaperArtifact = {
  id: string
  artifactScope: string
  artifactType: string
  artifactRole: NullableString
  cephBucket: NullableString
  cephObjectKey: NullableString
  artifactUri: NullableString
  contentType: NullableString
  sizeBytes: number | null
  createdAt: NullableString
}

export type TorghutWhitepaperRolloutTransition = {
  id: string
  transitionId: string
  fromStage: NullableString
  toStage: NullableString
  transitionType: string
  status: string
  reasonCodes: string[]
  blockingGate: NullableString
  evidenceHash: NullableString
  createdAt: NullableString
}

export type TorghutWhitepaperDetail = {
  run: {
    id: string
    runId: string
    status: string
    triggerSource: string
    triggerActor: NullableString
    failureCode: NullableString
    failureReason: NullableString
    createdAt: NullableString
    startedAt: NullableString
    completedAt: NullableString
    requestPayload: unknown
    resultPayload: unknown
  }
  document: {
    id: string
    key: NullableString
    title: NullableString
    source: NullableString
    sourceIdentifier: NullableString
    status: NullableString
    lastProcessedAt: NullableString
    metadata: unknown
    createdAt: NullableString
  }
  version: {
    id: string
    versionNumber: number | null
    fileName: NullableString
    fileSizeBytes: number | null
    checksumSha256: NullableString
    parseStatus: NullableString
    parseError: NullableString
    pageCount: number | null
    charCount: number | null
    tokenCount: number | null
    cephBucket: NullableString
    cephObjectKey: NullableString
    uploadedBy: NullableString
    uploadMetadata: unknown
    createdAt: NullableString
  }
  pdf: {
    fileName: NullableString
    cephBucket: NullableString
    cephObjectKey: NullableString
    sourceAttachmentUrl: NullableString
  }
  synthesis: {
    executiveSummary: NullableString
    methodologySummary: NullableString
    problemStatement: NullableString
    implementationPlanMd: NullableString
    confidence: number | null
    keyFindings: string[]
    noveltyClaims: string[]
    riskAssessment: unknown
    citations: unknown
    raw: unknown
  } | null
  verdict: {
    verdict: NullableString
    score: number | null
    confidence: number | null
    decisionPolicy: NullableString
    rationale: NullableString
    requiresFollowup: boolean
    rejectionReasons: string[]
    recommendations: string[]
    gating: unknown
  } | null
  engineeringTrigger: {
    triggerId: string
    implementationGrade: string
    decision: string
    reasonCodes: string[]
    approvalToken: NullableString
    dispatchedAgentrunName: NullableString
    rolloutProfile: string
    approvalSource: NullableString
    approvedBy: NullableString
    approvedAt: NullableString
    approvalReason: NullableString
    policyRef: NullableString
    gateSnapshotHash: NullableString
    gateSnapshot: unknown
    createdAt: NullableString
    updatedAt: NullableString
  } | null
  latestAgentrun: TorghutWhitepaperAgentRun | null
  agentruns: TorghutWhitepaperAgentRun[]
  designPullRequests: TorghutWhitepaperDesignPullRequest[]
  steps: TorghutWhitepaperAnalysisStep[]
  artifacts: TorghutWhitepaperArtifact[]
  rolloutTransitions: TorghutWhitepaperRolloutTransition[]
}

export type TorghutWhitepaperPdfLocator = {
  runId: string
  fileName: NullableString
  cephBucket: NullableString
  cephObjectKey: NullableString
  sourceAttachmentUrl: NullableString
}

export type TorghutWhitepaperManualApprovalInput = {
  runId: string
  approvedBy: string
  approvalReason: string
  targetScope?: string | null
  repository?: string | null
  base?: string | null
  head?: string | null
  rolloutProfile?: 'manual' | 'assisted' | 'automatic' | null
}

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const DEFAULT_SEARCH_LIMIT = 15
const MAX_SEARCH_LIMIT = 50
const DEFAULT_WHITEPAPER_CONTROL_BASE_URL = 'http://torghut.torghut.svc.cluster.local'
const WHITEPAPER_CONTROL_TIMEOUT_MS = 15_000

const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

const asIso = (value: unknown): string | null => {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const asInteger = (value: unknown): number | null => {
  const numeric = asNumber(value)
  if (numeric === null) return null
  return Math.trunc(numeric)
}

const asBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 't' || normalized === '1' || normalized === 'yes'
  }
  if (typeof value === 'number') return value !== 0
  return false
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const asStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null)
  }
  const single = asString(value)
  return single ? [single] : []
}

const extractSourceAttachmentUrl = (uploadMetadata: unknown): string | null => {
  const record = asRecord(uploadMetadata)
  if (!record) return null
  return (
    asString(record.attachment_url) ??
    asString(record.attachmentUrl) ??
    asString(record.source_url) ??
    asString(record.sourceUrl)
  )
}

const clampLimit = (value: number | undefined) => {
  if (!value || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(Math.trunc(value), MAX_LIMIT))
}

const clampOffset = (value: number | undefined) => {
  if (!value || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

const clampSearchLimit = (value: number | undefined) => {
  if (!value || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT
  return Math.max(1, Math.min(Math.trunc(value), MAX_SEARCH_LIMIT))
}

const resolveWhitepaperControlBaseUrl = () => {
  const explicit =
    asString(process.env.JANGAR_WHITEPAPER_CONTROL_BASE_URL) ??
    asString(process.env.JANGAR_WHITEPAPER_FINALIZE_BASE_URL) ??
    asString(process.env.TORGHUT_BASE_URL)
  return (explicit ?? DEFAULT_WHITEPAPER_CONTROL_BASE_URL).replace(/\/+$/, '')
}

const resolveWhitepaperControlToken = async () => {
  const explicit =
    asString(process.env.JANGAR_WHITEPAPER_CONTROL_TOKEN) ??
    asString(process.env.JANGAR_WHITEPAPER_FINALIZE_TOKEN) ??
    asString(process.env.WHITEPAPER_WORKFLOW_API_TOKEN) ??
    asString(process.env.JANGAR_API_KEY)
  if (explicit) return explicit

  const useServiceAccountToken = asBoolean(process.env.JANGAR_WHITEPAPER_FINALIZE_USE_SERVICE_ACCOUNT_TOKEN ?? 'true')
  if (!useServiceAccountToken) return null
  const tokenPath =
    asString(process.env.JANGAR_WHITEPAPER_SERVICE_ACCOUNT_TOKEN_PATH) ??
    '/var/run/secrets/kubernetes.io/serviceaccount/token'
  try {
    const token = (await readFile(tokenPath, 'utf8')).trim()
    return token || null
  } catch {
    return null
  }
}

const normalizeEndpoint = (endpoint: string, secure: boolean) => {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  return `http${secure ? 's' : ''}://${endpoint}`
}

const resolveStorageEndpoint = () => {
  const explicit = asString(process.env.WHITEPAPER_CEPH_ENDPOINT) ?? asString(process.env.MINIO_ENDPOINT)
  if (explicit) {
    const secureRaw = (process.env.WHITEPAPER_CEPH_USE_TLS ?? process.env.MINIO_SECURE ?? '').trim().toLowerCase()
    const secure = secureRaw === 'true' || secureRaw === '1' || secureRaw === 'yes'
    return normalizeEndpoint(explicit, secure)
  }

  const bucketHost = asString(process.env.WHITEPAPER_CEPH_BUCKET_HOST) ?? asString(process.env.BUCKET_HOST)
  if (!bucketHost) return null
  const bucketPort = asString(process.env.WHITEPAPER_CEPH_BUCKET_PORT) ?? asString(process.env.BUCKET_PORT)
  const secureRaw = (process.env.WHITEPAPER_CEPH_USE_TLS ?? '').trim().toLowerCase()
  const secure = secureRaw === 'true' || secureRaw === '1' || secureRaw === 'yes'
  const base = `http${secure ? 's' : ''}://${bucketHost}`
  return bucketPort ? `${base}:${bucketPort}` : base
}

const resolveWhitepaperStorageConfig = (): WhitepaperStorageConfig | null => {
  const endpoint = resolveStorageEndpoint()
  const accessKey =
    asString(process.env.WHITEPAPER_CEPH_ACCESS_KEY) ??
    asString(process.env.AWS_ACCESS_KEY_ID) ??
    asString(process.env.MINIO_ACCESS_KEY)
  const secretKey =
    asString(process.env.WHITEPAPER_CEPH_SECRET_KEY) ??
    asString(process.env.AWS_SECRET_ACCESS_KEY) ??
    asString(process.env.MINIO_SECRET_KEY)
  const region =
    asString(process.env.WHITEPAPER_CEPH_REGION) ??
    asString(process.env.AWS_REGION) ??
    asString(process.env.AWS_DEFAULT_REGION) ??
    'us-east-1'

  if (!endpoint || !accessKey || !secretKey) return null
  return { endpoint, accessKey, secretKey, region }
}

const whitepaperS3ClientCache = (() => {
  let cachedKey: string | null = null
  let cachedClient: S3Client | null = null

  return (config: WhitepaperStorageConfig) => {
    const cacheKey = `${config.endpoint}:${config.accessKey}:${config.secretKey}:${config.region}`
    if (cachedClient && cachedKey === cacheKey) return cachedClient

    cachedKey = cacheKey
    cachedClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    })

    return cachedClient
  }
})()

const buildSignedPdfUrl = async (bucket: string, key: string) => {
  const config = resolveWhitepaperStorageConfig()
  if (!config) return null

  try {
    const client = whitepaperS3ClientCache(config)
    const command = new GetObjectCommand({ Bucket: bucket, Key: key })
    return await getSignedUrl(client, command, { expiresIn: 5 * 60 })
  } catch {
    return null
  }
}

const formatPdfResponse = (
  upstream: Response,
  {
    fileName,
    source,
  }: {
    fileName: string | null
    source: 'bucket' | 'source_url'
  },
) => {
  if (!upstream.ok || !upstream.body) return null

  const safeName = (fileName ?? 'whitepaper.pdf').replace(/[^a-zA-Z0-9._-]+/g, '_')
  const headers = new Headers()
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/pdf')
  headers.set('cache-control', 'private, max-age=60')
  headers.set('content-disposition', `inline; filename="${safeName}"`)
  headers.set('x-whitepaper-pdf-source', source)

  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('content-length', contentLength)

  return new Response(upstream.body, {
    status: 200,
    headers,
  })
}

const fetchPdfFromUrl = async (
  url: string,
  {
    fileName,
    source,
  }: {
    fileName: string | null
    source: 'bucket' | 'source_url'
  },
) => {
  try {
    const upstream = await fetch(url)
    return formatPdfResponse(upstream, { fileName, source })
  } catch {
    return null
  }
}

export const listTorghutWhitepapers = async (
  params: {
    pool: Pool
  } & TorghutWhitepaperListFilters,
): Promise<TorghutWhitepaperListResult> => {
  const limit = clampLimit(params.limit)
  const offset = clampOffset(params.offset)
  const query = asString(params.query)
  const status = asString(params.status)
  const verdict = asString(params.verdict)

  const result = await params.pool.query(
    `
      select
        count(*) over()::bigint as total_count,
        r.run_id,
        r.status as run_status,
        r.trigger_source,
        r.trigger_actor,
        r.failure_reason,
        r.created_at as run_created_at,
        r.started_at as run_started_at,
        r.completed_at as run_completed_at,
        d.document_key,
        d.title as document_title,
        d.source as document_source,
        d.source_identifier,
        d.status as document_status,
        d.last_processed_at,
        v.version_number,
        v.parse_status,
        v.file_name,
        v.file_size_bytes,
        v.checksum_sha256,
        v.ceph_bucket,
        v.ceph_object_key,
        v.upload_metadata_json,
        ag.agentrun_name,
        ag.status as agentrun_status,
        ag.vcs_head_branch,
        ag.started_at as agentrun_started_at,
        ag.completed_at as agentrun_completed_at,
        vv.verdict,
        vv.score,
        vv.confidence,
        vv.requires_followup,
        pr.status as pr_status,
        pr.pr_number,
        pr.pr_url,
        pr.is_merged,
        wt.implementation_grade,
        wt.decision as trigger_decision,
        wt.rollout_profile,
        wt.approval_source,
        wt.dispatched_agentrun_name
      from whitepaper_analysis_runs r
      join whitepaper_documents d on d.id = r.document_id
      join whitepaper_document_versions v on v.id = r.document_version_id
      left join lateral (
        select
          c.agentrun_name,
          c.status,
          c.vcs_head_branch,
          c.started_at,
          c.completed_at
        from whitepaper_codex_agentruns c
        where c.analysis_run_id = r.id
        order by c.created_at desc
        limit 1
      ) ag on true
      left join whitepaper_viability_verdicts vv on vv.analysis_run_id = r.id
      left join whitepaper_engineering_triggers wt on wt.analysis_run_id = r.id
      left join lateral (
        select
          p.status,
          p.pr_number,
          p.pr_url,
          p.is_merged
        from whitepaper_design_pull_requests p
        where p.analysis_run_id = r.id
        order by p.attempt desc, p.created_at desc
        limit 1
      ) pr on true
      where ($1::text is null or r.status = $1)
        and ($2::text is null or vv.verdict = $2)
        and (
          $3::text is null
          or d.title ilike '%' || $3 || '%'
          or d.source_identifier ilike '%' || $3 || '%'
          or r.run_id ilike '%' || $3 || '%'
        )
      order by r.created_at desc
      limit $4
      offset $5
    `,
    [status, verdict, query, limit, offset],
  )

  const items = result.rows.map((row) => {
    const uploadMetadata = asRecord(row.upload_metadata_json)

    const latestAgentrun = asString(row.agentrun_name)
      ? {
          name: asString(row.agentrun_name),
          status: asString(row.agentrun_status),
          headBranch: asString(row.vcs_head_branch),
          startedAt: asIso(row.agentrun_started_at),
          completedAt: asIso(row.agentrun_completed_at),
        }
      : null

    const verdictPayload = asString(row.verdict)
      ? {
          verdict: asString(row.verdict),
          score: asNumber(row.score),
          confidence: asNumber(row.confidence),
          requiresFollowup: asBoolean(row.requires_followup),
        }
      : null

    const designPullRequest =
      asString(row.pr_status) || asNumber(row.pr_number) !== null || asString(row.pr_url)
        ? {
            status: asString(row.pr_status),
            prNumber: asInteger(row.pr_number),
            prUrl: asString(row.pr_url),
            isMerged: asBoolean(row.is_merged),
          }
        : null
    const engineeringTrigger = asString(row.implementation_grade)
      ? {
          implementationGrade: asString(row.implementation_grade),
          decision: asString(row.trigger_decision),
          rolloutProfile: asString(row.rollout_profile),
          approvalSource: asString(row.approval_source),
          dispatchedAgentrunName: asString(row.dispatched_agentrun_name),
        }
      : null

    return {
      runId: String(row.run_id),
      status: String(row.run_status),
      triggerSource: String(row.trigger_source),
      triggerActor: asString(row.trigger_actor),
      failureReason: asString(row.failure_reason),
      createdAt: asIso(row.run_created_at),
      startedAt: asIso(row.run_started_at),
      completedAt: asIso(row.run_completed_at),
      document: {
        key: asString(row.document_key),
        title: asString(row.document_title),
        source: asString(row.document_source),
        sourceIdentifier: asString(row.source_identifier),
        status: asString(row.document_status),
        lastProcessedAt: asIso(row.last_processed_at),
      },
      version: {
        versionNumber: asInteger(row.version_number),
        parseStatus: asString(row.parse_status),
        fileName: asString(row.file_name),
        fileSizeBytes: asInteger(row.file_size_bytes),
        checksumSha256: asString(row.checksum_sha256),
        cephBucket: asString(row.ceph_bucket),
        cephObjectKey: asString(row.ceph_object_key),
        sourceAttachmentUrl: extractSourceAttachmentUrl(uploadMetadata),
      },
      latestAgentrun,
      verdict: verdictPayload,
      designPullRequest,
      engineeringTrigger,
    } satisfies TorghutWhitepaperListItem
  })

  const total = result.rows.length ? Math.max(0, asInteger(result.rows[0]?.total_count) ?? 0) : 0

  return {
    items,
    total,
    limit,
    offset,
  }
}

export const searchTorghutWhitepapersSemantic = async (
  filters: TorghutWhitepaperSemanticSearchFilters,
): Promise<TorghutWhitepaperSemanticSearchResult> => {
  const query = asString(filters.query)
  if (!query) throw new Error('query_required')

  const limit = clampSearchLimit(filters.limit)
  const offset = clampOffset(filters.offset)
  const status = asString(filters.status) ?? 'completed'
  const subject = asString(filters.subject)
  const scopeRaw = asString(filters.scope)
  const scope: 'all' | 'full_text' | 'synthesis' =
    scopeRaw === 'full_text' || scopeRaw === 'synthesis' || scopeRaw === 'all' ? scopeRaw : 'all'

  const baseUrl = resolveWhitepaperControlBaseUrl()
  const token = await resolveWhitepaperControlToken()
  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`

  const url = new URL(`${baseUrl}/whitepapers/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))
  url.searchParams.set('status', status)
  url.searchParams.set('scope', scope)
  if (subject) url.searchParams.set('subject', subject)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WHITEPAPER_CONTROL_TIMEOUT_MS)
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    })

    const raw = await response.text()
    let payload: unknown = null
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).detail === 'string'
          ? String((payload as Record<string, unknown>).detail)
          : raw || response.statusText
      throw new Error(`whitepaper_semantic_search_failed:${response.status}:${detail}`.slice(0, 400))
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error('whitepaper_semantic_search_invalid_response')
    }

    const record = payload as Record<string, unknown>
    const itemsRaw = Array.isArray(record.items) ? record.items : []
    const items = itemsRaw
      .map((item): TorghutWhitepaperSemanticSearchItem | null => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const chunk = asRecord(row.chunk)
        const document = asRecord(row.document)
        if (!chunk || !document) return null

        return {
          runId: String(row.run_id ?? ''),
          runStatus: String(row.run_status ?? ''),
          runCreatedAt: asIso(row.run_created_at),
          runCompletedAt: asIso(row.run_completed_at),
          document: {
            documentKey: asString(document.document_key),
            title: asString(document.title),
            sourceIdentifier: asString(document.source_identifier),
          },
          chunk: {
            sourceScope: String(chunk.source_scope ?? 'all'),
            sectionKey: asString(chunk.section_key),
            chunkIndex: asInteger(chunk.chunk_index) ?? 0,
            snippet: String(chunk.snippet ?? ''),
          },
          semanticDistance: asNumber(row.semantic_distance),
          lexicalScore: asNumber(row.lexical_score),
          hybridScore: asNumber(row.hybrid_score),
        }
      })
      .filter((item): item is TorghutWhitepaperSemanticSearchItem => item !== null && item.runId.length > 0)

    const payloadScope = asString(record.scope)
    const normalizedScope: 'all' | 'full_text' | 'synthesis' =
      payloadScope === 'full_text' || payloadScope === 'synthesis' ? payloadScope : 'all'

    return {
      items,
      total: asInteger(record.total) ?? 0,
      limit: asInteger(record.limit) ?? limit,
      offset: asInteger(record.offset) ?? offset,
      query: asString(record.query) ?? query,
      scope: normalizedScope,
      status: asString(record.status) ?? status,
      subject: asString(record.subject),
    }
  } finally {
    clearTimeout(timeout)
  }
}

const mapAgentRunRow = (row: Record<string, unknown>): TorghutWhitepaperAgentRun => ({
  id: String(row.id),
  name: String(row.agentrun_name),
  status: String(row.status),
  requestedBy: asString(row.requested_by),
  namespace: asString(row.agentrun_namespace),
  vcsRepository: asString(row.vcs_repository),
  vcsBaseBranch: asString(row.vcs_base_branch),
  vcsHeadBranch: asString(row.vcs_head_branch),
  startedAt: asIso(row.started_at),
  completedAt: asIso(row.completed_at),
  failureReason: asString(row.failure_reason),
  logArtifactRef: asString(row.log_artifact_ref),
  patchArtifactRef: asString(row.patch_artifact_ref),
  createdAt: asIso(row.created_at),
})

export const getTorghutWhitepaperDetail = async (params: {
  pool: Pool
  runId: string
}): Promise<TorghutWhitepaperDetail | null> => {
  const runResult = await params.pool.query(
    `
      select
        r.id::text as analysis_run_id,
        r.run_id,
        r.status as run_status,
        r.trigger_source,
        r.trigger_actor,
        r.failure_code,
        r.failure_reason,
        r.created_at as run_created_at,
        r.started_at as run_started_at,
        r.completed_at as run_completed_at,
        r.request_payload_json,
        r.result_payload_json,
        d.id::text as document_id,
        d.document_key,
        d.title as document_title,
        d.source as document_source,
        d.source_identifier,
        d.status as document_status,
        d.last_processed_at,
        d.metadata_json,
        d.created_at as document_created_at,
        v.id::text as document_version_id,
        v.version_number,
        v.file_name,
        v.file_size_bytes,
        v.checksum_sha256,
        v.parse_status,
        v.parse_error,
        v.page_count,
        v.char_count,
        v.token_count,
        v.ceph_bucket,
        v.ceph_object_key,
        v.uploaded_by,
        v.upload_metadata_json,
        v.created_at as version_created_at,
        s.executive_summary,
        s.methodology_summary,
        s.problem_statement,
        s.implementation_plan_md,
        s.confidence as synthesis_confidence,
        s.key_findings_json,
        s.novelty_claims_json,
        s.risk_assessment_json,
        s.citations_json,
        s.synthesis_json,
        vv.verdict,
        vv.score,
        vv.confidence as verdict_confidence,
        vv.decision_policy,
        vv.rationale,
        vv.requires_followup,
        vv.rejection_reasons_json,
        vv.recommendations_json,
        vv.gating_json,
        wt.id::text as trigger_row_id,
        wt.trigger_id,
        wt.implementation_grade,
        wt.decision as trigger_decision,
        wt.reason_codes_json as trigger_reason_codes_json,
        wt.approval_token,
        wt.dispatched_agentrun_name,
        wt.rollout_profile,
        wt.approval_source,
        wt.approved_by,
        wt.approved_at,
        wt.approval_reason,
        wt.policy_ref,
        wt.gate_snapshot_hash,
        wt.gate_snapshot_json,
        wt.created_at as trigger_created_at,
        wt.updated_at as trigger_updated_at
      from whitepaper_analysis_runs r
      join whitepaper_documents d on d.id = r.document_id
      join whitepaper_document_versions v on v.id = r.document_version_id
      left join whitepaper_syntheses s on s.analysis_run_id = r.id
      left join whitepaper_viability_verdicts vv on vv.analysis_run_id = r.id
      left join whitepaper_engineering_triggers wt on wt.analysis_run_id = r.id
      where r.run_id = $1
      limit 1
    `,
    [params.runId],
  )

  const runRow = runResult.rows[0] as Record<string, unknown> | undefined
  if (!runRow) return null

  const analysisRunId = String(runRow.analysis_run_id)
  const triggerRowId = asString(runRow.trigger_row_id)

  const [agentrunsResult, stepsResult, prsResult, artifactsResult, rolloutTransitionsResult] = await Promise.all([
    params.pool.query(
      `
        select
          id::text,
          agentrun_name,
          status,
          requested_by,
          agentrun_namespace,
          vcs_repository,
          vcs_base_branch,
          vcs_head_branch,
          started_at,
          completed_at,
          failure_reason,
          log_artifact_ref,
          patch_artifact_ref,
          created_at
        from whitepaper_codex_agentruns
        where analysis_run_id = $1::uuid
        order by created_at desc
      `,
      [analysisRunId],
    ),
    params.pool.query(
      `
        select
          id::text,
          step_name,
          attempt,
          status,
          executor,
          started_at,
          completed_at,
          duration_ms,
          error_json,
          output_json,
          created_at
        from whitepaper_analysis_steps
        where analysis_run_id = $1::uuid
        order by created_at asc, attempt asc
      `,
      [analysisRunId],
    ),
    params.pool.query(
      `
        select
          id::text,
          attempt,
          status,
          repository,
          base_branch,
          head_branch,
          pr_number,
          pr_url,
          title,
          ci_status,
          is_merged,
          merged_at,
          created_at
        from whitepaper_design_pull_requests
        where analysis_run_id = $1::uuid
        order by attempt desc, created_at desc
      `,
      [analysisRunId],
    ),
    params.pool.query(
      `
        select
          id::text,
          artifact_scope,
          artifact_type,
          artifact_role,
          ceph_bucket,
          ceph_object_key,
          artifact_uri,
          content_type,
          size_bytes,
          created_at
        from whitepaper_artifacts
        where analysis_run_id = $1::uuid
        order by created_at desc
        limit 200
      `,
      [analysisRunId],
    ),
    triggerRowId
      ? params.pool.query(
          `
            select
              id::text,
              transition_id,
              from_stage,
              to_stage,
              transition_type,
              status,
              reason_codes_json,
              blocking_gate,
              evidence_hash,
              created_at
            from whitepaper_rollout_transitions
            where trigger_id = $1::uuid
            order by created_at asc
          `,
          [triggerRowId],
        )
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ])

  const uploadMetadata = asRecord(runRow.upload_metadata_json)

  const synthesis = asString(runRow.executive_summary)
    ? {
        executiveSummary: asString(runRow.executive_summary),
        methodologySummary: asString(runRow.methodology_summary),
        problemStatement: asString(runRow.problem_statement),
        implementationPlanMd: asString(runRow.implementation_plan_md),
        confidence: asNumber(runRow.synthesis_confidence),
        keyFindings: asStringArray(runRow.key_findings_json),
        noveltyClaims: asStringArray(runRow.novelty_claims_json),
        riskAssessment: runRow.risk_assessment_json ?? null,
        citations: runRow.citations_json ?? null,
        raw: runRow.synthesis_json ?? null,
      }
    : null

  const verdict = asString(runRow.verdict)
    ? {
        verdict: asString(runRow.verdict),
        score: asNumber(runRow.score),
        confidence: asNumber(runRow.verdict_confidence),
        decisionPolicy: asString(runRow.decision_policy),
        rationale: asString(runRow.rationale),
        requiresFollowup: asBoolean(runRow.requires_followup),
        rejectionReasons: asStringArray(runRow.rejection_reasons_json),
        recommendations: asStringArray(runRow.recommendations_json),
        gating: runRow.gating_json ?? null,
      }
    : null
  const engineeringTrigger = asString(runRow.trigger_id)
    ? {
        triggerId: String(runRow.trigger_id),
        implementationGrade: String(runRow.implementation_grade ?? 'research_only'),
        decision: String(runRow.trigger_decision ?? 'suppressed'),
        reasonCodes: asStringArray(runRow.trigger_reason_codes_json),
        approvalToken: asString(runRow.approval_token),
        dispatchedAgentrunName: asString(runRow.dispatched_agentrun_name),
        rolloutProfile: String(runRow.rollout_profile ?? 'manual'),
        approvalSource: asString(runRow.approval_source),
        approvedBy: asString(runRow.approved_by),
        approvedAt: asIso(runRow.approved_at),
        approvalReason: asString(runRow.approval_reason),
        policyRef: asString(runRow.policy_ref),
        gateSnapshotHash: asString(runRow.gate_snapshot_hash),
        gateSnapshot: runRow.gate_snapshot_json ?? null,
        createdAt: asIso(runRow.trigger_created_at),
        updatedAt: asIso(runRow.trigger_updated_at),
      }
    : null

  const agentruns = agentrunsResult.rows.map((row) => mapAgentRunRow(row as Record<string, unknown>))
  const latestAgentrun = agentruns[0] ?? null

  const designPullRequests = prsResult.rows.map((row) => {
    const record = row as Record<string, unknown>
    return {
      id: String(record.id),
      attempt: asInteger(record.attempt),
      status: String(record.status),
      repository: asString(record.repository),
      baseBranch: asString(record.base_branch),
      headBranch: asString(record.head_branch),
      prNumber: asInteger(record.pr_number),
      prUrl: asString(record.pr_url),
      title: asString(record.title),
      ciStatus: asString(record.ci_status),
      isMerged: asBoolean(record.is_merged),
      mergedAt: asIso(record.merged_at),
      createdAt: asIso(record.created_at),
    } satisfies TorghutWhitepaperDesignPullRequest
  })

  const steps = stepsResult.rows.map((row) => {
    const record = row as Record<string, unknown>
    return {
      id: String(record.id),
      stepName: String(record.step_name),
      attempt: asInteger(record.attempt),
      status: String(record.status),
      executor: asString(record.executor),
      startedAt: asIso(record.started_at),
      completedAt: asIso(record.completed_at),
      durationMs: asInteger(record.duration_ms),
      error: record.error_json ?? null,
      output: record.output_json ?? null,
      createdAt: asIso(record.created_at),
    } satisfies TorghutWhitepaperAnalysisStep
  })

  const artifacts = artifactsResult.rows.map((row) => {
    const record = row as Record<string, unknown>
    return {
      id: String(record.id),
      artifactScope: String(record.artifact_scope),
      artifactType: String(record.artifact_type),
      artifactRole: asString(record.artifact_role),
      cephBucket: asString(record.ceph_bucket),
      cephObjectKey: asString(record.ceph_object_key),
      artifactUri: asString(record.artifact_uri),
      contentType: asString(record.content_type),
      sizeBytes: asInteger(record.size_bytes),
      createdAt: asIso(record.created_at),
    } satisfies TorghutWhitepaperArtifact
  })
  const rolloutTransitions = rolloutTransitionsResult.rows.map((row) => {
    const record = row as Record<string, unknown>
    return {
      id: String(record.id),
      transitionId: String(record.transition_id),
      fromStage: asString(record.from_stage),
      toStage: asString(record.to_stage),
      transitionType: String(record.transition_type),
      status: String(record.status),
      reasonCodes: asStringArray(record.reason_codes_json),
      blockingGate: asString(record.blocking_gate),
      evidenceHash: asString(record.evidence_hash),
      createdAt: asIso(record.created_at),
    } satisfies TorghutWhitepaperRolloutTransition
  })

  return {
    run: {
      id: String(runRow.analysis_run_id),
      runId: String(runRow.run_id),
      status: String(runRow.run_status),
      triggerSource: String(runRow.trigger_source),
      triggerActor: asString(runRow.trigger_actor),
      failureCode: asString(runRow.failure_code),
      failureReason: asString(runRow.failure_reason),
      createdAt: asIso(runRow.run_created_at),
      startedAt: asIso(runRow.run_started_at),
      completedAt: asIso(runRow.run_completed_at),
      requestPayload: runRow.request_payload_json ?? null,
      resultPayload: runRow.result_payload_json ?? null,
    },
    document: {
      id: String(runRow.document_id),
      key: asString(runRow.document_key),
      title: asString(runRow.document_title),
      source: asString(runRow.document_source),
      sourceIdentifier: asString(runRow.source_identifier),
      status: asString(runRow.document_status),
      lastProcessedAt: asIso(runRow.last_processed_at),
      metadata: runRow.metadata_json ?? null,
      createdAt: asIso(runRow.document_created_at),
    },
    version: {
      id: String(runRow.document_version_id),
      versionNumber: asInteger(runRow.version_number),
      fileName: asString(runRow.file_name),
      fileSizeBytes: asInteger(runRow.file_size_bytes),
      checksumSha256: asString(runRow.checksum_sha256),
      parseStatus: asString(runRow.parse_status),
      parseError: asString(runRow.parse_error),
      pageCount: asInteger(runRow.page_count),
      charCount: asInteger(runRow.char_count),
      tokenCount: asInteger(runRow.token_count),
      cephBucket: asString(runRow.ceph_bucket),
      cephObjectKey: asString(runRow.ceph_object_key),
      uploadedBy: asString(runRow.uploaded_by),
      uploadMetadata: uploadMetadata,
      createdAt: asIso(runRow.version_created_at),
    },
    pdf: {
      fileName: asString(runRow.file_name),
      cephBucket: asString(runRow.ceph_bucket),
      cephObjectKey: asString(runRow.ceph_object_key),
      sourceAttachmentUrl: extractSourceAttachmentUrl(uploadMetadata),
    },
    synthesis,
    verdict,
    engineeringTrigger,
    latestAgentrun,
    agentruns,
    designPullRequests,
    steps,
    artifacts,
    rolloutTransitions,
  }
}

export const approveTorghutWhitepaperForImplementation = async (
  input: TorghutWhitepaperManualApprovalInput,
): Promise<Record<string, unknown>> => {
  const runId = input.runId.trim()
  if (!runId) throw new Error('run_id_required')
  const approvedBy = input.approvedBy.trim()
  if (!approvedBy) throw new Error('approved_by_required')
  const approvalReason = input.approvalReason.trim()
  if (!approvalReason) throw new Error('approval_reason_required')

  const baseUrl = resolveWhitepaperControlBaseUrl()
  const token = await resolveWhitepaperControlToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WHITEPAPER_CONTROL_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/whitepapers/runs/${encodeURIComponent(runId)}/approve-implementation`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        approved_by: approvedBy,
        approval_reason: approvalReason,
        approval_source: 'jangar_ui',
        target_scope: asString(input.targetScope),
        repository: asString(input.repository),
        base: asString(input.base),
        head: asString(input.head),
        rollout_profile: asString(input.rolloutProfile),
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    let payload: unknown = null
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : null
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).detail === 'string'
          ? String((payload as Record<string, unknown>).detail)
          : raw || response.statusText
      throw new Error(`whitepaper_approval_failed:${response.status}:${detail}`.slice(0, 400))
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('whitepaper_approval_invalid_response')
    }
    return payload as Record<string, unknown>
  } finally {
    clearTimeout(timeout)
  }
}

export const getTorghutWhitepaperPdfLocator = async (params: {
  pool: Pool
  runId: string
}): Promise<TorghutWhitepaperPdfLocator | null> => {
  const result = await params.pool.query(
    `
      select
        r.run_id,
        v.file_name,
        v.ceph_bucket,
        v.ceph_object_key,
        v.upload_metadata_json
      from whitepaper_analysis_runs r
      join whitepaper_document_versions v on v.id = r.document_version_id
      where r.run_id = $1
      limit 1
    `,
    [params.runId],
  )

  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null

  const uploadMetadata = asRecord(row.upload_metadata_json)

  return {
    runId: String(row.run_id),
    fileName: asString(row.file_name),
    cephBucket: asString(row.ceph_bucket),
    cephObjectKey: asString(row.ceph_object_key),
    sourceAttachmentUrl: extractSourceAttachmentUrl(uploadMetadata),
  }
}

export const streamTorghutWhitepaperPdf = async (locator: TorghutWhitepaperPdfLocator): Promise<Response | null> => {
  const bucket = asString(locator.cephBucket)
  const key = asString(locator.cephObjectKey)

  if (bucket && key) {
    const signedUrl = await buildSignedPdfUrl(bucket, key)
    if (signedUrl) {
      const streamed = await fetchPdfFromUrl(signedUrl, {
        fileName: locator.fileName,
        source: 'bucket',
      })
      if (streamed) return streamed
    }
  }

  const sourceUrl = asString(locator.sourceAttachmentUrl)
  if (!sourceUrl) return null

  return fetchPdfFromUrl(sourceUrl, {
    fileName: locator.fileName,
    source: 'source_url',
  })
}
