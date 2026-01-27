import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  ConditionsList,
  DescriptionList,
  deriveStatusLabel,
  EventsList,
  getMetadataValue,
  getStatusConditions,
  readNestedValue,
  StatusBadge,
  YamlCodeBlock,
} from '@/components/agents-control-plane'
import { buildBaseSummaryItems } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchPrimitiveDetail, fetchPrimitiveEvents, type PrimitiveEventItem } from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/agents-control-plane/implementation-sources/$name')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSourceDetailPage,
})

const readScopeTarget = (resource: Record<string, unknown>) =>
  readNestedValue(resource, ['spec', 'scope', 'repository']) ??
  readNestedValue(resource, ['spec', 'scope', 'project']) ??
  readNestedValue(resource, ['spec', 'scope', 'organization']) ??
  readNestedValue(resource, ['spec', 'scope', 'team']) ??
  readNestedValue(resource, ['spec', 'scope', 'query']) ??
  '—'

function ImplementationSourceDetailPage() {
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
        kind: 'ImplementationSource',
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
        kind: 'ImplementationSource',
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
      setError(err instanceof Error ? err.message : 'Failed to load implementation source')
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
        ...buildBaseSummaryItems(resource, searchState.namespace),
        { label: 'Provider', value: readNestedValue(resource, ['spec', 'provider']) ?? '—' },
        { label: 'Scope', value: readScopeTarget(resource) },
        { label: 'Auth secret', value: readNestedValue(resource, ['spec', 'auth', 'secretRef', 'name']) ?? '—' },
        { label: 'Webhook', value: readNestedValue(resource, ['spec', 'webhook', 'enabled']) ?? '—' },
        { label: 'Last sync', value: readNestedValue(resource, ['status', 'lastSyncedAt']) ?? '—' },
      ]
    : []

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">{params.name}</h1>
          <p className="text-xs text-muted-foreground">Implementation source details.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resource ? <StatusBadge label={statusLabel} /> : null}
          <Button variant="outline" onClick={() => void load()} disabled={isLoading}>
            Refresh
          </Button>
          <Link
            to="/agents-control-plane/implementation-sources"
            search={searchState}
            className={cn(buttonVariants({ variant: 'ghost', size: 'default' }))}
          >
            Back to list
          </Link>
        </div>
      </header>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {resource ? (
        <Tabs defaultValue="summary" className="space-y-4">
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="yaml">YAML</TabsTrigger>
            <TabsTrigger value="conditions">Conditions</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="space-y-4">
            <section className="space-y-4 rounded-none border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Summary</h2>
              <DescriptionList items={summaryItems} />
            </section>
            <section className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded-none border border-border bg-card p-4">
                <h2 className="text-sm font-semibold text-foreground">Spec snapshot</h2>
                <pre className="overflow-auto text-xs">
                  <code className="font-mono">{JSON.stringify(spec, null, 2)}</code>
                </pre>
              </div>
              <div className="space-y-3 rounded-none border border-border bg-card p-4">
                <h2 className="text-sm font-semibold text-foreground">Status snapshot</h2>
                <pre className="overflow-auto text-xs">
                  <code className="font-mono">{JSON.stringify(status, null, 2)}</code>
                </pre>
              </div>
            </section>
          </TabsContent>
          <TabsContent value="yaml">
            <section className="space-y-3 rounded-none border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Resource YAML</h2>
              <YamlCodeBlock value={resource} />
            </section>
          </TabsContent>
          <TabsContent value="conditions">
            <section className="space-y-3 rounded-none border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Conditions</h2>
              <ConditionsList conditions={conditions} />
            </section>
          </TabsContent>
          <TabsContent value="events">
            <section className="space-y-3 rounded-none border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Events</h2>
              <EventsList events={events} error={eventsError} />
            </section>
          </TabsContent>
        </Tabs>
      ) : null}
    </main>
  )
}
