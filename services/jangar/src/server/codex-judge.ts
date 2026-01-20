import { Buffer } from 'node:buffer'

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as S from '@effect/schema/Schema'
import * as Either from 'effect/Either'
import { publishAgentMessages } from '~/server/agent-messages-bus'
import { createAgentMessagesStore } from '~/server/agent-messages-store'
import {
  buildBackfillDedupeKey,
  parseAgentMessagesFromEvents,
  parseAgentMessagesFromLog,
} from '~/server/codex-judge-agent-messages'
import { extractImplementationManifestFromArchive, extractTextFromArchive } from '~/server/codex-judge-artifacts'
import { loadCodexJudgeConfig } from '~/server/codex-judge-config'
import {
  type CodexArtifactRecord,
  type CodexEvaluationRecord,
  type CodexRunRecord,
  createCodexJudgeStore,
  type UpdateDecisionInput,
} from '~/server/codex-judge-store'
import { createGitHubClient, GitHubRateLimitError, type PullRequest } from '~/server/github-client'
import { ingestGithubReviewEvent } from '~/server/github-review-ingest'
import { createPostgresMemoriesStore } from '~/server/memories-store'
import { submitOrchestrationRun } from '~/server/orchestration-submit'

type MemoryStoreFactory = () => ReturnType<typeof createPostgresMemoriesStore>

const globalOverrides = globalThis as typeof globalThis & {
  __codexJudgeStoreMock?: ReturnType<typeof createCodexJudgeStore>
  __codexJudgeConfigMock?: ReturnType<typeof loadCodexJudgeConfig>
  __codexJudgeGithubMock?: ReturnType<typeof createGitHubClient>
  __codexJudgeMemoryStoreMock?: ReturnType<typeof createPostgresMemoriesStore>
  __codexJudgeMemoryStoreFactory?: MemoryStoreFactory
  __codexJudgeOrchestrationSubmitMock?: typeof submitOrchestrationRun
}

let cachedStore: ReturnType<typeof createCodexJudgeStore> | null = null
const resolveStore = () => {
  if (globalOverrides.__codexJudgeStoreMock) return globalOverrides.__codexJudgeStoreMock
  if (!cachedStore) {
    cachedStore = createCodexJudgeStore()
  }
  return cachedStore
}
const store = new Proxy({} as ReturnType<typeof createCodexJudgeStore>, {
  get: (_target, prop) => resolveStore()[prop as keyof ReturnType<typeof createCodexJudgeStore>],
})
const getStore = () => resolveStore()
const storeReady = () => resolveStore().ready ?? Promise.resolve()
const ensureStoreReady = async () => {
  await storeReady()
}
const defaultConfig = loadCodexJudgeConfig()
const resolveConfig = () => globalOverrides.__codexJudgeConfigMock ?? defaultConfig
const config = new Proxy({} as ReturnType<typeof loadCodexJudgeConfig>, {
  get: (_target, prop) => resolveConfig()[prop as keyof ReturnType<typeof loadCodexJudgeConfig>],
})
const getConfig = () => resolveConfig()
const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
let cachedGithub: ReturnType<typeof createGitHubClient> | null = null
const resolveGithub = () => {
  if (globalOverrides.__codexJudgeGithubMock) return globalOverrides.__codexJudgeGithubMock
  if (!cachedGithub) {
    cachedGithub = createGitHubClient({
      token: resolveConfig().githubToken,
      apiBaseUrl: resolveConfig().githubApiBaseUrl,
    })
  }
  return cachedGithub
}
const getGithub = () => resolveGithub()
const resolveOrchestrationSubmit = () => globalOverrides.__codexJudgeOrchestrationSubmitMock ?? submitOrchestrationRun
const getMemoryStoreFactory = () => globalOverrides.__codexJudgeMemoryStoreFactory ?? createPostgresMemoriesStore

const scheduledRuns = new Map<string, NodeJS.Timeout>()
const activeEvaluations = new Set<string>()
const terminalStatuses = new Set(['completed', 'needs_human', 'needs_iteration'])
const isTerminalStatus = (status: string | null | undefined) => (status ? terminalStatuses.has(status) : false)
const _RECONCILE_STARTUP_DELAY_MS = 5_000
const _RECONCILE_INTERVAL_MS = 60_000
const _RECONCILE_BASE_DELAY_MS = 1_000
const _RECONCILE_JITTER_MS = 15_000
const _PENDING_EVALUATION_STATUSES = ['run_complete', 'waiting_for_ci', 'judging'] as const
const _RECONCILE_DISABLED = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
const RERUN_SUBMISSION_BACKOFF_MS = [2_000, 7_000, 15_000]
const RERUN_WORKER_BATCH_SIZE = 10

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

const isGitHubRateLimitError = (error: unknown): error is GitHubRateLimitError => {
  if (error instanceof GitHubRateLimitError) return true
  if (!error || typeof error !== 'object') return false
  return 'retryAt' in error && 'status' in error
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
  turnId: S.optional(S.String),
  turn_id: S.optional(S.String),
  threadId: S.optional(S.String),
  thread_id: S.optional(S.String),
  iteration: S.optional(S.Union(S.String, S.Number)),
  iteration_cycle: S.optional(S.Union(S.String, S.Number)),
  iterationCycle: S.optional(S.Union(S.String, S.Number)),
  iterations: S.optional(S.Union(S.String, S.Number)),
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
  workflowName: S.optional(S.String),
  workflowNamespace: S.optional(S.String),
  workflowUid: S.optional(S.String),
  repository: S.optional(S.String),
  issueNumber: S.optional(S.Union(S.String, S.Number)),
  branch: S.optional(S.String),
  base: S.optional(S.String),
  prompt: S.optional(S.String),
  iteration: S.optional(S.Union(S.String, S.Number)),
  iterationCycle: S.optional(S.Union(S.String, S.Number)),
  iteration_cycle: S.optional(S.Union(S.String, S.Number)),
  iterations: S.optional(S.Union(S.String, S.Number)),
  startedAt: S.optional(S.String),
  finishedAt: S.optional(S.String),
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

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeStringMap = (value: unknown) => {
  if (!isRecord(value)) return {}
  const entries = Object.entries(value)
  const result: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (entry == null) continue
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed) {
        result[key] = trimmed
      }
      continue
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      result[key] = String(entry)
    }
  }
  return result
}

const readMetadataMap = (value: unknown) => {
  if (typeof value === 'string') {
    return normalizeStringMap(safeParseJson(value))
  }
  return normalizeStringMap(value)
}

const getMetadataValue = (
  rawMetadata: Record<string, unknown>,
  labels: Record<string, string>,
  annotations: Record<string, string>,
  keys: string[],
) => {
  for (const key of keys) {
    const candidate = labels[key] ?? annotations[key]
    if (candidate && candidate.trim().length > 0) {
      return candidate.trim()
    }
    const direct = rawMetadata[key]
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct.trim()
    }
  }
  return ''
}

const REPO_METADATA_KEYS = [
  'codex.repository',
  'codex.repo',
  'repository',
  'repo',
  'github.repository',
  'facteur.codex.repository',
]

const ISSUE_METADATA_KEYS = [
  'codex.issue_number',
  'codex.issue-number',
  'codex.issueNumber',
  'codex.issue',
  'issue_number',
  'issue-number',
  'issueNumber',
  'issue',
  'github.issue_number',
  'facteur.codex.issue_number',
]

const HEAD_METADATA_KEYS = [
  'codex.head',
  'codex.head_branch',
  'codex.head-branch',
  'codex.headBranch',
  'head',
  'head_branch',
  'head-branch',
  'headBranch',
  'branch',
  'codex.branch',
]

const BASE_METADATA_KEYS = [
  'codex.base',
  'codex.base_branch',
  'codex.base-branch',
  'codex.baseBranch',
  'base',
  'base_branch',
  'base-branch',
  'baseBranch',
]

const TURN_METADATA_KEYS = ['codex.turn_id', 'codex.turn-id', 'codex.turnId', 'turn_id', 'turn-id', 'turnId']

const THREAD_METADATA_KEYS = [
  'codex.thread_id',
  'codex.thread-id',
  'codex.threadId',
  'thread_id',
  'thread-id',
  'threadId',
]

const extractRepositoryFromRawEvent = (rawEvent: Record<string, unknown>) => {
  const repositoryValue = rawEvent.repository
  if (typeof repositoryValue === 'string') {
    return normalizeRepo(repositoryValue)
  }
  if (isRecord(repositoryValue)) {
    const fullName = normalizeRepo(repositoryValue.full_name)
    if (fullName) return fullName
    const repoName = normalizeRepo(repositoryValue.name)
    if (repoName) {
      const owner = isRecord(repositoryValue.owner)
        ? normalizeRepo(repositoryValue.owner.login ?? repositoryValue.owner.name)
        : ''
      if (owner) {
        return `${owner}/${repoName}`
      }
    }
  }

  const repoValue = rawEvent.repo
  if (typeof repoValue === 'string') {
    return normalizeRepo(repoValue)
  }
  if (isRecord(repoValue)) {
    const fullName = normalizeRepo(repoValue.full_name)
    if (fullName) return fullName
    const repoName = normalizeRepo(repoValue.name)
    if (repoName) {
      const owner = isRecord(repoValue.owner) ? normalizeRepo(repoValue.owner.login ?? repoValue.owner.name) : ''
      if (owner) {
        return `${owner}/${repoName}`
      }
    }
  }

  return ''
}

const extractIssueNumberFromRawEvent = (rawEvent: Record<string, unknown>) => {
  const direct = normalizeNumber(rawEvent.issue_number ?? rawEvent.issueNumber ?? rawEvent.number ?? 0)
  if (direct) return direct
  if (isRecord(rawEvent.issue)) {
    const issueNumber = normalizeNumber(rawEvent.issue.number ?? rawEvent.issue.issue_number ?? 0)
    if (issueNumber) return issueNumber
  }
  if (isRecord(rawEvent.pull_request)) {
    const prNumber = normalizeNumber(rawEvent.pull_request.number ?? 0)
    if (prNumber) return prNumber
  }
  return 0
}

const extractBranchFromRawEvent = (rawEvent: Record<string, unknown>, field: 'head' | 'base') => {
  const direct = rawEvent[field]
  if (typeof direct === 'string') {
    return normalizeRepo(direct)
  }
  const pr = isRecord(rawEvent.pull_request) ? rawEvent.pull_request : null
  const branch = pr && isRecord(pr[field]) ? pr[field] : null
  if (branch && typeof branch.ref === 'string') {
    return normalizeRepo(branch.ref)
  }
  return ''
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
  const metadataRecord: Record<string, unknown> = isRecord(rawMetadata) ? rawMetadata : {}
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
  const rawEventRaw = getParamValue(params, 'rawEvent')
  const rawEvent = rawEventRaw ? decodeBase64Json(rawEventRaw) : {}

  const labels = readMetadataMap(metadataRecord.labels)
  const annotations = readMetadataMap(metadataRecord.annotations)

  const metadataRepository = normalizeRepo(getMetadataValue(metadataRecord, labels, annotations, REPO_METADATA_KEYS))
  const metadataIssueNumber = normalizeNumber(
    getMetadataValue(metadataRecord, labels, annotations, ISSUE_METADATA_KEYS),
  )
  const metadataHead = normalizeRepo(getMetadataValue(metadataRecord, labels, annotations, HEAD_METADATA_KEYS))
  const metadataBase = normalizeRepo(getMetadataValue(metadataRecord, labels, annotations, BASE_METADATA_KEYS))
  const metadataTurnId = normalizeOptionalString(
    getMetadataValue(metadataRecord, labels, annotations, TURN_METADATA_KEYS),
  )
  const metadataThreadId = normalizeOptionalString(
    getMetadataValue(metadataRecord, labels, annotations, THREAD_METADATA_KEYS),
  )

  const repository =
    normalizeRepo(decodedPayload.repository) ||
    normalizeRepo(eventBody.repository ?? eventBody.repo) ||
    metadataRepository ||
    normalizeRepo(extractRepositoryFromRawEvent(rawEvent))
  const issueNumber =
    normalizeNumber(decodedPayload.issueNumber ?? 0) ||
    normalizeNumber(eventBody.issueNumber ?? eventBody.issue_number ?? 0) ||
    metadataIssueNumber ||
    extractIssueNumberFromRawEvent(rawEvent)
  const head =
    normalizeRepo(decodedPayload.branch) ||
    normalizeRepo(eventBody.head) ||
    normalizeRepo(getParamValue(params, 'head')) ||
    metadataHead ||
    normalizeRepo(extractBranchFromRawEvent(rawEvent, 'head'))
  const base =
    normalizeRepo(decodedPayload.base) ||
    normalizeRepo(eventBody.base) ||
    normalizeRepo(getParamValue(params, 'base')) ||
    metadataBase ||
    normalizeRepo(extractBranchFromRawEvent(rawEvent, 'base'))
  const prompt =
    typeof decodedPayload.prompt === 'string'
      ? decodedPayload.prompt.trim()
      : typeof eventBody.prompt === 'string'
        ? eventBody.prompt.trim()
        : null
  const iterationRaw =
    normalizeNumber(decodedPayload.iteration ?? 0) ||
    normalizeNumber(eventBody.iteration ?? 0) ||
    normalizeNumber(getParamValue(params, 'iteration'))
  const iterationCycleRaw =
    normalizeNumber(decodedPayload.iterationCycle ?? decodedPayload.iteration_cycle ?? 0) ||
    normalizeNumber(eventBody.iterationCycle ?? eventBody.iteration_cycle ?? 0) ||
    normalizeNumber(getParamValue(params, 'iteration_cycle'))
  const iterationsRaw =
    normalizeNumber(decodedPayload.iterations ?? 0) ||
    normalizeNumber(eventBody.iterations ?? 0) ||
    normalizeNumber(getParamValue(params, 'iterations'))
  const iteration = iterationRaw > 0 ? iterationRaw : null
  const iterationCycle = iterationCycleRaw > 0 ? iterationCycleRaw : null
  const iterations = iterationsRaw > 0 ? iterationsRaw : null
  const issueTitle = typeof eventBody.issueTitle === 'string' ? eventBody.issueTitle : null
  const issueBody = typeof eventBody.issueBody === 'string' ? eventBody.issueBody : null
  const issueUrl = typeof eventBody.issueUrl === 'string' ? eventBody.issueUrl : null
  const turnId = normalizeOptionalString(eventBody.turnId ?? eventBody.turn_id) ?? metadataTurnId
  const threadId = normalizeOptionalString(eventBody.threadId ?? eventBody.thread_id) ?? metadataThreadId
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
    iteration,
    iterationCycle,
    iterations,
    issueTitle,
    issueBody,
    issueUrl,
    turnId,
    threadId,
    workflowName:
      typeof decodedPayload.workflowName === 'string' && decodedPayload.workflowName.trim()
        ? decodedPayload.workflowName.trim()
        : String(metadataRecord.name ?? ''),
    workflowUid:
      (typeof decodedPayload.workflowUid === 'string' ? decodedPayload.workflowUid.trim() : '') ||
      (typeof metadataRecord.uid === 'string' ? metadataRecord.uid : null),
    workflowNamespace:
      (typeof decodedPayload.workflowNamespace === 'string' ? decodedPayload.workflowNamespace.trim() : '') ||
      (typeof metadataRecord.namespace === 'string' ? metadataRecord.namespace : null),
    stage: typeof decodedPayload.stage === 'string' ? decodedPayload.stage : null,
    phase: typeof rawStatus.phase === 'string' ? rawStatus.phase : null,
    startedAt:
      normalizeOptionalString(decodedPayload.startedAt) ??
      (typeof rawStatus.startedAt === 'string' ? rawStatus.startedAt : null),
    finishedAt:
      normalizeOptionalString(decodedPayload.finishedAt) ??
      (typeof rawStatus.finishedAt === 'string' ? rawStatus.finishedAt : null),
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
  const issueNumber = Number(data.issue_number ?? data.issueNumber ?? 0)
  const branch =
    typeof data.head_branch === 'string'
      ? data.head_branch.trim()
      : typeof data.branch === 'string'
        ? data.branch.trim()
        : ''
  const prompt = typeof data.prompt === 'string' ? data.prompt : null
  const prNumberRaw = data.pr_number ?? data.prNumber
  const prNumber = typeof prNumberRaw === 'number' ? prNumberRaw : Number(prNumberRaw ?? 0)
  const prUrl = typeof data.pr_url === 'string' ? data.pr_url : typeof data.prUrl === 'string' ? data.prUrl : null
  const headSha =
    typeof data.head_sha === 'string' ? data.head_sha : typeof data.headSha === 'string' ? data.headSha : null
  const stage = typeof data.stage === 'string' ? data.stage : null
  const reviewStatus =
    typeof data.review_status === 'string'
      ? data.review_status
      : typeof data.reviewStatus === 'string'
        ? data.reviewStatus
        : null
  const reviewSummary = isRecord(data.review_summary)
    ? data.review_summary
    : isRecord(data.reviewSummary)
      ? data.reviewSummary
      : null
  const iterationRaw = normalizeNumber(data.iteration ?? 0)
  const iterationCycleRaw = normalizeNumber(data.iteration_cycle ?? data.iterationCycle ?? 0)
  const iteration = iterationRaw > 0 ? iterationRaw : null
  const iterationCycle = iterationCycleRaw > 0 ? iterationCycleRaw : null
  return {
    workflowName,
    workflowNamespace,
    repository,
    issueNumber,
    branch,
    prompt,
    prNumber: Number.isFinite(prNumber) && prNumber > 0 ? prNumber : null,
    prUrl,
    headSha,
    stage,
    iteration,
    iterationCycle,
    reviewStatus,
    reviewSummary,
    notifyPayload: data,
  }
}

const parseRepositoryParts = (repository: string) => {
  const [owner, repo] = repository.split('/')
  if (!owner || !repo) {
    throw new Error(`invalid repository value: ${repository}`)
  }
  return { owner, repo }
}

const UNKNOWN_REPOSITORY = 'unknown/unknown'
const UNKNOWN_BRANCH = 'unknown'

const hasRequiredRunMetadata = (run: Pick<CodexRunRecord, 'repository' | 'issueNumber' | 'branch'>) => {
  if (!run.repository || !run.branch) return false
  if (run.repository === UNKNOWN_REPOSITORY || run.branch === UNKNOWN_BRANCH) return false
  if (!Number.isFinite(run.issueNumber) || run.issueNumber <= 0) return false
  try {
    parseRepositoryParts(run.repository)
    return true
  } catch {
    return false
  }
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

const getArtifactBucket = () => config.workflowArtifactsBucket
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const MAX_LOG_CHARS = 20_000

const FALLBACK_ARTIFACTS = [
  { name: 'implementation-changes', path: '.codex-implementation-changes.tar.gz' },
  { name: 'implementation-patch', path: '.codex-implementation.patch' },
  { name: 'implementation-status', path: '.codex-implementation-status.txt' },
  { name: 'implementation-log', path: '.codex-implementation.log' },
  { name: 'implementation-events', path: '.codex/implementation-events.jsonl' },
  { name: 'implementation-agent-log', path: '.codex-implementation-agent.log' },
  { name: 'implementation-runtime-log', path: '.codex-implementation-runtime.log' },
  { name: 'implementation-resume', path: '.codex/implementation-resume.json' },
  { name: 'implementation-notify', path: '.codex-implementation-notify.json' },
]

const ARTIFACT_TEXT_HINTS: Record<string, string[]> = {
  'implementation-log': ['.codex-implementation.log', 'codex-implementation.log'],
  'implementation-events': [
    '.codex/implementation-events.jsonl',
    '.codex-implementation-events.jsonl',
    'codex-implementation-events.jsonl',
  ],
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

const addParam = (params: Record<string, string>, key: string, value: unknown) => {
  if (value == null) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      params[key] = trimmed
    }
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    params[key] = String(value)
    return
  }
  if (typeof value === 'boolean') {
    params[key] = value ? 'true' : 'false'
    return
  }
  params[key] = JSON.stringify(value)
}

const addParamAlias = (params: Record<string, string>, keys: string[], value: unknown) => {
  for (const key of keys) {
    addParam(params, key, value)
  }
}

const buildCodexParameters = (input: {
  repository?: string | null
  issueNumber?: number | string | null
  base?: string | null
  head?: string | null
  prompt?: string | null
  judgePrompt?: string | null
  attempt?: number | string | null
  parentRunUid?: string | null
  iterationCycle?: number | string | null
  iterationsCount?: number | string | null
  resumeKey?: string | null
  changesKey?: string | null
}) => {
  const params: Record<string, string> = {}
  addParam(params, 'repository', input.repository)
  addParamAlias(params, ['issueNumber', 'issue_number'], input.issueNumber)
  addParam(params, 'base', input.base)
  addParam(params, 'head', input.head)
  addParam(params, 'prompt', input.prompt)
  addParamAlias(params, ['judgePrompt', 'judge_prompt'], input.judgePrompt)
  addParam(params, 'attempt', input.attempt)
  addParamAlias(params, ['parentRunUid', 'parent_run_uid'], input.parentRunUid)
  addParamAlias(params, ['iterationCycle', 'iteration_cycle'], input.iterationCycle)
  addParamAlias(params, ['implementationIterations', 'implementation_iterations'], input.iterationsCount)
  addParamAlias(params, ['implementationResumeKey', 'implementation_resume_key'], input.resumeKey)
  addParamAlias(params, ['implementationChangesKey', 'implementation_changes_key'], input.changesKey)
  return params
}

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

const buildFallbackArtifactEntries = (workflowName: string, bucket: string): ResolvedArtifact[] => {
  const baseKey = `${workflowName}/${workflowName}`
  return FALLBACK_ARTIFACTS.map((artifact) => ({
    name: artifact.name,
    key: `${baseKey}/${artifact.path}`,
    bucket,
    url: null,
    metadata: { source: 'static' },
  }))
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
  const workflowNamespace = run.workflowNamespace ?? config.workflowNamespace ?? null
  const artifactBucket = getArtifactBucket()

  const artifactMap = new Map<string, ResolvedArtifact>()
  for (const artifact of buildFallbackArtifactEntries(workflowName, artifactBucket)) {
    addArtifactEntry(artifactMap, artifact)
  }

  if (artifactsOverride && artifactsOverride.length > 0) {
    for (const artifact of artifactsOverride) {
      addArtifactEntry(artifactMap, {
        name: artifact.name,
        key: artifact.key,
        bucket: artifact.bucket ?? artifactBucket,
        url: artifact.url ?? null,
        metadata: { ...(artifact.metadata ?? {}), source: 'run-complete' },
      })
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
        bucket: artifact.bucket ?? artifactBucket,
        url: artifact.url,
        metadata: artifact.metadata,
      })),
  })

  return resolved
}

const normalizeShaValue = (value: string | null | undefined) => value?.trim().toLowerCase() ?? ''

const matchesCommitSha = (expected: string | null | undefined, actual: string | null | undefined) => {
  if (!expected || !actual) return true
  const expectedValue = normalizeShaValue(expected)
  const actualValue = normalizeShaValue(actual)
  if (!expectedValue || !actualValue) return true
  return expectedValue === actualValue || expectedValue.startsWith(actualValue) || actualValue.startsWith(expectedValue)
}

const fetchCiStatus = async (run: CodexRunRecord, commitSha?: string | null) => {
  const githubClient = getGithub()
  const { owner, repo } = parseRepositoryParts(run.repository)
  const sha = commitSha ?? run.commitSha
  if (!sha) return { status: 'pending' as const, url: undefined }
  try {
    return await githubClient.getCheckRuns(owner, repo, sha)
  } catch (error) {
    console.warn('Failed to fetch CI check runs', { repository: run.repository, sha, error })
    return { status: 'pending' as const, url: undefined }
  }
}

const resolveCiContext = async (run: CodexRunRecord, pr: PullRequest | null) => {
  const prSha = pr?.headSha ?? null
  const artifactSha = prSha ? null : extractCommitShaFromRun(run)
  const existingSha = prSha ? null : run.commitSha
  const commitSha = prSha ?? artifactSha ?? existingSha ?? null

  if (!getConfig().ciEventStreamEnabled) {
    const ci = await fetchCiStatus(run, commitSha)
    return { commitSha, ci, updatedRun: null as CodexRunRecord | null }
  }

  const commitChanged = Boolean(commitSha && run.commitSha && !matchesCommitSha(commitSha, run.commitSha))
  const status = commitChanged ? 'pending' : (run.ciStatus ?? 'pending')
  const url = commitChanged ? undefined : (run.ciUrl ?? undefined)
  let updatedRun: CodexRunRecord | null = null

  if (commitSha && (commitChanged || !run.commitSha || !run.ciStatus)) {
    updatedRun =
      (await getStore().updateCiStatus({
        runId: run.id,
        status,
        url,
        commitSha,
      })) ?? null
  }

  return { commitSha, ci: { status, url }, updatedRun }
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
  const raw = (payload.logs as Record<string, unknown> | undefined) ?? payload.log_excerpt
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

type GithubWebhookStreamEvent = {
  event: string
  action: string | null
  deliveryId: string | null
  repository: string | null
  sender: string | null
  payload: Record<string, unknown>
}

const SUPPORTED_GITHUB_STREAM_EVENTS = new Set([
  'check_run',
  'check_suite',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
])

const normalizeOptionalNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const extractRepositoryFromWebhookPayload = (payload: Record<string, unknown>) => {
  if (isRecord(payload.repository)) {
    const fullName = payload.repository.full_name
    if (typeof fullName === 'string' && fullName.trim().length > 0) return fullName.trim()
  }
  if (
    isRecord(payload.pull_request) &&
    isRecord(payload.pull_request.base) &&
    isRecord(payload.pull_request.base.repo)
  ) {
    const fullName = payload.pull_request.base.repo.full_name
    if (typeof fullName === 'string' && fullName.trim().length > 0) return fullName.trim()
  }
  if (isRecord(payload.issue) && typeof payload.issue.repository_url === 'string') {
    try {
      const parsed = new URL(payload.issue.repository_url)
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (segments.length >= 2) {
        const owner = segments[segments.length - 2]
        const repo = segments[segments.length - 1]
        if (owner && repo) return `${owner}/${repo}`
      }
    } catch {
      return null
    }
  }
  return null
}

const extractSenderLogin = (payload: Record<string, unknown>) => {
  if (isRecord(payload.sender) && typeof payload.sender.login === 'string') {
    return payload.sender.login.trim() || null
  }
  return null
}

const parseGithubWebhookEvent = (payload: Record<string, unknown>): GithubWebhookStreamEvent => {
  const rawPayload = isRecord(payload.payload) ? payload.payload : payload
  const event =
    normalizeOptionalString(
      payload.event ?? payload.event_type ?? payload.eventType ?? payload.name ?? payload['x-github-event'],
    ) ?? ''
  const action =
    normalizeOptionalString(
      payload.action ?? payload.event_action ?? payload.eventAction ?? payload['x-github-action'],
    ) ?? null
  const deliveryId =
    normalizeOptionalString(
      payload.deliveryId ?? payload.delivery_id ?? payload['x-github-delivery'] ?? payload.id ?? payload.key,
    ) ?? null
  const repository =
    normalizeOptionalString(payload.repository) ??
    normalizeOptionalString(payload.repository_full_name) ??
    extractRepositoryFromWebhookPayload(rawPayload)
  const sender = normalizeOptionalString(payload.sender) ?? extractSenderLogin(rawPayload)

  return {
    event,
    action,
    deliveryId,
    repository,
    sender,
    payload: rawPayload,
  }
}

const extractPullRequestInfo = (payload: Record<string, unknown>) => {
  const pr = isRecord(payload.pull_request) ? payload.pull_request : null
  if (!pr) {
    return { number: null, url: null, headSha: null, headRef: null }
  }
  const number = normalizeOptionalNumber(pr.number)
  const url = normalizeOptionalString(pr.html_url ?? pr.url)
  const head = isRecord(pr.head) ? pr.head : null
  const headSha = head ? normalizeSha(head.sha) : null
  const headRef = head && typeof head.ref === 'string' ? head.ref.trim() || null : null
  return { number, url, headSha, headRef }
}

const extractCheckPayload = (payload: Record<string, unknown>) => {
  if (isRecord(payload.check_run)) return payload.check_run
  if (isRecord(payload.check_suite)) return payload.check_suite
  return null
}

const extractCheckPullRequests = (check: Record<string, unknown>) => {
  const pullRequests = Array.isArray(check.pull_requests) ? check.pull_requests : []
  return pullRequests
    .map((entry) => (isRecord(entry) ? normalizeOptionalNumber(entry.number) : null))
    .filter((value): value is number => value != null)
}

const deriveCiStatus = (status: string | null, conclusion: string | null) => {
  const normalizedStatus = status?.trim().toLowerCase() ?? ''
  if (normalizedStatus !== 'completed') return 'pending'
  const normalizedConclusion = conclusion?.trim().toLowerCase() ?? ''
  if (!normalizedConclusion) return 'pending'
  if (normalizedConclusion === 'success' || normalizedConclusion === 'skipped') return 'success'
  return 'failure'
}

const shouldRefreshReviewForPullRequest = (action: string | null) => {
  const normalized = action?.trim().toLowerCase() ?? ''
  return ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft'].includes(normalized)
}

const dedupeRuns = (runs: CodexRunRecord[]) => {
  const seen = new Map<string, CodexRunRecord>()
  for (const run of runs) {
    if (!seen.has(run.id)) {
      seen.set(run.id, run)
    }
  }
  return [...seen.values()]
}

const shouldTriggerEvaluation = (run: CodexRunRecord) => !isTerminalStatus(run.status) && run.status !== 'superseded'

const scheduleEvaluationForRun = (runId: string) => scheduleEvaluation(runId, 1000, { reschedule: true })

const fetchReviewSummaryForRepository = async (repository: string, prNumber: number) => {
  const { owner, repo } = parseRepositoryParts(repository)
  const reviewers = getConfig().codexReviewers.map((value) => value.toLowerCase())
  return getGithub().getReviewSummary(owner, repo, prNumber, reviewers)
}

const fetchCheckRunSummaryForRepository = async (repository: string, commitSha: string) => {
  const { owner, repo } = parseRepositoryParts(repository)
  return getGithub().getCheckRuns(owner, repo, commitSha)
}

const resolveRunsForCommitOrPr = async (
  repository: string,
  commitSha: string | null,
  prNumbers: number[],
): Promise<CodexRunRecord[]> => {
  if (!repository) return []
  const activeStore = getStore()
  let runs: CodexRunRecord[] = []
  if (commitSha) {
    runs = await activeStore.listRunsByCommitSha(repository, commitSha)
  }
  if (runs.length === 0 && prNumbers.length > 0) {
    const collected: CodexRunRecord[] = []
    for (const prNumber of prNumbers) {
      const prRuns = await activeStore.listRunsByPrNumber(repository, prNumber)
      collected.push(...prRuns)
    }
    runs = collected
  }
  return dedupeRuns(runs)
}

const handleCheckStreamEvent = async (event: GithubWebhookStreamEvent) => {
  const repository = event.repository
  if (!repository) return { updatedRunIds: [] as string[], status: null as string | null }
  const checkPayload = extractCheckPayload(event.payload)
  if (!checkPayload) return { updatedRunIds: [] as string[], status: null as string | null }

  const activeStore = getStore()
  const commitSha = normalizeSha(checkPayload.head_sha ?? checkPayload.headSha)
  const status = normalizeOptionalString(checkPayload.status)
  const conclusion = normalizeOptionalString(checkPayload.conclusion)
  const url = normalizeOptionalString(checkPayload.html_url ?? checkPayload.details_url ?? checkPayload.url)
  const prNumbers = extractCheckPullRequests(checkPayload)

  const normalizedAction = event.action?.trim().toLowerCase() ?? ''
  const isCompleted = normalizedAction === 'completed' || status?.trim().toLowerCase() === 'completed'

  let ciStatus = deriveCiStatus(status, conclusion)
  let ciUrl = url ?? undefined

  if (isCompleted && commitSha) {
    try {
      const summary = await fetchCheckRunSummaryForRepository(repository, commitSha)
      ciStatus = summary.status
      ciUrl = summary.url ?? ciUrl
    } catch (error) {
      console.warn('Failed to fetch aggregated check runs for CI status', { repository, commitSha, error })
    }
  }

  const runs = await resolveRunsForCommitOrPr(repository, commitSha, prNumbers)
  const updatedRunIds = new Set<string>()
  for (const run of runs) {
    if (!shouldTriggerEvaluation(run)) continue
    const commitChanged = Boolean(commitSha && run.commitSha && !matchesCommitSha(commitSha, run.commitSha))
    if (ciStatus === 'pending' && run.ciStatus && run.ciStatus !== 'pending' && !commitChanged) {
      continue
    }
    const updated = await activeStore.updateCiStatus({
      runId: run.id,
      status: ciStatus,
      url: ciUrl,
      commitSha,
    })
    if (updated) {
      updatedRunIds.add(updated.id)
      scheduleEvaluationForRun(updated.id)
    }
  }

  return { updatedRunIds: [...updatedRunIds], status: ciStatus }
}

const handlePullRequestStreamEvent = async (event: GithubWebhookStreamEvent) => {
  const repository = event.repository
  if (!repository) return { updatedRunIds: [] as string[] }
  const prInfo = extractPullRequestInfo(event.payload)
  if (!prInfo.number) return { updatedRunIds: [] as string[] }

  const activeStore = getStore()
  let runs: CodexRunRecord[] = []
  if (prInfo.headRef) {
    runs = await activeStore.listRunsByBranch(repository, prInfo.headRef)
  }
  if (runs.length === 0 && prInfo.headSha) {
    runs = await activeStore.listRunsByCommitSha(repository, prInfo.headSha)
  }
  runs = dedupeRuns(runs)
  if (runs.length === 0) return { updatedRunIds: [] as string[] }

  const prUrl = prInfo.url ?? `https://github.com/${repository}/pull/${prInfo.number}`
  const updatedRunIds = new Set<string>()
  for (const run of runs) {
    if (!shouldTriggerEvaluation(run)) continue
    const updated = await activeStore.updateRunPrInfo(run.id, prInfo.number, prUrl, prInfo.headSha)
    if (updated) {
      updatedRunIds.add(updated.id)
      scheduleEvaluationForRun(updated.id)
    }
  }

  if (shouldRefreshReviewForPullRequest(event.action)) {
    try {
      const review = await fetchReviewSummaryForRepository(repository, prInfo.number)
      const reviewSummary = {
        unresolvedThreads: review.unresolvedThreads,
        requestedChanges: review.requestedChanges,
        reviewComments: review.reviewComments,
        issueComments: review.issueComments,
      }
      for (const run of runs) {
        if (!shouldTriggerEvaluation(run)) continue
        const updated = await activeStore.updateReviewStatus({
          runId: run.id,
          status: review.status,
          summary: reviewSummary,
        })
        if (updated) {
          updatedRunIds.add(updated.id)
          scheduleEvaluationForRun(updated.id)
        }
      }
    } catch (error) {
      console.warn('Failed to refresh review summary from pull request event', {
        repository,
        prNumber: prInfo.number,
        error,
      })
    }
  }

  return { updatedRunIds: [...updatedRunIds] }
}

const isPullRequestIssueComment = (payload: Record<string, unknown>) => {
  if (!isRecord(payload.issue)) return false
  return Boolean(payload.issue.pull_request)
}

const extractIssueCommentPrNumber = (payload: Record<string, unknown>) => {
  if (!isRecord(payload.issue)) return null
  return normalizeOptionalNumber(payload.issue.number)
}

const handleReviewStreamEvent = async (event: GithubWebhookStreamEvent) => {
  const repository = event.repository
  if (!repository) return { updatedRunIds: [] as string[] }

  if (event.event === 'issue_comment' && !isPullRequestIssueComment(event.payload)) {
    return { updatedRunIds: [] as string[] }
  }

  const prInfo = extractPullRequestInfo(event.payload)
  const prNumber = prInfo.number ?? extractIssueCommentPrNumber(event.payload)
  if (!prNumber) return { updatedRunIds: [] as string[] }

  const activeStore = getStore()
  let runs = await activeStore.listRunsByPrNumber(repository, prNumber)
  if (runs.length === 0 && prInfo.headRef) {
    runs = await activeStore.listRunsByBranch(repository, prInfo.headRef)
  }
  if (runs.length === 0 && prInfo.headSha) {
    runs = await activeStore.listRunsByCommitSha(repository, prInfo.headSha)
  }
  runs = dedupeRuns(runs)
  if (runs.length === 0) return { updatedRunIds: [] as string[] }

  const prUrl = prInfo.url ?? `https://github.com/${repository}/pull/${prNumber}`
  const updatedRunIds = new Set<string>()
  for (const run of runs) {
    if (!shouldTriggerEvaluation(run)) continue
    const updated = await activeStore.updateRunPrInfo(run.id, prNumber, prUrl, prInfo.headSha)
    if (updated) {
      updatedRunIds.add(updated.id)
      scheduleEvaluationForRun(updated.id)
    }
  }

  try {
    const review = await fetchReviewSummaryForRepository(repository, prNumber)
    const reviewSummary = {
      unresolvedThreads: review.unresolvedThreads,
      requestedChanges: review.requestedChanges,
      reviewComments: review.reviewComments,
      issueComments: review.issueComments,
    }
    for (const run of runs) {
      if (!shouldTriggerEvaluation(run)) continue
      const updated = await activeStore.updateReviewStatus({
        runId: run.id,
        status: review.status,
        summary: reviewSummary,
      })
      if (updated) {
        updatedRunIds.add(updated.id)
        scheduleEvaluationForRun(updated.id)
      }
    }
  } catch (error) {
    console.warn('Failed to refresh review summary from webhook event', { repository, prNumber, error })
  }

  return { updatedRunIds: [...updatedRunIds] }
}

export const handleGithubWebhookEvent = async (payload: Record<string, unknown>) => {
  if (!getConfig().ciEventStreamEnabled) {
    return { ok: false, reason: 'event_stream_disabled' }
  }

  await ensureStoreReady()
  const parsed = parseGithubWebhookEvent(payload)
  if (!parsed.event || !SUPPORTED_GITHUB_STREAM_EVENTS.has(parsed.event)) {
    return { ok: false, reason: 'unsupported_event', event: parsed.event || null }
  }

  const receivedAt =
    normalizeOptionalString(payload.receivedAt ?? payload.received_at) ??
    normalizeOptionalString((payload.payload as Record<string, unknown> | undefined)?.receivedAt) ??
    normalizeOptionalString((payload.payload as Record<string, unknown> | undefined)?.received_at) ??
    null
  const reviewIngest = await ingestGithubReviewEvent({
    ...parsed,
    receivedAt,
  })

  if (parsed.event === 'check_run' || parsed.event === 'check_suite') {
    const result = await handleCheckStreamEvent(parsed)
    return { ok: true, event: parsed.event, action: parsed.action, reviewIngest, ...result }
  }

  if (parsed.event === 'pull_request') {
    const result = await handlePullRequestStreamEvent(parsed)
    return { ok: true, event: parsed.event, action: parsed.action, reviewIngest, ...result }
  }

  const result = await handleReviewStreamEvent(parsed)
  return { ok: true, event: parsed.event, action: parsed.action, reviewIngest, ...result }
}

type MinioConfig = {
  endpoint: string
  accessKey: string
  secretKey: string
  region: string
}

const normalizeMinioEndpoint = (endpoint: string, secure: boolean) => {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  return `http${secure ? 's' : ''}://${endpoint}`
}

const resolveMinioConfig = (): MinioConfig | null => {
  const endpointRaw = (process.env.MINIO_ENDPOINT ?? '').trim()
  const accessKey = (process.env.MINIO_ACCESS_KEY ?? '').trim()
  const secretKey = (process.env.MINIO_SECRET_KEY ?? '').trim()
  if (!endpointRaw || !accessKey || !secretKey) return null
  const secureRaw = (process.env.MINIO_SECURE ?? '').trim().toLowerCase()
  const secure = secureRaw === 'true' || secureRaw === '1'
  const endpoint = normalizeMinioEndpoint(endpointRaw, secure)
  return {
    endpoint,
    accessKey,
    secretKey,
    region: 'us-east-1',
  }
}

const minioClientCache = (() => {
  let cachedKey: string | null = null
  let cachedClient: S3Client | null = null
  return (config: MinioConfig) => {
    const cacheKey = `${config.endpoint}:${config.accessKey}:${config.secretKey}:${config.region}`
    if (cachedClient && cachedKey === cacheKey) return cachedClient
    cachedKey = cacheKey
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    })
    return cachedClient
  }
})()

const buildArtifactSignedUrl = async (artifact: ResolvedArtifact) => {
  if (!artifact.bucket || !artifact.key) return null
  const config = resolveMinioConfig()
  if (!config) return null
  try {
    const client = minioClientCache(config)
    const command = new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.key })
    return await getSignedUrl(client, command, { expiresIn: 60 })
  } catch {
    return null
  }
}

const fetchUrlBuffer = async (url: string, maxBytes: number) => {
  try {
    const response = await fetch(url)
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

const fetchArtifactBuffer = async (artifact: ResolvedArtifact, maxBytes = MAX_ARTIFACT_BYTES) => {
  const urlBuffer = artifact.url ? await fetchUrlBuffer(artifact.url, maxBytes) : null
  if (urlBuffer) return urlBuffer
  const signedUrl = await buildArtifactSignedUrl(artifact)
  if (!signedUrl) return null
  return fetchUrlBuffer(signedUrl, maxBytes)
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

const toResolvedArtifact = (artifact: CodexArtifactRecord): ResolvedArtifact => ({
  name: artifact.name,
  key: artifact.key,
  bucket: artifact.bucket,
  url: artifact.url,
  metadata: artifact.metadata ?? {},
})

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

const extractJudgeOutputFromArtifacts = async (artifacts: ResolvedArtifact[]) => {
  const artifact = buildArtifactIndex(artifacts).get('judge-output')
  if (!artifact) return null
  const text = await fetchArtifactText(artifact)
  if (!text) return null
  const parsed = safeParseJson(text)
  return isRecord(parsed) ? parsed : null
}

const resolveCommitSha = async (run: CodexRunRecord, fallbackCommitSha: string | null) => {
  if (run.commitSha) return run.commitSha
  const commitSha = fallbackCommitSha ?? null
  if (commitSha) {
    await store.updateCiStatus({ runId: run.id, status: run.ciStatus ?? 'pending', commitSha })
    return commitSha
  }
  return null
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

    const inserted = await agentStore.insertMessages(records)
    if (inserted.length > 0) {
      publishAgentMessages(inserted)
    }
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

const UNKNOWN_FAILURE_REASON = 'unknown_failure'

const resolveFailureReason = (reason: string | null | undefined, evaluation?: CodexEvaluationRecord) => {
  const reasons = evaluation?.reasons as Record<string, unknown> | undefined
  const error = typeof reasons?.error === 'string' ? reasons.error : null
  if (error) return error
  if (reason) return reason
  if (evaluation && evaluation.decision !== 'pass') return 'judge_failed'
  return null
}

const recordDecision = async (
  input: UpdateDecisionInput,
  run?: CodexRunRecord | null,
): Promise<CodexEvaluationRecord> => {
  const evaluation = await store.updateDecision(input)
  if (input.decision !== 'needs_iteration' && input.decision !== 'needs_human') {
    return evaluation
  }

  const resolvedRun = run ?? (await store.getRunById(input.runId))
  if (!resolvedRun) return evaluation

  const failureReason = resolveFailureReason(null, evaluation) ?? UNKNOWN_FAILURE_REASON
  const submission = await maybeSubmitSystemImprovementWorkflow(resolvedRun, failureReason, evaluation)
  if (!isTestEnv && !submission.submitted) {
    const updated = await store.updateRunStatus(resolvedRun.id, 'needs_human')
    if (updated) {
      await sendDiscordEscalation(resolvedRun, 'system_improvement_failed')
    }
  }

  return evaluation
}

const evaluateRun = async (runId: string) => {
  await ensureStoreReady()
  if (activeEvaluations.has(runId)) return
  activeEvaluations.add(runId)

  try {
    const run = await store.getRunById(runId)
    if (!run) return

    if (isTerminalStatus(run.status) || run.status === 'superseded') return

    if (!hasRequiredRunMetadata(run)) {
      const evaluation = await recordDecision({
        runId: run.id,
        decision: 'needs_human',
        reasons: {
          error: 'missing_run_metadata',
          repository: run.repository,
          issue_number: run.issueNumber,
          branch: run.branch,
        },
        suggestedFixes: {
          fix: 'Ensure the workflow metadata includes repository, issue number, and head branch.',
        },
        nextPrompt: null,
        promptTuning: {},
        systemSuggestions: {
          suggestions: ['Attach codex repository/issue/head/base metadata to workflow labels or annotations.'],
        },
      })
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      return
    }

    const notifyStage = typeof run.notifyPayload?.stage === 'string' ? run.notifyPayload.stage : null
    const isJudgeStage = run.stage === 'judge' || run.runCompletePayload?.stage === 'judge' || notifyStage === 'judge'

    await store.updateRunPrompt(run.id, run.prompt, run.nextPrompt)

    if (!isJudgeStage) {
      return
    }

    let artifactJudgeOutput: Record<string, unknown> | null = null
    try {
      const artifactRecords = await store.listArtifactsForRun(run.id)
      if (artifactRecords.length > 0) {
        const artifacts = artifactRecords.map((artifact) => toResolvedArtifact(artifact))
        artifactJudgeOutput = await extractJudgeOutputFromArtifacts(artifacts)
      }
    } catch (error) {
      console.warn('Failed to load judge output from artifacts', error)
    }

    const notifyJudgeOutput = (run.notifyPayload?.judge_output as Record<string, unknown> | undefined) ?? null
    const notifyMessage = run.notifyPayload?.last_assistant_message as string | null
    const parsedFromMessage = notifyMessage ? safeParseJson(notifyMessage) : null
    const resolvedArtifactJudgeOutput =
      artifactJudgeOutput && Object.keys(artifactJudgeOutput).length > 0 ? artifactJudgeOutput : null
    const judgeOutput = resolvedArtifactJudgeOutput ?? notifyJudgeOutput ?? parsedFromMessage ?? {}

    if (Object.keys(judgeOutput).length === 0) {
      const evaluation = await recordDecision(
        {
          runId: run.id,
          decision: 'needs_iteration',
          reasons: { error: 'infra_failure', detail: 'missing_judge_output' },
          suggestedFixes: { fix: 'Ensure judge output JSON is persisted in run-complete artifacts.' },
          nextPrompt: 'Judge output missing. Re-run judge and emit JSON output.',
          promptTuning: {},
          systemSuggestions: {},
        },
        run,
      )
      const refreshedRun = (await store.getRunById(run.id)) ?? run
      await writeMemories(refreshedRun, evaluation)
      return
    }

    const decisionRaw = typeof judgeOutput.decision === 'string' ? judgeOutput.decision : 'fail'
    const decision = normalizeJudgeDecision(decisionRaw)
    const nextPrompt = typeof judgeOutput.next_prompt === 'string' ? judgeOutput.next_prompt : null

    const evaluation = await recordDecision(
      {
        runId: run.id,
        decision: decision === 'pass' ? 'pass' : 'needs_iteration',
        confidence: typeof judgeOutput.confidence === 'number' ? judgeOutput.confidence : null,
        reasons: { requirements_coverage: judgeOutput.requirements_coverage ?? [], decision },
        missingItems: { missing_items: judgeOutput.missing_items ?? [] },
        suggestedFixes: { suggested_fixes: judgeOutput.suggested_fixes ?? [] },
        nextPrompt,
        promptTuning: { suggestions: judgeOutput.prompt_tuning_suggestions ?? [] },
        systemSuggestions: { suggestions: judgeOutput.system_improvement_suggestions ?? [] },
      },
      run,
    )

    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
  } catch (error) {
    if (isGitHubRateLimitError(error)) {
      const now = Date.now()
      const retryAt = typeof error.retryAt === 'number' ? error.retryAt : now + 60_000
      const delayMs = Math.max(retryAt - now, 5_000)
      console.warn('GitHub rate limit exceeded; delaying Codex judge evaluation', {
        runId,
        delayMs,
        retryAt: new Date(retryAt).toISOString(),
      })
      scheduleEvaluation(runId, delayMs, { reschedule: true })
      return
    }
    console.error('Failed to evaluate Codex run', { runId, error })
  } finally {
    activeEvaluations.delete(runId)
  }
}

const extractSystemSuggestions = (evaluation?: CodexEvaluationRecord) => {
  if (!evaluation?.systemSuggestions) return []
  const raw = evaluation.systemSuggestions as Record<string, unknown>
  const suggestions: string[] = []

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') suggestions.push(entry)
    }
  }

  const nested = raw?.suggestions
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      if (typeof entry === 'string') suggestions.push(entry)
    }
  }

  if (typeof raw?.summary === 'string') suggestions.push(raw.summary)
  if (typeof raw?.notes === 'string') suggestions.push(raw.notes)

  if (suggestions.length === 0) {
    suggestions.push(JSON.stringify(raw, null, 2))
  }

  return suggestions.filter((value) => value.trim().length > 0)
}

const buildSystemImprovementLinks = (run: CodexRunRecord) => {
  const links: string[] = []
  if (run.repository && run.issueNumber) {
    links.push(`Issue: https://github.com/${run.repository}/issues/${run.issueNumber}`)
  }
  if (run.prUrl) {
    links.push(`PR: ${run.prUrl}`)
  }
  if (run.ciUrl) {
    links.push(`CI: ${run.ciUrl}`)
  }
  return links
}

const buildSystemImprovementPrompt = (
  run: CodexRunRecord,
  reason: string | null,
  evaluation?: CodexEvaluationRecord,
) => {
  const failureReason = reason ?? 'unknown'
  const suggestions = extractSystemSuggestions(evaluation)
  const links = buildSystemImprovementLinks(run)
  const nextPrompt = evaluation?.nextPrompt ?? run.nextPrompt ?? ''
  const suggestedFixes = evaluation?.suggestedFixes ?? {}
  const reasons = evaluation?.reasons ?? {}
  const missingItems = evaluation?.missingItems ?? {}
  const systemSuggestions =
    suggestions.length > 0
      ? suggestions
      : [
          `Investigate and resolve the failure reason (${failureReason}).`,
          'Review run artifacts/logs to identify missing or flaky steps and harden the pipeline.',
          'Add validation or automated checks to prevent recurrence.',
        ]

  return [
    'You are Codex operating on system improvements for the autonomous pipeline.',
    '',
    'Run context:',
    `- Run id: ${run.id}`,
    `- Repository: ${run.repository}`,
    `- Issue: #${run.issueNumber}`,
    `- Branch: ${run.branch}`,
    `- Stage: ${run.stage ?? 'unknown'}`,
    `- Attempt: ${run.attempt}`,
    `- Failure reason: ${failureReason}`,
    run.workflowName ? `- Workflow: ${run.workflowName}` : null,
    run.workflowNamespace ? `- Workflow namespace: ${run.workflowNamespace}` : null,
    '',
    'Run links:',
    links.length > 0 ? links.map((entry) => `- ${entry}`).join('\n') : '- n/a',
    '',
    'Requirements:',
    '- Implement real code/config improvements (no doc-only placeholders).',
    '- Keep changes additive and composable with existing design.',
    '- Update manifests, scripts, and services as needed to make the pipeline reliable.',
    '- Add tests or validation steps where applicable.',
    '',
    'Failure context:',
    `Reasons: ${JSON.stringify(reasons, null, 2)}`,
    `Missing items: ${JSON.stringify(missingItems, null, 2)}`,
    `Suggested fixes: ${JSON.stringify(suggestedFixes, null, 2)}`,
    '',
    'System suggestions:',
    systemSuggestions.map((entry) => `- ${entry}`).join('\n'),
    '',
    nextPrompt ? `Prior next_prompt: ${nextPrompt}` : 'Prior next_prompt: n/a',
    '',
    'Validation plan:',
    '- Re-run the failing step(s) with the same inputs and confirm the failure is resolved.',
    '- Run the smallest relevant linters/tests for the changed components.',
    '- Confirm the full autonomous pipeline (gate → merge → verify) passes end-to-end.',
    '',
    'Rollback steps:',
    '- Revert the system-improvement PR or roll back the GitOps revision.',
    '- Confirm the rollback restores the prior healthy workflow behavior.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

const maybeSubmitSystemImprovementWorkflow = async (
  run: CodexRunRecord,
  reason: string | null,
  evaluation?: CodexEvaluationRecord,
): Promise<{ submitted: boolean; error?: string }> => {
  const baseRef =
    typeof run.runCompletePayload?.base === 'string' && run.runCompletePayload.base.trim().length > 0
      ? run.runCompletePayload.base.trim()
      : 'main'
  const branch = `codex/system-improvement-${run.issueNumber}-${run.id.slice(0, 8)}`
  const prompt = buildSystemImprovementPrompt(run, reason, evaluation)
  const orchestrationName = config.systemImprovementOrchestrationName
  if (orchestrationName) {
    const submitter = resolveOrchestrationSubmit()
    const deliveryId = `codex-system-improvement-${run.id}`
    const parameters = buildCodexParameters({
      repository: run.repository,
      issueNumber: run.issueNumber,
      base: baseRef,
      head: branch,
      prompt,
      judgePrompt: config.systemImprovementJudgePrompt,
      parentRunUid: run.workflowUid ?? run.id,
    })
    try {
      await submitter({
        deliveryId,
        orchestrationRef: { name: orchestrationName },
        namespace: config.systemImprovementOrchestrationNamespace,
        parameters,
      })
      return { submitted: true }
    } catch (error) {
      console.warn('Failed to submit system improvement orchestration', error)
      return { submitted: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return { submitted: false, error: 'system_improvement_orchestration_unconfigured' }
}

const shouldDelayRerun = (submissionAttempt: number, updatedAt: string | null) => {
  const delayIndex = Math.min(Math.max(submissionAttempt, 0), RERUN_SUBMISSION_BACKOFF_MS.length - 1)
  const delayMs = RERUN_SUBMISSION_BACKOFF_MS[delayIndex] ?? 0
  if (delayMs <= 0) return false
  const updatedMs = updatedAt ? Date.parse(updatedAt) : null
  if (!updatedMs || Number.isNaN(updatedMs)) return false
  return Date.now() - updatedMs < delayMs
}

const processRerunQueue = async () => {
  await ensureStoreReady()
  const submissions = await store.listRerunSubmissions({
    statuses: ['queued', 'failed'],
    limit: RERUN_WORKER_BATCH_SIZE,
  })
  for (const submission of submissions) {
    if (shouldDelayRerun(submission.submissionAttempt, submission.updatedAt)) continue
    const run = await store.getRunById(submission.parentRunId)
    if (!run) continue
    const prompt = run.nextPrompt ?? run.prompt
    if (!prompt) continue
    const result = await submitRerun(run, prompt, submission.attempt)
    if (result.status === 'failed') {
      await recordDecision({
        runId: run.id,
        decision: 'needs_human',
        reasons: { error: 'rerun_submission_failed', detail: result.error ?? null },
        suggestedFixes: { fix: 'Check Facteur availability and requeue the rerun.' },
        nextPrompt: null,
        promptTuning: {},
        systemSuggestions: {},
      })
      const updated = await store.updateRunStatus(run.id, 'needs_human')
      if (updated) {
        await sendDiscordEscalation(run, 'rerun_submission_failed')
      }
    }
  }
}

type RerunSubmissionResult = { status: 'submitted' | 'skipped' | 'failed'; error?: string }

const resolveResumeArtifactKeys = async (run: CodexRunRecord) => {
  try {
    const artifactRecords = await store.listArtifactsForRun(run.id)
    if (artifactRecords.length === 0) {
      return { resumeKey: null, changesKey: null }
    }
    const artifactMap = buildArtifactIndex(artifactRecords.map((artifact) => toResolvedArtifact(artifact)))
    return {
      resumeKey: artifactMap.get('implementation-resume')?.key ?? null,
      changesKey: artifactMap.get('implementation-changes')?.key ?? null,
    }
  } catch (error) {
    console.warn('Failed to resolve resume artifact keys for rerun', error)
    return { resumeKey: null, changesKey: null }
  }
}

const submitRerun = async (run: CodexRunRecord, prompt: string, attempt: number): Promise<RerunSubmissionResult> => {
  const latestRun = await store.getRunById(run.id)
  if (!latestRun || latestRun.status === 'superseded') {
    return { status: 'skipped' }
  }

  const resumeArtifacts = await resolveResumeArtifactKeys(run)

  const deliveryId = `jangar-${run.id}-attempt-${attempt}`
  const claimed = await store.claimRerunSubmission({ parentRunId: run.id, attempt, deliveryId })
  if (!claimed) {
    return { status: 'failed', error: 'rerun_submission_claim_failed' }
  }
  if (!claimed.shouldSubmit) {
    return { status: 'skipped' }
  }

  const baseRef =
    typeof run.runCompletePayload?.base === 'string' && run.runCompletePayload.base.trim().length > 0
      ? run.runCompletePayload.base.trim()
      : 'main'
  const iterationCycle =
    typeof run.iterationCycle === 'number' && Number.isFinite(run.iterationCycle)
      ? run.iterationCycle + 1
      : typeof run.runCompletePayload?.iteration_cycle === 'number' &&
          Number.isFinite(run.runCompletePayload?.iteration_cycle)
        ? Number(run.runCompletePayload?.iteration_cycle) + 1
        : 1
  const iterationsCount =
    typeof run.runCompletePayload?.iterations === 'number' && Number.isFinite(run.runCompletePayload?.iterations)
      ? Number(run.runCompletePayload?.iterations)
      : null

  const submitViaOrchestration = async () => {
    if (!config.rerunOrchestrationName) return null
    const submitter = resolveOrchestrationSubmit()
    const parameters = buildCodexParameters({
      repository: run.repository,
      issueNumber: run.issueNumber,
      base: baseRef,
      head: run.branch,
      prompt,
      judgePrompt: config.defaultJudgePrompt,
      attempt,
      parentRunUid: run.workflowUid ?? run.id,
      iterationCycle,
      iterationsCount,
      resumeKey: resumeArtifacts.resumeKey,
      changesKey: resumeArtifacts.changesKey,
    })
    try {
      await submitter({
        deliveryId,
        orchestrationRef: { name: config.rerunOrchestrationName },
        namespace: config.rerunOrchestrationNamespace,
        parameters,
      })
      await store.updateRerunSubmission({
        id: claimed.submission.id,
        status: 'submitted',
        responseStatus: 201,
        error: null,
        submittedAt: new Date().toISOString(),
      })
      return { status: 'submitted' as const }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'failed' as const, error: message }
    }
  }

  const orchestrationResult = await submitViaOrchestration()
  if (orchestrationResult?.status === 'submitted') {
    return orchestrationResult
  }
  let lastError: string | undefined =
    orchestrationResult?.status === 'failed'
      ? `Native orchestration submission failed: ${orchestrationResult.error}`
      : undefined

  const { CodexTaskSchema, CodexTaskStage, CodexIterationsPolicySchema } = await import('./proto/codex_task_pb')
  const { create, toBinary } = await import('@bufbuild/protobuf')
  const { timestampFromDate } = await import('@bufbuild/protobuf/wkt')

  const iterationsPolicy = iterationsCount
    ? create(CodexIterationsPolicySchema, { mode: 'fixed', count: iterationsCount })
    : undefined

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
    metadataVersion: 1,
    iterations: iterationsPolicy,
    iterationCycle,
  })

  const payload = toBinary(CodexTaskSchema, message)

  const maxAttempts = RERUN_SUBMISSION_BACKOFF_MS.length + 1
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

const DISCORD_MESSAGE_LIMIT = 1900
const DISCORD_ARTIFACT_PREFERENCE = [
  'implementation-log',
  'implementation-status',
  'implementation-events',
  'implementation-agent-log',
  'implementation-runtime-log',
  'implementation-changes',
  'implementation-patch',
]
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

const buildDiscordEscalationMessage = (run: CodexRunRecord, reason: string) => {
  const issueUrl = resolveIssueUrl(run)
  const resolvedPrUrl = resolvePrUrl(run)
  const resolvedCiUrl = resolveCiUrl(run)
  const artifactUrl = extractArtifactUrl(run)
  const normalizedReason = reason.trim().length > 0 ? reason.trim() : 'unknown'
  const statusLine = `⚠️ Codex needs human help for ${run.repository}#${run.issueNumber}.`
  const reasonPrefix = 'Reason: '
  const linkLines = [
    issueUrl ? `Issue: ${issueUrl}` : null,
    resolvedPrUrl ? `PR: ${resolvedPrUrl}` : null,
    resolvedCiUrl ? `CI: ${resolvedCiUrl}` : null,
    artifactUrl ? `Artifacts: ${artifactUrl}` : null,
  ].filter(Boolean) as string[]

  const buildLines = (links: string[]) => {
    const fixedLines = [statusLine, ...links]
    const fixedLength = fixedLines.join('\n').length
    const maxReason = DISCORD_MESSAGE_LIMIT - fixedLength - reasonPrefix.length - 1
    const trimmedReason = truncateDiscordText(normalizedReason, maxReason)
    return [statusLine, `${reasonPrefix}${trimmedReason || 'unknown'}`, ...links]
  }

  let lines = buildLines(linkLines)
  if (lines.join('\n').length > DISCORD_MESSAGE_LIMIT && artifactUrl) {
    lines = buildLines(linkLines.filter((line) => !line.startsWith('Artifacts:')))
  }

  const content = lines.join('\n')
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content

  const tightenedReason = truncateDiscordText(
    normalizedReason,
    Math.max(1, DISCORD_MESSAGE_LIMIT - content.length + normalizedReason.length),
  )
  return [statusLine, `${reasonPrefix}${tightenedReason || 'unknown'}`, ...linkLines]
    .join('\n')
    .slice(0, DISCORD_MESSAGE_LIMIT)
}

const sendDiscordEscalation = async (run: CodexRunRecord, reason: string) => {
  if (!config.discordBotToken || !config.discordChannelId) return
  let runForMessage = run
  try {
    const latest = await store.getRunById(run.id)
    if (latest) {
      runForMessage = latest
    }
  } catch {
    // ignore store lookup failures; fall back to provided run
  }
  const content = buildDiscordEscalationMessage(runForMessage, reason)
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
  buildFallbackArtifactEntries,
  evaluateRun,
  extractCommitShaFromArtifacts,
  fetchArtifactBuffer,
  findCommitShaInValue,
  normalizeBranchRef,
  resolveCiContext,
  processRerunQueue,
  writeMemories,
}
export const handleRunComplete = async (payload: Record<string, unknown>) => {
  await ensureStoreReady()
  const parsed = parseRunCompletePayload(payload)
  const existing =
    parsed.workflowName.length > 0 ? await store.getRunByWorkflow(parsed.workflowName, parsed.workflowNamespace) : null
  const resolvedRepository = parsed.repository || existing?.repository || UNKNOWN_REPOSITORY
  const resolvedIssueNumber =
    parsed.issueNumber > 0 ? parsed.issueNumber : existing?.issueNumber ? Number(existing.issueNumber) : 0
  const resolvedBranch = parsed.head || existing?.branch || UNKNOWN_BRANCH
  const resolvedBase =
    parsed.base ||
    (typeof existing?.runCompletePayload?.base === 'string' ? existing.runCompletePayload.base : null) ||
    null
  const resolvedPrompt = parsed.prompt ?? existing?.prompt ?? null
  const resolvedWorkflowUid = parsed.workflowUid ?? existing?.workflowUid ?? null
  const resolvedWorkflowNamespace = parsed.workflowNamespace ?? existing?.workflowNamespace ?? null
  const resolvedStage = parsed.stage ?? existing?.stage ?? null
  const resolvedTurnId = parsed.turnId ?? existing?.turnId ?? null
  const resolvedThreadId = parsed.threadId ?? existing?.threadId ?? null

  const run = await store.upsertRunComplete({
    repository: resolvedRepository,
    issueNumber: resolvedIssueNumber,
    branch: resolvedBranch,
    workflowName: parsed.workflowName,
    workflowUid: resolvedWorkflowUid,
    workflowNamespace: resolvedWorkflowNamespace,
    stage: resolvedStage,
    turnId: resolvedTurnId,
    threadId: resolvedThreadId,
    status: 'run_complete',
    phase: parsed.phase,
    iteration: parsed.iteration,
    iterationCycle: parsed.iterationCycle,
    prompt: resolvedPrompt,
    runCompletePayload: {
      ...parsed.runCompletePayload,
      issueTitle: parsed.issueTitle,
      issueBody: parsed.issueBody,
      issueUrl: parsed.issueUrl,
      base: resolvedBase,
      head: resolvedBranch,
      repository: resolvedRepository,
      issueNumber: resolvedIssueNumber,
      turnId: resolvedTurnId,
      threadId: resolvedThreadId,
      iteration: parsed.iteration,
      iteration_cycle: parsed.iterationCycle,
      iterations: parsed.iterations,
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

const parseRerunPayload = (payload: Record<string, unknown>) => {
  const repository = typeof payload.repository === 'string' ? payload.repository.trim() : ''
  const issueNumberRaw = payload.issue_number ?? payload.issueNumber
  const issueNumber = Number.parseInt(String(issueNumberRaw ?? ''), 10)
  const attemptRaw = payload.attempt ?? payload.rerun_attempt
  const attempt = Number.parseInt(String(attemptRaw ?? ''), 10)
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  const runId = typeof payload.run_id === 'string' ? payload.run_id.trim() : ''
  const workflowName = typeof payload.workflow_name === 'string' ? payload.workflow_name.trim() : ''
  const workflowNamespace = typeof payload.workflow_namespace === 'string' ? payload.workflow_namespace.trim() : ''
  const resolvedWorkflowNamespace = workflowNamespace || config.workflowNamespace || null
  const deliveryId =
    typeof payload.delivery_id === 'string'
      ? payload.delivery_id.trim()
      : workflowName && Number.isFinite(attempt)
        ? `${workflowName}:${attempt}`
        : `rerun-${Date.now()}`

  if (!repository || !Number.isFinite(issueNumber) || !Number.isFinite(attempt) || !prompt) {
    throw new Error('rerun payload missing required fields (repository, issue_number, attempt, prompt)')
  }

  return {
    repository,
    issueNumber,
    attempt,
    prompt,
    runId: runId || null,
    workflowName: workflowName || null,
    workflowNamespace: resolvedWorkflowNamespace,
    deliveryId,
  }
}

export const handleRerunRequest = async (payload: Record<string, unknown>) => {
  await ensureStoreReady()
  const parsed = parseRerunPayload(payload)

  const run = parsed.runId
    ? await store.getRunById(parsed.runId)
    : parsed.workflowName
      ? await store.getRunByWorkflow(parsed.workflowName, parsed.workflowNamespace)
      : null

  if (!run) {
    throw new Error('rerun parent run not found')
  }

  await store.updateRunPrompt(run.id, run.prompt, parsed.prompt)
  await store.updateRunStatus(run.id, 'needs_iteration')

  const submission = await store.enqueueRerunSubmission({
    parentRunId: run.id,
    attempt: parsed.attempt,
    deliveryId: parsed.deliveryId,
  })

  if (submission) {
    void processRerunQueue()
  }

  return { run, submission }
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
    stage: parsed.stage,
    iteration: parsed.iteration,
    iterationCycle: parsed.iterationCycle,
  })

  if (run && parsed.prNumber && parsed.prUrl) {
    await store.updateRunPrInfo(run.id, parsed.prNumber, parsed.prUrl, parsed.headSha ?? null)
  }

  if (run && parsed.reviewStatus) {
    await store.updateReviewStatus({
      runId: run.id,
      status: parsed.reviewStatus,
      summary: parsed.reviewSummary ?? {},
    })
  }

  if (run && run.status === 'run_complete') {
    scheduleEvaluation(run.id, 1000)
  }

  return run
}
