import { Buffer } from 'node:buffer'

import * as S from '@effect/schema/Schema'
import { Effect } from 'effect'
import * as Either from 'effect/Either'
import { createAgentMessagesStore } from '~/server/agent-messages-store'
import { createArgoClient } from '~/server/argo-client'
import { getCodexClient } from '~/server/codex-client'
import {
  buildBackfillDedupeKey,
  parseAgentMessagesFromEvents,
  parseAgentMessagesFromLog,
} from '~/server/codex-judge-agent-messages'
import { extractImplementationManifestFromArchive, extractTextFromArchive } from '~/server/codex-judge-artifacts'
import { loadCodexJudgeConfig } from '~/server/codex-judge-config'
import { evaluateDeterministicGates } from '~/server/codex-judge-gates'
import {
  type CodexEvaluationRecord,
  type CodexPendingRun,
  type CodexRunRecord,
  createCodexJudgeStore,
} from '~/server/codex-judge-store'
import { createGitHubClient, type PullRequest, type ReviewSummary } from '~/server/github-client'
import { createPostgresMemoriesStore } from '~/server/memories-store'

type MemoryStoreFactory = () => ReturnType<typeof createPostgresMemoriesStore>

const globalOverrides = globalThis as typeof globalThis & {
  __codexJudgeStoreMock?: ReturnType<typeof createCodexJudgeStore>
  __codexJudgeConfigMock?: ReturnType<typeof loadCodexJudgeConfig>
  __codexJudgeGithubMock?: ReturnType<typeof createGitHubClient>
  __codexJudgeMemoryStoreMock?: ReturnType<typeof createPostgresMemoriesStore>
  __codexJudgeMemoryStoreFactory?: MemoryStoreFactory
  __codexJudgeArgoMock?: ReturnType<typeof createArgoClient> | null
}

const store = globalOverrides.__codexJudgeStoreMock ?? createCodexJudgeStore()
const storeReady = store.ready ?? Promise.resolve()
const ensureStoreReady = async () => {
  await storeReady
}
storeReady.catch((error) => {
  console.error('Codex judge store failed to initialize', error)
})
const config = globalOverrides.__codexJudgeConfigMock ?? loadCodexJudgeConfig()
const github =
  globalOverrides.__codexJudgeGithubMock ??
  createGitHubClient({ token: config.githubToken, apiBaseUrl: config.githubApiBaseUrl })
const argo =
  globalOverrides.__codexJudgeArgoMock ??
  (config.argoServerUrl ? createArgoClient({ baseUrl: config.argoServerUrl }) : null)
const getMemoryStoreFactory = () => globalOverrides.__codexJudgeMemoryStoreFactory ?? createPostgresMemoriesStore

const scheduledRuns = new Map<string, NodeJS.Timeout>()
const activeEvaluations = new Set<string>()
let reconcileTimer: NodeJS.Timeout | null = null
let reconcileInFlight = false
const terminalStatuses = new Set(['completed', 'needs_human', 'needs_iteration'])
const isTerminalStatus = (status: string | null | undefined) => (status ? terminalStatuses.has(status) : false)
const MAX_JUDGE_JSON_RETRIES = 2
const RECONCILE_STARTUP_DELAY_MS = 5_000
const RECONCILE_INTERVAL_MS = 60_000
const RECONCILE_BASE_DELAY_MS = 1_000
const RECONCILE_JITTER_MS = 15_000
const PENDING_EVALUATION_STATUSES = ['run_complete', 'judging'] as const
const RECONCILE_DISABLED = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
const RERUN_SUBMISSION_BACKOFF_MS = [2_000, 7_000, 15_000]
const JSON_ONLY_REMINDER = [
  'IMPORTANT: Return a single JSON object only.',
  'Do not include markdown, code fences, or extra text.',
].join('\n')

const safeParseJson = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const decodeBase64Json = (value: string) => {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return safeParseJson(decoded)
  } catch {
    return {}
  }
}

const getParamValue = (params: ReadonlyArray<{ name?: string; value?: string }>, name: string) => {
  const match = params.find((param) => param.name === name)
  return match?.value ?? ''
}

const ParameterSchema = S.Struct({
  name: S.optional(S.String),
  value: S.optional(S.String),
})

const ParametersSchema = S.Array(ParameterSchema)

const ArtifactSchema = S.Struct({
  name: S.optional(S.String),
  key: S.optional(S.String),
  bucket: S.optional(S.String),
  url: S.optional(S.String),
})

const EventBodySchema = S.Struct({
  repository: S.optional(S.String),
  repo: S.optional(S.String),
  issueNumber: S.optional(S.Union(S.String, S.Number)),
  issue_number: S.optional(S.Union(S.String, S.Number)),
  head: S.optional(S.String),
  base: S.optional(S.String),
  prompt: S.optional(S.String),
  issueTitle: S.optional(S.String),
  issueBody: S.optional(S.String),
  issueUrl: S.optional(S.String),
})

const RunCompletePayloadSchema = S.Struct({
  metadata: S.optional(
    S.Struct({
      name: S.optional(S.String),
      uid: S.optional(S.String),
      namespace: S.optional(S.String),
    }),
  ),
  status: S.optional(
    S.Struct({
      phase: S.optional(S.String),
      startedAt: S.optional(S.String),
      finishedAt: S.optional(S.String),
    }),
  ),
  arguments: S.optional(
    S.Struct({
      parameters: S.optional(ParametersSchema),
    }),
  ),
  artifacts: S.optional(S.Array(S.Unknown)),
  stage: S.optional(S.String),
})

const decodeSchema = <SchemaT extends S.Schema.AnyNoContext>(
  schema: SchemaT,
  input: unknown,
  fallback: S.Schema.Type<SchemaT>,
): S.Schema.Type<SchemaT> => {
  const decoded = S.decodeUnknownEither(schema)(input)
  return Either.isLeft(decoded) ? fallback : decoded.right
}

const normalizeRepo = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizeNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const parseRunCompletePayload = (payload: Record<string, unknown>) => {
  const rawData = (payload.data as Record<string, unknown> | string | undefined) ?? payload
  const data = typeof rawData === 'string' ? safeParseJson(rawData) : isRecord(rawData) ? rawData : {}
  const decodedPayload = decodeSchema(RunCompletePayloadSchema, data, {})
  const rawMetadata = (() => {
    if (isRecord(data.metadata)) return data.metadata
    if (typeof data.metadata === 'string') return safeParseJson(data.metadata)
    return decodedPayload.metadata ?? {}
  })()
  const rawStatus = (() => {
    if (isRecord(data.status)) return data.status
    if (typeof data.status === 'string') return safeParseJson(data.status)
    return decodedPayload.status ?? {}
  })()
  const rawArguments = (() => {
    if (isRecord(data.arguments)) return data.arguments
    if (typeof data.arguments === 'string') return safeParseJson(data.arguments)
    return decodedPayload.arguments ?? {}
  })()
  const argumentsRecord = isRecord(rawArguments) ? rawArguments : {}
  const params = decodeSchema(
    ParametersSchema,
    argumentsRecord.parameters ?? decodedPayload.arguments?.parameters ?? [],
    [],
  )

  const eventBodyRaw = getParamValue(params, 'eventBody')
  const eventBody = decodeSchema(EventBodySchema, eventBodyRaw ? decodeBase64Json(eventBodyRaw) : {}, {})
  const repository = normalizeRepo(eventBody.repository ?? eventBody.repo)
  const issueNumber = normalizeNumber(eventBody.issueNumber ?? eventBody.issue_number ?? 0)
  const head = normalizeRepo(eventBody.head) || normalizeRepo(getParamValue(params, 'head'))
  const base = normalizeRepo(eventBody.base) || normalizeRepo(getParamValue(params, 'base'))
  const prompt = typeof eventBody.prompt === 'string' ? eventBody.prompt.trim() : null
  const issueTitle = typeof eventBody.issueTitle === 'string' ? eventBody.issueTitle : null
  const issueBody = typeof eventBody.issueBody === 'string' ? eventBody.issueBody : null
  const issueUrl = typeof eventBody.issueUrl === 'string' ? eventBody.issueUrl : null
  const artifacts = (() => {
    if (Array.isArray(data.artifacts)) return data.artifacts
    if (typeof data.artifacts === 'string') {
      const parsed = safeParseJson(data.artifacts)
      return Array.isArray(parsed) ? parsed : []
    }
    return decodedPayload.artifacts ?? []
  })()
    .map((artifact: unknown) => {
      const decoded = decodeSchema(ArtifactSchema, artifact, {})
      const name = decoded.name ?? ''
      const key = decoded.key ?? ''
      if (!name || !key) return null
      return {
        name,
        key,
        bucket: decoded.bucket ?? null,
        url: decoded.url ?? null,
        metadata: isRecord(artifact) ? artifact : {},
      }
    })
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))

  return {
    repository,
    issueNumber,
    head,
    base,
    prompt,
    issueTitle,
    issueBody,
    issueUrl,
    workflowName: String(rawMetadata.name ?? ''),
    workflowUid: typeof rawMetadata.uid === 'string' ? rawMetadata.uid : null,
    workflowNamespace: typeof rawMetadata.namespace === 'string' ? rawMetadata.namespace : null,
    stage: typeof decodedPayload.stage === 'string' ? decodedPayload.stage : null,
    phase: typeof rawStatus.phase === 'string' ? rawStatus.phase : null,
    startedAt: typeof rawStatus.startedAt === 'string' ? rawStatus.startedAt : null,
    finishedAt: typeof rawStatus.finishedAt === 'string' ? rawStatus.finishedAt : null,
    artifacts,
    runCompletePayload: data,
  }
}

const parseNotifyPayload = (payload: Record<string, unknown>) => {
  const rawData = (payload.data as Record<string, unknown> | string | undefined) ?? payload
  const data = typeof rawData === 'string' ? safeParseJson(rawData) : rawData
  const workflowName =
    typeof data.workflow_name === 'string'
      ? data.workflow_name
      : typeof data.workflowName === 'string'
        ? data.workflowName
        : ''
  const workflowNamespace =
    typeof data.workflow_namespace === 'string'
      ? data.workflow_namespace
      : typeof data.workflowNamespace === 'string'
        ? data.workflowNamespace
        : null
  const repository = normalizeRepo(data.repository)
  const issueNumber = Number(data.issue_number ?? 0)
  const branch = typeof data.head_branch === 'string' ? data.head_branch.trim() : ''
  const prompt = typeof data.prompt === 'string' ? data.prompt : null
  return { workflowName, workflowNamespace, repository, issueNumber, branch, prompt, notifyPayload: data }
}

const parseRepositoryParts = (repository: string) => {
  const [owner, repo] = repository.split('/')
  if (!owner || !repo) {
    throw new Error(`invalid repository value: ${repository}`)
  }
  return { owner, repo }
}

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i
const SHORT_COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i

const isCommitSha = (value: string, allowShort = false) => {
  const trimmed = value.trim()
  return allowShort ? SHORT_COMMIT_SHA_PATTERN.test(trimmed) : FULL_COMMIT_SHA_PATTERN.test(trimmed)
}

const isCommitKey = (key: string) => {
  const normalized = key.toLowerCase()
  if (normalized.includes('commit')) return true
  return normalized === 'git_sha' || normalized === 'gitsha' || normalized === 'head_sha' || normalized === 'headsha'
}

const MANIFEST_SHA_PATHS = [
  ['metadata', 'manifest', 'commit_sha'],
  ['metadata', 'manifest', 'commitSha'],
  ['manifest', 'commit_sha'],
  ['manifest', 'commitSha'],
]

const getStringAtPath = (value: unknown, path: ReadonlyArray<string>) => {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return typeof current === 'string' ? current : null
}

const findManifestCommitSha = (value: unknown) => {
  if (!value || typeof value !== 'object') return null
  for (const path of MANIFEST_SHA_PATHS) {
    const candidate = getStringAtPath(value, path)
    if (candidate && isCommitSha(candidate, true)) {
      return candidate.trim()
    }
  }
  return null
}

const findCommitShaInValue = (value: unknown, depth = 0, seen = new Set<object>()): string | null => {
  if (!value || depth > 6) return null
  if (typeof value !== 'object') return null
  if (seen.has(value as object)) return null
  seen.add(value as object)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findCommitShaInValue(entry, depth + 1, seen)
      if (match) return match
    }
    return null
  }

  const record = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && isCommitKey(key) && isCommitSha(entry)) {
      return entry.trim()
    }
  }

  for (const entry of Object.values(record)) {
    if (entry && typeof entry === 'object') {
      const match = findCommitShaInValue(entry, depth + 1, seen)
      if (match) return match
    }
  }

  return null
}

const extractArtifactsFromPayload = (payload: Record<string, unknown> | null) => {
  if (!payload) return []
  const rawData = payload.data
  const data = typeof rawData === 'string' ? safeParseJson(rawData) : isRecord(rawData) ? rawData : payload
  const artifactsValue = (data as Record<string, unknown>).artifacts
  if (Array.isArray(artifactsValue)) return artifactsValue
  if (typeof artifactsValue === 'string') {
    const parsed = safeParseJson(artifactsValue)
    return Array.isArray(parsed) ? parsed : []
  }
  return []
}

const extractManifestCommitShaFromPayload = (payload: Record<string, unknown> | null) => {
  if (!payload) return null
  const artifacts = extractArtifactsFromPayload(payload)
  for (const artifact of artifacts) {
    const match = findManifestCommitSha(artifact)
    if (match) return match
  }
  return findManifestCommitSha(payload)
}

const extractCommitShaFromArtifacts = (payload: Record<string, unknown> | null) => {
  const artifacts = extractArtifactsFromPayload(payload)
  for (const artifact of artifacts) {
    const match = findCommitShaInValue(artifact)
    if (match) return match
  }
  return null
}

const extractCommitShaFromRun = (run: CodexRunRecord) => {
  const fromManifest = extractManifestCommitShaFromPayload(run.runCompletePayload)
  if (fromManifest) return fromManifest
  const fromRunComplete = findCommitShaInValue(run.runCompletePayload)
  if (fromRunComplete) return fromRunComplete
  const fromNotifyManifest = extractManifestCommitShaFromPayload(run.notifyPayload)
  if (fromNotifyManifest) return fromNotifyManifest
  return findCommitShaInValue(run.notifyPayload)
}

const normalizeBranchRef = (branch: string) => {
  const trimmed = branch.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('refs/')) {
    return trimmed.replace(/^refs\//, '')
  }
  if (trimmed.startsWith('heads/')) {
    return trimmed
  }
  return `heads/${trimmed}`
}

const fetchBranchHeadSha = async (repository: string, branch: string) => {
  if (!branch) return null
  const ref = normalizeBranchRef(branch)
  if (!ref) return null
  const { owner, repo } = parseRepositoryParts(repository)
  try {
    return await github.getRefSha(owner, repo, ref)
  } catch {
    return null
  }
}

const scheduleEvaluation = (runId: string, delayMs: number, options: { reschedule?: boolean } = {}) => {
  const existing = scheduledRuns.get(runId)
  if (existing) {
    if (!options.reschedule) return
    clearTimeout(existing)
  }
  const timeout = setTimeout(() => {
    scheduledRuns.delete(runId)
    void evaluateRun(runId)
  }, delayMs)
  scheduledRuns.set(runId, timeout)
}

const buildReconcileDelay = () => RECONCILE_BASE_DELAY_MS + Math.floor(Math.random() * RECONCILE_JITTER_MS)

const shouldScheduleReconcile = (run: CodexPendingRun) =>
  !scheduledRuns.has(run.id) && !activeEvaluations.has(run.id) && !isTerminalStatus(run.status)

const reconcilePendingRuns = async () => {
  if (reconcileInFlight) return
  await ensureStoreReady()
  reconcileInFlight = true
  try {
    const pending = await store.listRunsByStatus([...PENDING_EVALUATION_STATUSES])
    for (const run of pending) {
      if (!shouldScheduleReconcile(run)) continue
      scheduleEvaluation(run.id, buildReconcileDelay())
    }
  } catch (error) {
    console.warn('Failed to reconcile Codex judge runs', error)
  } finally {
    reconcileInFlight = false
  }
}

const scheduleReconcileLoop = (delayMs: number) => {
  reconcileTimer = setTimeout(() => {
    void (async () => {
      try {
        await reconcilePendingRuns()
      } finally {
        scheduleReconcileLoop(RECONCILE_INTERVAL_MS)
      }
    })()
  }, delayMs)
  reconcileTimer.unref?.()
}

const startReconcileLoop = () => {
  if (RECONCILE_DISABLED || reconcileTimer) return
  scheduleReconcileLoop(RECONCILE_STARTUP_DELAY_MS)
}

startReconcileLoop()

const DEFAULT_ARTIFACT_BUCKET = 'argo-workflows'
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const MAX_LOG_CHARS = 20_000

const FALLBACK_ARTIFACTS = [
  { name: 'implementation-changes', suffix: 'implementation-changes.tgz' },
  { name: 'implementation-patch', suffix: 'implementation-patch.tgz' },
  { name: 'implementation-status', suffix: 'implementation-status.tgz' },
  { name: 'implementation-log', suffix: 'implementation-log.tgz' },
  { name: 'implementation-events', suffix: 'implementation-events.tgz' },
  { name: 'implementation-agent-log', suffix: 'implementation-agent-log.tgz' },
  { name: 'implementation-runtime-log', suffix: 'implementation-runtime-log.tgz' },
  { name: 'implementation-resume', suffix: 'implementation-resume.tgz' },
  { name: 'implementation-notify', suffix: 'implementation-notify.tgz' },
]

const ARTIFACT_TEXT_HINTS: Record<string, string[]> = {
  'implementation-log': ['.codex-implementation.log', 'codex-implementation.log'],
  'implementation-events': ['.codex-implementation-events.jsonl', 'codex-implementation-events.jsonl'],
  'implementation-agent-log': ['.codex-implementation-agent.log', 'codex-implementation-agent.log'],
  'implementation-runtime-log': ['.codex-implementation-runtime.log', 'codex-implementation-runtime.log'],
  'implementation-status': ['.codex-implementation-status.txt', 'codex-implementation-status.txt'],
  'implementation-notify': ['.codex-implementation-notify.json', 'codex-implementation-notify.json'],
}

const getArtifactTextHints = (name: string) => ARTIFACT_TEXT_HINTS[name] ?? []

type ResolvedArtifact = {
  name: string
  key: string | null
  bucket: string | null
  url: string | null
  metadata: Record<string, unknown>
}

const coalesceString = (value: string | null | undefined) => (value && value.trim().length > 0 ? value : null)

const mergeArtifactEntry = (existing: ResolvedArtifact | undefined, incoming: ResolvedArtifact) => {
  if (!existing) return incoming
  return {
    name: existing.name,
    key: coalesceString(incoming.key) ?? existing.key,
    bucket: incoming.bucket ?? existing.bucket,
    url: incoming.url ?? existing.url,
    metadata: { ...existing.metadata, ...incoming.metadata },
  }
}

const addArtifactEntry = (map: Map<string, ResolvedArtifact>, incoming: ResolvedArtifact) => {
  const existing = map.get(incoming.name)
  map.set(incoming.name, mergeArtifactEntry(existing, incoming))
}

const updateArtifactsFromWorkflow = async (
  run: CodexRunRecord,
  artifactsOverride?: Array<{
    name: string
    key: string
    bucket?: string | null
    url?: string | null
    metadata?: Record<string, unknown>
  }>,
) => {
  const workflowName = run.workflowName
  if (!workflowName) return []
  const workflowNamespace = run.workflowNamespace ?? 'argo-workflows'

  const artifactMap = new Map<string, ResolvedArtifact>()
  const baseKey = `${workflowName}/${workflowName}`

  for (const artifact of FALLBACK_ARTIFACTS) {
    addArtifactEntry(artifactMap, {
      name: artifact.name,
      key: `${baseKey}/${artifact.suffix}`,
      bucket: DEFAULT_ARTIFACT_BUCKET,
      url: null,
      metadata: { source: 'static' },
    })
  }

  if (artifactsOverride && artifactsOverride.length > 0) {
    for (const artifact of artifactsOverride) {
      addArtifactEntry(artifactMap, {
        name: artifact.name,
        key: artifact.key,
        bucket: artifact.bucket ?? DEFAULT_ARTIFACT_BUCKET,
        url: artifact.url ?? null,
        metadata: { ...(artifact.metadata ?? {}), source: 'run-complete' },
      })
    }
  }

  if (argo && workflowNamespace) {
    try {
      const argoArtifacts = await argo.getWorkflowArtifacts(workflowNamespace, workflowName)
      if (argoArtifacts?.artifacts?.length) {
        for (const artifact of argoArtifacts.artifacts) {
          addArtifactEntry(artifactMap, {
            name: artifact.name,
            key: artifact.key,
            bucket: artifact.bucket ?? DEFAULT_ARTIFACT_BUCKET,
            url: artifact.url ?? null,
            metadata: {
              ...artifact.metadata,
              nodeId: artifact.nodeId ?? null,
              source: 'argo',
            },
          })
        }
      }
    } catch (error) {
      console.warn('Failed to fetch Argo workflow artifacts', error)
    }
  }

  const resolved = Array.from(artifactMap.values())

  await store.upsertArtifacts({
    runId: run.id,
    artifacts: resolved
      .filter((artifact) => Boolean(artifact.key))
      .map((artifact) => ({
        name: artifact.name,
        key: artifact.key ?? '',
        bucket: artifact.bucket ?? DEFAULT_ARTIFACT_BUCKET,
        url: artifact.url,
        metadata: artifact.metadata,
      })),
  })

  return resolved
}

const fetchPullRequest = async (run: CodexRunRecord) => {
  const { owner, repo } = parseRepositoryParts(run.repository)
  const head = `${owner}:${run.branch}`
  const pr = await github.getPullRequestByHead(owner, repo, head)
  if (!pr) return null
  const full = await github.getPullRequest(owner, repo, pr.number)
  return {
    ...pr,
    mergeableState: full.mergeableState ?? pr.mergeableState ?? null,
  }
}

const normalizeShaValue = (value: string | null | undefined) => value?.trim().toLowerCase() ?? ''

const matchesCommitSha = (expected: string | null | undefined, actual: string | null | undefined) => {
  if (!expected || !actual) return true
  const expectedValue = normalizeShaValue(expected)
  const actualValue = normalizeShaValue(actual)
  if (!expectedValue || !actualValue) return true
  return expectedValue === actualValue || expectedValue.startsWith(actualValue) || actualValue.startsWith(expectedValue)
}

const resolveExistingPrForIssue = async (run: CodexRunRecord, commitSha?: string | null) => {
  const candidates = await store.listRunsByIssue(run.repository, run.issueNumber, null)
  const { owner, repo } = parseRepositoryParts(run.repository)

  for (const candidate of candidates) {
    if (candidate.id === run.id) continue
    if (!candidate.branch) continue
    try {
      const head = `${owner}:${candidate.branch}`
      const pr = await github.getPullRequestByHead(owner, repo, head)
      if (pr && matchesCommitSha(commitSha, pr.headSha)) {
        return { pr, branch: candidate.branch }
      }
    } catch {
      // ignore lookup errors and keep searching
    }
  }

  return null
}

const fetchCiStatus = async (run: CodexRunRecord, commitSha?: string | null) => {
  const { owner, repo } = parseRepositoryParts(run.repository)
  const sha = commitSha ?? run.commitSha
  if (!sha) return { status: 'pending' as const, url: undefined }
  try {
    return await github.getCheckRuns(owner, repo, sha)
  } catch (error) {
    console.warn('Failed to fetch CI check runs', { repository: run.repository, sha, error })
    return { status: 'pending' as const, url: undefined }
  }
}

const resolveCiContext = async (run: CodexRunRecord, pr: PullRequest | null) => {
  const prSha = pr?.headSha ?? null
  const artifactSha = prSha ? null : extractCommitShaFromRun(run)
  const existingSha = prSha ? null : run.commitSha
  let commitSha = prSha ?? artifactSha ?? existingSha ?? null

  if (!commitSha && !prSha) {
    commitSha = await fetchBranchHeadSha(run.repository, run.branch)
  }

  const ci = await fetchCiStatus(run, commitSha)
  return { commitSha, ci }
}

const fetchReviewStatus = async (run: CodexRunRecord, prNumber: number) => {
  const { owner, repo } = parseRepositoryParts(run.repository)
  const reviewers = config.codexReviewers.map((value) => value.toLowerCase())
  return github.getReviewSummary(owner, repo, prNumber, reviewers)
}

const extractLogExcerpt = (payload?: Record<string, unknown> | null) => {
  if (!payload) {
    return {
      output: null,
      events: null,
      agent: null,
      runtime: null,
      status: null,
    }
  }
  const raw = payload.log_excerpt
  if (!raw || typeof raw !== 'object') {
    return {
      output: null,
      events: null,
      agent: null,
      runtime: null,
      status: null,
    }
  }
  const logExcerpt = raw as Record<string, unknown>
  return {
    output: typeof logExcerpt.output === 'string' ? logExcerpt.output : null,
    events: typeof logExcerpt.events === 'string' ? logExcerpt.events : null,
    agent: typeof logExcerpt.agent === 'string' ? logExcerpt.agent : null,
    runtime: typeof logExcerpt.runtime === 'string' ? logExcerpt.runtime : null,
    status: typeof logExcerpt.status === 'string' ? logExcerpt.status : null,
  }
}

const hasLogExcerpt = (logExcerpt: ReturnType<typeof extractLogExcerpt>) =>
  Object.values(logExcerpt).some((value) => typeof value === 'string' && value.length > 0)

const mergeLogExcerpt = (
  primary: ReturnType<typeof extractLogExcerpt>,
  fallback: ReturnType<typeof extractLogExcerpt>,
) => ({
  output: primary.output ?? fallback.output,
  events: primary.events ?? fallback.events,
  agent: primary.agent ?? fallback.agent,
  runtime: primary.runtime ?? fallback.runtime,
  status: primary.status ?? fallback.status,
})

const normalizeSha = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return /^[a-f0-9]{7,40}$/i.test(trimmed) ? trimmed : null
}

const extractSessionIdFromPayload = (payload: Record<string, unknown>) => {
  const candidates = [payload.session_id, payload.sessionId, isRecord(payload.session) ? payload.session.id : null]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }
  return null
}

const extractCommitShaFromPayload = (payload: Record<string, unknown>) => {
  const candidates = [payload.commit_sha, payload.commitSha, payload.sha, payload.commit]
  for (const candidate of candidates) {
    const normalized = normalizeSha(candidate)
    if (normalized) return normalized
  }
  return null
}

const fetchArtifactBuffer = async (artifact: ResolvedArtifact, maxBytes = MAX_ARTIFACT_BYTES) => {
  if (!artifact.url) return null
  try {
    const response = await fetch(artifact.url)
    if (!response.ok) return null
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > maxBytes) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) return null
    return buffer
  } catch {
    return null
  }
}

const fetchArtifactText = async (artifact: ResolvedArtifact, maxBytes = MAX_ARTIFACT_BYTES) => {
  const buffer = await fetchArtifactBuffer(artifact, maxBytes)
  if (!buffer) return null
  const extracted = await extractTextFromArchive(buffer, getArtifactTextHints(artifact.name))
  const text = extracted ?? buffer.toString('utf8')
  if (text.length > MAX_LOG_CHARS) {
    return text.slice(-MAX_LOG_CHARS)
  }
  return text
}

const fetchArtifactFullText = async (artifact: ResolvedArtifact, maxBytes = MAX_ARTIFACT_BYTES) => {
  const buffer = await fetchArtifactBuffer(artifact, maxBytes)
  if (!buffer) return null
  const extracted = await extractTextFromArchive(buffer, getArtifactTextHints(artifact.name))
  return extracted ?? buffer.toString('utf8')
}

const buildArtifactIndex = (artifacts: ResolvedArtifact[]) =>
  new Map(artifacts.map((artifact) => [artifact.name, artifact]))

const extractNotifyPayloadFromArtifacts = async (artifactMap: Map<string, ResolvedArtifact>) => {
  const artifact = artifactMap.get('implementation-notify')
  if (!artifact) return null
  const text = await fetchArtifactText(artifact)
  if (!text) return null
  const parsed = safeParseJson(text)
  return isRecord(parsed) ? parsed : null
}

const extractLogExcerptFromArtifacts = async (artifactMap: Map<string, ResolvedArtifact>) => {
  const logArtifacts = [
    { name: 'implementation-log', field: 'output' },
    { name: 'implementation-events', field: 'events' },
    { name: 'implementation-agent-log', field: 'agent' },
    { name: 'implementation-runtime-log', field: 'runtime' },
    { name: 'implementation-status', field: 'status' },
  ] as const

  const logExcerpt: ReturnType<typeof extractLogExcerpt> = {
    output: null,
    events: null,
    agent: null,
    runtime: null,
    status: null,
  }

  for (const entry of logArtifacts) {
    const artifact = artifactMap.get(entry.name)
    if (!artifact) continue
    const text = await fetchArtifactText(artifact)
    if (!text) continue
    logExcerpt[entry.field] = text
  }

  return logExcerpt
}

const resolveBaseTimestamp = (run: CodexRunRecord) => {
  const candidates = [run.startedAt, run.finishedAt]
  for (const candidate of candidates) {
    if (!candidate) continue
    const parsed = Date.parse(candidate)
    if (!Number.isNaN(parsed)) {
      return new Date(parsed)
    }
  }
  return new Date()
}

const extractManifestFromArtifacts = async (artifactMap: Map<string, ResolvedArtifact>) => {
  const artifact = artifactMap.get('implementation-changes')
  if (!artifact) return null
  const buffer = await fetchArtifactBuffer(artifact)
  if (!buffer) return null
  return extractImplementationManifestFromArchive(buffer)
}

const resolveCommitSha = async (run: CodexRunRecord, fallbackCommitSha: string | null) => {
  if (run.commitSha) return run.commitSha
  const commitSha = fallbackCommitSha ?? null
  if (commitSha) {
    await store.updateCiStatus({ runId: run.id, status: run.ciStatus ?? 'pending', commitSha })
    return commitSha
  }
  if (!run.repository || !run.branch) return null
  const sha = await fetchBranchHeadSha(run.repository, run.branch)
  if (!sha) return null
  await store.updateCiStatus({ runId: run.id, status: run.ciStatus ?? 'pending', commitSha: sha })
  return sha
}

const applyArtifactFallback = async (run: CodexRunRecord, artifacts: ResolvedArtifact[]) => {
  if (!run.workflowName) return

  const existingLogExcerpt = extractLogExcerpt(run.notifyPayload)
  const existingSessionId = run.notifyPayload ? extractSessionIdFromPayload(run.notifyPayload) : null
  const existingCommitSha = run.commitSha ?? (run.notifyPayload ? extractCommitShaFromPayload(run.notifyPayload) : null)
  const needsFallback =
    !run.notifyPayload || !hasLogExcerpt(existingLogExcerpt) || !run.prompt || !existingSessionId || !existingCommitSha
  if (!needsFallback) return

  const artifactMap = buildArtifactIndex(artifacts)
  const [notifyPayload, manifest, logExcerptFromArtifacts] = await Promise.all([
    extractNotifyPayloadFromArtifacts(artifactMap),
    extractManifestFromArtifacts(artifactMap),
    extractLogExcerptFromArtifacts(artifactMap),
  ])

  const logExcerptFromNotify = notifyPayload ? extractLogExcerpt(notifyPayload) : existingLogExcerpt
  const logExcerpt = mergeLogExcerpt(logExcerptFromNotify, logExcerptFromArtifacts)

  const prompt =
    run.prompt ??
    (notifyPayload && typeof notifyPayload.prompt === 'string' ? notifyPayload.prompt : null) ??
    manifest?.prompt ??
    null
  const repository = manifest?.repository ?? run.repository
  const issueNumber = manifest?.issueNumber ?? run.issueNumber
  const sessionId = notifyPayload ? extractSessionIdFromPayload(notifyPayload) : (manifest?.sessionId ?? null)
  const commitSha = (notifyPayload ? extractCommitShaFromPayload(notifyPayload) : null) ?? manifest?.commitSha ?? null

  if (!run.prompt && prompt) {
    await store.updateRunPrompt(run.id, prompt)
  }

  const resolvedCommitSha = await resolveCommitSha(run, commitSha)

  if (!hasLogExcerpt(logExcerpt) && !prompt && !sessionId && !resolvedCommitSha) return

  const fallbackPayload = {
    ...(isRecord(run.notifyPayload) ? run.notifyPayload : {}),
    workflow_name: run.workflowName,
    workflow_namespace: run.workflowNamespace,
    repository,
    issue_number: issueNumber,
    head_branch: run.branch,
    prompt: prompt ?? null,
    session_id: sessionId ?? null,
    commit_sha: resolvedCommitSha ?? commitSha ?? null,
    log_excerpt: logExcerpt,
    source: 'artifact-fallback',
    issued_at: new Date().toISOString(),
  }

  await store.attachNotify({
    workflowName: run.workflowName,
    workflowNamespace: run.workflowNamespace,
    notifyPayload: fallbackPayload,
    repository,
    issueNumber,
    branch: run.branch,
    prompt: run.prompt ?? prompt ?? null,
  })
}

const backfillAgentMessages = async (run: CodexRunRecord, artifacts: ResolvedArtifact[]) => {
  let agentStore: ReturnType<typeof createAgentMessagesStore> | null = null
  try {
    agentStore = createAgentMessagesStore()
    const hasMessages = await agentStore.hasMessages({ runId: run.id, workflowUid: run.workflowUid })
    if (hasMessages) return

    const artifactMap = buildArtifactIndex(artifacts)
    const eventArtifact = artifactMap.get('implementation-events') ?? null
    const agentArtifact = artifactMap.get('implementation-agent-log') ?? null

    const eventText = eventArtifact ? await fetchArtifactFullText(eventArtifact) : null
    let messages = parseAgentMessagesFromEvents(eventText)
    if (messages.length === 0 && agentArtifact) {
      const agentText = await fetchArtifactFullText(agentArtifact)
      messages = parseAgentMessagesFromLog(agentText)
    }

    if (messages.length === 0) return

    const baseTimestamp = resolveBaseTimestamp(run)
    const baseMillis = baseTimestamp.getTime()
    const stage = run.stage ?? null

    const records = messages.map((message, index) => ({
      workflowUid: run.workflowUid,
      workflowName: run.workflowName,
      workflowNamespace: run.workflowNamespace,
      runId: run.id,
      stepId: null,
      agentId: null,
      role: 'assistant',
      kind: 'message',
      timestamp: new Date(baseMillis + index * 1000).toISOString(),
      channel: null,
      stage,
      content: message.content,
      attrs: message.attrs,
      dedupeKey: buildBackfillDedupeKey(run.id, message.attrs),
    }))

    await agentStore.insertMessages(records)
  } catch (error) {
    console.warn('Failed to backfill agent messages', error)
  } finally {
    if (agentStore) {
      try {
        await agentStore.close()
      } catch (error) {
        console.warn('Failed to close agent messages store', error)
      }
    }
  }
}

const normalizeReviewBody = (value: string) => value.replace(/\s+/g, ' ').trim()

const formatReviewThreads = (threads: ReviewSummary['unresolvedThreads']) => {
  if (threads.length === 0) return 'None.'

  return threads
    .map((thread, index) => {
      const author = thread.author ?? 'unknown'
      const comments =
        thread.comments.length > 0
          ? thread.comments
              .map((comment) => {
                const location = comment.path
                  ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
                  : 'location not provided'
                const body = comment.body ? normalizeReviewBody(comment.body) : 'no comment body provided'
                const truncated = body.length > 240 ? `${body.slice(0, 237)}...` : body
                return `- ${location}: Required fix: ${truncated}`
              })
              .join('\n')
          : '- no comment text captured'
      return `Thread ${index + 1} (author: ${author})\n${comments}`
    })
    .join('\n\n')
}

const formatIssueComments = (comments: ReviewSummary['issueComments']) => {
  if (comments.length === 0) return 'None.'
  return comments
    .map((comment, index) => {
      const author = comment.author ?? 'unknown'
      const body = comment.body ? normalizeReviewBody(comment.body) : 'no comment body provided'
      const truncated = body.length > 240 ? `${body.slice(0, 237)}...` : body
      return `Comment ${index + 1} (author: ${author})\n- Required fix: ${truncated}`
    })
    .join('\n\n')
}

const buildReviewNextPrompt = (review: ReviewSummary) => {
  const threadSummary = formatReviewThreads(review.unresolvedThreads)
  const issueSummary = formatIssueComments(review.issueComments)
  const lines = [
    'Address every Codex review comment. Each item below is required before completion.',
    'Make the requested code changes, update the PR description if needed, and reply on each thread with what changed.',
    '',
    'Open Codex review threads:',
    threadSummary,
  ]
  if (review.issueComments.length > 0) {
    lines.push(
      '',
      review.unresolvedThreads.length === 0
        ? 'Codex issue comments (no formal review threads detected):'
        : 'Additional Codex issue comments:',
      issueSummary,
    )
  }
  return lines.join('\n')
}

const buildJudgePrompt = (input: {
  issueTitle: string
  issueBody: string
  prTitle: string
  prBody: string | null
  diff: string
  summary: string | null
  ciStatus: string
  reviewStatus: string
  logExcerpt: ReturnType<typeof extractLogExcerpt>
}) => {
  const logs = [
    `Status log:\n${input.logExcerpt.status ?? 'n/a'}`,
    `Output log:\n${input.logExcerpt.output ?? 'n/a'}`,
    `Agent log:\n${input.logExcerpt.agent ?? 'n/a'}`,
    `Runtime log:\n${input.logExcerpt.runtime ?? 'n/a'}`,
    `Event log:\n${input.logExcerpt.events ?? 'n/a'}`,
  ].join('\n\n')

  return [
    'You are the Codex judge. Evaluate whether the implementation satisfies the issue requirements.',
    'Return JSON only with fields: decision, confidence, requirements_coverage, missing_items, suggested_fixes, next_prompt, prompt_tuning_suggestions, system_improvement_suggestions.',
    "Use decision = 'pass' when requirements are satisfied, otherwise 'fail'.",
    '',
    `CI status: ${input.ciStatus}`,
    `Codex review status: ${input.reviewStatus}`,
    '',
    `Issue: ${input.issueTitle}`,
    input.issueBody,
    '',
    `PR: ${input.prTitle}`,
    input.prBody ?? 'No PR description provided.',
    '',
    'Codex summary (last assistant message):',
    input.summary ?? 'No summary available.',
    '',
    'Log excerpts:',
    logs,
    '',
    'Diff:',
    input.diff || 'No diff available.',
  ].join('\n')
}

const parseJudgeOutput = (raw: string) => {
  const trimmed = raw.trim()
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error('judge output missing JSON object')
  }
  return JSON.parse(match[0]) as Record<string, unknown>
}

const buildJudgeRetryPrompt = (prompt: string, attempt: number) => {
  const retryNote = `Retry ${attempt} of ${MAX_JUDGE_JSON_RETRIES}.`
  return `${prompt}\n\n${JSON_ONLY_REMINDER}\n${retryNote}`
}

const runJudgeWithRetries = async (
  client: { runTurn: (prompt: string) => Promise<{ text: string }> },
  prompt: string,
  maxRetries: number,
) => {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptPrompt = attempt === 0 ? prompt : buildJudgeRetryPrompt(prompt, attempt)
    const { text } = await client.runTurn(attemptPrompt)
    try {
      return { output: parseJudgeOutput(text), attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries) {
        throw error
      }
    }
  }

  throw lastError ?? new Error('judge output missing JSON object')
}

const normalizeJudgeDecision = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (['pass', 'approve', 'approved', 'success', 'complete', 'completed'].includes(normalized)) {
    return 'pass'
  }
  if (['fail', 'failed', 'reject', 'rejected'].includes(normalized)) {
    return 'fail'
  }
  return normalized
}

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const getElapsedMs = (value: string | null | undefined) => {
  const startMs = parseTimestampMs(value)
  if (startMs == null) return null
  return Math.max(0, Date.now() - startMs)
}

const hasWaitTimedOut = (since: string | null | undefined, maxWaitMs: number) => {
  if (maxWaitMs <= 0) return false
  const elapsedMs = getElapsedMs(since)
  if (elapsedMs == null) return false
  return elapsedMs >= maxWaitMs
}

type MergeableGate = {
  decision: 'needs_iteration' | 'needs_human'
  reason: string
  suggestedFix: string
  nextPrompt: string
  systemSuggestions?: string[]
}

type MergeableOutcome =
  | { action: 'gate'; gate: MergeableGate }
  | { action: 'wait'; delayMs: number }
  | { action: 'none' }

const normalizeMergeableState = (state: string | null | undefined) => {
  if (!state) return null
  const trimmed = state.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

const getMergeableOutcome = (state: string | null | undefined): MergeableOutcome => {
  const normalized = normalizeMergeableState(state)
  if (!normalized || normalized === 'clean') return { action: 'none' }
  if (normalized === 'unknown') {
    return { action: 'wait', delayMs: 5_000 }
  }
  if (normalized === 'dirty') {
    return {
      action: 'gate',
      gate: {
        decision: 'needs_human',
        reason: 'merge_conflict',
        suggestedFix: 'Resolve merge conflicts on the branch before resuming.',
        nextPrompt: 'Resolve merge conflicts on the branch and update the PR.',
        systemSuggestions: ['Auto-detect merge conflicts earlier and alert with targeted guidance.'],
      },
    }
  }
  if (normalized === 'behind') {
    return {
      action: 'gate',
      gate: {
        decision: 'needs_iteration',
        reason: 'mergeable_behind',
        suggestedFix: 'Rebase or merge the base branch into the PR branch and push updates.',
        nextPrompt: 'Rebase the PR branch on the base branch, resolve any conflicts, and push the updated branch.',
        systemSuggestions: ['Auto-rebase codex branches when GitHub reports mergeable_state=behind.'],
      },
    }
  }
  if (normalized === 'draft') {
    return {
      action: 'gate',
      gate: {
        decision: 'needs_iteration',
        reason: 'mergeable_draft',
        suggestedFix: 'Mark the PR as ready for review.',
        nextPrompt: 'Mark the PR as ready for review and ensure required checks run.',
        systemSuggestions: ['Auto-mark PRs ready once Codex completes and CI passes.'],
      },
    }
  }
  if (normalized === 'blocked' || normalized === 'has_hooks') {
    return {
      action: 'gate',
      gate: {
        decision: 'needs_iteration',
        reason: 'mergeable_blocked',
        suggestedFix: 'Satisfy required checks and required reviews; request required reviewers if needed.',
        nextPrompt: 'Ensure required checks and reviews are satisfied, then update the PR status.',
        systemSuggestions: ['Surface required checks/reviewers that keep PRs blocked and auto-request them.'],
      },
    }
  }
  if (normalized === 'unstable') {
    return {
      action: 'gate',
      gate: {
        decision: 'needs_iteration',
        reason: 'mergeable_unstable',
        suggestedFix: 'Fix failing required checks and re-run CI.',
        nextPrompt: 'Fix failing checks and re-run CI until GitHub reports the PR as mergeable.',
        systemSuggestions: ['Capture required check failures directly when mergeable_state=unstable.'],
      },
    }
  }
  return { action: 'none' }
}

const evaluateRun = async (runId: string) => {
  await ensureStoreReady()
  if (activeEvaluations.has(runId)) return
  activeEvaluations.add(runId)

  try {
    const run = await store.getRunById(runId)
    if (!run) return

    const repoParts = (() => {
      try {
        return parseRepositoryParts(run.repository)
      } catch {
        return null
      }
    })()

    if (isTerminalStatus(run.status) || run.status === 'superseded') return

    if (run.status !== 'judging') {
      const updated = await store.updateRunStatus(run.id, 'judging')
      if (!updated) return
    }

    let pr = await fetchPullRequest(run)
    const commitShaHint = extractCommitShaFromRun(run)

    if (!pr) {
      try {
        const existing = await resolveExistingPrForIssue(run, commitShaHint ?? run.commitSha ?? null)
        if (existing?.pr && repoParts) {
          const full = await github.getPullRequest(repoParts.owner, repoParts.repo, existing.pr.number)
          pr = {
            ...existing.pr,
            mergeableState: full.mergeableState ?? existing.pr.mergeableState ?? null,
          }
        }
      } catch (error) {
        console.warn('Failed to resolve existing PR for issue', error)
      }
    }

    if (pr) {
      await store.updateRunPrInfo(run.id, pr.number, pr.htmlUrl, pr.headSha)
    }

    await store.updateRunPrompt(run.id, run.prompt, run.nextPrompt)

    const logExcerpt = extractLogExcerpt(run.notifyPayload)
    const issueTitle = (run.runCompletePayload?.issueTitle as string | undefined) ?? pr?.title ?? ''
    const issueBody = (run.runCompletePayload?.issueBody as string | undefined) ?? ''
    let diff = ''

    if (pr) {
      const { owner, repo } = parseRepositoryParts(run.repository)
      diff = await github.getPullRequestDiff(owner, repo, pr.number)

      const gateFailure = evaluateDeterministicGates({
        diff,
        logExcerpt,
        issueTitle,
        issueBody,
        prompt: run.nextPrompt ?? run.prompt,
        runCompletePayload: run.runCompletePayload,
      })

      if (gateFailure) {
        const evaluation = await store.updateDecision({
          runId: run.id,
          decision: gateFailure.decision,
          reasons: { error: gateFailure.reason, detail: gateFailure.detail },
          suggestedFixes: { fix: gateFailure.suggestedFix },
          nextPrompt: gateFailure.nextPrompt,
          promptTuning: {},
          systemSuggestions: {},
        })
        const refreshedRun = (await store.getRunById(run.id)) ?? run
        await writeMemories(refreshedRun, evaluation)

        if (gateFailure.decision === 'needs_human') {
          await maybeCreatePromptTuningPr(refreshedRun, gateFailure.reason, evaluation.nextPrompt ?? '', evaluation)
          await sendDiscordEscalation(run, gateFailure.reason)
          return
        }

        await triggerRerun(run, gateFailure.reason, evaluation)
        return
      }
    }

    const { commitSha, ci } = await resolveCiContext(run, pr)
    if (!pr && !commitSha) {
      const evaluation = await store.updateDecision({
        runId: run.id,
        decision: 'needs_iteration',
        reasons: { error: 'missing_pull_request' },
        suggestedFixes: { fix: 'Ensure PR exists for branch before completion.' },
        nextPrompt: 'Open a PR for the current branch and ensure all required checks run.',
        promptTuning: {},
        systemSuggestions: {
          suggestions: [
            'Ensure Codex runs always open or update a PR for the issue branch.',
            'Reuse a stable per-issue branch instead of creating new branches per attempt.',
          ],
        },
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      await triggerRerun(run, 'missing_pull_request', evaluation)
      return
    }

    const ciRun = (await store.updateCiStatus({ runId: run.id, status: ci.status, url: ci.url, commitSha })) ?? run

    if (ci.status === 'pending') {
      if (hasWaitTimedOut(ciRun.ciStatusUpdatedAt, config.ciMaxWaitMs)) {
        const elapsedMs = getElapsedMs(ciRun.ciStatusUpdatedAt)
        const evaluation = await store.updateDecision({
          runId: run.id,
          decision: 'needs_iteration',
          reasons: {
            error: 'ci_timeout',
            url: ci.url,
            pending_since: ciRun.ciStatusUpdatedAt,
            elapsed_ms: elapsedMs,
            max_wait_ms: config.ciMaxWaitMs,
          },
          suggestedFixes: { fix: 'Investigate CI delays and re-run checks if needed.' },
          nextPrompt: 'CI checks did not complete in time. Re-run CI and ensure all checks finish.',
          promptTuning: {},
          systemSuggestions: {
            suggestions: [
              'Auto-retry or cancel/requeue CI runs that exceed the timeout threshold.',
              'Surface per-check runtime metrics to detect flaky or stuck jobs.',
            ],
          },
        })
        const refreshedRun = (await store.getRunById(run.id)) ?? run
        await writeMemories(refreshedRun, evaluation)
        await triggerRerun(run, 'ci_timeout', evaluation)
        return
      }
      scheduleEvaluation(run.id, config.ciPollIntervalMs, { reschedule: true })
      return
    }

    if (ci.status === 'failure') {
      const evaluation = await store.updateDecision({
        runId: run.id,
        decision: 'needs_iteration',
        reasons: { error: 'ci_failed', url: ci.url },
        suggestedFixes: { fix: 'Fix CI failures and re-run tests.' },
        nextPrompt: 'Fix CI failures for this PR and ensure all checks are green.',
        promptTuning: {},
        systemSuggestions: {},
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      await triggerRerun(run, 'ci_failed', evaluation)
      return
    }

    if (!pr) {
      try {
        const existing = await resolveExistingPrForIssue(run, commitSha ?? run.commitSha ?? null)
        if (existing?.pr && repoParts) {
          const full = await github.getPullRequest(repoParts.owner, repoParts.repo, existing.pr.number)
          const prData = {
            ...existing.pr,
            mergeableState: full.mergeableState ?? existing.pr.mergeableState ?? null,
          }
          await store.updateRunPrInfo(run.id, prData.number, prData.htmlUrl, prData.headSha)
          pr = prData
        }
      } catch (error) {
        console.warn('Failed to resolve existing PR after CI update', error)
      }
    }

    if (!pr) {
      const evaluation = await store.updateDecision({
        runId: run.id,
        decision: 'needs_iteration',
        reasons: { error: 'missing_pull_request' },
        suggestedFixes: { fix: 'Ensure PR exists for branch before completion.' },
        nextPrompt: 'Open a PR for the current branch and ensure all required checks run.',
        promptTuning: {},
        systemSuggestions: {
          suggestions: [
            'Ensure Codex runs always open or update a PR for the issue branch.',
            'Reuse a stable per-issue branch instead of creating new branches per attempt.',
          ],
        },
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      await triggerRerun(run, 'missing_pull_request', evaluation)
      return
    }

    const review = await fetchReviewStatus(run, pr.number)
    const reviewSummary = {
      unresolvedThreads: review.unresolvedThreads,
      requestedChanges: review.requestedChanges,
      issueComments: review.issueComments,
    }
    const reviewRun =
      (await store.updateReviewStatus({
        runId: run.id,
        status: review.status,
        summary: reviewSummary,
      })) ?? run

    const shouldBypassReview =
      review.status === 'pending' &&
      (config.reviewBypassMode === 'always' ||
        (config.reviewBypassMode === 'timeout' &&
          hasWaitTimedOut(reviewRun.reviewStatusUpdatedAt, config.reviewMaxWaitMs)))

    if (shouldBypassReview && reviewRun.reviewStatus !== 'bypassed') {
      await store.updateReviewStatus({
        runId: run.id,
        status: 'bypassed',
        summary: reviewSummary,
      })
    }

    if (review.status === 'pending' && !shouldBypassReview) {
      if (hasWaitTimedOut(reviewRun.reviewStatusUpdatedAt, config.reviewMaxWaitMs)) {
        const elapsedMs = getElapsedMs(reviewRun.reviewStatusUpdatedAt)
        const evaluation = await store.updateDecision({
          runId: run.id,
          decision: 'needs_iteration',
          reasons: {
            error: 'review_timeout',
            pending_since: reviewRun.reviewStatusUpdatedAt,
            elapsed_ms: elapsedMs,
            max_wait_ms: config.reviewMaxWaitMs,
          },
          suggestedFixes: { fix: 'Follow up on Codex review or re-request review to unblock.' },
          nextPrompt: 'Codex review did not complete in time. Re-request review and resolve feedback.',
          promptTuning: {},
          systemSuggestions: {
            suggestions: [
              'Auto-bypass Codex review after a configurable timeout when no review arrives.',
              'Verify Codex review bot is configured as an allowed reviewer in branch protections.',
            ],
          },
        })
        const refreshedRun = (await store.getRunById(run.id)) ?? run
        await writeMemories(refreshedRun, evaluation)
        await triggerRerun(run, 'review_timeout', evaluation)
        return
      }
      scheduleEvaluation(run.id, config.reviewPollIntervalMs, { reschedule: true })
      return
    }

    if (review.requestedChanges || review.unresolvedThreads.length > 0) {
      const evaluation = await store.updateDecision({
        runId: run.id,
        decision: 'needs_iteration',
        reasons: {
          error: review.requestedChanges ? 'codex_review_changes_requested' : 'codex_review_unresolved_threads',
          unresolved: review.unresolvedThreads,
        },
        suggestedFixes: { fix: 'Address Codex review comments and resolve all threads.' },
        nextPrompt: buildReviewNextPrompt(review),
        promptTuning: {},
        systemSuggestions: {},
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      await triggerRerun(run, 'codex_review_changes', evaluation)
      return
    }

    const mergeableOutcome = getMergeableOutcome(pr.mergeableState)
    if (mergeableOutcome.action === 'wait') {
      scheduleEvaluation(run.id, mergeableOutcome.delayMs, { reschedule: true })
      return
    }

    if (mergeableOutcome.action === 'gate') {
      const gate = mergeableOutcome.gate
      const evaluation = await store.updateDecision({
        runId: run.id,
        decision: gate.decision,
        reasons: { error: gate.reason, mergeable_state: pr.mergeableState ?? null },
        suggestedFixes: { fix: gate.suggestedFix },
        nextPrompt: gate.nextPrompt,
        promptTuning: {},
        systemSuggestions: gate.systemSuggestions ? { suggestions: gate.systemSuggestions } : {},
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)

      if (gate.decision === 'needs_human') {
        await maybeCreatePromptTuningPr(refreshedRun, gate.reason, evaluation.nextPrompt ?? '', evaluation)
        await sendDiscordEscalation(run, gate.reason)
        return
      }

      await triggerRerun(run, gate.reason, evaluation)
      return
    }

    const reviewStatusForJudge = shouldBypassReview ? 'bypassed' : review.status
    const judgePrompt = buildJudgePrompt({
      issueTitle,
      issueBody,
      prTitle: pr.title,
      prBody: pr.body,
      diff,
      summary: (run.notifyPayload?.last_assistant_message as string | null) ?? null,
      ciStatus: ci.status,
      reviewStatus: reviewStatusForJudge,
      logExcerpt,
    })

    const client = await Effect.runPromise(getCodexClient({ defaultModel: config.judgeModel }))

    let judgeOutput: Record<string, unknown>
    let judgeAttempts = 0
    try {
      const result = await runJudgeWithRetries(client, judgePrompt, MAX_JUDGE_JSON_RETRIES)
      judgeOutput = result.output
      judgeAttempts = result.attempts
    } catch (error) {
      const evaluation = await store.updateDecision({
        runId: run.id,
        decision: 'needs_iteration',
        reasons: {
          error: 'judge_invalid_json',
          detail: String(error),
          attempts: judgeAttempts || MAX_JUDGE_JSON_RETRIES + 1,
        },
        suggestedFixes: { fix: 'Retry judge output formatting.' },
        nextPrompt: 'Re-run judge with valid JSON output.',
        promptTuning: {},
        systemSuggestions: {},
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      await triggerRerun(run, 'judge_invalid_json', evaluation)
      return
    }

    const decisionRaw = typeof judgeOutput.decision === 'string' ? judgeOutput.decision : 'fail'
    const decision = normalizeJudgeDecision(decisionRaw)
    const nextPrompt = typeof judgeOutput.next_prompt === 'string' ? judgeOutput.next_prompt : null

    const evaluation = await store.updateDecision({
      runId: run.id,
      decision: decision === 'pass' ? 'pass' : 'needs_iteration',
      confidence: typeof judgeOutput.confidence === 'number' ? judgeOutput.confidence : null,
      reasons: { requirements_coverage: judgeOutput.requirements_coverage ?? [], decision },
      missingItems: { missing_items: judgeOutput.missing_items ?? [] },
      suggestedFixes: { suggested_fixes: judgeOutput.suggested_fixes ?? [] },
      nextPrompt,
      promptTuning: { suggestions: judgeOutput.prompt_tuning_suggestions ?? [] },
      systemSuggestions: { suggestions: judgeOutput.system_improvement_suggestions ?? [] },
    })

    if (decision === 'pass') {
      const updatedRun = (await store.updateRunStatus(run.id, 'completed')) ?? run
      await sendDiscordSuccess(run, pr.htmlUrl, ci.url)
      await writeMemories(updatedRun, evaluation)
      return
    }

    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
    await triggerRerun(run, 'judge_failed', evaluation)
  } finally {
    activeEvaluations.delete(runId)
  }
}

const GENERIC_PROMPT_SUGGESTIONS = new Set([
  'tighten prompt to reduce iteration loops.',
  'tighten prompt to reduce iteration loops',
])
const GENERIC_SYSTEM_SUGGESTIONS = new Set(['clarify judge gating criteria.', 'clarify judge gating criteria'])

const normalizeSuggestion = (value: unknown) => {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

const normalizeSuggestionKey = (value: string) => normalizeSuggestion(value).toLowerCase()

const normalizeSuggestionList = (value: unknown) => {
  if (!Array.isArray(value)) return []
  return value.map((entry) => normalizeSuggestion(entry)).filter((entry) => entry.length > 0)
}

const filterGenericSuggestions = (suggestions: string[], blocked: Set<string>) =>
  suggestions.filter((entry) => !blocked.has(normalizeSuggestionKey(entry)))

const extractSuggestions = (payload: Record<string, unknown> | undefined, blocked: Set<string>) =>
  filterGenericSuggestions(normalizeSuggestionList(payload?.suggestions), blocked)

type PromptTuningRunReference = {
  runId: string
  attempt: number
  status: string
  workflowName: string
  createdAt: string
  prUrl: string | null
  ciUrl: string | null
  failureReason: string
}

type PromptTuningAggregate = {
  reason: string
  matchingFailures: number
  totalFailures: number
  windowHours: number
  failureReasonCounts: Record<string, number>
  runReferences: PromptTuningRunReference[]
  promptSuggestions: string[]
  systemSuggestions: string[]
}

const UNKNOWN_FAILURE_REASON = 'unknown_failure'

const resolveFailureReason = (reason: string | null | undefined, evaluation?: CodexEvaluationRecord) => {
  const reasons = evaluation?.reasons as Record<string, unknown> | undefined
  const error = typeof reasons?.error === 'string' ? reasons.error : null
  if (error) return error
  if (reason) return reason
  if (evaluation && evaluation.decision !== 'pass') return 'judge_failed'
  return null
}

const buildPromptTuningAggregate = async (
  run: CodexRunRecord,
  reason: string | null,
  evaluation?: CodexEvaluationRecord,
) => {
  const windowHours = Math.max(config.promptTuningWindowHours, 0)
  const windowMs = windowHours > 0 ? windowHours * 60 * 60 * 1000 : null
  const now = Date.now()
  const cutoff = windowMs ? now - windowMs : null

  const history = await store.getRunHistory({
    repository: run.repository,
    issueNumber: run.issueNumber,
    branch: run.branch,
  })

  const entries: Array<{
    run: CodexRunRecord
    evaluation: CodexEvaluationRecord
    failureReason: string
    timestamp: number
    createdAt: string
  }> = []

  for (const entry of history.runs) {
    if (!entry.evaluation) continue
    if (entry.evaluation.decision === 'pass') continue
    const createdAt =
      entry.evaluation.createdAt ?? entry.run.updatedAt ?? entry.run.createdAt ?? new Date().toISOString()
    const timestamp = parseTimestampMs(createdAt) ?? now
    if (cutoff != null && timestamp < cutoff) continue
    const failureReason = resolveFailureReason(null, entry.evaluation) ?? UNKNOWN_FAILURE_REASON
    entries.push({ run: entry.run, evaluation: entry.evaluation, failureReason, timestamp, createdAt })
  }

  if (evaluation && !entries.some((entry) => entry.run.id === run.id)) {
    const createdAt = evaluation.createdAt ?? run.updatedAt ?? run.createdAt ?? new Date().toISOString()
    const timestamp = parseTimestampMs(createdAt) ?? now
    if (cutoff == null || timestamp >= cutoff) {
      const failureReason = resolveFailureReason(reason, evaluation) ?? UNKNOWN_FAILURE_REASON
      entries.push({ run, evaluation, failureReason, timestamp, createdAt })
    }
  }

  entries.sort((a, b) => b.timestamp - a.timestamp)

  const failureReasonCounts: Record<string, number> = {}
  for (const entry of entries) {
    failureReasonCounts[entry.failureReason] = (failureReasonCounts[entry.failureReason] ?? 0) + 1
  }

  const resolvedReason =
    resolveFailureReason(reason, evaluation) ??
    Object.entries(failureReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    UNKNOWN_FAILURE_REASON

  const matchingFailures = failureReasonCounts[resolvedReason] ?? 0
  const totalFailures = entries.length

  const promptSuggestions = new Set<string>()
  const systemSuggestions = new Set<string>()
  for (const entry of entries) {
    for (const suggestion of extractSuggestions(
      entry.evaluation.promptTuning as Record<string, unknown> | undefined,
      GENERIC_PROMPT_SUGGESTIONS,
    )) {
      promptSuggestions.add(suggestion)
    }
    for (const suggestion of extractSuggestions(
      entry.evaluation.systemSuggestions as Record<string, unknown> | undefined,
      GENERIC_SYSTEM_SUGGESTIONS,
    )) {
      systemSuggestions.add(suggestion)
    }
  }

  const runReferences = entries.map((entry) => ({
    runId: entry.run.id,
    attempt: entry.run.attempt,
    status: entry.run.status,
    workflowName: entry.run.workflowName,
    createdAt: entry.createdAt,
    prUrl: entry.run.prUrl ?? null,
    ciUrl: entry.run.ciUrl ?? null,
    failureReason: entry.failureReason,
  }))

  return {
    reason: resolvedReason,
    matchingFailures,
    totalFailures,
    windowHours,
    failureReasonCounts,
    runReferences,
    promptSuggestions: [...promptSuggestions],
    systemSuggestions: [...systemSuggestions],
  }
}

const maybeCreatePromptTuningPr = async (
  run: CodexRunRecord,
  reason: string | null,
  nextPrompt: string,
  evaluation?: CodexEvaluationRecord,
) => {
  if (!config.promptTuningEnabled || !config.promptTuningRepo) return
  const aggregate = await buildPromptTuningAggregate(run, reason, evaluation)
  if (aggregate.totalFailures === 0) return
  const threshold = Math.max(config.promptTuningFailureThreshold, 1)
  if (aggregate.matchingFailures < threshold) return
  if (aggregate.promptSuggestions.length === 0 && aggregate.systemSuggestions.length === 0) return

  const cooldownHours = Math.max(config.promptTuningCooldownHours, 0)
  const cooldownMs = cooldownHours > 0 ? cooldownHours * 60 * 60 * 1000 : null
  if (cooldownMs) {
    const latest = await store.getLatestPromptTuningByIssue(run.repository, run.issueNumber)
    if (latest) {
      const createdAt = parseTimestampMs(latest.createdAt)
      if (createdAt != null && Date.now() - createdAt < cooldownMs) {
        return
      }
    }
  }

  await createPromptTuningPr(run, nextPrompt, aggregate)
}

const triggerRerun = async (run: CodexRunRecord, reason: string, evaluation?: CodexEvaluationRecord) => {
  const latestRun = await store.getRunById(run.id)
  if (!latestRun || latestRun.status === 'superseded') return

  const attempts = (await store.listRunsByIssue(run.repository, run.issueNumber)).length
  const resolvedReason = resolveFailureReason(reason, evaluation) ?? UNKNOWN_FAILURE_REASON

  if (attempts >= config.maxAttempts) {
    const updated = await store.updateRunStatus(run.id, 'needs_human')
    if (!updated) return
    await maybeCreatePromptTuningPr(updated, resolvedReason, evaluation?.nextPrompt ?? run.nextPrompt ?? '', evaluation)
    await sendDiscordEscalation(run, reason)
    return
  }

  const nextPrompt = evaluation?.nextPrompt ?? run.nextPrompt
  if (!nextPrompt) {
    const updated = await store.updateRunStatus(run.id, 'needs_iteration')
    if (!updated) return
    await maybeCreatePromptTuningPr(updated, resolvedReason, '', evaluation)
    return
  }

  const updated = await store.updateRunStatus(run.id, 'needs_iteration')
  if (!updated) return
  await maybeCreatePromptTuningPr(updated, resolvedReason, nextPrompt, evaluation)
  const delayIndex = Math.min(Math.max(attempts - 1, 0), config.backoffScheduleMs.length - 1)
  const delayMs = config.backoffScheduleMs[delayIndex] ?? 0
  if (delayMs > 0) {
    setTimeout(() => {
      void handleRerunSubmission(run, nextPrompt, attempts + 1)
    }, delayMs)
    return
  }
  await handleRerunSubmission(run, nextPrompt, attempts + 1)
}

type RerunSubmissionResult = { status: 'submitted' | 'skipped' | 'failed'; error?: string }

const handleRerunSubmission = async (run: CodexRunRecord, prompt: string, attempt: number) => {
  const result = await submitRerun(run, prompt, attempt)
  if (result.status !== 'failed') return

  await store.updateDecision({
    runId: run.id,
    decision: 'needs_human',
    reasons: { error: 'rerun_submission_failed', detail: result.error ?? null },
    suggestedFixes: { fix: 'Check Facteur availability and requeue the rerun.' },
    nextPrompt: null,
    promptTuning: {},
    systemSuggestions: {},
  })

  const updated = await store.updateRunStatus(run.id, 'needs_human')
  if (!updated) return
  await sendDiscordEscalation(run, 'rerun_submission_failed')
}

const submitRerun = async (run: CodexRunRecord, prompt: string, attempt: number): Promise<RerunSubmissionResult> => {
  const latestRun = await store.getRunById(run.id)
  if (!latestRun || latestRun.status === 'superseded') {
    return { status: 'skipped' }
  }

  const deliveryId = `jangar-${run.id}-attempt-${attempt}`
  const claimed = await store.claimRerunSubmission({ parentRunId: run.id, attempt, deliveryId })
  if (!claimed) {
    return { status: 'failed', error: 'rerun_submission_claim_failed' }
  }
  if (!claimed.shouldSubmit) {
    return { status: 'skipped' }
  }

  const { CodexTaskSchema, CodexTaskStage } = await import('./proto/codex_task_pb')
  const { create, toBinary } = await import('@bufbuild/protobuf')
  const { timestampFromDate } = await import('@bufbuild/protobuf/wkt')

  const message = create(CodexTaskSchema, {
    stage: CodexTaskStage.IMPLEMENTATION,
    prompt,
    repository: run.repository,
    base: typeof run.runCompletePayload?.base === 'string' ? String(run.runCompletePayload.base) : 'main',
    head: run.branch,
    issueNumber: BigInt(run.issueNumber),
    issueUrl:
      typeof run.runCompletePayload?.issueUrl === 'string'
        ? String(run.runCompletePayload.issueUrl)
        : `https://github.com/${run.repository}/issues/${run.issueNumber}`,
    issueTitle:
      typeof run.runCompletePayload?.issueTitle === 'string'
        ? String(run.runCompletePayload.issueTitle)
        : `Issue #${run.issueNumber}`,
    issueBody:
      typeof run.runCompletePayload?.issueBody === 'string' ? String(run.runCompletePayload.issueBody) : prompt,
    sender: 'jangar',
    issuedAt: timestampFromDate(new Date()),
    deliveryId,
  })

  const payload = toBinary(CodexTaskSchema, message)

  const maxAttempts = RERUN_SUBMISSION_BACKOFF_MS.length + 1
  let lastError: string | undefined
  for (let index = 0; index < maxAttempts; index += 1) {
    let responseStatus: number | null = null
    try {
      const response = await fetch(`${config.facteurBaseUrl}/codex/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: payload,
      })
      responseStatus = response.status

      const responseText = response.ok ? '' : await response.text().catch(() => '')
      if (!response.ok) {
        lastError = `Facteur rerun submission failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`
        if (index >= maxAttempts - 1) {
          await store.updateRerunSubmission({
            id: claimed.submission.id,
            status: 'failed',
            responseStatus,
            error: lastError,
          })
          return { status: 'failed', error: lastError }
        }
        await wait(RERUN_SUBMISSION_BACKOFF_MS[index] ?? 0)
        continue
      }

      await store.updateRerunSubmission({
        id: claimed.submission.id,
        status: 'submitted',
        responseStatus,
        error: null,
        submittedAt: new Date().toISOString(),
      })

      return { status: 'submitted' }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (index >= maxAttempts - 1) {
        await store.updateRerunSubmission({
          id: claimed.submission.id,
          status: 'failed',
          responseStatus,
          error: lastError,
        })
        return { status: 'failed', error: lastError }
      }
      await wait(RERUN_SUBMISSION_BACKOFF_MS[index] ?? 0)
    }
  }

  return { status: 'failed', error: lastError ?? 'rerun_submission_failed' }
}

const PROMPT_TUNING_RUN_REFERENCE_LIMIT = 10

const formatPromptTuningRunReference = (reference: PromptTuningRunReference) => {
  const parts = [
    `run ${reference.runId}`,
    `attempt ${reference.attempt}`,
    `status ${reference.status}`,
    `reason ${reference.failureReason}`,
    `created ${reference.createdAt}`,
  ]
  if (reference.workflowName) {
    parts.push(`workflow ${reference.workflowName}`)
  }
  if (reference.prUrl) {
    parts.push(`PR ${reference.prUrl}`)
  }
  if (reference.ciUrl) {
    parts.push(`CI ${reference.ciUrl}`)
  }
  return `- ${parts.join(' | ')}`
}

const createPromptTuningPr = async (run: CodexRunRecord, nextPrompt: string, aggregate: PromptTuningAggregate) => {
  if (!config.promptTuningRepo) return
  const { owner, repo } = parseRepositoryParts(config.promptTuningRepo)
  const baseRef = 'main'
  const branch = `codex/prompt-tuning-${run.issueNumber}-${Date.now()}`
  const baseSha = await github.getRefSha(owner, repo, `heads/${baseRef}`)
  await github.createBranch({ owner, repo, branch, baseSha })

  const promptPath = 'apps/froussard/src/codex.ts'
  if (aggregate.promptSuggestions.length > 0) {
    const promptFile = await github.getFile(owner, repo, promptPath, baseRef)
    const promptInsert = aggregate.promptSuggestions.map((entry) => `    '- ${entry}',`).join('\n')
    const marker = "    'Memory:',"
    const updatedPrompt = promptFile.content.replace(
      marker,
      `    '',\n    'Prompt tuning:',\n${promptInsert}\n${marker}`,
    )

    await github.updateFile({
      owner,
      repo,
      path: promptPath,
      branch,
      message: `docs(prompt): tune codex prompt for issue ${run.issueNumber}`,
      content: updatedPrompt,
      sha: promptFile.sha,
    })
  }

  const tuningDocPath = `docs/jangar/prompt-tuning/${run.issueNumber}-${Date.now()}.md`
  const failureReasonEntries = Object.entries(aggregate.failureReasonCounts).sort((a, b) => b[1] - a[1])
  const failureReasonLines =
    failureReasonEntries.length > 0
      ? failureReasonEntries.map(([reason, count]) => `- ${reason}: ${count}`)
      : ['- None']
  const runReferenceLines = aggregate.runReferences
    .slice(0, PROMPT_TUNING_RUN_REFERENCE_LIMIT)
    .map((entry) => formatPromptTuningRunReference(entry))
  if (aggregate.runReferences.length > PROMPT_TUNING_RUN_REFERENCE_LIMIT) {
    runReferenceLines.push(`- ...and ${aggregate.runReferences.length - PROMPT_TUNING_RUN_REFERENCE_LIMIT} more runs`)
  }
  const promptSuggestionLines =
    aggregate.promptSuggestions.length > 0 ? aggregate.promptSuggestions.map((entry) => `- ${entry}`) : ['- None']
  const systemSuggestionLines =
    aggregate.systemSuggestions.length > 0 ? aggregate.systemSuggestions.map((entry) => `- ${entry}`) : ['- None']

  const tuningDocContent = [
    `# Prompt tuning for ${run.repository}#${run.issueNumber}`,
    '',
    '## Aggregated signals',
    `- Window: last ${aggregate.windowHours} hours`,
    `- Failure reason: ${aggregate.reason} (${aggregate.matchingFailures}/${Math.max(
      config.promptTuningFailureThreshold,
      1,
    )})`,
    `- Total failures in window: ${aggregate.totalFailures}`,
    '',
    '## Failure reasons',
    ...failureReasonLines,
    '',
    '## Run references',
    ...(runReferenceLines.length > 0 ? runReferenceLines : ['- None']),
    '',
    '## Next prompt',
    nextPrompt || 'N/A',
    '',
    '## Suggestions',
    ...promptSuggestionLines,
    '',
    '## System improvements',
    ...systemSuggestionLines,
  ].join('\n')

  await github
    .updateFile({
      owner,
      repo,
      path: tuningDocPath,
      branch,
      message: `docs(prompt): add tuning context for issue ${run.issueNumber}`,
      content: tuningDocContent,
    })
    .catch(() => {
      // ignore if doc already exists
    })

  let prBody = `## Summary\n- Automated prompt tuning from Jangar\n\n## Related Issues\n- #${run.issueNumber}\n\n## Testing\n- N/A (prompt update)\n\n## Screenshots (if applicable)\n- N/A\n\n## Breaking Changes\n- None\n`
  try {
    const prTemplate = await github.getFile(owner, repo, '.github/PULL_REQUEST_TEMPLATE.md', baseRef)
    prBody = prTemplate.content
      .replace('## Summary', '## Summary\n- Automated prompt tuning from Jangar')
      .replace('## Related Issues', `## Related Issues\n- #${run.issueNumber}`)
      .replace('## Testing', '## Testing\n- N/A (prompt update)')
      .replace('## Screenshots (if applicable)', '## Screenshots (if applicable)\n- N/A')
      .replace('## Breaking Changes', '## Breaking Changes\n- None')
  } catch {
    // fallback to default body
  }

  const prFailureReasons =
    failureReasonEntries.length > 0
      ? failureReasonEntries.map(([reason, count]) => `${reason} (${count})`).join(', ')
      : 'None'
  const prRunReferences = runReferenceLines.length > 0 ? runReferenceLines : ['- None']
  const prSystemSuggestions =
    aggregate.systemSuggestions.length > 0 ? aggregate.systemSuggestions.map((entry) => `- ${entry}`) : ['- None']

  const promptTuningSection = [
    '',
    '## Prompt tuning signals',
    `- Aggregated ${aggregate.matchingFailures} "${aggregate.reason}" failures in the last ${aggregate.windowHours} hours.`,
    `- Failure reasons: ${prFailureReasons}`,
    '',
    '## Run references',
    ...prRunReferences,
    '',
    '## System improvements',
    ...prSystemSuggestions,
    '',
    '## Prompt tuning doc',
    `- ${tuningDocPath}`,
  ].join('\n')

  prBody = `${prBody.trim()}\n${promptTuningSection}\n`

  const pr = (await github.createPullRequest({
    owner,
    repo,
    head: branch,
    base: baseRef,
    title: `docs(prompt): tune codex prompt for #${run.issueNumber}`,
    body: prBody,
  })) as Record<string, unknown>

  const prUrl = typeof pr.html_url === 'string' ? pr.html_url : ''
  if (prUrl) {
    await store.createPromptTuning(run.id, prUrl, 'open', {
      reason: aggregate.reason,
      matchingFailures: aggregate.matchingFailures,
      totalFailures: aggregate.totalFailures,
      windowHours: aggregate.windowHours,
      failureReasonCounts: aggregate.failureReasonCounts,
      runReferences: aggregate.runReferences.map((entry) => ({
        runId: entry.runId,
        attempt: entry.attempt,
        status: entry.status,
        failureReason: entry.failureReason,
        createdAt: entry.createdAt,
      })),
      promptSuggestions: aggregate.promptSuggestions,
      systemSuggestions: aggregate.systemSuggestions,
    })
  }
}

const DISCORD_MESSAGE_LIMIT = 1900
const DISCORD_SUMMARY_FALLBACK = 'No summary available.'
const DISCORD_SUMMARY_HEADERS = new Set(['summary'])
const DISCORD_SECTION_HEADERS = new Set([
  'summary',
  'tests',
  'testing',
  'pr link',
  'pr',
  'blockers',
  'screenshots',
  'breaking changes',
])
const DISCORD_ARTIFACT_PREFERENCE = [
  'implementation-log',
  'implementation-status',
  'implementation-events',
  'implementation-agent-log',
  'implementation-runtime-log',
  'implementation-changes',
  'implementation-patch',
]

const normalizeDiscordHeader = (value: string) =>
  value
    .toLowerCase()
    .replace(/^[#>*-]+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const isDiscordHeader = (value: string, headers: Set<string>) => {
  const normalized = normalizeDiscordHeader(value)
  if (!normalized) return false
  if (headers.has(normalized)) return true
  for (const header of headers) {
    if (normalized.startsWith(`${header} `) || normalized.startsWith(`${header}:`)) {
      return true
    }
  }
  return false
}

const normalizeDiscordSummary = (value: string) => value.replace(/\s+/g, ' ').trim()

const extractSummaryFromAssistantMessage = (value: string | null | undefined) => {
  if (!value) return null
  const lines = value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
  const summaryIndex = lines.findIndex((line) => isDiscordHeader(line, DISCORD_SUMMARY_HEADERS))

  if (summaryIndex >= 0) {
    const bullets: string[] = []
    for (let i = summaryIndex + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) {
        if (bullets.length > 0) break
        continue
      }
      if (isDiscordHeader(line, DISCORD_SECTION_HEADERS)) break
      const bulletMatch = line.match(/^[-*\u2022]\s+(.*)$/)
      if (bulletMatch) {
        const content = bulletMatch[1]?.trim()
        if (content) {
          bullets.push(content)
        }
        if (bullets.length >= 2) break
        continue
      }
      if (bullets.length === 0) {
        const normalized = normalizeDiscordSummary(line)
        return normalized || null
      }
      break
    }
    if (bullets.length > 0) {
      return normalizeDiscordSummary(bullets.join('; '))
    }
  }

  const firstLine = lines.find((line) => line.length > 0)
  return firstLine ? normalizeDiscordSummary(firstLine) : null
}

const resolveIssueUrl = (run: CodexRunRecord) => {
  const runPayload = run.runCompletePayload ?? {}
  const rawIssueUrl =
    (typeof runPayload.issueUrl === 'string' && runPayload.issueUrl.trim()) ||
    (typeof runPayload.issue_url === 'string' && runPayload.issue_url.trim())
  if (rawIssueUrl) return rawIssueUrl.trim()
  if (!run.repository || !run.issueNumber) return null
  return `https://github.com/${run.repository}/issues/${run.issueNumber}`
}

const resolvePrUrl = (run: CodexRunRecord, prUrl?: string) => {
  if (prUrl && prUrl.trim().length > 0) return prUrl.trim()
  if (run.prUrl && run.prUrl.trim().length > 0) return run.prUrl.trim()
  if (run.prNumber && run.repository) {
    return `https://github.com/${run.repository}/pull/${run.prNumber}`
  }
  return null
}

const resolveCiUrl = (run: CodexRunRecord, ciUrl?: string) => {
  if (ciUrl && ciUrl.trim().length > 0) return ciUrl.trim()
  if (run.ciUrl && run.ciUrl.trim().length > 0) return run.ciUrl.trim()
  if (run.commitSha && run.repository) {
    return `https://github.com/${run.repository}/commit/${run.commitSha}/checks`
  }
  return null
}

const extractArtifactUrl = (run: CodexRunRecord) => {
  const payload = run.runCompletePayload
  if (!payload || typeof payload !== 'object') return null
  const artifacts = Array.isArray(payload.artifacts)
    ? payload.artifacts
    : isRecord(payload.data) && Array.isArray(payload.data.artifacts)
      ? payload.data.artifacts
      : []

  if (artifacts.length === 0) return null

  const findUrl = (name: string) => {
    const match = artifacts.find(
      (artifact) =>
        isRecord(artifact) && artifact.name === name && typeof artifact.url === 'string' && artifact.url.trim().length,
    )
    return match && typeof match.url === 'string' ? match.url.trim() : null
  }

  for (const name of DISCORD_ARTIFACT_PREFERENCE) {
    const url = findUrl(name)
    if (url) return url
  }

  const fallback = artifacts.find(
    (artifact) => isRecord(artifact) && typeof artifact.url === 'string' && artifact.url.trim().length,
  )
  return fallback && typeof fallback.url === 'string' ? fallback.url.trim() : null
}

const truncateDiscordText = (value: string, maxLength: number) => {
  if (maxLength <= 0) return ''
  if (value.length <= maxLength) return value
  const suffix = '...'
  const sliceLength = Math.max(0, maxLength - suffix.length)
  if (sliceLength === 0) return suffix.slice(0, maxLength)
  return `${value.slice(0, sliceLength)}${suffix}`
}

const buildDiscordSuccessMessage = (run: CodexRunRecord, prUrl?: string, ciUrl?: string) => {
  const issueUrl = resolveIssueUrl(run)
  const resolvedPrUrl = resolvePrUrl(run, prUrl)
  const resolvedCiUrl = resolveCiUrl(run, ciUrl)
  const artifactUrl = extractArtifactUrl(run)
  const summaryRaw = extractSummaryFromAssistantMessage(
    typeof run.notifyPayload?.last_assistant_message === 'string' ? run.notifyPayload.last_assistant_message : null,
  )
  const summary = summaryRaw || DISCORD_SUMMARY_FALLBACK

  const statusLine = `✅ Codex completed ${run.repository}#${run.issueNumber}.`
  const summaryPrefix = 'Summary: '
  const linkLines = [
    issueUrl ? `Issue: ${issueUrl}` : null,
    resolvedPrUrl ? `PR: ${resolvedPrUrl}` : null,
    resolvedCiUrl ? `CI: ${resolvedCiUrl}` : null,
    artifactUrl ? `Artifacts: ${artifactUrl}` : null,
  ].filter(Boolean) as string[]

  const buildLines = (links: string[]) => {
    const fixedLines = [statusLine, ...links]
    const fixedLength = fixedLines.join('\n').length
    const maxSummary = DISCORD_MESSAGE_LIMIT - fixedLength - summaryPrefix.length - 1
    const trimmedSummary = truncateDiscordText(summary, maxSummary)
    return [statusLine, `${summaryPrefix}${trimmedSummary || DISCORD_SUMMARY_FALLBACK}`, ...links]
  }

  let lines = buildLines(linkLines)
  if (lines.join('\n').length > DISCORD_MESSAGE_LIMIT && artifactUrl) {
    lines = buildLines(linkLines.filter((line) => !line.startsWith('Artifacts:')))
  }

  const content = lines.join('\n')
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content

  const tightenedSummary = truncateDiscordText(
    summary,
    Math.max(1, DISCORD_MESSAGE_LIMIT - content.length + summary.length),
  )
  return [statusLine, `${summaryPrefix}${tightenedSummary || '...'}`, ...linkLines]
    .join('\n')
    .slice(0, DISCORD_MESSAGE_LIMIT)
}

const sendDiscordSuccess = async (run: CodexRunRecord, prUrl?: string, ciUrl?: string) => {
  if (!config.discordBotToken || !config.discordChannelId) return
  const content = buildDiscordSuccessMessage(run, prUrl, ciUrl)

  await fetch(`${config.discordApiBaseUrl}/channels/${config.discordChannelId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bot ${config.discordBotToken}`,
    },
    body: JSON.stringify({ content }),
  })
}

const sendDiscordEscalation = async (run: CodexRunRecord, reason: string) => {
  if (!config.discordBotToken || !config.discordChannelId) return
  const content = `⚠️ Codex needs human help for ${run.repository}#${run.issueNumber}. Reason: ${reason}`
  await fetch(`${config.discordApiBaseUrl}/channels/${config.discordChannelId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bot ${config.discordBotToken}`,
    },
    body: JSON.stringify({ content }),
  })
}

const writeMemories = async (run: CodexRunRecord, evaluation: CodexEvaluationRecord) => {
  let memoryStore: ReturnType<typeof createPostgresMemoriesStore> | null = null
  let shouldClose = false
  try {
    const memoryStoreFactory = getMemoryStoreFactory()
    memoryStore = globalOverrides.__codexJudgeMemoryStoreMock ?? null
    if (!memoryStore) {
      memoryStore = memoryStoreFactory()
      shouldClose = true
    }
    const namespace = `codex:${run.repository}:${run.issueNumber}`
    const workflowTag = run.workflowName ? `workflow-${run.workflowName}` : 'workflow-unknown'
    const stageTag = run.stage ? `stage-${run.stage}` : 'stage-unknown'
    const tags = [
      'codex',
      run.repository,
      `issue-${run.issueNumber}`,
      workflowTag,
      `attempt-${run.attempt}`,
      run.status,
      stageTag,
    ].filter((tag) => tag.length > 0)
    const logExcerpt = extractLogExcerpt(run.notifyPayload)
    const metadata = {
      runId: run.id,
      commitSha: run.commitSha,
      ciUrl: run.ciUrl,
      workflowName: run.workflowName,
      workflowNamespace: run.workflowNamespace,
      workflowUid: run.workflowUid,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }

    const snapshots = [
      {
        summary: 'Run summary',
        content: `Status: ${run.status} CI: ${run.ciStatus}\nStatus log:\n${logExcerpt.status ?? 'n/a'}`,
      },
      { summary: 'Decision', content: JSON.stringify(evaluation, null, 2) },
      { summary: 'Prompt', content: run.prompt ?? '' },
      { summary: 'Next prompt', content: run.nextPrompt ?? '' },
      { summary: 'Output log excerpt', content: logExcerpt.output ?? 'n/a' },
      { summary: 'Agent log excerpt', content: logExcerpt.agent ?? 'n/a' },
      { summary: 'Runtime log excerpt', content: logExcerpt.runtime ?? 'n/a' },
      { summary: 'Event log excerpt', content: logExcerpt.events ?? 'n/a' },
      { summary: 'Review status', content: JSON.stringify(run.reviewSummary ?? {}, null, 2) },
      { summary: 'PR info', content: run.prUrl ?? 'no PR' },
    ]

    for (const snapshot of snapshots) {
      await memoryStore.persist({
        namespace,
        content: snapshot.content || 'n/a',
        summary: snapshot.summary,
        tags,
        metadata,
      })
    }
  } catch (error) {
    console.warn('Failed to persist Codex judge memories', error)
  } finally {
    if (memoryStore && shouldClose) {
      try {
        await memoryStore.close()
      } catch (error) {
        console.warn('Failed to close Codex judge memories store', error)
      }
    }
  }
}

export const __private = {
  evaluateRun,
  extractCommitShaFromArtifacts,
  findCommitShaInValue,
  normalizeBranchRef,
  resolveCiContext,
  writeMemories,
}
export const handleRunComplete = async (payload: Record<string, unknown>) => {
  await ensureStoreReady()
  const parsed = parseRunCompletePayload(payload)
  if (!parsed.repository || !parsed.issueNumber || !parsed.head) {
    return null
  }

  const run = await store.upsertRunComplete({
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    branch: parsed.head,
    workflowName: parsed.workflowName,
    workflowUid: parsed.workflowUid,
    workflowNamespace: parsed.workflowNamespace,
    stage: parsed.stage,
    status: 'run_complete',
    phase: parsed.phase,
    prompt: parsed.prompt,
    runCompletePayload: {
      ...parsed.runCompletePayload,
      issueTitle: parsed.issueTitle,
      issueBody: parsed.issueBody,
      issueUrl: parsed.issueUrl,
      base: parsed.base,
      head: parsed.head,
    },
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
  })

  const resolvedArtifacts = await updateArtifactsFromWorkflow(run, parsed.artifacts)
  await applyArtifactFallback(run, resolvedArtifacts)
  await backfillAgentMessages(run, resolvedArtifacts)
  if (run.status === 'run_complete') {
    scheduleEvaluation(run.id, 1000)
  }

  return run
}

export const handleNotify = async (payload: Record<string, unknown>) => {
  await ensureStoreReady()
  const parsed = parseNotifyPayload(payload)
  if (!parsed.workflowName) {
    throw new Error('notify payload missing workflow name')
  }

  const run = await store.attachNotify({
    workflowName: parsed.workflowName,
    workflowNamespace: parsed.workflowNamespace,
    notifyPayload: parsed.notifyPayload,
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    branch: parsed.branch,
    prompt: parsed.prompt,
  })

  if (run && run.status === 'run_complete') {
    scheduleEvaluation(run.id, 1000)
  }

  return run
}
