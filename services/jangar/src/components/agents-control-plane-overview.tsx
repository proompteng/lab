import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { deriveStatusLabel, formatTimestamp, getMetadataValue, StatusBadge } from '@/components/agents-control-plane'
import { buttonVariants } from '@/components/ui/button'
import type { AgentPrimitiveKind, PrimitiveEventItem, PrimitiveResource } from '@/data/agents-control-plane'
import { fetchPrimitiveEvents, fetchPrimitiveList } from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'

type PrimitiveDefinition = {
  kind: AgentPrimitiveKind
  title: string
  description: string
  section: string
  listPath: string
  detailPath: string
}

type ControlPlaneHealth = 'Ready' | 'Degraded' | 'Unknown'

type PrimitiveTileData = {
  definition: PrimitiveDefinition
  total: number
  resources: PrimitiveResource[]
  readyCount: number
  degradedCount: number
  unknownCount: number
  health: ControlPlaneHealth
  error: string | null
}

type ProblemEntry = {
  id: string
  kind: AgentPrimitiveKind
  name: string
  namespace: string
  reason: string
  message: string | null
  type: string | null
  count: number | null
  timestamp: string | null
  detailPath: string
}

type OverviewState = {
  tiles: PrimitiveTileData[]
  problems: ProblemEntry[]
  isLoading: boolean
  error: string | null
  refresh: () => void
}

const CONTROL_PLANE_PRIMITIVES: PrimitiveDefinition[] = [
  {
    kind: 'Agent',
    title: 'Agents',
    description: 'Agent configurations and defaults.',
    section: 'Resources',
    listPath: '/agents-control-plane/agents',
    detailPath: '/agents-control-plane/agents/$name',
  },
  {
    kind: 'AgentProvider',
    title: 'Agent providers',
    description: 'Provider runtime and integration settings.',
    section: 'Resources',
    listPath: '/agents-control-plane/agent-providers',
    detailPath: '/agents-control-plane/agent-providers/$name',
  },
  {
    kind: 'ImplementationSpec',
    title: 'Implementation specs',
    description: 'Normalized implementation definitions.',
    section: 'Resources',
    listPath: '/agents-control-plane/implementation-specs',
    detailPath: '/agents-control-plane/implementation-specs/$name',
  },
  {
    kind: 'ImplementationSource',
    title: 'Implementation sources',
    description: 'Upstream feeds that generate specs.',
    section: 'Resources',
    listPath: '/agents-control-plane/implementation-sources',
    detailPath: '/agents-control-plane/implementation-sources/$name',
  },
  {
    kind: 'Tool',
    title: 'Tools',
    description: 'Tool definitions and runtime wiring.',
    section: 'Resources',
    listPath: '/agents-control-plane/tools',
    detailPath: '/agents-control-plane/tools/$name',
  },
  {
    kind: 'AgentRun',
    title: 'Agent runs',
    description: 'Execution history and status.',
    section: 'Runs',
    listPath: '/agents-control-plane/agent-runs',
    detailPath: '/agents-control-plane/agent-runs/$name',
  },
  {
    kind: 'ToolRun',
    title: 'Tool runs',
    description: 'Execution history for tools.',
    section: 'Runs',
    listPath: '/agents-control-plane/tool-runs',
    detailPath: '/agents-control-plane/tool-runs/$name',
  },
  {
    kind: 'ApprovalPolicy',
    title: 'Approvals',
    description: 'Approval policies and gates.',
    section: 'Policies',
    listPath: '/agents-control-plane/approvals',
    detailPath: '/agents-control-plane/approvals/$name',
  },
  {
    kind: 'Budget',
    title: 'Budgets',
    description: 'Budget ceilings and enforcement.',
    section: 'Policies',
    listPath: '/agents-control-plane/budgets',
    detailPath: '/agents-control-plane/budgets/$name',
  },
  {
    kind: 'SecretBinding',
    title: 'Secret bindings',
    description: 'Secret access control policies.',
    section: 'Policies',
    listPath: '/agents-control-plane/secret-bindings',
    detailPath: '/agents-control-plane/secret-bindings/$name',
  },
  {
    kind: 'Signal',
    title: 'Signals',
    description: 'Signal definitions and routing.',
    section: 'Signals',
    listPath: '/agents-control-plane/signals',
    detailPath: '/agents-control-plane/signals/$name',
  },
  {
    kind: 'SignalDelivery',
    title: 'Signal deliveries',
    description: 'Delivery records and payloads.',
    section: 'Signals',
    listPath: '/agents-control-plane/signal-deliveries',
    detailPath: '/agents-control-plane/signal-deliveries/$name',
  },
  {
    kind: 'Memory',
    title: 'Memories',
    description: 'Memory backends and health.',
    section: 'Storage',
    listPath: '/agents-control-plane/memories',
    detailPath: '/agents-control-plane/memories/$name',
  },
  {
    kind: 'Artifact',
    title: 'Artifacts',
    description: 'Artifact storage configuration.',
    section: 'Storage',
    listPath: '/agents-control-plane/artifacts',
    detailPath: '/agents-control-plane/artifacts/$name',
  },
  {
    kind: 'Workspace',
    title: 'Workspaces',
    description: 'Workspace storage definitions.',
    section: 'Storage',
    listPath: '/agents-control-plane/workspaces',
    detailPath: '/agents-control-plane/workspaces/$name',
  },
  {
    kind: 'Orchestration',
    title: 'Orchestrations',
    description: 'Orchestration templates.',
    section: 'Orchestration',
    listPath: '/agents-control-plane/orchestrations',
    detailPath: '/agents-control-plane/orchestrations/$name',
  },
  {
    kind: 'OrchestrationRun',
    title: 'Orchestration runs',
    description: 'Execution records for orchestrations.',
    section: 'Orchestration',
    listPath: '/agents-control-plane/orchestration-runs',
    detailPath: '/agents-control-plane/orchestration-runs/$name',
  },
  {
    kind: 'Schedule',
    title: 'Schedules',
    description: 'Recurring schedule definitions.',
    section: 'Orchestration',
    listPath: '/agents-control-plane/schedules',
    detailPath: '/agents-control-plane/schedules/$name',
  },
]

const CONTROL_PLANE_SECTIONS = Array.from(
  CONTROL_PLANE_PRIMITIVES.reduce((map, definition) => {
    const items = map.get(definition.section) ?? []
    items.push(definition)
    map.set(definition.section, items)
    return map
  }, new Map<string, PrimitiveDefinition[]>()),
).map(([label, items]) => ({ label, items }))

const normalizeStatus = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()

const isDegradedStatus = (value: string) => {
  const normalized = normalizeStatus(value)
  return (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('invalid') ||
    normalized.includes('degrad') ||
    normalized.includes('unhealthy') ||
    normalized.includes('not ready')
  )
}

const isReadyStatus = (value: string) => {
  const normalized = normalizeStatus(value)
  return (
    normalized.includes('ready') ||
    normalized.includes('succeeded') ||
    normalized.includes('success') ||
    normalized.includes('running') ||
    normalized.includes('completed')
  )
}

const deriveHealth = (resources: PrimitiveResource[], error: string | null): ControlPlaneHealth => {
  if (error) return 'Unknown'
  if (resources.length === 0) return 'Unknown'
  let degradedCount = 0
  let readyCount = 0
  for (const resource of resources) {
    const status = deriveStatusLabel(resource)
    if (isDegradedStatus(status)) {
      degradedCount += 1
    } else if (isReadyStatus(status)) {
      readyCount += 1
    }
  }
  if (degradedCount > 0) return 'Degraded'
  if (readyCount > 0) return 'Ready'
  return 'Unknown'
}

const summarizeResourceStatuses = (resources: PrimitiveResource[]) => {
  let readyCount = 0
  let degradedCount = 0
  let unknownCount = 0
  for (const resource of resources) {
    const status = deriveStatusLabel(resource)
    if (isDegradedStatus(status)) {
      degradedCount += 1
    } else if (isReadyStatus(status)) {
      readyCount += 1
    } else {
      unknownCount += 1
    }
  }
  return { readyCount, degradedCount, unknownCount }
}

const buildProblemEntries = (
  definition: PrimitiveDefinition,
  resource: PrimitiveResource,
  events: PrimitiveEventItem[],
  namespaceFallback: string,
) => {
  const name = getMetadataValue(resource, 'name')
  if (!name) return [] as ProblemEntry[]
  const namespace = getMetadataValue(resource, 'namespace') ?? namespaceFallback

  return events.map((event) => ({
    id: `${definition.kind}-${name}-${event.reason ?? event.message ?? 'event'}-${event.lastTimestamp ?? event.eventTime ?? 'time'}`,
    kind: definition.kind,
    name,
    namespace,
    reason: event.reason ?? 'Event',
    message: event.message ?? null,
    type: event.type ?? null,
    count: event.count ?? null,
    timestamp: event.eventTime ?? event.lastTimestamp ?? event.firstTimestamp ?? null,
    detailPath: definition.detailPath,
  }))
}

const sortEvents = (a: ProblemEntry, b: ProblemEntry) => {
  const timeA = a.timestamp ? Date.parse(a.timestamp) : 0
  const timeB = b.timestamp ? Date.parse(b.timestamp) : 0
  return timeB - timeA
}

const buildProblemsFallback = (
  definition: PrimitiveDefinition,
  resource: PrimitiveResource,
  namespaceFallback: string,
) => {
  const name = getMetadataValue(resource, 'name')
  if (!name) return [] as ProblemEntry[]
  const namespace = getMetadataValue(resource, 'namespace') ?? namespaceFallback
  const status = deriveStatusLabel(resource)

  return [
    {
      id: `${definition.kind}-${name}-status`,
      kind: definition.kind,
      name,
      namespace,
      reason: 'Degraded',
      message: `Status: ${status}`,
      type: 'Warning',
      count: null,
      timestamp: getMetadataValue(resource, 'creationTimestamp'),
      detailPath: definition.detailPath,
    },
  ]
}

export const useControlPlaneOverview = (namespace: string): OverviewState => {
  const [tiles, setTiles] = React.useState<PrimitiveTileData[]>([])
  const [problems, setProblems] = React.useState<ProblemEntry[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true)
      setError(null)
      try {
        const results = await Promise.all(
          CONTROL_PLANE_PRIMITIVES.map(async (definition) => {
            const result = await fetchPrimitiveList({ kind: definition.kind, namespace, signal })
            return { definition, result }
          }),
        )

        const nextTiles = results.map(({ definition, result }) => {
          if (!result.ok) {
            return {
              definition,
              total: 0,
              resources: [] as PrimitiveResource[],
              readyCount: 0,
              degradedCount: 0,
              unknownCount: 0,
              health: 'Unknown' as const,
              error: result.message,
            }
          }
          const { readyCount, degradedCount, unknownCount } = summarizeResourceStatuses(result.items)
          return {
            definition,
            total: result.total,
            resources: result.items,
            readyCount,
            degradedCount,
            unknownCount,
            health: deriveHealth(result.items, null),
            error: null,
          }
        })

        setTiles(nextTiles)

        const degradedResources = nextTiles
          .flatMap((tile) =>
            tile.resources.map((resource) => ({
              definition: tile.definition,
              resource,
              status: deriveStatusLabel(resource),
            })),
          )
          .filter((entry) => isDegradedStatus(entry.status))
          .slice(0, 12)

        if (degradedResources.length === 0) {
          setProblems([])
          setIsLoading(false)
          return
        }

        const eventsResponses = await Promise.all(
          degradedResources.map(async ({ definition, resource }) => {
            const name = getMetadataValue(resource, 'name')
            if (!name) {
              return { definition, resource, events: [] as PrimitiveEventItem[] }
            }
            const resourceNamespace = getMetadataValue(resource, 'namespace') ?? namespace
            const eventsResult = await fetchPrimitiveEvents({
              kind: definition.kind,
              name,
              namespace: resourceNamespace,
              limit: 5,
              signal,
            })
            return {
              definition,
              resource,
              events: eventsResult.ok ? eventsResult.items : [],
            }
          }),
        )

        const collectedEvents = eventsResponses.flatMap(({ definition, resource, events }) =>
          buildProblemEntries(definition, resource, events, namespace),
        )

        const problemsToShow = collectedEvents
          .filter((entry) => entry.type?.toLowerCase() === 'warning' || isDegradedStatus(entry.reason))
          .sort(sortEvents)
          .slice(0, 5)

        if (problemsToShow.length > 0) {
          setProblems(problemsToShow)
          setIsLoading(false)
          return
        }

        const fallback = degradedResources.flatMap(({ definition, resource }) =>
          buildProblemsFallback(definition, resource, namespace),
        )

        setProblems(fallback.slice(0, 5))
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load control plane overview')
      } finally {
        setIsLoading(false)
      }
    },
    [namespace],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const refresh = React.useCallback(() => {
    const controller = new AbortController()
    void load(controller.signal)
  }, [load])

  return { tiles, problems, isLoading, error, refresh }
}

export const ControlPlaneOverviewTile = ({
  definition,
  data,
  namespace,
  isLoading,
}: {
  definition: PrimitiveDefinition
  data?: PrimitiveTileData
  namespace: string
  isLoading: boolean
}) => {
  const resources = data?.resources ?? []
  const total = data?.total ?? 0
  const readyCount = data?.readyCount ?? 0
  const degradedCount = data?.degradedCount ?? 0
  const unknownCount = data?.unknownCount ?? 0
  const health = data?.health ?? 'Unknown'
  const error = data?.error ?? null

  const recentResources = resources.slice(0, 2)

  const primaryResource = recentResources[0]
  const primaryName = primaryResource ? getMetadataValue(primaryResource, 'name') : null
  const primaryNamespace = primaryResource ? (getMetadataValue(primaryResource, 'namespace') ?? namespace) : namespace

  return (
    <div className="flex flex-col gap-4 h-full rounded-none border p-4 border-border bg-card">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{definition.title}</h3>
          <p className="text-xs text-muted-foreground">{definition.description}</p>
        </div>
        <StatusBadge label={health} />
      </div>

      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide">Total</div>
          <div className="text-sm font-semibold text-foreground tabular-nums">{total}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide">Ready</div>
          <div className="text-sm font-semibold text-foreground tabular-nums">{readyCount}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide">Degraded</div>
          <div className="text-sm font-semibold text-foreground tabular-nums">{degradedCount}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide">Unknown</div>
          <div className="text-sm font-semibold text-foreground tabular-nums">{unknownCount}</div>
        </div>
      </div>

      {error ? (
        <div className="rounded-none border p-2 text-xs border-destructive/40 bg-destructive/10 text-destructive">
          {error}
        </div>
      ) : null}

      {isLoading && resources.length === 0 ? (
        <div className="text-xs text-muted-foreground">Loading resources...</div>
      ) : null}

      {recentResources.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Recent</div>
          <ul className="space-y-1">
            {recentResources.map((resource) => {
              const name = getMetadataValue(resource, 'name') ?? 'unknown'
              const resourceNamespace = getMetadataValue(resource, 'namespace') ?? namespace
              return (
                <li key={`${definition.kind}-${resourceNamespace}-${name}`} className="flex items-center gap-2 text-xs">
                  <span className="truncate text-foreground">{name}</span>
                  <span className="text-muted-foreground">{resourceNamespace}</span>
                  <StatusBadge label={deriveStatusLabel(resource)} />
                  <Link
                    to={definition.detailPath}
                    params={{ name }}
                    search={{ namespace: resourceNamespace }}
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    View
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap mt-auto gap-2">
        <Link
          to={definition.listPath}
          search={{ namespace }}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          Open list
        </Link>
        {primaryName ? (
          <Link
            to={definition.detailPath}
            params={{ name: primaryName }}
            search={{ namespace: primaryNamespace }}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          >
            View latest
          </Link>
        ) : null}
      </div>
    </div>
  )
}

export const ControlPlaneProblems = ({
  problems,
  namespace,
  isLoading,
  error,
}: {
  problems: ProblemEntry[]
  namespace: string
  isLoading: boolean
  error: string | null
}) => (
  <section className="rounded-none border p-4 space-y-3 border-border bg-card">
    <div className="flex items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Problems</h2>
        <p className="text-xs text-muted-foreground">Recent warnings and failures in {namespace}.</p>
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{problems.length}</span>
    </div>

    {error ? <div className="text-xs text-destructive">{error}</div> : null}
    {isLoading && problems.length === 0 ? (
      <div className="text-xs text-muted-foreground">Loading recent failures...</div>
    ) : null}

    {!isLoading && problems.length === 0 ? (
      <div className="text-xs text-muted-foreground">No recent failures detected.</div>
    ) : null}

    {problems.length > 0 ? (
      <ul className="space-y-3 text-xs">
        {problems.map((problem) => (
          <li key={problem.id} className="rounded-none border p-3 space-y-1 border-border/60 bg-muted/30">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">{problem.reason}</span>
                  {problem.type ? (
                    <span className="rounded-none border px-1.5 py-0.5 text-[10px] uppercase border-border bg-card">
                      {problem.type}
                    </span>
                  ) : null}
                  {typeof problem.count === 'number' && problem.count > 1 ? (
                    <span className="text-muted-foreground">x{problem.count}</span>
                  ) : null}
                </div>
                <div className="text-muted-foreground">
                  {problem.kind} · {problem.name}
                </div>
                <div className="text-muted-foreground">{problem.namespace}</div>
              </div>
              <span className="text-muted-foreground">{formatTimestamp(problem.timestamp)}</span>
            </div>
            {problem.message ? <div className="text-muted-foreground">{problem.message}</div> : null}
            <Link
              to={problem.detailPath}
              params={{ name: problem.name }}
              search={{ namespace: problem.namespace }}
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View details
            </Link>
          </li>
        ))}
      </ul>
    ) : null}
  </section>
)

export const controlPlaneSections = CONTROL_PLANE_SECTIONS
