import { Link } from '@tanstack/react-router'
import { formatRelativeTime, formatShortDate } from '../lib/time'
import type { Mission } from '../lib/types'

const statusCopy: Record<Mission['status'], { label: string; tone: 'info' | 'warn' | 'ok' | 'error' }> = {
  running: { label: 'Running', tone: 'info' },
  pending: { label: 'Pending', tone: 'warn' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
}

export const MissionCard = ({ mission }: { mission: Mission }) => {
  const status = statusCopy[mission.status]

  return (
    <article className="card flex h-full flex-col gap-3 p-4" aria-label={`${mission.title} mission`}>
      <header className="flex items-start gap-3">
        <div className="flex-1 space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">{mission.repo}</p>
          <h2 className="text-lg font-semibold text-slate-50 leading-snug">{mission.title}</h2>
          <p className="text-sm text-slate-300 line-clamp-2">{mission.summary}</p>
        </div>
        <StatusPill status={status.label} tone={status.tone} />
      </header>

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span className="font-medium text-slate-200">{mission.owner}</span>
        <span aria-hidden="true">•</span>
        <span>{formatRelativeTime(mission.updatedAt)}</span>
        {mission.eta ? (
          <>
            <span aria-hidden="true">•</span>
            <span>ETA {mission.eta}</span>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <div
          className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800"
          role="progressbar"
          aria-label="Progress"
          aria-valuenow={Math.round(mission.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-sky-500"
            style={{ width: `${mission.progress * 100}%` }}
          />
        </div>
        <span className="font-mono text-slate-200">{Math.round(mission.progress * 100)}%</span>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-slate-200">
        {mission.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="rounded-full bg-slate-800 px-3 py-1">
            {tag}
          </span>
        ))}
      </div>

      <footer className="mt-auto flex items-center justify-between text-xs text-slate-400">
        <p>Snapshot {formatShortDate(mission.updatedAt)}</p>
        <Link
          to="/mission/$id"
          params={{ id: mission.id }}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-slate-50 hover:border-sky-400 hover:text-sky-100"
          preload="intent"
        >
          Open
        </Link>
      </footer>
    </article>
  )
}

const toneToClass: Record<'info' | 'warn' | 'ok' | 'error', string> = {
  info: 'pill pill-info',
  warn: 'pill pill-warn',
  ok: 'pill pill-ok',
  error: 'pill pill-error',
}

const StatusPill = ({ status, tone }: { status: string; tone: keyof typeof toneToClass }) => (
  <span className={toneToClass[tone]} aria-live="polite">
    {status}
  </span>
)
