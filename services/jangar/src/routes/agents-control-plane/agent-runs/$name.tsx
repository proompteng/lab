import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  ConditionsList,
  DescriptionList,
  deriveStatusLabel,
  EventsList,
  formatTimestamp,
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

export const Route = createFileRoute('/agents-control-plane/agent-runs/$name')({
  validateSearch: parseNamespaceSearch,
  component: AgentRunDetailPage,
})

const isUrl = (value: string) => value.startsWith('http://') || value.startsWith('https://')

type ActivityEntry = {
  name: string
  status: string | null
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  logs: string[]
}

const readText = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return null
}

const readTextFromKeys = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = readText(record[key])
    if (value) return value
  }
  return null
}

const asRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const collectLogLinks = (value: unknown, depth = 0, links = new Set<string>()) => {
  if (depth > 4 || value == null) return links
  if (typeof value === 'string') {
    if (isUrl(value) && value.toLowerCase().includes('log')) {
      links.add(value)
    }
    return links
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectLogLinks(entry, depth + 1, links)
    }
    return links
  }
  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      if (key.toLowerCase().includes('log') && typeof entry === 'string' && isUrl(entry)) {
        links.add(entry)
      } else {
        collectLogLinks(entry, depth + 1, links)
      }
    })
  }
  return links
}

const normalizeActivityEntry = (entry: Record<string, unknown>, index: number): ActivityEntry => {
  const name =
    readTextFromKeys(entry, ['name', 'step', 'title', 'id']) ??
    readTextFromKeys(entry, ['stage', 'task']) ??
    `Step ${index + 1}`
  const status = readTextFromKeys(entry, ['phase', 'status', 'state', 'result'])
  const startedAt = readTextFromKeys(entry, ['startedAt', 'startTime', 'started', 'started_at'])
  const finishedAt = readTextFromKeys(entry, ['finishedAt', 'finished', 'completedAt', 'endTime'])
  const message = readTextFromKeys(entry, ['message', 'reason', 'detail', 'summary'])
  const logs = Array.from(collectLogLinks(entry))
  return { name, status, startedAt, finishedAt, message, logs }
}

const extractActivityEntries = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status) ?? {}
  const candidates = [
    { label: 'steps', items: status.steps },
    { label: 'stepStatuses', items: status.stepStatuses },
    { label: 'activity', items: status.activity ?? status.activities },
    { label: 'timeline', items: status.timeline ?? status.events },
    { label: 'artifacts', items: status.artifacts },
  ]

  for (const candidate of candidates) {
    const rawItems = asArray(candidate.items)
    const items = rawItems.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    if (items.length > 0) {
      return {
        source: candidate.label,
        entries: items.map((entry, index) => normalizeActivityEntry(entry, index)),
      }
    }
  }

  return { source: null, entries: [] as ActivityEntry[] }
}

function AgentRunDetailPage() {
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
        kind: 'AgentRun',
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
        kind: 'AgentRun',
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
      setError(err instanceof Error ? err.message : 'Failed to load agent run')
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
  const runtimeType = resource ? readNestedValue(resource, ['spec', 'runtime', 'type']) : null
  const runtimeRefRaw =
    resource && typeof resource.status === 'object' ? (resource.status as Record<string, unknown>) : {}
  const runtimeRef =
    typeof runtimeRefRaw?.runtimeRef === 'string'
      ? runtimeRefRaw.runtimeRef
      : runtimeRefRaw?.runtimeRef
        ? JSON.stringify(runtimeRefRaw.runtimeRef, null, 2)
        : null
  const phase = resource ? readNestedValue(resource, ['status', 'phase']) : null
  const logLinks = resource ? Array.from(collectLogLinks(status)) : []
  const activity = resource ? extractActivityEntries(resource) : { source: null, entries: [] as ActivityEntry[] }
  const recentEvents = events.slice(0, 5)

  const summaryItems = resource
    ? [
        ...buildBaseSummaryItems(resource, searchState.namespace),
        { label: 'Agent', value: readNestedValue(resource, ['spec', 'agentRef', 'name']) ?? '—' },
        {
          label: 'Implementation',
          value:
            readNestedValue(resource, ['spec', 'implementationSpecRef', 'name']) ??
            readNestedValue(resource, ['spec', 'implementation', 'inline', 'title']) ??
            '—',
        },
        { label: 'Runtime type', value: runtimeType ?? '—' },
        { label: 'Phase', value: phase ?? '—' },
      ]
    : []

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">{params.name}</h1>
          <p className="text-xs text-muted-foreground">Agent run execution details.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resource ? <StatusBadge label={statusLabel} /> : null}
          <Button variant="outline" onClick={() => void load()} disabled={isLoading}>
            Refresh
          </Button>
          <Link
            to="/agents-control-plane/agent-runs"
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
                <h2 className="text-sm font-semibold text-foreground">Runtime</h2>
                <DescriptionList
                  items={[
                    { label: 'Runtime type', value: runtimeType ?? '—' },
                    { label: 'Runtime ref', value: runtimeRef ?? '—' },
                    { label: 'Phase', value: phase ?? '—' },
                    {
                      label: 'Started',
                      value: formatTimestamp(readNestedValue(resource ?? {}, ['status', 'startedAt'])),
                    },
                    {
                      label: 'Finished',
                      value: formatTimestamp(readNestedValue(resource ?? {}, ['status', 'finishedAt'])),
                    },
                  ]}
                />
                {logLinks.length > 0 ? (
                  <div className="space-y-2 text-xs">
                    <div className="font-semibold text-foreground">Log links</div>
                    <ul className="space-y-1">
                      {logLinks.map((link) => (
                        <li key={link}>
                          <a
                            className="text-sky-600 underline-offset-2 hover:underline"
                            href={link}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {link}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">No log links reported.</div>
                )}
              </div>

              <div className="space-y-3 rounded-none border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">Activity timeline</h2>
                  {activity.source ? (
                    <span className="rounded-none border border-border bg-muted px-2 py-0.5 text-[10px] uppercase">
                      {activity.source}
                    </span>
                  ) : null}
                </div>
                {activity.entries.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No activity steps reported.</div>
                ) : (
                  <ul className="space-y-3 border-l border-border pl-4">
                    {activity.entries.map((entry, index) => (
                      <li key={`${entry.name}-${index}`} className="space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-foreground">{entry.name}</span>
                          {entry.status ? <StatusBadge label={entry.status} /> : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                          {entry.startedAt ? <span>Started: {formatTimestamp(entry.startedAt)}</span> : null}
                          {entry.finishedAt ? <span>Finished: {formatTimestamp(entry.finishedAt)}</span> : null}
                        </div>
                        {entry.message ? <div className="text-muted-foreground">{entry.message}</div> : null}
                        {entry.logs.length > 0 ? (
                          <div className="space-y-1 text-muted-foreground">
                            {entry.logs.map((link) => (
                              <a
                                key={link}
                                className="block text-sky-600 underline-offset-2 hover:underline"
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {link}
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="space-y-3 rounded-none border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Recent events</h2>
              <EventsList events={recentEvents} error={eventsError} emptyLabel="No recent events logged." />
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
