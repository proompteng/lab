import { Buffer } from 'node:buffer'

export type AgentRunCallbackArtifact = {
  name: string
  key: string
  bucket: string | null
  url: string | null
  metadata: Record<string, unknown>
}

export type ParsedAgentRunRunCompletePayload = {
  repository: string
  issueNumber: number
  head: string
  base: string
  prompt: string | null
  iteration: number | null
  iterationCycle: number | null
  iterations: number | null
  issueTitle: string | null
  issueBody: string | null
  issueUrl: string | null
  turnId: string | null
  threadId: string | null
  runId: string | null
  agentRunName: string
  agentRunNamespace: string | null
  agentRunUid: string | null
  stage: string | null
  phase: string | null
  startedAt: string | null
  finishedAt: string | null
  artifacts: AgentRunCallbackArtifact[]
  runCompletePayload: Record<string, unknown>
}

export type ParsedAgentRunNotifyPayload = {
  runId: string | null
  agentRunName: string
  agentRunNamespace: string | null
  repository: string
  issueNumber: number
  branch: string
  prompt: string | null
  prNumber: number | null
  prUrl: string | null
  headSha: string | null
  stage: string | null
  iteration: number | null
  iterationCycle: number | null
  reviewStatus: string | null
  reviewSummary: Record<string, unknown> | null
  notifyPayload: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const parseJsonRecord = (value: string) => {
  const parsed = parseJson(value)
  return isRecord(parsed) ? parsed : {}
}

const decodeBase64JsonRecord = (value: string) => {
  try {
    return parseJsonRecord(Buffer.from(value, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

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

const firstNonEmptyString = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = normalizeOptionalString(value)
    if (normalized) return normalized
  }
  return null
}

const normalizeStringMap = (value: unknown) => {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
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
    return normalizeStringMap(parseJsonRecord(value))
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

type AgentRunCallbackParameter = {
  name?: string
  value?: string
}

const getParameterValue = (params: ReadonlyArray<AgentRunCallbackParameter>, name: string) => {
  const match = params.find((param) => param.name === name)
  return match?.value ?? ''
}

const normalizeParameters = (value: unknown) => {
  if (!Array.isArray(value)) return []
  const params: AgentRunCallbackParameter[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    params.push({
      name: normalizeOptionalString(entry.name) ?? undefined,
      value: typeof entry.value === 'string' ? entry.value : undefined,
    })
  }
  return params
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
    return normalizeString(repositoryValue)
  }
  if (isRecord(repositoryValue)) {
    const fullName = normalizeString(repositoryValue.full_name)
    if (fullName) return fullName
    const repoName = normalizeString(repositoryValue.name)
    if (repoName) {
      const owner = isRecord(repositoryValue.owner)
        ? normalizeString(repositoryValue.owner.login ?? repositoryValue.owner.name)
        : ''
      if (owner) {
        return `${owner}/${repoName}`
      }
    }
  }

  const repoValue = rawEvent.repo
  if (typeof repoValue === 'string') {
    return normalizeString(repoValue)
  }
  if (isRecord(repoValue)) {
    const fullName = normalizeString(repoValue.full_name)
    if (fullName) return fullName
    const repoName = normalizeString(repoValue.name)
    if (repoName) {
      const owner = isRecord(repoValue.owner) ? normalizeString(repoValue.owner.login ?? repoValue.owner.name) : ''
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
    return normalizeString(direct)
  }
  const pr = isRecord(rawEvent.pull_request) ? rawEvent.pull_request : null
  const branch = pr && isRecord(pr[field]) ? pr[field] : null
  if (branch && typeof branch.ref === 'string') {
    return normalizeString(branch.ref)
  }
  return ''
}

const readRecordField = (value: unknown) => {
  if (isRecord(value)) return value
  if (typeof value === 'string') return parseJsonRecord(value)
  return {}
}

const LEGACY_WORKFLOW_IDENTITY_KEYS = new Set([
  'workflowName',
  'workflow_name',
  'workflowNamespace',
  'workflow_namespace',
  'workflowUid',
  'workflow_uid',
  'workflowStage',
  'workflow_stage',
  'workflowStep',
  'workflow_step',
])

const stripLegacyWorkflowIdentityFields = (value: Record<string, unknown>) => {
  const next = { ...value }
  for (const key of LEGACY_WORKFLOW_IDENTITY_KEYS) {
    delete next[key]
  }
  return next
}

const readArtifacts = (data: Record<string, unknown>): AgentRunCallbackArtifact[] => {
  const rawArtifacts = (() => {
    if (Array.isArray(data.artifacts)) return data.artifacts
    if (typeof data.artifacts === 'string') {
      const parsed = parseJson(data.artifacts)
      return Array.isArray(parsed) ? parsed : []
    }
    return []
  })()

  return rawArtifacts
    .map((artifact: unknown) => {
      if (!isRecord(artifact)) return null
      const name = normalizeOptionalString(artifact.name)
      const key = normalizeOptionalString(artifact.key)
      if (!name || !key) return null
      return {
        name,
        key,
        bucket: normalizeOptionalString(artifact.bucket),
        url: normalizeOptionalString(artifact.url),
        metadata: artifact,
      }
    })
    .filter((artifact): artifact is AgentRunCallbackArtifact => Boolean(artifact))
}

export const parseAgentRunRunCompletePayload = (payload: Record<string, unknown>): ParsedAgentRunRunCompletePayload => {
  const rawData = payload.data ?? payload
  const data = stripLegacyWorkflowIdentityFields(
    typeof rawData === 'string' ? parseJsonRecord(rawData) : isRecord(rawData) ? rawData : {},
  )
  const metadataRecord = readRecordField(data.metadata)
  const rawStatus = readRecordField(data.status)
  const argumentsRecord = readRecordField(data.arguments)
  const params = normalizeParameters(argumentsRecord.parameters)

  const eventBodyRaw = getParameterValue(params, 'eventBody')
  const eventBody = eventBodyRaw ? decodeBase64JsonRecord(eventBodyRaw) : {}
  const rawEventRaw = getParameterValue(params, 'rawEvent')
  const rawEvent = rawEventRaw ? decodeBase64JsonRecord(rawEventRaw) : {}

  const labels = readMetadataMap(metadataRecord.labels)
  const annotations = readMetadataMap(metadataRecord.annotations)

  const metadataRepository = normalizeString(getMetadataValue(metadataRecord, labels, annotations, REPO_METADATA_KEYS))
  const metadataIssueNumber = normalizeNumber(
    getMetadataValue(metadataRecord, labels, annotations, ISSUE_METADATA_KEYS),
  )
  const metadataHead = normalizeString(getMetadataValue(metadataRecord, labels, annotations, HEAD_METADATA_KEYS))
  const metadataBase = normalizeString(getMetadataValue(metadataRecord, labels, annotations, BASE_METADATA_KEYS))
  const metadataTurnId = normalizeOptionalString(
    getMetadataValue(metadataRecord, labels, annotations, TURN_METADATA_KEYS),
  )
  const metadataThreadId = normalizeOptionalString(
    getMetadataValue(metadataRecord, labels, annotations, THREAD_METADATA_KEYS),
  )

  const repository =
    normalizeString(data.repository) ||
    normalizeString(eventBody.repository ?? eventBody.repo) ||
    metadataRepository ||
    extractRepositoryFromRawEvent(rawEvent)
  const issueNumber =
    normalizeNumber(data.issueNumber ?? 0) ||
    normalizeNumber(eventBody.issueNumber ?? eventBody.issue_number ?? 0) ||
    metadataIssueNumber ||
    extractIssueNumberFromRawEvent(rawEvent)
  const head =
    normalizeString(data.branch) ||
    normalizeString(eventBody.head) ||
    normalizeString(getParameterValue(params, 'head')) ||
    metadataHead ||
    extractBranchFromRawEvent(rawEvent, 'head')
  const base =
    normalizeString(data.base) ||
    normalizeString(eventBody.base) ||
    normalizeString(getParameterValue(params, 'base')) ||
    metadataBase ||
    extractBranchFromRawEvent(rawEvent, 'base')
  const prompt =
    typeof data.prompt === 'string'
      ? data.prompt.trim()
      : typeof eventBody.prompt === 'string'
        ? eventBody.prompt.trim()
        : null
  const iterationRaw =
    normalizeNumber(data.iteration ?? 0) ||
    normalizeNumber(eventBody.iteration ?? 0) ||
    normalizeNumber(getParameterValue(params, 'iteration'))
  const iterationCycleRaw =
    normalizeNumber(data.iterationCycle ?? data.iteration_cycle ?? 0) ||
    normalizeNumber(eventBody.iterationCycle ?? eventBody.iteration_cycle ?? 0) ||
    normalizeNumber(getParameterValue(params, 'iteration_cycle'))
  const iterationsRaw =
    normalizeNumber(data.iterations ?? 0) ||
    normalizeNumber(eventBody.iterations ?? 0) ||
    normalizeNumber(getParameterValue(params, 'iterations'))
  const iteration = iterationRaw > 0 ? iterationRaw : null
  const iterationCycle = iterationCycleRaw > 0 ? iterationCycleRaw : null
  const iterations = iterationsRaw > 0 ? iterationsRaw : null
  const issueTitle = typeof eventBody.issueTitle === 'string' ? eventBody.issueTitle : null
  const issueBody = typeof eventBody.issueBody === 'string' ? eventBody.issueBody : null
  const issueUrl = typeof eventBody.issueUrl === 'string' ? eventBody.issueUrl : null
  const turnId = normalizeOptionalString(eventBody.turnId ?? eventBody.turn_id) ?? metadataTurnId
  const threadId = normalizeOptionalString(eventBody.threadId ?? eventBody.thread_id) ?? metadataThreadId
  const artifacts = readArtifacts(data)

  const agentRunMetadataName =
    firstNonEmptyString(data.kind) === 'AgentRun' ||
    firstNonEmptyString(data.apiVersion)?.startsWith('agents.proompteng.ai/')
      ? firstNonEmptyString(metadataRecord.name)
      : null
  const runId = firstNonEmptyString(data.runId, data.run_id, data.agentRunId, data.agent_run_id)
  const agentRunName = firstNonEmptyString(data.agentRunName, data.agent_run_name, agentRunMetadataName)
  const agentRunNamespace = firstNonEmptyString(
    data.agentRunNamespace,
    data.agent_run_namespace,
    agentRunMetadataName ? metadataRecord.namespace : null,
  )
  const agentRunUid = firstNonEmptyString(
    data.agentRunUid,
    data.agent_run_uid,
    agentRunMetadataName ? metadataRecord.uid : null,
  )
  const resolvedAgentRunName = firstNonEmptyString(agentRunName, runId, metadataRecord.name) ?? ''
  const resolvedAgentRunNamespace = firstNonEmptyString(agentRunNamespace, metadataRecord.namespace)
  const resolvedAgentRunUid = firstNonEmptyString(agentRunUid, metadataRecord.uid)

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
    runId,
    agentRunName: resolvedAgentRunName,
    agentRunNamespace: resolvedAgentRunNamespace,
    agentRunUid: resolvedAgentRunUid,
    stage: normalizeOptionalString(data.stage),
    phase: normalizeOptionalString(rawStatus.phase),
    startedAt: normalizeOptionalString(data.startedAt) ?? normalizeOptionalString(rawStatus.startedAt),
    finishedAt: normalizeOptionalString(data.finishedAt) ?? normalizeOptionalString(rawStatus.finishedAt),
    artifacts,
    runCompletePayload: data,
  }
}

export const parseAgentRunNotifyPayload = (payload: Record<string, unknown>): ParsedAgentRunNotifyPayload => {
  const rawData = payload.data ?? payload
  const data = stripLegacyWorkflowIdentityFields(
    typeof rawData === 'string' ? parseJsonRecord(rawData) : isRecord(rawData) ? rawData : {},
  )
  const runId = firstNonEmptyString(data.runId, data.run_id, data.agentRunId, data.agent_run_id)
  const agentRunName = firstNonEmptyString(data.agentRunName, data.agent_run_name)
  const agentRunNamespace = firstNonEmptyString(data.agentRunNamespace, data.agent_run_namespace)
  const resolvedAgentRunName = firstNonEmptyString(agentRunName, runId) ?? ''
  const repository = normalizeString(data.repository)
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

  return {
    runId,
    agentRunName: resolvedAgentRunName,
    agentRunNamespace: agentRunNamespace ?? null,
    repository,
    issueNumber,
    branch,
    prompt,
    prNumber: Number.isFinite(prNumber) && prNumber > 0 ? prNumber : null,
    prUrl,
    headSha,
    stage,
    iteration: iterationRaw > 0 ? iterationRaw : null,
    iterationCycle: iterationCycleRaw > 0 ? iterationCycleRaw : null,
    reviewStatus,
    reviewSummary,
    notifyPayload: data,
  }
}
