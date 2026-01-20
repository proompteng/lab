import { Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  ConditionsList,
  DescriptionList,
  deriveStatusLabel,
  EventsList,
  getMetadataValue,
  getStatusConditions,
  StatusBadge,
  YamlCodeBlock,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE } from '@/components/agents-control-plane-search'
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

export type PrimitiveField = {
  label: string
  value: React.ReactNode
}

type ControlPlaneDetailRoute =
  | '/agents-control-plane/agents/$name'
  | '/agents-control-plane/agent-runs/$name'
  | '/agents-control-plane/agent-providers/$name'
  | '/agents-control-plane/implementation-specs/$name'
  | '/agents-control-plane/implementation-sources/$name'
  | '/agents-control-plane/memories/$name'
  | '/agents-control-plane/orchestrations/$name'
  | '/agents-control-plane/orchestration-runs/$name'
  | '/agents-control-plane/tools/$name'
  | '/agents-control-plane/tool-runs/$name'
  | '/agents-control-plane/signals/$name'
  | '/agents-control-plane/signal-deliveries/$name'
  | '/agents-control-plane/approval-policies/$name'
  | '/agents-control-plane/budgets/$name'
  | '/agents-control-plane/secret-bindings/$name'
  | '/agents-control-plane/schedules/$name'
  | '/agents-control-plane/artifacts/$name'
  | '/agents-control-plane/workspaces/$name'

type ControlPlaneListRoute =
  | '/agents-control-plane/agents'
  | '/agents-control-plane/agent-runs'
  | '/agents-control-plane/agent-providers'
  | '/agents-control-plane/implementation-specs'
  | '/agents-control-plane/implementation-sources'
  | '/agents-control-plane/memories'
  | '/agents-control-plane/orchestrations'
  | '/agents-control-plane/orchestration-runs'
  | '/agents-control-plane/tools'
  | '/agents-control-plane/tool-runs'
  | '/agents-control-plane/signals'
  | '/agents-control-plane/signal-deliveries'
  | '/agents-control-plane/approval-policies'
  | '/agents-control-plane/budgets'
  | '/agents-control-plane/secret-bindings'
  | '/agents-control-plane/schedules'
  | '/agents-control-plane/artifacts'
  | '/agents-control-plane/workspaces'

type PrimitiveListPageProps = {
  kind: AgentPrimitiveKind
  title: string
  description: string
  groupLabel: string
  emptyLabel: string
  statusLabel: (count: number) => string
  errorLabel: string
  detailTo: ControlPlaneDetailRoute
  buildFields: (resource: PrimitiveResource) => PrimitiveField[]
  searchState: { namespace: string }
  onNavigate: (namespace: string) => void
}

export function PrimitiveListPage({
  kind,
  title,
  description,
  groupLabel,
  emptyLabel,
  statusLabel,
  errorLabel,
  detailTo,
  buildFields,
  searchState,
  onNavigate,
}: PrimitiveListPageProps) {
  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [items, setItems] = React.useState<PrimitiveResource[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

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
        setStatus(statusLabel(result.items.length))
      } catch (err) {
        setItems([])
        setTotal(0)
        setError(err instanceof Error ? err.message : `Failed to load ${errorLabel}`)
      } finally {
        setIsLoading(false)
      }
    },
    [kind, statusLabel, errorLabel],
  )

  React.useEffect(() => {
    void load(searchState.namespace)
  }, [load, searchState.namespace])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onNavigate(namespace.trim() || DEFAULT_NAMESPACE)
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{groupLabel}</p>
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{total}</span> total
        </div>
      </header>

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label className="text-xs font-medium text-foreground" htmlFor={namespaceId}>
            Namespace
          </label>
          <Input
            id={namespaceId}
            name="namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="jangar"
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
            const status = deriveStatusLabel(resource)
            const fields = buildFields(resource)
            return (
              <li key={`${resourceNamespace}/${name}`} className="border-b border-border last:border-b-0">
                <Link
                  to={detailTo}
                  params={{ name }}
                  search={{ namespace: resourceNamespace }}
                  className="block space-y-3 p-4 transition hover:bg-muted/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-foreground">{name}</div>
                      <div className="text-xs text-muted-foreground">{resourceNamespace}</div>
                    </div>
                    <StatusBadge label={status} />
                  </div>
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                    {fields.map((field) => (
                      <div key={field.label} className="space-y-0.5">
                        <div className="uppercase tracking-wide text-[10px]">{field.label}</div>
                        <div className="text-foreground">{field.value}</div>
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

type PrimitiveDetailPageProps = {
  kind: AgentPrimitiveKind
  title: string
  description: string
  groupLabel: string
  backTo: ControlPlaneListRoute
  errorLabel: string
  name: string
  searchState: { namespace: string }
  buildSummary: (resource: Record<string, unknown>, namespace: string) => PrimitiveField[]
}

export function PrimitiveDetailPage({
  kind,
  title,
  description,
  groupLabel,
  backTo,
  errorLabel,
  name,
  searchState,
  buildSummary,
}: PrimitiveDetailPageProps) {
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
      const result = await fetchPrimitiveDetail({ kind, name, namespace: searchState.namespace })
      if (!result.ok) {
        setResource(null)
        setEvents([])
        setError(result.message)
        return
      }
      setResource(result.resource)
      const uid = getMetadataValue(result.resource, 'uid')
      const eventsResult = await fetchPrimitiveEvents({ kind, name, namespace: searchState.namespace, uid })
      if (eventsResult.ok) {
        setEvents(eventsResult.items)
      } else {
        setEvents([])
        setEventsError(eventsResult.message)
      }
    } catch (err) {
      setResource(null)
      setEvents([])
      setError(err instanceof Error ? err.message : `Failed to load ${errorLabel}`)
    } finally {
      setIsLoading(false)
    }
  }, [errorLabel, kind, name, searchState.namespace])

  React.useEffect(() => {
    void load()
  }, [load])

  const statusLabel = resource ? deriveStatusLabel(resource) : 'Unknown'
  const conditions = resource ? getStatusConditions(resource) : []
  const spec = resource && typeof resource.spec === 'object' ? resource.spec : {}
  const status = resource && typeof resource.status === 'object' ? resource.status : {}

  const summaryItems = resource ? buildSummary(resource, searchState.namespace) : []

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{groupLabel}</p>
          <h1 className="text-lg font-semibold">{name}</h1>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resource ? <StatusBadge label={statusLabel} /> : null}
          <Button variant="outline" onClick={() => void load()} disabled={isLoading}>
            Refresh
          </Button>
          <Link to={backTo} search={searchState} className={cn(buttonVariants({ variant: 'ghost', size: 'default' }))}>
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
              <h2 className="text-sm font-semibold text-foreground">{title} summary</h2>
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
