import { createFileRoute, Link } from '@tanstack/react-router'
import { MissionCard } from '../components/mission-card'
import { fetchMissions } from '../lib/mocks'
import type { Mission } from '../lib/types'

export const Route = createFileRoute('/_index')({
  loader: () => fetchMissions(),
  pendingComponent: MissionListSkeleton,
  errorComponent: MissionListError,
  component: MissionList,
})

function MissionList() {
  const missions = Route.useLoaderData() as Mission[]

  return (
    <section className="flex flex-col gap-6" aria-label="Mission list">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-50">Active missions</h1>
        <Link
          to="."
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300 focus:ring-offset-1 focus:ring-offset-slate-900"
          aria-label="Create mission"
          preload="intent"
        >
          Create mission
        </Link>
      </header>
      {missions.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Mission list">
          {missions.map((mission) => (
            <li key={mission.id} className="h-full">
              <MissionCard mission={mission} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function EmptyState() {
  return (
    <div className="card px-4 py-6 text-slate-200" aria-live="polite">
      <p className="text-lg font-semibold">No missions yet</p>
      <p className="text-sm text-slate-400">Once the API is wired, new missions will appear here automatically.</p>
    </div>
  )
}

function MissionListSkeleton() {
  const placeholders = ['alpha', 'bravo', 'charlie']

  return (
    <section className="flex flex-col gap-4" aria-label="Loading missions">
      <div className="h-5 w-48 rounded bg-slate-800" />
      <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
        {placeholders.map((key) => (
          <div key={key} className="card h-44 animate-pulse bg-slate-900/70" />
        ))}
      </div>
    </section>
  )
}

function MissionListError({ error }: { error: Error }) {
  return (
    <div className="card space-y-2 border-rose-800/60 bg-rose-950/60 p-4" role="alert">
      <p className="text-lg font-semibold text-rose-100">Could not load missions</p>
      <p className="text-sm text-rose-200">{error.message}</p>
      <button
        className="inline-flex items-center rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-500"
        type="button"
        onClick={() => location.reload()}
      >
        Retry
      </button>
    </div>
  )
}
