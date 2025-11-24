import { createFileRoute, Link } from '@tanstack/react-router'
import { useId } from 'react'
import { fetchMissionById } from '../../lib/mocks'
import { formatClock, formatRelativeTime, formatShortDate } from '../../lib/time'
import type { MissionDetail as MissionDetailType, TimelineItem } from '../../lib/types'

export const Route = createFileRoute('/mission/$id')({
  loader: ({ params }) => fetchMissionById(params.id),
  pendingComponent: MissionDetailSkeleton,
  errorComponent: MissionDetailError,
  component: MissionDetailView,
})

function MissionDetailView() {
  const mission = Route.useLoaderData() as MissionDetailType
  const statusTone = statusToneMap[mission.status]
  const headingId = useId()

  return (
    <section className="stack gap-lg mission-detail" aria-labelledby={headingId}>
      <header className="breadcrumb-row">
        <div className="crumbs">
          <Link to="/" className="link-inline" preload="intent">
            ← Back to missions
          </Link>
          <span className="muted">Updated {formatRelativeTime(mission.updatedAt)}</span>
        </div>
        <span className={`pill ${statusTone}`}>{statusLabel[mission.status]}</span>
      </header>

      <div className="detail-grid">
        <article className="card" aria-labelledby={headingId}>
          <div className="card-header">
            <p className="eyebrow">{mission.repo}</p>
            <h1 id={headingId} className="page-title">
              {mission.title}
            </h1>
            <p className="card-summary">{mission.summary}</p>
          </div>
          <dl className="meta-grid">
            <div>
              <dt>Owner</dt>
              <dd>{mission.owner}</dd>
            </div>
            <div>
              <dt>ETA</dt>
              <dd>{mission.eta ?? 'TBD'}</dd>
            </div>
            <div>
              <dt>Last touch</dt>
              <dd>{formatShortDate(mission.updatedAt)}</dd>
            </div>
          </dl>
          <div className="progress-row">
            <div
              className="progress-track"
              role="progressbar"
              aria-label="Mission progress"
              aria-valuenow={Math.round(mission.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-fill" style={{ width: `${mission.progress * 100}%` }} />
            </div>
            <span className="progress-value">{Math.round(mission.progress * 100)}%</span>
          </div>
        </article>

        <aside className="card pr-card" aria-label="Pull request placeholder">
          <header className="card-header">
            <p className="eyebrow">Worker PR</p>
            <h2 className="card-title">{mission.pr.title}</h2>
          </header>
          <dl className="meta-grid">
            <div>
              <dt>Status</dt>
              <dd className="pill info">{mission.pr.status}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd className="mono">{mission.pr.branch}</dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>{mission.pr.reviewer ?? 'pending'}</dd>
            </div>
          </dl>
          <p className="muted">
            This is a stub. Once the worker activity opens a PR the link will appear here automatically.
          </p>
          <div className="action-row">
            {mission.pr.url ? (
              <a className="button" href={mission.pr.url} rel="noreferrer" target="_blank">
                View PR
              </a>
            ) : (
              <button className="button ghost" type="button" disabled>
                Waiting for PR URL
              </button>
            )}
          </div>
        </aside>
      </div>

      <div className="detail-grid">
        <article className="card timeline-card" aria-label="Conversation timeline">
          <header className="card-header">
            <p className="eyebrow">Chat & planning stream</p>
            <h2 className="card-title">Mock timeline</h2>
            <p className="muted">
              Messages combine plan + worker updates. SSE will hydrate this panel once connected to the API.
            </p>
          </header>
          <ol className="timeline" aria-live="polite">
            {mission.timeline.map((item) => (
              <TimelineEntry key={item.id} item={item} />
            ))}
          </ol>
        </article>

        <article className="card logs-card" aria-label="Execution logs">
          <header className="card-header">
            <p className="eyebrow">Log tail</p>
            <h2 className="card-title">Last 10 entries</h2>
          </header>
          <table className="log-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Level</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {mission.logs.map((log) => (
                <tr key={log.id}>
                  <td className="mono">{formatClock(log.at)}</td>
                  <td>
                    <span className={`pill ${levelTone[log.level]}`}>{log.level}</span>
                  </td>
                  <td>{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" role="note">
            Placeholder only — stream wiring will replace this with live entries.
          </p>
        </article>
      </div>
    </section>
  )
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  return (
    <li className={`timeline-item ${item.kind}`}>
      <div>
        <p className="timeline-label">{item.label}</p>
        <p className="muted small">{item.note}</p>
      </div>
      <div className="timeline-meta">
        <span className="pill ghost">{item.actor}</span>
        <span className="mono">{formatClock(item.at)}</span>
      </div>
    </li>
  )
}

function MissionDetailSkeleton() {
  const timelineSkeletons = ['t1', 't2', 't3', 't4']
  const logSkeletons = ['l1', 'l2', 'l3', 'l4', 'l5']

  return (
    <section className="stack gap-lg" aria-label="Loading mission">
      <div className="breadcrumb-row skeleton-line w-40" />
      <div className="detail-grid">
        <article className="card">
          <div className="skeleton-line" />
          <div className="skeleton-line w-80" />
          <div className="skeleton-line w-60" />
          <div className="skeleton-progress" />
        </article>
        <article className="card">
          <div className="skeleton-line" />
          <div className="skeleton-line w-70" />
          <div className="skeleton-line w-50" />
        </article>
      </div>
      <div className="detail-grid">
        <article className="card">
          {timelineSkeletons.map((key) => (
            <div key={key} className="timeline-skeleton">
              <span className="skeleton-pill" />
              <div className="skeleton-line" />
            </div>
          ))}
        </article>
        <article className="card">
          {logSkeletons.map((key) => (
            <div key={key} className="skeleton-line" />
          ))}
        </article>
      </div>
    </section>
  )
}

function MissionDetailError({ error }: { error: Error }) {
  return (
    <div className="card error-card" role="alert">
      <p className="card-title">Mission unavailable</p>
      <p className="muted">{error.message}</p>
      <Link to="/" className="button">
        Back to missions
      </Link>
    </div>
  )
}

const statusLabel: Record<MissionDetailType['status'], string> = {
  running: 'Running',
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
}

const statusToneMap: Record<MissionDetailType['status'], string> = {
  running: 'info',
  pending: 'warn',
  completed: 'ok',
  failed: 'error',
}

const levelTone: Record<'info' | 'warn' | 'error', string> = {
  info: 'ghost',
  warn: 'warn',
  error: 'error',
}
