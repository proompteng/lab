import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

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

export type CodexPromptTuningRecord = {
  id: string
  runId: string
  prUrl: string
  status: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type CodexPendingRun = {
  id: string
  status: string
  updatedAt: string
}

export type CodexRerunSubmissionRecord = {
  id: string
  parentRunId: string
  attempt: number
  deliveryId: string
  status: string
  submissionAttempt: number
  responseStatus: number | null
  error: string | null
  createdAt: string
  updatedAt: string
  submittedAt: string | null
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

export type ListRecentRunsInput = {
  repository?: string | null
  limit?: number
}

export type GetRunHistoryInput = {
  repository: string
  issueNumber: number
  branch?: string | null
  limit?: number
}

export type UpsertRunCompleteInput = {
  repository: string
  issueNumber: number
  branch: string
  workflowName: string
  workflowUid: string | null
  workflowNamespace: string | null
  turnId: string | null
  threadId: string | null
  stage: string | null
  status: string
  phase: string | null
  prompt: string | null
  runCompletePayload: Record<string, unknown>
  startedAt: string | null
  finishedAt: string | null
}

export type AttachNotifyInput = {
  workflowName: string
  workflowNamespace?: string | null
  notifyPayload: Record<string, unknown>
  repository?: string
  issueNumber?: number
  branch?: string
  prompt?: string | null
}

export type UpdateCiInput = {
  runId: string
  status: string
  url?: string | null
  commitSha?: string | null
}

export type UpdateReviewInput = {
  runId: string
  status: string
  summary: Record<string, unknown>
}

export type UpdateDecisionInput = {
  runId: string
  decision: string
  confidence?: number | null
  reasons?: Record<string, unknown>
  missingItems?: Record<string, unknown>
  suggestedFixes?: Record<string, unknown>
  nextPrompt?: string | null
  promptTuning?: Record<string, unknown>
  systemSuggestions?: Record<string, unknown>
}

export type UpsertArtifactsInput = {
  runId: string
  artifacts: Array<{
    name: string
    key: string
    bucket?: string | null
    url?: string | null
    metadata?: Record<string, unknown>
  }>
}

export type ClaimRerunSubmissionInput = {
  parentRunId: string
  attempt: number
  deliveryId: string
}

export type UpdateRerunSubmissionInput = {
  id: string
  status: string
  responseStatus?: number | null
  error?: string | null
  submittedAt?: string | null
}

export type CodexJudgeStore = {
  ready: Promise<void>
  upsertRunComplete: (input: UpsertRunCompleteInput) => Promise<CodexRunRecord>
  attachNotify: (input: AttachNotifyInput) => Promise<CodexRunRecord | null>
  updateCiStatus: (input: UpdateCiInput) => Promise<CodexRunRecord | null>
  updateReviewStatus: (input: UpdateReviewInput) => Promise<CodexRunRecord | null>
  updateDecision: (input: UpdateDecisionInput) => Promise<CodexEvaluationRecord>
  updateRunStatus: (runId: string, status: string) => Promise<CodexRunRecord | null>
  updateRunPrompt: (runId: string, prompt: string | null, nextPrompt?: string | null) => Promise<CodexRunRecord | null>
  updateRunPrInfo: (
    runId: string,
    prNumber: number,
    prUrl: string,
    commitSha?: string | null,
  ) => Promise<CodexRunRecord | null>
  upsertArtifacts: (input: UpsertArtifactsInput) => Promise<CodexArtifactRecord[]>
  listRunsByStatus: (statuses: string[]) => Promise<CodexPendingRun[]>
  claimRerunSubmission: (
    input: ClaimRerunSubmissionInput,
  ) => Promise<{ submission: CodexRerunSubmissionRecord; shouldSubmit: boolean } | null>
  updateRerunSubmission: (input: UpdateRerunSubmissionInput) => Promise<CodexRerunSubmissionRecord | null>
  getRunByWorkflow: (workflowName: string, namespace?: string | null) => Promise<CodexRunRecord | null>
  getRunById: (runId: string) => Promise<CodexRunRecord | null>
  listRunsByIssue: (repository: string, issueNumber: number, branch?: string | null) => Promise<CodexRunRecord[]>
  listRunsByBranch: (repository: string, branch: string) => Promise<CodexRunRecord[]>
  listRunsByCommitSha: (repository: string, commitSha: string) => Promise<CodexRunRecord[]>
  listRunsByPrNumber: (repository: string, prNumber: number) => Promise<CodexRunRecord[]>
  getRunHistory: (input: GetRunHistoryInput) => Promise<CodexRunHistory>
  listRecentRuns: (input: ListRecentRunsInput) => Promise<CodexRunSummaryRecord[]>
  listIssueSummaries: (repository: string, limit?: number) => Promise<CodexIssueSummaryRecord[]>
  getLatestPromptTuningByIssue: (repository: string, issueNumber: number) => Promise<CodexPromptTuningRecord | null>
  createPromptTuning: (
    runId: string,
    prUrl: string,
    status: string,
    metadata?: Record<string, unknown>,
  ) => Promise<CodexPromptTuningRecord>
  close: () => Promise<void>
}

const ensureSchema = async (db: Db) => {
  await ensureMigrations(db)
}

const TERMINAL_RUN_STATUS_LIST = ['completed', 'needs_human', 'superseded'] as const

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATUS_LIST)

const isTerminalRunStatus = (status: string) => TERMINAL_RUN_STATUSES.has(status)

const parseTimestamp = (value: string | null) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const normalizeShaValue = (value: string | null | undefined) => value?.trim().toLowerCase() ?? ''

const matchesCommitSha = (expected: string | null | undefined, actual: string | null | undefined) => {
  if (!expected || !actual) return true
  const expectedValue = normalizeShaValue(expected)
  const actualValue = normalizeShaValue(actual)
  if (!expectedValue || !actualValue) return true
  return expectedValue === actualValue || expectedValue.startsWith(actualValue) || actualValue.startsWith(expectedValue)
}

const getRunSortKey = (run: CodexRunRecord) => {
  const finished = parseTimestamp(run.finishedAt)
  const started = parseTimestamp(run.startedAt)
  const created = parseTimestamp(run.createdAt) ?? 0
  const primary = finished ?? started ?? created
  return { primary, created, attempt: run.attempt }
}

const computeRunStats = (
  runs: CodexRunRecord[],
  evaluations: Map<string, CodexEvaluationRecord | null>,
): CodexRunStats => {
  if (runs.length === 0) {
    return {
      completionRate: null,
      avgAttemptsPerIssue: null,
      failureReasonCounts: {},
      avgCiDurationSeconds: null,
      avgJudgeConfidence: null,
    }
  }

  const completedCount = runs.filter((run) => run.status === 'completed').length

  const attemptsByIssue = new Map<string, number>()
  for (const run of runs) {
    const key = `${run.repository}#${run.issueNumber}`
    const current = attemptsByIssue.get(key) ?? 0
    attemptsByIssue.set(key, Math.max(current, run.attempt))
  }

  const avgAttemptsPerIssue =
    attemptsByIssue.size === 0
      ? null
      : [...attemptsByIssue.values()].reduce((sum, value) => sum + value, 0) / attemptsByIssue.size

  const failureReasonCounts: Record<string, number> = {}
  const confidences: number[] = []
  for (const evaluation of evaluations.values()) {
    if (!evaluation) continue
    if (typeof evaluation.confidence === 'number') {
      confidences.push(evaluation.confidence)
    }
    const reasons = evaluation.reasons as Record<string, unknown>
    const error = typeof reasons?.error === 'string' ? reasons.error : null
    if (error && evaluation.decision !== 'pass') {
      failureReasonCounts[error] = (failureReasonCounts[error] ?? 0) + 1
    }
  }

  const ciDurations: number[] = []
  for (const run of runs) {
    const started = parseTimestamp(run.startedAt)
    const finished = parseTimestamp(run.finishedAt)
    if (started != null && finished != null && finished >= started) {
      ciDurations.push((finished - started) / 1000)
    }
  }

  return {
    completionRate: runs.length > 0 ? completedCount / runs.length : null,
    avgAttemptsPerIssue,
    failureReasonCounts,
    avgCiDurationSeconds:
      ciDurations.length > 0 ? ciDurations.reduce((sum, value) => sum + value, 0) / ciDurations.length : null,
    avgJudgeConfidence:
      confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
  }
}

const selectActiveRun = (runs: CodexRunRecord[]) => {
  const active = runs.filter((run) => !isTerminalRunStatus(run.status))
  if (active.length === 0) return null

  return active.reduce((latest, run) => {
    const latestKey = getRunSortKey(latest)
    const runKey = getRunSortKey(run)

    if (runKey.primary > latestKey.primary) return run
    if (runKey.primary < latestKey.primary) return latest
    if (runKey.created > latestKey.created) return run
    if (runKey.created < latestKey.created) return latest
    if (runKey.attempt > latestKey.attempt) return run
    if (runKey.attempt < latestKey.attempt) return latest

    return run.id > latest.id ? run : latest
  })
}

const planSupersession = (runs: CodexRunRecord[]) => {
  const activeRun = selectActiveRun(runs)
  if (!activeRun) {
    return { activeRun: null, supersededIds: [] as string[] }
  }

  const supersededIds = runs
    .filter((run) => run.id !== activeRun.id)
    .filter((run) => !isTerminalRunStatus(run.status))
    .map((run) => run.id)

  return { activeRun, supersededIds }
}

const rowToRun = (row: Record<string, unknown>): CodexRunRecord => {
  return {
    id: String(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    branch: String(row.branch),
    attempt: Number(row.attempt),
    workflowName: String(row.workflow_name),
    workflowUid: row.workflow_uid ? String(row.workflow_uid) : null,
    workflowNamespace: row.workflow_namespace ? String(row.workflow_namespace) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    threadId: row.thread_id ? String(row.thread_id) : null,
    stage: row.stage ? String(row.stage) : null,
    status: String(row.status),
    phase: row.phase ? String(row.phase) : null,
    prompt: row.prompt ? String(row.prompt) : null,
    nextPrompt: row.next_prompt ? String(row.next_prompt) : null,
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    prNumber: row.pr_number != null ? Number(row.pr_number) : null,
    prUrl: row.pr_url ? String(row.pr_url) : null,
    ciStatus: row.ci_status ? String(row.ci_status) : null,
    ciUrl: row.ci_url ? String(row.ci_url) : null,
    ciStatusUpdatedAt: row.ci_status_updated_at ? String(row.ci_status_updated_at) : null,
    reviewStatus: row.review_status ? String(row.review_status) : null,
    reviewSummary: (row.review_summary as Record<string, unknown>) ?? {},
    reviewStatusUpdatedAt: row.review_status_updated_at ? String(row.review_status_updated_at) : null,
    notifyPayload: (row.notify_payload as Record<string, unknown>) ?? null,
    runCompletePayload: (row.run_complete_payload as Record<string, unknown>) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  }
}

const rowToRunSummary = (row: Record<string, unknown>): CodexRunSummaryRecord => ({
  id: String(row.id),
  repository: String(row.repository),
  issueNumber: Number(row.issue_number),
  branch: String(row.branch),
  attempt: Number(row.attempt),
  workflowName: String(row.workflow_name),
  workflowNamespace: row.workflow_namespace ? String(row.workflow_namespace) : null,
  stage: row.stage ? String(row.stage) : null,
  status: String(row.status),
  phase: row.phase ? String(row.phase) : null,
  commitSha: row.commit_sha ? String(row.commit_sha) : null,
  prNumber: row.pr_number != null ? Number(row.pr_number) : null,
  prUrl: row.pr_url ? String(row.pr_url) : null,
  ciStatus: row.ci_status ? String(row.ci_status) : null,
  reviewStatus: row.review_status ? String(row.review_status) : null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  startedAt: row.started_at ? String(row.started_at) : null,
  finishedAt: row.finished_at ? String(row.finished_at) : null,
})

const rowToArtifact = (row: Record<string, unknown>): CodexArtifactRecord => ({
  id: String(row.id),
  runId: String(row.run_id),
  name: String(row.name),
  key: String(row.key),
  bucket: row.bucket ? String(row.bucket) : null,
  url: row.url ? String(row.url) : null,
  metadata: (row.metadata as Record<string, unknown>) ?? {},
  createdAt: String(row.created_at),
})

const rowToEvaluation = (row: Record<string, unknown>): CodexEvaluationRecord => ({
  id: String(row.id),
  runId: String(row.run_id),
  decision: String(row.decision),
  confidence: row.confidence == null ? null : Number(row.confidence),
  reasons: (row.reasons as Record<string, unknown>) ?? {},
  missingItems: (row.missing_items as Record<string, unknown>) ?? {},
  suggestedFixes: (row.suggested_fixes as Record<string, unknown>) ?? {},
  nextPrompt: row.next_prompt ? String(row.next_prompt) : null,
  promptTuning: (row.prompt_tuning as Record<string, unknown>) ?? {},
  systemSuggestions: (row.system_suggestions as Record<string, unknown>) ?? {},
  createdAt: String(row.created_at),
})

const rowToPromptTuning = (row: Record<string, unknown>): CodexPromptTuningRecord => ({
  id: String(row.id),
  runId: String(row.run_id),
  prUrl: String(row.pr_url),
  status: String(row.status),
  metadata: (row.metadata as Record<string, unknown>) ?? {},
  createdAt: String(row.created_at),
})

const rowToRerunSubmission = (row: Record<string, unknown>): CodexRerunSubmissionRecord => ({
  id: String(row.id),
  parentRunId: String(row.parent_run_id),
  attempt: Number(row.attempt ?? 0),
  deliveryId: String(row.delivery_id),
  status: String(row.status),
  submissionAttempt: Number(row.submission_attempt ?? 0),
  responseStatus: row.response_status != null ? Number(row.response_status) : null,
  error: row.error ? String(row.error) : null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  submittedAt: row.submitted_at ? String(row.submitted_at) : null,
})

export const createCodexJudgeStore = (
  options: { url?: string; createDb?: (url: string) => Db } = {},
): CodexJudgeStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for Codex judge storage')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  const ready = ensureSchema(db)

  const getRunByWorkflow = async (workflowName: string, namespace?: string | null) => {
    if (!workflowName) return null
    const row = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('workflow_name', '=', workflowName)
      .where('workflow_namespace', '=', namespace ?? null)
      .executeTakeFirst()
    return row ? rowToRun(row as Record<string, unknown>) : null
  }

  const getRunById = async (runId: string) => {
    const row = await db.selectFrom('codex_judge.runs').selectAll().where('id', '=', runId).executeTakeFirst()
    return row ? rowToRun(row as Record<string, unknown>) : null
  }

  const listRunsByIssue = async (repository: string, issueNumber: number, branch?: string | null) => {
    let query = db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('repository', '=', repository)
      .where('issue_number', '=', issueNumber)

    if (branch && branch.length > 0) {
      query = query.where('branch', '=', branch)
    }

    const rows = await query.orderBy('created_at desc').execute()
    return rows.map((row) => rowToRun(row as Record<string, unknown>))
  }

  const listRunsByBranch = async (repository: string, branch: string) => {
    const rows = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('repository', '=', repository)
      .where('branch', '=', branch)
      .orderBy('created_at desc')
      .execute()
    return rows.map((row) => rowToRun(row as Record<string, unknown>))
  }

  const listRunsByCommitSha = async (repository: string, commitSha: string) => {
    const trimmed = commitSha.trim()
    if (!trimmed) return []
    const prefix = trimmed.slice(0, Math.min(7, trimmed.length))
    const rows = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('repository', '=', repository)
      .where('commit_sha', 'like', `${prefix}%`)
      .orderBy('created_at desc')
      .execute()
    return rows
      .map((row) => rowToRun(row as Record<string, unknown>))
      .filter((run) => matchesCommitSha(trimmed, run.commitSha))
  }

  const listRunsByPrNumber = async (repository: string, prNumber: number) => {
    const rows = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('repository', '=', repository)
      .where('pr_number', '=', prNumber)
      .orderBy('created_at desc')
      .execute()
    return rows.map((row) => rowToRun(row as Record<string, unknown>))
  }

  const getRunHistory = async (input: GetRunHistoryInput): Promise<CodexRunHistory> => {
    let query = db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('repository', '=', input.repository)
      .where('issue_number', '=', input.issueNumber)

    if (input.branch) {
      query = query.where('branch', '=', input.branch)
    }

    const runRows = await query.orderBy('attempt asc').orderBy('created_at asc').execute()
    const runs = runRows.map((row) => rowToRun(row as Record<string, unknown>))

    const runIds = runs.map((run) => run.id)
    const artifactsByRun = new Map<string, CodexArtifactRecord[]>()
    const evaluationsByRun = new Map<string, CodexEvaluationRecord | null>()

    if (runIds.length > 0) {
      const artifactRows = await db
        .selectFrom('codex_judge.artifacts')
        .selectAll()
        .where('run_id', 'in', runIds)
        .orderBy('created_at asc')
        .execute()
      for (const row of artifactRows) {
        const artifact = rowToArtifact(row as Record<string, unknown>)
        const bucket = artifactsByRun.get(artifact.runId) ?? []
        bucket.push(artifact)
        artifactsByRun.set(artifact.runId, bucket)
      }

      const evaluationRows = await db
        .selectFrom('codex_judge.evaluations')
        .selectAll()
        .where('run_id', 'in', runIds)
        .orderBy('run_id')
        .orderBy('created_at desc')
        .execute()
      for (const row of evaluationRows) {
        const evaluation = rowToEvaluation(row as Record<string, unknown>)
        if (!evaluationsByRun.has(evaluation.runId)) {
          evaluationsByRun.set(evaluation.runId, evaluation)
        }
      }
    }

    for (const runId of runIds) {
      if (!evaluationsByRun.has(runId)) {
        evaluationsByRun.set(runId, null)
      }
    }

    const stats = computeRunStats(runs, evaluationsByRun)
    const limit = input.limit && input.limit > 0 ? input.limit : null
    const visibleRuns = limit ? runs.slice(Math.max(runs.length - limit, 0)) : runs

    return {
      runs: visibleRuns.map((run) => ({
        run,
        artifacts: artifactsByRun.get(run.id) ?? [],
        evaluation: evaluationsByRun.get(run.id) ?? null,
      })),
      stats,
    }
  }

  const listRecentRuns = async (input: ListRecentRunsInput): Promise<CodexRunSummaryRecord[]> => {
    const repository = input.repository?.trim()
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 200) : 50
    let query = db
      .selectFrom('codex_judge.runs')
      .select([
        'id',
        'repository',
        'issue_number',
        'branch',
        'attempt',
        'workflow_name',
        'workflow_namespace',
        'stage',
        'status',
        'phase',
        'commit_sha',
        'pr_number',
        'pr_url',
        'ci_status',
        'review_status',
        'created_at',
        'updated_at',
        'started_at',
        'finished_at',
      ])
      .orderBy('created_at desc')

    if (repository) {
      query = query.where('repository', '=', repository)
    }

    const rows = await query.limit(limit).execute()
    return rows.map((row) => rowToRunSummary(row as Record<string, unknown>))
  }

  const listIssueSummaries = async (repository: string, limit?: number): Promise<CodexIssueSummaryRecord[]> => {
    const trimmed = repository.trim()
    if (!trimmed) return []
    const safeLimit = limit && limit > 0 ? Math.min(limit, 500) : 200
    const rows = await db
      .selectFrom('codex_judge.runs')
      .select(['issue_number', sql`max(created_at)`.as('last_seen'), sql`count(*)`.as('run_count')])
      .where('repository', '=', trimmed)
      .groupBy('issue_number')
      .orderBy('last_seen desc')
      .limit(safeLimit)
      .execute()

    return rows.map((row) => ({
      issueNumber: Number(row.issue_number),
      runCount: Number((row as Record<string, unknown>).run_count ?? 0),
      lastSeenAt: (row as Record<string, unknown>).last_seen ? String((row as Record<string, unknown>).last_seen) : '',
    }))
  }

  const getLatestPromptTuningByIssue = async (repository: string, issueNumber: number) => {
    const row = await db
      .selectFrom('codex_judge.prompt_tuning')
      .innerJoin('codex_judge.runs', 'codex_judge.prompt_tuning.run_id', 'codex_judge.runs.id')
      .selectAll('codex_judge.prompt_tuning')
      .where('codex_judge.runs.repository', '=', repository)
      .where('codex_judge.runs.issue_number', '=', issueNumber)
      .orderBy('codex_judge.prompt_tuning.created_at desc')
      .executeTakeFirst()
    return row ? rowToPromptTuning(row as Record<string, unknown>) : null
  }

  const enforceSingleActiveRun = async (run: CodexRunRecord) => {
    if (isTerminalRunStatus(run.status)) return run

    const runs = await listRunsByIssue(run.repository, run.issueNumber)
    const plan = planSupersession(runs)
    if (!plan.activeRun) return run

    if (plan.activeRun.id !== run.id) {
      const updated = await db
        .updateTable('codex_judge.runs')
        .set({ status: 'superseded', updated_at: sql`now()` })
        .where('id', '=', run.id)
        .where('status', 'not in', TERMINAL_RUN_STATUS_LIST)
        .returningAll()
        .executeTakeFirst()
      return updated ? rowToRun(updated as Record<string, unknown>) : run
    }

    if (plan.supersededIds.length > 0) {
      await db
        .updateTable('codex_judge.runs')
        .set({ status: 'superseded', updated_at: sql`now()` })
        .where('id', 'in', plan.supersededIds)
        .where('status', 'not in', TERMINAL_RUN_STATUS_LIST)
        .execute()
    }

    return run
  }

  const upsertRunComplete = async (input: UpsertRunCompleteInput) => {
    const existingByUid = input.workflowUid
      ? await db
          .selectFrom('codex_judge.runs')
          .selectAll()
          .where('workflow_uid', '=', input.workflowUid)
          .executeTakeFirst()
      : null
    const existingByName = existingByUid
      ? null
      : await db
          .selectFrom('codex_judge.runs')
          .selectAll()
          .where('workflow_name', '=', input.workflowName)
          .where('workflow_namespace', '=', input.workflowNamespace ?? null)
          .executeTakeFirst()

    const existing = existingByUid ?? existingByName

    if (existing) {
      const existingStatus = String(existing.status)
      const nextStatus =
        existingStatus === 'run_complete' || existingStatus === 'notified' ? 'run_complete' : existingStatus

      const updated = await db
        .updateTable('codex_judge.runs')
        .set({
          repository: input.repository,
          issue_number: input.issueNumber,
          branch: input.branch,
          workflow_name: input.workflowName,
          workflow_namespace: input.workflowNamespace ?? null,
          turn_id: input.turnId ?? (existing.turn_id ? String(existing.turn_id) : null),
          thread_id: input.threadId ?? (existing.thread_id ? String(existing.thread_id) : null),
          stage: input.stage,
          status: nextStatus,
          phase: input.phase,
          prompt: input.prompt,
          run_complete_payload: input.runCompletePayload,
          started_at: input.startedAt ? new Date(input.startedAt) : null,
          finished_at: input.finishedAt ? new Date(input.finishedAt) : null,
          updated_at: sql`now()`,
        })
        .where('id', '=', String(existing.id))
        .returningAll()
        .executeTakeFirstOrThrow()
      return enforceSingleActiveRun(rowToRun(updated as Record<string, unknown>))
    }

    const priorRuns = await db
      .selectFrom('codex_judge.runs')
      .select(['attempt'])
      .where('repository', '=', input.repository)
      .where('issue_number', '=', input.issueNumber)
      .execute()
    const attempt = priorRuns.reduce((max, row) => Math.max(max, Number(row.attempt ?? 0)), 0) + 1

    const inserted = await db
      .insertInto('codex_judge.runs')
      .values({
        repository: input.repository,
        issue_number: input.issueNumber,
        branch: input.branch,
        attempt,
        workflow_name: input.workflowName,
        workflow_uid: input.workflowUid,
        workflow_namespace: input.workflowNamespace,
        turn_id: input.turnId ?? null,
        thread_id: input.threadId ?? null,
        stage: input.stage,
        status: 'run_complete',
        phase: input.phase,
        prompt: input.prompt,
        review_summary: {},
        run_complete_payload: input.runCompletePayload,
        started_at: input.startedAt ? new Date(input.startedAt) : null,
        finished_at: input.finishedAt ? new Date(input.finishedAt) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return enforceSingleActiveRun(rowToRun(inserted as Record<string, unknown>))
  }

  const attachNotify = async (input: AttachNotifyInput) => {
    const row = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('workflow_name', '=', input.workflowName)
      .where('workflow_namespace', '=', input.workflowNamespace ?? null)
      .executeTakeFirst()
    if (!row) {
      if (!input.repository || !input.issueNumber || !input.branch) {
        return null
      }

      const priorRuns = await db
        .selectFrom('codex_judge.runs')
        .select(['attempt'])
        .where('repository', '=', input.repository)
        .where('issue_number', '=', input.issueNumber)
        .execute()
      const attempt = priorRuns.reduce((max, row) => Math.max(max, Number(row.attempt ?? 0)), 0) + 1

      const inserted = await db
        .insertInto('codex_judge.runs')
        .values({
          repository: input.repository,
          issue_number: input.issueNumber,
          branch: input.branch,
          attempt,
          workflow_name: input.workflowName,
          workflow_namespace: input.workflowNamespace ?? null,
          status: 'notified',
          prompt: input.prompt ?? null,
          review_summary: {},
          notify_payload: input.notifyPayload,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return enforceSingleActiveRun(rowToRun(inserted as Record<string, unknown>))
    }

    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        repository: input.repository && input.repository.length > 0 ? input.repository : row.repository,
        issue_number: input.issueNumber ?? row.issue_number,
        branch: input.branch && input.branch.length > 0 ? input.branch : row.branch,
        prompt: input.prompt ?? row.prompt,
        notify_payload: input.notifyPayload,
        updated_at: sql`now()`,
      })
      .where('id', '=', String(row.id))
      .returningAll()
      .executeTakeFirstOrThrow()

    return enforceSingleActiveRun(rowToRun(updated as Record<string, unknown>))
  }

  const updateCiStatus = async (input: UpdateCiInput) => {
    const existing = await db
      .selectFrom('codex_judge.runs')
      .select(['ci_status', 'ci_status_updated_at', 'commit_sha'])
      .where('id', '=', input.runId)
      .executeTakeFirst()
    const existingStatus = existing?.ci_status ? String(existing.ci_status) : null
    const existingCommitSha = existing?.commit_sha ? String(existing.commit_sha) : null
    const statusChanged = existingStatus !== input.status
    const commitChanged = input.commitSha ? input.commitSha !== existingCommitSha : false
    const shouldBumpStatus = statusChanged || commitChanged || !existing?.ci_status_updated_at
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        ci_status: input.status,
        ci_url: input.url ?? null,
        commit_sha: input.commitSha ?? sql`coalesce(commit_sha, commit_sha)`,
        ci_status_updated_at: shouldBumpStatus ? sql`now()` : (existing?.ci_status_updated_at ?? sql`now()`),
        updated_at: sql`now()`,
      })
      .where('id', '=', input.runId)
      .returningAll()
      .executeTakeFirst()

    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateReviewStatus = async (input: UpdateReviewInput) => {
    const existing = await db
      .selectFrom('codex_judge.runs')
      .select(['review_status', 'review_status_updated_at'])
      .where('id', '=', input.runId)
      .executeTakeFirst()
    const existingStatus = existing?.review_status ? String(existing.review_status) : null
    const statusChanged = existingStatus !== input.status
    const shouldBumpStatus = statusChanged || !existing?.review_status_updated_at
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        review_status: input.status,
        review_summary: input.summary,
        review_status_updated_at: shouldBumpStatus ? sql`now()` : (existing?.review_status_updated_at ?? sql`now()`),
        updated_at: sql`now()`,
      })
      .where('id', '=', input.runId)
      .returningAll()
      .executeTakeFirst()

    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateDecision = async (input: UpdateDecisionInput) => {
    const inserted = await db
      .insertInto('codex_judge.evaluations')
      .values({
        run_id: input.runId,
        decision: input.decision,
        confidence: input.confidence ?? null,
        reasons: input.reasons ?? {},
        missing_items: input.missingItems ?? {},
        suggested_fixes: input.suggestedFixes ?? {},
        next_prompt: input.nextPrompt ?? null,
        prompt_tuning: input.promptTuning ?? {},
        system_suggestions: input.systemSuggestions ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await db
      .updateTable('codex_judge.runs')
      .set({
        status: input.decision === 'pass' ? 'completed' : input.decision,
        next_prompt: input.nextPrompt ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', input.runId)
      .where('status', 'not in', ['superseded'])
      .execute()

    return rowToEvaluation(inserted as Record<string, unknown>)
  }

  const updateRunStatus = async (runId: string, status: string) => {
    let query = db.updateTable('codex_judge.runs').set({ status, updated_at: sql`now()` }).where('id', '=', runId)
    if (status !== 'superseded') {
      query = query.where('status', 'not in', ['superseded'])
    }
    const updated = await query.returningAll().executeTakeFirst()
    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateRunPrompt = async (runId: string, prompt: string | null, nextPrompt?: string | null) => {
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        prompt,
        next_prompt: nextPrompt ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirst()
    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateRunPrInfo = async (runId: string, prNumber: number, prUrl: string, commitSha?: string | null) => {
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        pr_number: prNumber,
        pr_url: prUrl,
        commit_sha: commitSha ?? sql`coalesce(commit_sha, commit_sha)`,
        updated_at: sql`now()`,
      })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirst()
    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const listRunsByStatus = async (statuses: string[]): Promise<CodexPendingRun[]> => {
    if (statuses.length === 0) return []
    const rows = await db
      .selectFrom('codex_judge.runs')
      .select(['id', 'status', 'updated_at'])
      .where('status', 'in', statuses)
      .orderBy('updated_at asc')
      .execute()

    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      updatedAt: String(row.updated_at),
    }))
  }

  const upsertArtifacts = async (input: UpsertArtifactsInput) => {
    if (input.artifacts.length === 0) return []

    const rows: CodexArtifactRecord[] = []
    for (const artifact of input.artifacts) {
      const existing = await db
        .selectFrom('codex_judge.artifacts')
        .selectAll()
        .where('run_id', '=', input.runId)
        .where('name', '=', artifact.name)
        .executeTakeFirst()

      const payload = {
        run_id: input.runId,
        name: artifact.name,
        key: artifact.key,
        bucket: artifact.bucket ?? null,
        url: artifact.url ?? null,
        metadata: artifact.metadata ?? {},
      }

      if (existing) {
        const updated = await db
          .updateTable('codex_judge.artifacts')
          .set({
            key: payload.key,
            bucket: payload.bucket,
            url: payload.url,
            metadata: payload.metadata,
          })
          .where('id', '=', String(existing.id))
          .returningAll()
          .executeTakeFirstOrThrow()
        rows.push(rowToArtifact(updated as Record<string, unknown>))
      } else {
        const inserted = await db
          .insertInto('codex_judge.artifacts')
          .values(payload)
          .returningAll()
          .executeTakeFirstOrThrow()
        rows.push(rowToArtifact(inserted as Record<string, unknown>))
      }
    }

    return rows
  }

  const claimRerunSubmission = async (input: ClaimRerunSubmissionInput) => {
    const updated = await db
      .updateTable('codex_judge.rerun_submissions')
      .set({
        status: 'pending',
        submission_attempt: sql`submission_attempt + 1`,
        response_status: null,
        error: null,
        updated_at: sql`now()`,
      })
      .where('parent_run_id', '=', input.parentRunId)
      .where('attempt', '=', input.attempt)
      .where('status', 'in', ['failed', 'pending'])
      .returningAll()
      .executeTakeFirst()

    if (updated) {
      return { submission: rowToRerunSubmission(updated as Record<string, unknown>), shouldSubmit: true }
    }

    const inserted = await db
      .insertInto('codex_judge.rerun_submissions')
      .values({
        parent_run_id: input.parentRunId,
        attempt: input.attempt,
        delivery_id: input.deliveryId,
        status: 'pending',
        submission_attempt: 1,
      })
      .onConflict((oc) => oc.columns(['parent_run_id', 'attempt']).doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) {
      return { submission: rowToRerunSubmission(inserted as Record<string, unknown>), shouldSubmit: true }
    }

    const existing = await db
      .selectFrom('codex_judge.rerun_submissions')
      .selectAll()
      .where('parent_run_id', '=', input.parentRunId)
      .where('attempt', '=', input.attempt)
      .executeTakeFirst()

    if (existing) {
      return { submission: rowToRerunSubmission(existing as Record<string, unknown>), shouldSubmit: false }
    }

    const existingByDelivery = await db
      .selectFrom('codex_judge.rerun_submissions')
      .selectAll()
      .where('delivery_id', '=', input.deliveryId)
      .executeTakeFirst()

    return existingByDelivery
      ? { submission: rowToRerunSubmission(existingByDelivery as Record<string, unknown>), shouldSubmit: false }
      : null
  }

  const updateRerunSubmission = async (input: UpdateRerunSubmissionInput) => {
    const update: Record<string, unknown> = { status: input.status, updated_at: sql`now()` }
    if (input.responseStatus !== undefined) {
      update.response_status = input.responseStatus
    }
    if (input.error !== undefined) {
      update.error = input.error
    }
    if (input.submittedAt !== undefined) {
      update.submitted_at = input.submittedAt ? new Date(input.submittedAt) : null
    }

    const updated = await db
      .updateTable('codex_judge.rerun_submissions')
      .set(update)
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirst()

    return updated ? rowToRerunSubmission(updated as Record<string, unknown>) : null
  }

  const createPromptTuning = async (
    runId: string,
    prUrl: string,
    status: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const inserted = await db
      .insertInto('codex_judge.prompt_tuning')
      .values({
        run_id: runId,
        pr_url: prUrl,
        status,
        metadata,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return rowToPromptTuning(inserted as Record<string, unknown>)
  }

  const close = async () => {
    await db.destroy()
  }

  return {
    ready,
    upsertRunComplete,
    attachNotify,
    updateCiStatus,
    updateReviewStatus,
    updateDecision,
    updateRunStatus,
    updateRunPrompt,
    updateRunPrInfo,
    upsertArtifacts,
    listRunsByStatus,
    claimRerunSubmission,
    updateRerunSubmission,
    getRunByWorkflow,
    getRunById,
    listRunsByIssue,
    listRunsByBranch,
    listRunsByCommitSha,
    listRunsByPrNumber,
    getRunHistory,
    listRecentRuns,
    listIssueSummaries,
    getLatestPromptTuningByIssue,
    createPromptTuning,
    close,
  }
}

export const __private = {
  isTerminalRunStatus,
  selectActiveRun,
  planSupersession,
  computeRunStats,
}
