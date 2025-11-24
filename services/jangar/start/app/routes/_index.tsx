import { createFileRoute } from '@tanstack/react-router'
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
    <section className="stack gap-lg" aria-label="Mission list">
      <header className="section-header">
        <div>
          <p className="eyebrow">JNG-070a · TanStack Start stub</p>
          <h1 className="page-title">Active missions</h1>
          <p className="muted">Static mocks for list/detail while the SSE + OpenWebUI wiring lands in JNG-070b/c.</p>
        </div>
      </header>
      {missions.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="mission-grid" aria-label="Mission list">
          {missions.map((mission) => (
            <li key={mission.id} className="mission-grid__item">
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
    <div className="card muted-card" aria-live="polite">
      <p className="card-title">No missions yet</p>
      <p className="muted">Once the API is wired, new missions will appear here automatically.</p>
    </div>
  )
}

function MissionListSkeleton() {
  const placeholders = ['alpha', 'bravo', 'charlie']

  return (
    <section className="stack gap-md" aria-label="Loading missions">
      <div className="skeleton-heading">
        <div className="skeleton-line" />
        <div className="skeleton-line short" />
      </div>
      <ul className="mission-grid" aria-hidden="true">
        {placeholders.map((key) => (
          <li key={key} className="mission-grid__item">
            <article className="card mission-card">
              <div className="skeleton-line w-60" />
              <div className="skeleton-line" />
              <div className="skeleton-line w-40" />
              <div className="skeleton-badge-row">
                <span className="skeleton-pill" />
                <span className="skeleton-pill" />
              </div>
              <div className="progress-track skeleton-progress" />
            </article>
          </li>
        ))}
      </ul>
    </section>
  )
}

function MissionListError({ error }: { error: Error }) {
  return (
    <div className="card error-card" role="alert">
      <p className="card-title">Could not load missions</p>
      <p className="muted">{error.message}</p>
      <button className="button" type="button" onClick={() => location.reload()}>
        Retry
      </button>
    </div>
  )
}
