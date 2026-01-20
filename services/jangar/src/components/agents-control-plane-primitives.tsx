import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import * as React from 'react'

import {
  ConditionsList,
  DescriptionList,
  deriveStatusCategory,
  deriveStatusLabel,
  EventsList,
  formatGenerationSummary,
  formatTimestamp,
  getMetadataValue,
  getResourceCreatedAt,
  getResourceReconciledAt,
  getResourceUpdatedAt,
  getStatusConditions,
  StatusBadge,
  summarizeConditions,
  YamlCodeBlock,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, type NamespaceSearchState } from '@/components/agents-control-plane-search'
import { useControlPlaneStream } from '@/components/agents-control-plane-stream'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  type AgentPrimitiveKind,
  fetchPrimitiveDetail,
  fetchPrimitiveEvents,
  fetchPrimitiveList,
  type PrimitiveEventItem,
  type PrimitiveResource,
} from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'

type PrimitiveListField = {
  label: string
  value: (resource: PrimitiveResource) => ReactNode
}

type PrimitiveListPageProps = {
  title: string
  description: string
  kind: AgentPrimitiveKind
  emptyLabel: string
  detailPath: string
  fields: PrimitiveListField[]
  searchState: NamespaceSearchState
  onNavigate: (namespace: string) => void
  sectionLabel?: string
}

type PrimitiveDetailPageProps = {
  title: string
  description: string
  kind: AgentPrimitiveKind
  name: string
  backPath: string
  searchState: NamespaceSearchState
  summaryItems: (resource: Record<string, unknown>, namespace: string) => Array<{ label: string; value: ReactNode }>
  sectionLabel?: string
  errorLabel?: string
}

export const buildBaseSummaryItems = (resource: Record<string, unknown>, namespace: string) => [
  { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
  { label: 'Status', value: deriveStatusLabel(resource) },
  { label: 'Updated', value: formatTimestamp(getResourceUpdatedAt(resource)) },
  { label: 'Reconciled', value: formatTimestamp(getResourceReconciledAt(resource)) },
  { label: 'Observed generation', value: formatGenerationSummary(resource) },
]

export function PrimitiveListPage({
  title,
  description,
  kind,
  emptyLabel,
  detailPath,
  fields,
  searchState,
  onNavigate,
  sectionLabel = 'Agents',
}: PrimitiveListPageProps) {
  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [items, setItems] = React.useState<PrimitiveResource[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const reloadTimerRef = React.useRef<number | null>(null)

  const namespaceId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
  }, [searchState.namespace])

  const load = React.useCallback(
    async (value: string) => {
      setIsLoading(true)
      setError(null)
      setStatus(null)
      try {
        const result = await fetchPrimitiveList({ kind, namespace: value })
        if (!result.ok) {
          setItems([])
          setTotal(0)
          setError(result.message)
          return
        }
        setItems(result.items)
        setTotal(result.total)
        setStatus(result.items.length === 0 ? emptyLabel : `Loaded ${result.items.length} ${title.toLowerCase()}.`)
      } catch (err) {
        setItems([])
        setTotal(0)
        setError(err instanceof Error ? err.message : `Failed to load ${title.toLowerCase()}`)
      } finally {
        setIsLoading(false)
      }
    },
    [emptyLabel, kind, title],
  )

  React.useEffect(() => {
    void load(searchState.namespace)
  }, [load, searchState.namespace])

  const scheduleReload = React.useCallback(() => {
    if (reloadTimerRef.current !== null) return
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null
      void load(searchState.namespace)
    }, 350)
  }, [load, searchState.namespace])

  useControlPlaneStream(searchState.namespace, {
    onEvent: (event) => {
      if (event.type !== 'resource') return
      if (event.kind !== kind) return
      if (event.namespace !== searchState.namespace) return
      scheduleReload()
    },
  })

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onNavigate(namespace.trim() || DEFAULT_NAMESPACE)
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{sectionLabel}</p>
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{total}</span> total
        </div>
      </header>

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <label className="text-xs font-medium text-foreground" htmlFor={namespaceId}>
            Namespace
          </label>
          <Input
            id={namespaceId}
            name="namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="agents"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={isLoading}>
          Filter
        </Button>
        <Button type="button" variant="outline" onClick={() => void load(searchState.namespace)} disabled={isLoading}>
          Refresh
        </Button>
      </form>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}

      {items.length === 0 && !isLoading ? (
        <div className="rounded-none border border-border bg-card p-6 text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <ul className="overflow-hidden rounded-none border border-border bg-card">
          {items.map((resource) => {
            const name = getMetadataValue(resource, 'name') ?? 'unknown'
            const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
            const statusLabel = deriveStatusCategory(resource)
            const conditionSummary = summarizeConditions(resource)
            const createdAt = getResourceCreatedAt(resource)
            const updatedAt = getResourceUpdatedAt(resource)
            const reconciledAt = getResourceReconciledAt(resource)
            const generationSummary = formatGenerationSummary(resource)
            return (
              <li key={`${resourceNamespace}/${name}`} className="border-b border-border last:border-b-0">
                <Link
                  to={detailPath}
                  params={{ name }}
                  search={{ namespace: resourceNamespace }}
                  className="block space-y-3 p-4 transition hover:bg-muted/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-foreground">{name}</div>
                      <div className="text-xs text-muted-foreground">{resourceNamespace}</div>
                    </div>
                    <StatusBadge label={statusLabel} />
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Conditions</span>
                      <span className="text-foreground">{conditionSummary.summary}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Last transition</span>
                      <span className="text-foreground">{formatTimestamp(conditionSummary.lastTransitionTime)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Created</span>
                      <span className="text-foreground">{formatTimestamp(createdAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Updated</span>
                      <span className="text-foreground">{formatTimestamp(updatedAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Reconciled</span>
                      <span className="text-foreground">{formatTimestamp(reconciledAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Observed gen</span>
                      <span className="text-foreground">{generationSummary}</span>
                    </div>
                  </div>
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                    {fields.map((field) => (
                      <div key={field.label} className="space-y-0.5">
                        <div className="text-[10px] uppercase tracking-wide">{field.label}</div>
                        <div className="text-foreground">{field.value(resource)}</div>
                      </div>
                    ))}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}

export function PrimitiveDetailPage({
  title,
  description,
  kind,
  name,
  backPath,
  searchState,
  summaryItems,
  sectionLabel = 'Agents',
  errorLabel,
}: PrimitiveDetailPageProps) {
  const [resource, setResource] = React.useState<Record<string, unknown> | null>(null)
  const [events, setEvents] = React.useState<PrimitiveEventItem[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [eventsError, setEventsError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const reloadTimerRef = React.useRef<number | null>(null)

  const load = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setEventsError(null)
    try {
      const result = await fetchPrimitiveDetail({
        kind,
        name,
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
        kind,
        name,
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
      setError(err instanceof Error ? err.message : (errorLabel ?? `Failed to load ${title.toLowerCase()}`))
    } finally {
      setIsLoading(false)
    }
  }, [errorLabel, kind, name, searchState.namespace, title])

  React.useEffect(() => {
    void load()
  }, [load])

  const scheduleReload = React.useCallback(() => {
    if (reloadTimerRef.current !== null) return
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null
      void load()
    }, 350)
  }, [load])

  useControlPlaneStream(searchState.namespace, {
    onEvent: (event) => {
      if (event.type !== 'resource') return
      if (event.kind !== kind) return
      if (event.name !== name) return
      if (event.namespace !== searchState.namespace) return
      scheduleReload()
    },
  })

  const statusLabel = resource ? deriveStatusLabel(resource) : 'Unknown'
  const conditions = resource ? getStatusConditions(resource) : []
  const spec = resource && typeof resource.spec === 'object' ? resource.spec : {}
  const status = resource && typeof resource.status === 'object' ? resource.status : {}

  const summary = resource
    ? [...buildBaseSummaryItems(resource, searchState.namespace), ...summaryItems(resource, searchState.namespace)]
    : []

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{sectionLabel}</p>
          <h1 className="text-lg font-semibold">{name}</h1>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resource ? <StatusBadge label={statusLabel} /> : null}
          <Button variant="outline" onClick={() => void load()} disabled={isLoading}>
            Refresh
          </Button>
          <Link
            to={backPath}
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
              <DescriptionList items={summary} />
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
