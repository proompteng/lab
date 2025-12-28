import type { CodexRunRecord } from '../codex-judge-store'

const TERMINAL_RUN_STATUS_LIST = ['completed', 'needs_human', 'superseded'] as const
const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATUS_LIST)

const isTerminalRunStatus = (status: string) => TERMINAL_RUN_STATUSES.has(status)

const parseTimestamp = (value: string | null) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const getRunSortKey = (run: CodexRunRecord) => {
  const finished = parseTimestamp(run.finishedAt)
  const started = parseTimestamp(run.startedAt)
  const created = parseTimestamp(run.createdAt) ?? 0
  const primary = finished ?? started ?? created
  return { primary, created, attempt: run.attempt }
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

const computeRunStats = (
  runs: CodexRunRecord[],
  evaluations: Map<string, { decision: string; confidence: number | null; reasons: Record<string, unknown> } | null>,
) => {
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
    const error = typeof evaluation.reasons.error === 'string' ? evaluation.reasons.error : null
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

export const storePrivate = {
  isTerminalRunStatus,
  selectActiveRun,
  planSupersession,
  computeRunStats,
}

export { planSupersession }
