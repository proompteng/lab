export type CodexRunRecord = {
  id: string
  repository: string
  issueNumber: number
  branch: string
  attempt: number
  workflowName: string
  workflowUid: string | null
  workflowNamespace: string | null
  turnId: string | null
  threadId: string | null
  stage: string | null
  status: string
  phase: string | null
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
  workflowName: string
  workflowNamespace: string | null
  stage: string | null
  status: string
  phase: string | null
  commitSha: string | null
  prNumber: number | null
  prUrl: string | null
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
  promptTuning: Record<string, unknown>
  systemSuggestions: Record<string, unknown>
  createdAt: string
}

export type CodexRunHistoryEntry = {
  run: CodexRunRecord
  artifacts: CodexArtifactRecord[]
  evaluation: CodexEvaluationRecord | null
}

export type CodexRunStats = {
  completionRate: number | null
  avgAttemptsPerIssue: number | null
  failureReasonCounts: Record<string, number>
  avgCiDurationSeconds: number | null
  avgJudgeConfidence: number | null
}

export type CodexRunHistory = {
  runs: CodexRunHistoryEntry[]
  stats: CodexRunStats
}

export type CodexIssueSummaryResult =
  | { ok: true; issues: CodexIssueSummaryRecord[]; raw?: unknown }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type CodexRecentRunsResult =
  | { ok: true; runs: CodexRunSummaryRecord[]; raw?: unknown }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type CodexRunsPageResult =
  | { ok: true; runs: CodexRunSummaryRecord[]; total: number; raw?: unknown }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type CodexRunHistoryParams = {
  repository: string
  issueNumber: number
  branch?: string
  limit?: number
  signal?: AbortSignal
}

export type CodexRunHistoryResult =
  | { ok: true; history: CodexRunHistory; raw?: unknown }
  | { ok: false; message: string; status?: number; raw?: unknown }

const DEFAULT_STATS: CodexRunStats = {
  completionRate: null,
  avgAttemptsPerIssue: null,
  failureReasonCounts: {},
  avgCiDurationSeconds: null,
  avgJudgeConfidence: null,
}

const parseNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const normalizeStats = (value: unknown): CodexRunStats => {
  if (!value || typeof value !== 'object') return { ...DEFAULT_STATS }
  const record = value as Record<string, unknown>
  const failureCounts = record.failureReasonCounts
  const normalizedFailureCounts: Record<string, number> = {}

  if (failureCounts && typeof failureCounts === 'object') {
    for (const [key, entry] of Object.entries(failureCounts)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        normalizedFailureCounts[key] = entry
      }
    }
  }

  return {
    completionRate: parseNumber(record.completionRate),
    avgAttemptsPerIssue: parseNumber(record.avgAttemptsPerIssue),
    failureReasonCounts: normalizedFailureCounts,
    avgCiDurationSeconds: parseNumber(record.avgCiDurationSeconds),
    avgJudgeConfidence: parseNumber(record.avgJudgeConfidence),
  }
}

const extractErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message
  return null
}

export const fetchCodexRunHistory = async (params: CodexRunHistoryParams): Promise<CodexRunHistoryResult> => {
  const searchParams = new URLSearchParams({
    repository: params.repository,
    issueNumber: params.issueNumber.toString(),
  })
  if (params.branch) {
    searchParams.set('branch', params.branch)
  }
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/codex/runs?${searchParams.toString()}`, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractErrorMessage(payload) ?? `Request failed (${response.status})`,
      raw: payload ?? undefined,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Unexpected response format.', raw: payload ?? undefined }
  }

  const record = payload as Record<string, unknown>
  if (record.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed.',
      raw: payload ?? undefined,
    }
  }

  return {
    ok: true,
    history: {
      runs: Array.isArray(record.runs) ? (record.runs as CodexRunHistoryEntry[]) : [],
      stats: normalizeStats(record.stats),
    },
    raw: payload ?? undefined,
  }
}

export const fetchCodexIssueSummaries = async (params: {
  repository: string
  limit?: number
  signal?: AbortSignal
}): Promise<CodexIssueSummaryResult> => {
  const searchParams = new URLSearchParams({ repository: params.repository })
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/codex/issues?${searchParams.toString()}`, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractErrorMessage(payload) ?? `Request failed (${response.status})`,
      raw: payload ?? undefined,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Unexpected response format.', raw: payload ?? undefined }
  }

  const record = payload as Record<string, unknown>
  if (record.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed.',
      raw: payload ?? undefined,
    }
  }

  return {
    ok: true,
    issues: Array.isArray(record.issues) ? (record.issues as CodexIssueSummaryRecord[]) : [],
    raw: payload ?? undefined,
  }
}

export const fetchCodexRecentRuns = async (params: {
  repository?: string
  limit?: number
  signal?: AbortSignal
}): Promise<CodexRecentRunsResult> => {
  const searchParams = new URLSearchParams()
  if (params.repository) {
    searchParams.set('repository', params.repository)
  }
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/codex/runs/recent?${searchParams.toString()}`, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractErrorMessage(payload) ?? `Request failed (${response.status})`,
      raw: payload ?? undefined,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Unexpected response format.', raw: payload ?? undefined }
  }

  const record = payload as Record<string, unknown>
  if (record.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed.',
      raw: payload ?? undefined,
    }
  }

  return {
    ok: true,
    runs: Array.isArray(record.runs) ? (record.runs as CodexRunSummaryRecord[]) : [],
    raw: payload ?? undefined,
  }
}

export const fetchCodexRunsPage = async (params: {
  repository?: string
  page: number
  pageSize: number
  signal?: AbortSignal
}): Promise<CodexRunsPageResult> => {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    pageSize: params.pageSize.toString(),
  })
  if (params.repository) {
    searchParams.set('repository', params.repository)
  }

  const response = await fetch(`/api/codex/runs/list?${searchParams.toString()}`, { signal: params.signal })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractErrorMessage(payload) ?? `Request failed (${response.status})`,
      raw: payload ?? undefined,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Unexpected response format.', raw: payload ?? undefined }
  }

  const record = payload as Record<string, unknown>
  if (record.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed.',
      raw: payload ?? undefined,
    }
  }

  return {
    ok: true,
    runs: Array.isArray(record.runs) ? (record.runs as CodexRunSummaryRecord[]) : [],
    total: typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : 0,
    raw: payload ?? undefined,
  }
}
