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

export const storePrivate = {
  isTerminalRunStatus,
  selectActiveRun,
  planSupersession,
}

export { planSupersession }
