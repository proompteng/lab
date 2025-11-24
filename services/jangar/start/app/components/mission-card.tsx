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
    <article className="card mission-card" aria-label={`${mission.title} mission`}>
      <header className="card-header">
        <div className="title-row">
          <div>
            <p className="eyebrow">{mission.repo}</p>
            <h2 className="card-title">{mission.title}</h2>
          </div>
          <StatusPill status={status.label} tone={status.tone} />
        </div>
        <p className="card-summary">{mission.summary}</p>
      </header>
      <dl className="meta-grid">
        <div>
          <dt>Owner</dt>
          <dd>{mission.owner}</dd>
        </div>
        <div>
          <dt>Last update</dt>
          <dd>{formatRelativeTime(mission.updatedAt)}</dd>
        </div>
        <div>
          <dt>ETA</dt>
          <dd>{mission.eta ?? 'TBD'}</dd>
        </div>
      </dl>
      <div className="progress-row">
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Progress"
          aria-valuenow={Math.round(mission.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-fill" style={{ width: `${mission.progress * 100}%` }} />
        </div>
        <span className="progress-value">{Math.round(mission.progress * 100)}%</span>
      </div>
      <div className="tag-row">
        {mission.tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
          </span>
        ))}
      </div>
      <footer className="card-footer">
        <p className="muted">Snapshot: {formatShortDate(mission.updatedAt)}</p>
        <Link to="/mission/$id" params={{ id: mission.id }} className="button ghost" preload="intent">
          Open mission
        </Link>
      </footer>
    </article>
  )
}

const toneToClass: Record<'info' | 'warn' | 'ok' | 'error', string> = {
  info: 'pill info',
  warn: 'pill warn',
  ok: 'pill ok',
  error: 'pill error',
}

const StatusPill = ({ status, tone }: { status: string; tone: keyof typeof toneToClass }) => (
  <span className={toneToClass[tone]} aria-live="polite">
    {status}
  </span>
)
