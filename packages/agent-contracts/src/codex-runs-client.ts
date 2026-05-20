import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  runAgentsJsonPromise,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type CodexRunRecord = {
  id: string
  repository: string
  issueNumber: number
  branch: string
  attempt: number
  agentRunName: string
  agentRunUid: string | null
  agentRunNamespace: string | null
  turnId: string | null
  threadId: string | null
  stage: string | null
  status: string
  phase: string | null
  iteration: number | null
  iterationCycle: number | null
  prompt: string | null
  nextPrompt: string | null
  commitSha: string | null
  prNumber: number | null
  prUrl: string | null
  ciStatus: string | null
  ciUrl: string | null
  ciStatusUpdatedAt: string | null
  reviewStatus: string | null
  reviewSummary: Record<string, unknown>
  reviewStatusUpdatedAt: string | null
  notifyPayload: Record<string, unknown> | null
  runCompletePayload: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type CodexRunSummaryRecord = {
  id: string
  repository: string
  issueNumber: number
  branch: string
  attempt: number
  agentRunName: string
  agentRunNamespace: string | null
  stage: string | null
  status: string
  phase: string | null
  iteration: number | null
  iterationCycle: number | null
  decision: string | null
  commitSha: string | null
  prNumber: number | null
  prUrl: string | null
  prState: string | null
  prMerged: boolean | null
  ciStatus: string | null
  reviewStatus: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type CodexIssueSummaryRecord = {
  issueNumber: number
  runCount: number
  lastSeenAt: string
}

export type CodexArtifactRecord = {
  id: string
  runId: string
  name: string
  key: string
  bucket: string | null
  url: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type CodexEvaluationRecord = {
  id: string
  runId: string
  decision: string
  confidence: number | null
  reasons: Record<string, unknown>
  missingItems: Record<string, unknown>
  suggestedFixes: Record<string, unknown>
  nextPrompt: string | null
  systemSuggestions: Record<string, unknown>
  createdAt: string
}

export type CodexRunStats = {
  completionRate: number | null
  avgAttemptsPerIssue: number | null
  failureReasonCounts: Record<string, number>
  avgCiDurationSeconds: number | null
  avgJudgeConfidence: number | null
}

export type CodexRunHistoryEntry = {
  run: CodexRunRecord
  artifacts: CodexArtifactRecord[]
  evaluation: CodexEvaluationRecord | null
}

export type CodexRunHistoryResult = {
  ok: boolean
  runs: CodexRunHistoryEntry[]
  stats: CodexRunStats
}

export type CodexRunsPageResult = {
  ok: boolean
  runs: CodexRunSummaryRecord[]
  total: number
}

export type CodexRecentRunsResult = {
  ok: boolean
  runs: CodexRunSummaryRecord[]
}

export type CodexIssuesResult = {
  ok: boolean
  issues: CodexIssueSummaryRecord[]
}

export type CodexRunHistoryInput = {
  repository: string
  issueNumber: number
  branch?: string | null
  limit?: number | null
}

export type CodexRunsPageInput = {
  repository?: string | null
  page?: number | null
  pageSize?: number | null
}

export type CodexRecentRunsInput = {
  repository?: string | null
  limit?: number | null
}

export type CodexIssuesInput = {
  repository: string
  limit?: number | null
}

const appendOptionalNumber = (params: URLSearchParams, key: string, value?: number | null) => {
  if (value && value > 0) params.set(key, String(Math.trunc(value)))
}

const buildCodexPath = (path: string, params: URLSearchParams, env: EnvSource) => {
  const targetUrl = buildAgentsServiceUrl(path, env)
  for (const [key, value] of params) {
    targetUrl.searchParams.set(key, value)
  }
  return servicePath(targetUrl)
}

export const fetchCodexRunHistoryFromAgentsServiceEffect = (
  input: CodexRunHistoryInput,
  env: EnvSource = process.env,
) => {
  const params = new URLSearchParams({
    repository: input.repository,
    issueNumber: String(input.issueNumber),
  })
  if (input.branch?.trim()) params.set('branch', input.branch.trim())
  appendOptionalNumber(params, 'limit', input.limit)
  return fetchAgentsJsonEffect<CodexRunHistoryResult>(buildCodexPath('/v1/codex/runs', params, env), env)
}

export const fetchCodexRunsPageFromAgentsServiceEffect = (
  input: CodexRunsPageInput = {},
  env: EnvSource = process.env,
) => {
  const params = new URLSearchParams()
  if (input.repository?.trim()) params.set('repository', input.repository.trim())
  appendOptionalNumber(params, 'page', input.page)
  appendOptionalNumber(params, 'pageSize', input.pageSize)
  return fetchAgentsJsonEffect<CodexRunsPageResult>(buildCodexPath('/v1/codex/runs/list', params, env), env)
}

export const fetchCodexRecentRunsFromAgentsServiceEffect = (
  input: CodexRecentRunsInput = {},
  env: EnvSource = process.env,
) => {
  const params = new URLSearchParams()
  if (input.repository?.trim()) params.set('repository', input.repository.trim())
  appendOptionalNumber(params, 'limit', input.limit)
  return fetchAgentsJsonEffect<CodexRecentRunsResult>(buildCodexPath('/v1/codex/runs/recent', params, env), env)
}

export const fetchCodexIssuesFromAgentsServiceEffect = (input: CodexIssuesInput, env: EnvSource = process.env) => {
  const params = new URLSearchParams({ repository: input.repository })
  appendOptionalNumber(params, 'limit', input.limit)
  return fetchAgentsJsonEffect<CodexIssuesResult>(buildCodexPath('/v1/codex/issues', params, env), env)
}

export const fetchCodexRunHistoryFromAgentsService = (
  input: CodexRunHistoryInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<CodexRunHistoryResult>> =>
  runAgentsJsonPromise(fetchCodexRunHistoryFromAgentsServiceEffect(input, env))

export const fetchCodexRunsPageFromAgentsService = (
  input: CodexRunsPageInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<CodexRunsPageResult>> =>
  runAgentsJsonPromise(fetchCodexRunsPageFromAgentsServiceEffect(input, env))

export const fetchCodexRecentRunsFromAgentsService = (
  input: CodexRecentRunsInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<CodexRecentRunsResult>> =>
  runAgentsJsonPromise(fetchCodexRecentRunsFromAgentsServiceEffect(input, env))

export const fetchCodexIssuesFromAgentsService = (
  input: CodexIssuesInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<CodexIssuesResult>> =>
  runAgentsJsonPromise(fetchCodexIssuesFromAgentsServiceEffect(input, env))
