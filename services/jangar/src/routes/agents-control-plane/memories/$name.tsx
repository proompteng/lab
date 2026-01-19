import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  DescriptionList,
  deriveStatusLabel,
  formatTimestamp,
  getMetadataValue,
  getStatusConditions,
  readNestedValue,
  StatusBadge,
} from '@/components/agents-control-plane'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { fetchPrimitiveDetail, fetchPrimitiveEvents, type PrimitiveEventItem } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/memories/$name')({
  validateSearch: parseNamespaceSearch,
  component: MemoryDetailPage,
})

function MemoryDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  const [resource, setResource] = React.useState<Record<string, unknown> | null>(null)
  const [events, setEvents] = React.useState<PrimitiveEventItem[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [eventsError, setEventsError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setEventsError(null)
    try {
      const result = await fetchPrimitiveDetail({
        kind: 'Memory',
        name: params.name,
        namespace: searchState.namespace,
      })
      if (!result.ok) {
        setResource(null)
        setEvents([])
        setError(result.message)
        return
      }
      setResource(result.resource)
      const uid = getMetadataValue(result.resource, 'uid')
      const eventsResult = await fetchPrimitiveEvents({
        kind: 'Memory',
        name: params.name,
        namespace: searchState.namespace,
        uid,
      })
      if (eventsResult.ok) {
        setEvents(eventsResult.items)
      } else {
        setEvents([])
        setEventsError(eventsResult.message)
      }
    } catch (err) {
      setResource(null)
      setEvents([])
      setError(err instanceof Error ? err.message : 'Failed to load memory')
    } finally {
      setIsLoading(false)
    }
  }, [params.name, searchState.namespace])

  React.useEffect(() => {
    void load()
  }, [load])

  const statusLabel = resource ? deriveStatusLabel(resource) : 'Unknown'
  const conditions = resource ? getStatusConditions(resource) : []
  const spec = resource && typeof resource.spec === 'object' ? resource.spec : {}
  const status = resource && typeof resource.status === 'object' ? resource.status : {}

  const summaryItems = resource
    ? [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? searchState.namespace },
        { label: 'Type', value: readNestedValue(resource, ['spec', 'type']) ?? '—' },
        { label: 'Provider', value: readNestedValue(resource, ['spec', 'provider']) ?? '—' },
        {
          label: 'Secret',
          value: readNestedValue(resource, ['spec', 'connection', 'secretRef', 'name']) ?? '—',
        },
        { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
      ]
    : []

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">{params.name}</h1>
          <p className="text-xs text-muted-foreground">Memory backend configuration.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resource ? <StatusBadge label={statusLabel} /> : null}
          <Button variant="outline" onClick={() => void load()} disabled={isLoading}>
            Refresh
          </Button>
          <Button variant="ghost" render={<Link to="/agents-control-plane/memories" search={searchState} />}>
            Back to list
          </Button>
        </div>
      </header>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {resource ? (
        <section className="space-y-4 rounded-none border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Summary</h2>
          <DescriptionList items={summaryItems} />
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-none border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Conditions</h2>
          {conditions.length === 0 ? (
            <div className="text-xs text-muted-foreground">No conditions reported.</div>
          ) : (
            <ul className="space-y-2 text-xs">
              {conditions.map((condition) => (
                <li key={`${condition.type}-${condition.lastTransitionTime ?? 'unknown'}`} className="space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-foreground">{condition.type ?? 'Unknown'}</div>
                    <span className="text-muted-foreground">{condition.status ?? '—'}</span>
                  </div>
                  {condition.reason ? <div className="text-muted-foreground">{condition.reason}</div> : null}
                  {condition.message ? <div className="text-muted-foreground">{condition.message}</div> : null}
                  {condition.lastTransitionTime ? (
                    <div className="text-muted-foreground">{formatTimestamp(condition.lastTransitionTime)}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3 rounded-none border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Recent events</h2>
          {eventsError ? <div className="text-xs text-destructive">{eventsError}</div> : null}
          {events.length === 0 && !eventsError ? (
            <div className="text-xs text-muted-foreground">No recent events.</div>
          ) : (
            <ul className="space-y-2 text-xs">
              {events.map((event) => (
                <li key={`${event.name ?? 'event'}-${event.lastTimestamp ?? event.eventTime ?? 'time'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{event.reason ?? 'Event'}</span>
                    <span className="text-muted-foreground">
                      {formatTimestamp(event.eventTime ?? event.lastTimestamp)}
                    </span>
                  </div>
                  {event.message ? <div className="text-muted-foreground">{event.message}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {resource ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-none border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Spec</h2>
            <pre className="overflow-auto text-xs">
              <code className="font-mono">{JSON.stringify(spec, null, 2)}</code>
            </pre>
          </div>
          <div className="space-y-3 rounded-none border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Status</h2>
            <pre className="overflow-auto text-xs">
              <code className="font-mono">{JSON.stringify(status, null, 2)}</code>
            </pre>
          </div>
        </section>
      ) : null}
    </main>
  )
}
