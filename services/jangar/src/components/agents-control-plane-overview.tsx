import { Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  deriveStatusCategory,
  deriveStatusLabel,
  formatTimestamp,
  getMetadataValue,
  StatusBadge,
} from '@/components/agents-control-plane'
import { useControlPlaneStream } from '@/components/agents-control-plane-stream'
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

type ControlPlaneHealth = 'Healthy' | 'Progressing' | 'Degraded' | 'Unknown'

type PrimitiveTileData = {
  definition: PrimitiveDefinition
  total: number
  resources: PrimitiveResource[]
  readyCount: number
  runningCount: number
  failedCount: number
  unknownCount: number
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
  lastUpdatedAt: string | null
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

const summarizeResourceStatuses = (resources: PrimitiveResource[]) => {
  let readyCount = 0
  let runningCount = 0
  let failedCount = 0
  let unknownCount = 0
  for (const resource of resources) {
    const status = deriveStatusCategory(resource)
    if (status === 'Failed') {
      failedCount += 1
      continue
    }
    if (status === 'Running') {
      runningCount += 1
      continue
    }
    if (status === 'Ready') {
      readyCount += 1
      continue
    }
    unknownCount += 1
  }
  return { readyCount, runningCount, failedCount, unknownCount }
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
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const reloadTimerRef = React.useRef<number | null>(null)

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
              runningCount: 0,
              failedCount: 0,
              unknownCount: 0,
              error: result.message,
            }
          }
          const { readyCount, runningCount, failedCount, unknownCount } = summarizeResourceStatuses(result.items)
          return {
            definition,
            total: result.total,
            resources: result.items,
            readyCount,
            runningCount,
            failedCount,
            unknownCount,
            error: null,
          }
        })

        setTiles(nextTiles)
        setLastUpdatedAt(new Date().toISOString())

        const degradedResources = nextTiles
          .flatMap((tile) =>
            tile.resources.map((resource) => ({
              definition: tile.definition,
              resource,
              status: deriveStatusCategory(resource),
            })),
          )
          .filter((entry) => entry.status === 'Failed')
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
          .filter((entry) => entry.type?.toLowerCase() === 'warning' || entry.reason.toLowerCase().includes('fail'))
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

  const scheduleReload = React.useCallback(() => {
    if (reloadTimerRef.current !== null) return
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null
      const controller = new AbortController()
      void load(controller.signal)
    }, 500)
  }, [load])

  useControlPlaneStream(namespace, {
    onEvent: (event) => {
      if (event.type !== 'resource') return
      if (event.namespace !== namespace) return
      scheduleReload()
    },
  })

  const refresh = React.useCallback(() => {
    const controller = new AbortController()
    void load(controller.signal)
  }, [load])

  return { tiles, problems, isLoading, error, lastUpdatedAt, refresh }
}

const deriveTileStatus = (tile: PrimitiveTileData | undefined): StatusLabel => {
  if (!tile) return 'Unknown'
  if (tile.failedCount > 0) return 'Failed'
  if (tile.runningCount > 0) return 'Running'
  if (tile.readyCount > 0) return 'Ready'
  return 'Unknown'
}

type StatusLabel = 'Ready' | 'Running' | 'Failed' | 'Unknown'

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
  const runningCount = data?.runningCount ?? 0
  const failedCount = data?.failedCount ?? 0
  const unknownCount = data?.unknownCount ?? 0
  const statusLabel = deriveTileStatus(data)
  const error = data?.error ?? null

  const primaryResource = resources[0]
  const primaryName = primaryResource ? getMetadataValue(primaryResource, 'name') : null
  const primaryNamespace = primaryResource ? (getMetadataValue(primaryResource, 'namespace') ?? namespace) : namespace

  return (
    <div className="flex flex-col gap-4 h-full rounded-none border p-4 border-border bg-card">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{definition.title}</h3>
          <p className="text-xs text-muted-foreground">{definition.description}</p>
        </div>
        <StatusBadge label={statusLabel} />
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
          <div className="text-[10px] uppercase tracking-wide">Running</div>
          <div className="text-sm font-semibold text-foreground tabular-nums">{runningCount}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide">Failed</div>
          <div className="text-sm font-semibold text-foreground tabular-nums">{failedCount}</div>
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

const summarizeControllerCounts = (tiles: PrimitiveTileData[], kinds: AgentPrimitiveKind[]) =>
  tiles.reduce(
    (acc, tile) => {
      if (!kinds.includes(tile.definition.kind)) return acc
      acc.total += tile.total
      acc.ready += tile.readyCount
      acc.running += tile.runningCount
      acc.failed += tile.failedCount
      acc.unknown += tile.unknownCount
      return acc
    },
    { total: 0, ready: 0, running: 0, failed: 0, unknown: 0 },
  )

const aggregateControllerHealth = (tiles: PrimitiveTileData[], kinds: AgentPrimitiveKind[]): ControlPlaneHealth => {
  const totals = summarizeControllerCounts(tiles, kinds)

  if (totals.failed > 0) return 'Degraded'
  if (totals.running > 0) return 'Progressing'
  if (totals.ready > 0) return 'Healthy'
  if (totals.unknown > 0) return 'Unknown'
  return 'Unknown'
}

const controllers = [
  {
    id: 'agents',
    title: 'Agents controller',
    description: 'Agents, providers, and run execution.',
    kinds: ['Agent', 'AgentProvider', 'AgentRun'] as AgentPrimitiveKind[],
  },
  {
    id: 'orchestration',
    title: 'Orchestration controller',
    description: 'Orchestrations, schedules, and runs.',
    kinds: ['Orchestration', 'OrchestrationRun', 'Schedule'] as AgentPrimitiveKind[],
  },
  {
    id: 'supporting',
    title: 'Supporting controllers',
    description: 'Tools, signals, storage, and policies.',
    kinds: [
      'Tool',
      'ToolRun',
      'Signal',
      'SignalDelivery',
      'Memory',
      'Artifact',
      'Workspace',
      'ImplementationSpec',
      'ImplementationSource',
      'Budget',
      'ApprovalPolicy',
      'SecretBinding',
    ] as AgentPrimitiveKind[],
  },
]

export const ControlPlaneControllersPanel = ({ tiles }: { tiles: PrimitiveTileData[] }) => (
  <section className="rounded-none border p-4 space-y-3 border-border bg-card">
    <div>
      <h2 className="text-sm font-semibold text-foreground">Controllers</h2>
      <p className="text-xs text-muted-foreground">Health rollups for core control-plane controllers.</p>
    </div>
    <ul className="space-y-3 text-xs">
      {controllers.map((controller) => {
        const health = aggregateControllerHealth(tiles, controller.kinds)
        const counts = summarizeControllerCounts(tiles, controller.kinds)
        return (
          <li key={controller.id} className="rounded-none border p-3 border-border/60 bg-muted/30 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-foreground">{controller.title}</div>
              <StatusBadge label={health} />
            </div>
            <div className="text-muted-foreground">{controller.description}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Total</span>
                <span className="font-medium text-foreground tabular-nums">{counts.total}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Ready</span>
                <span className="font-medium text-foreground tabular-nums">{counts.ready}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Running</span>
                <span className="font-medium text-foreground tabular-nums">{counts.running}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Failed</span>
                <span className="font-medium text-foreground tabular-nums">{counts.failed}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Unknown</span>
                <span className="font-medium text-foreground tabular-nums">{counts.unknown}</span>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  </section>
)

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
