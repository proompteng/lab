import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
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
    <section className="flex flex-col gap-6" aria-labelledby={headingId}>
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <Link to=".." className="inline-flex items-center text-sky-300 hover:text-sky-200" preload="intent">
            ← Back to missions
          </Link>
          <span>Updated {formatRelativeTime(mission.updatedAt)}</span>
        </div>
        <span className={`pill ${statusToneClass(statusTone)}`}>{statusLabel[mission.status]}</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <article className="card lg:col-span-2 space-y-4 p-5" aria-labelledby={headingId}>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-400">{mission.repo}</p>
            <h1 id={headingId} className="text-2xl font-semibold text-slate-50">
              {mission.title}
            </h1>
            <p className="text-sm text-slate-300">{mission.summary}</p>
          </div>
          <dl className="grid gap-4 text-sm text-slate-200 sm:grid-cols-3">
            <InfoRow label="Owner" value={mission.owner} />
            <InfoRow label="ETA" value={mission.eta ?? 'TBD'} />
            <InfoRow label="Last touch" value={formatShortDate(mission.updatedAt)} />
          </dl>
          <div className="flex items-center gap-3 text-sm">
            <div
              className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-800"
              role="progressbar"
              aria-label="Mission progress"
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
        </article>

        <aside className="card space-y-4 p-5" aria-label="Pull request placeholder">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-400">Worker PR</p>
            <h2 className="text-lg font-semibold text-slate-50">{mission.pr.title}</h2>
          </div>
          <dl className="grid gap-3 text-sm text-slate-200">
            <InfoRow label="Status" value={<span className="pill pill-info capitalize">{mission.pr.status}</span>} />
            <InfoRow label="Branch" value={<span className="font-mono text-slate-100">{mission.pr.branch}</span>} />
            <InfoRow label="Reviewer" value={mission.pr.reviewer ?? 'pending'} />
          </dl>
          <p className="text-sm text-slate-300">
            This is a stub. Once the worker activity opens a PR the link will appear here automatically.
          </p>
          <div className="flex gap-2">
            {mission.pr.url ? (
              <a
                className="inline-flex items-center rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-500"
                href={mission.pr.url}
                rel="noreferrer"
                target="_blank"
              >
                View PR
              </a>
            ) : (
              <button
                className="inline-flex items-center rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-400"
                type="button"
                disabled
              >
                Waiting for PR URL
              </button>
            )}
          </div>
        </aside>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="card space-y-4 p-5" aria-label="Conversation timeline">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-400">Chat & planning stream</p>
            <h2 className="text-lg font-semibold text-slate-50">Mock timeline</h2>
            <p className="text-sm text-slate-300">
              Messages combine plan + worker updates. SSE will hydrate this panel once connected to the API.
            </p>
          </div>
          <ol className="space-y-3" aria-live="polite">
            {mission.timeline.map((item) => (
              <TimelineEntry key={item.id} item={item} />
            ))}
          </ol>
        </article>

        <article className="card space-y-3 p-5" aria-label="Execution logs">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-400">Log tail</p>
            <h2 className="text-lg font-semibold text-slate-50">Last 10 entries</h2>
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-800">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-900/60 text-slate-300">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    Time
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    Level
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    Message
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-950/40 text-slate-200">
                {mission.logs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">{formatClock(log.at)}</td>
                    <td className="px-3 py-2">
                      <span className={`pill ${levelToneClass[log.level]}`}>{log.level}</span>
                    </td>
                    <td className="px-3 py-2">{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400" role="note">
            Placeholder only — stream wiring will replace this with live entries.
          </p>
        </article>
      </div>
    </section>
  )
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-slate-800/70 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <p className="font-semibold text-slate-100">{item.label}</p>
        <span className="pill pill-info">{item.actor}</span>
      </div>
      <p className="text-sm text-slate-300">{item.note}</p>
      <span className="font-mono text-xs text-slate-500">{formatClock(item.at)}</span>
    </li>
  )
}

function MissionDetailSkeleton() {
  return (
    <section className="space-y-4" aria-label="Loading mission">
      <div className="h-4 w-40 rounded bg-slate-800" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card h-44 animate-pulse bg-slate-900/70 lg:col-span-2" />
        <div className="card h-44 animate-pulse bg-slate-900/70" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card h-64 animate-pulse bg-slate-900/70" />
        <div className="card h-64 animate-pulse bg-slate-900/70" />
      </div>
    </section>
  )
}

function MissionDetailError({ error }: { error: Error }) {
  return (
    <div className="card space-y-2 border-rose-800/70 bg-rose-950/70 p-5" role="alert">
      <p className="text-lg font-semibold text-rose-100">Mission unavailable</p>
      <p className="text-sm text-rose-200">{error.message}</p>
      <Link
        to=".."
        className="inline-flex items-center rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-500"
      >
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

const levelToneClass: Record<'info' | 'warn' | 'error', string> = {
  info: 'pill pill-info',
  warn: 'pill pill-warn',
  error: 'pill pill-error',
}

const statusToneClass = (tone: string) =>
  `pill ${tone === 'info' ? 'pill-info' : tone === 'warn' ? 'pill-warn' : tone === 'ok' ? 'pill-ok' : 'pill-error'}`

const InfoRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="space-y-1">
    <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
    <dd>{value}</dd>
  </div>
)
