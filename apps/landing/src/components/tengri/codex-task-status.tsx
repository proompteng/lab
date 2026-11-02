'use client'

import { useEffect, useState } from 'react'
import { codexRunIsTerminal, type TengriCodexRun } from '@/lib/tengri/codex-run'
import { codexTaskState, elapsedSinceSubmission, type CodexRunObservation } from './codex-task-state'

export function CodexTaskStatus({
  run,
  observation,
  degraded,
  checking,
  activity,
  canStop,
  stopping,
  onStop,
  onRetry,
}: {
  run: TengriCodexRun | null
  observation?: CodexRunObservation
  degraded: boolean
  checking: boolean
  activity?: string
  canStop: boolean
  stopping: boolean
  onStop: () => void
  onRetry: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const running = Boolean(run && !codexRunIsTerminal(run))
  const submittedAtMs = displayableTimestamp(observation?.submittedAtMs)
  const lastCheckedAtMs = displayableTimestamp(observation?.lastCheckedAtMs)
  const lastUpdateReceivedAtMs = displayableTimestamp(observation?.lastUpdateReceivedAtMs)
  useEffect(() => {
    if (!running || !submittedAtMs) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, submittedAtMs])
  if (!run && !degraded && !checking) return null
  const task = run ? codexTaskState(run.state) : null
  return (
    <section aria-label="Task status" className="shrink-0 border-b border-white/[0.08] bg-zinc-900/35 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-label-14 font-medium text-zinc-100" role="status">
          {degraded ? 'Status unavailable' : (task?.label ?? 'Checking task status')}
        </p>
        {submittedAtMs ? (
          <span className="text-label-12 text-zinc-400">
            {running ? `Since submitted: ${elapsedSinceSubmission(submittedAtMs, now)}` : 'Submitted '}
            {!running ? <Timestamp value={submittedAtMs} /> : null}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {degraded ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded px-2 py-1 text-label-12 text-blue-300 outline-none hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-blue-400"
            >
              Retry status
            </button>
          ) : null}
          {canStop ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="rounded border border-zinc-700 px-2 py-1 text-label-12 text-zinc-200 outline-none hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-50"
            >
              {stopping ? 'Requesting stop…' : run?.state.phase === 'cancelling' ? 'Retry stop' : 'Stop task'}
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-copy-14 leading-relaxed text-zinc-300">
        {degraded
          ? `The task state cannot be refreshed. ${task ? `Last confirmed state: ${task.label.toLowerCase()}.` : 'No execution outcome has been confirmed.'} Existing work may still be running.`
          : (task?.description ?? 'Checking this conversation before starting more work.')}
      </p>
      {activity && running ? (
        <p className="mt-1 truncate text-label-12 text-zinc-400" title={activity}>
          Latest activity: {activity}
        </p>
      ) : null}
      {lastCheckedAtMs || lastUpdateReceivedAtMs ? (
        <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-label-12 text-zinc-400">
          {lastUpdateReceivedAtMs ? (
            <div className="flex gap-1">
              <dt>Last update received</dt>
              <dd>
                <Timestamp value={lastUpdateReceivedAtMs} />
              </dd>
            </div>
          ) : null}
          {lastCheckedAtMs ? (
            <div className="flex gap-1">
              <dt>Last checked</dt>
              <dd>
                <Timestamp value={lastCheckedAtMs} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {task?.reason ? (
        <details className="mt-1.5 text-label-12 text-zinc-400">
          <summary className="w-fit cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-blue-400">
            Details
          </summary>
          <p className="mt-1 break-words">{task.reason}</p>
        </details>
      ) : null}
    </section>
  )
}

function Timestamp({ value }: { value: number }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleTimeString()}
    </time>
  )
}

function displayableTimestamp(value?: number) {
  return value !== undefined && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : undefined
}
