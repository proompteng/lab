import { Link } from '@tanstack/react-router'
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  CirclePlayIcon,
  FileTextIcon,
  PlugZapIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { fetchPrimitiveResources, type PrimitiveResourceSummary } from '../../control-plane/api-client'
import { Badge } from '../ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScrollArea } from '../ui/table'
import { ControlPlanePage } from './control-plane-page'

type DashboardKind =
  | 'agent-run'
  | 'agent'
  | 'agent-provider'
  | 'implementation-spec'
  | 'implementation-source'
  | 'workspace'

type DashboardResourceState = {
  resources: Record<DashboardKind, PrimitiveResourceSummary[]>
  loaded: boolean
  failed: boolean
}

type AttentionItem = {
  kind: DashboardKind
  label: string
  name: string
  namespace: string
  message: string
}

type DashboardLinkKind = 'agent-run' | 'agent' | 'agent-provider' | 'implementation-spec'

const dashboardKinds: DashboardKind[] = [
  'agent-run',
  'agent',
  'agent-provider',
  'implementation-spec',
  'implementation-source',
  'workspace',
]

const emptyResources = (): Record<DashboardKind, PrimitiveResourceSummary[]> => ({
  'agent-run': [],
  agent: [],
  'agent-provider': [],
  'implementation-spec': [],
  'implementation-source': [],
  workspace: [],
})

const useDashboardResources = () => {
  const [state, setState] = useState<DashboardResourceState>({
    resources: emptyResources(),
    loaded: false,
    failed: false,
  })

  useEffect(() => {
    let cancelled = false

    Promise.all(
      dashboardKinds.map(async (kind) => {
        try {
          const response = await fetchPrimitiveResources(kind)
          return [kind, response.items, false] as const
        } catch {
          return [kind, [], true] as const
        }
      }),
    ).then((results) => {
      if (cancelled) return
      setState({
        resources: {
          ...emptyResources(),
          ...Object.fromEntries(results.map(([kind, items]) => [kind, items])),
        },
        loaded: true,
        failed: results.every(([, , failed]) => failed),
      })
    })

    return () => {
      cancelled = true
    }
  }, [])

  return state
}

const metadataString = (resource: PrimitiveResourceSummary, key: string) => {
  const value = resource.metadata[key]
  return typeof value === 'string' ? value : ''
}

const specObject = (resource: PrimitiveResourceSummary, key: string) => {
  const value = resource.spec[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const specRefName = (resource: PrimitiveResourceSummary, key: string) => {
  const ref = specObject(resource, key)
  const name = ref?.name
  return typeof name === 'string' ? name : ''
}

const conditionList = (resource: PrimitiveResourceSummary) => {
  const conditions = resource.status.conditions
  return Array.isArray(conditions) ? (conditions as Array<Record<string, unknown>>) : []
}

const trueCondition = (resource: PrimitiveResourceSummary, types: string[]) =>
  conditionList(resource).find(
    (condition) => condition.status === 'True' && typeof condition.type === 'string' && types.includes(condition.type),
  )

const readyCondition = (resource: PrimitiveResourceSummary) =>
  conditionList(resource).find((condition) => condition.status === 'True' && condition.type === 'Ready')

const phaseOf = (resource: PrimitiveResourceSummary) => {
  const phase = resource.status.phase
  if (typeof phase === 'string' && phase.length > 0) return phase
  if (trueCondition(resource, ['Succeeded'])) return 'Succeeded'
  if (trueCondition(resource, ['Failed'])) return 'Failed'
  if (trueCondition(resource, ['InProgress', 'Progressing'])) return 'Running'
  if (readyCondition(resource)) return 'Ready'
  return '-'
}

const hasAttention = (resource: PrimitiveResourceSummary) =>
  Boolean(trueCondition(resource, ['Failed', 'Degraded', 'Blocked', 'InvalidSpec', 'Unreachable']))

const attentionMessage = (resource: PrimitiveResourceSummary) => {
  const condition = trueCondition(resource, ['Failed', 'Degraded', 'Blocked', 'InvalidSpec', 'Unreachable'])
  const message = condition?.message
  const reason = condition?.reason
  if (typeof message === 'string' && message.length > 0) return message
  if (typeof reason === 'string' && reason.length > 0) return reason
  return 'Needs attention'
}

const createdAt = (resource: PrimitiveResourceSummary) => metadataString(resource, 'creationTimestamp')

const compareNewestFirst = (left: PrimitiveResourceSummary, right: PrimitiveResourceSummary) =>
  Date.parse(createdAt(right) || '0') - Date.parse(createdAt(left) || '0')

const shortTime = (value: string) => {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return '-'
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (elapsedSeconds < 60) return 'just now'
  const elapsedMinutes = Math.round(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`
  const elapsedHours = Math.round(elapsedMinutes / 60)
  if (elapsedHours < 48) return `${elapsedHours}h ago`
  const elapsedDays = Math.round(elapsedHours / 24)
  return `${elapsedDays}d ago`
}

const phaseVariant = (phase: string): 'secondary' | 'destructive' | 'outline' => {
  if (phase === 'Succeeded' || phase === 'Ready') return 'secondary'
  if (phase === 'Failed') return 'destructive'
  return 'outline'
}

const recentAgentRuns = (runs: PrimitiveResourceSummary[]) => [...runs].sort(compareNewestFirst).slice(0, 8)

const attentionItems = (resources: Record<DashboardKind, PrimitiveResourceSummary[]>): AttentionItem[] =>
  dashboardKinds
    .flatMap((kind) =>
      resources[kind]
        .filter((resource) => hasAttention(resource))
        .sort(compareNewestFirst)
        .slice(0, kind === 'agent-run' ? 6 : 3)
        .map((resource) => ({
          kind,
          label: kindLabel(kind),
          name: metadataString(resource, 'name'),
          namespace: metadataString(resource, 'namespace') || 'agents',
          message: attentionMessage(resource),
        })),
    )
    .slice(0, 8)

const kindLabel = (kind: DashboardKind) => {
  switch (kind) {
    case 'agent-run':
      return 'AgentRun'
    case 'agent':
      return 'Agent'
    case 'agent-provider':
      return 'Agent Provider'
    case 'implementation-spec':
      return 'Implementation Spec'
    case 'implementation-source':
      return 'Implementation Source'
    case 'workspace':
      return 'Workspace'
  }
}

const readyCount = (items: PrimitiveResourceSummary[]) => items.filter((item) => readyCondition(item)).length
const attentionCount = (items: PrimitiveResourceSummary[]) => items.filter((item) => hasAttention(item)).length

export function ControlPlaneDashboard() {
  const state = useDashboardResources()
  const resources = state.resources
  const runs = resources['agent-run']
  const recentRuns = useMemo(() => recentAgentRuns(runs), [runs])
  const attention = useMemo(() => attentionItems(resources), [resources])

  const runningRuns = runs.filter((run) => phaseOf(run) === 'Running').length
  const failedRuns = runs.filter((run) => phaseOf(run) === 'Failed').length
  const succeededRuns = runs.filter((run) => phaseOf(run) === 'Succeeded').length
  const readyAgents = readyCount(resources.agent)
  const readyProviders = readyCount(resources['agent-provider'])
  const runtimeAttention = attentionCount(resources.agent) + attentionCount(resources['agent-provider'])

  return (
    <ControlPlanePage>
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">Agents Control Plane</h1>
        <p className="text-sm text-muted-foreground">
          Run AgentRuns, inspect failures, and manage the runtime primitives that back the agents service.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {!state.loaded ? (
          <>
            <DashboardSummarySkeleton icon={CirclePlayIcon} title="AgentRun Activity" />
            <DashboardSummarySkeleton icon={BotIcon} title="Runtime Readiness" />
            <DashboardSummarySkeleton icon={FileTextIcon} title="Implementation Inputs" />
          </>
        ) : (
          <>
            <DashboardSummaryCard
              icon={CirclePlayIcon}
              title="AgentRun Activity"
              primary={`${runningRuns} running`}
              detail={`${succeededRuns} succeeded, ${failedRuns} failed`}
              kind="agent-run"
            />
            <DashboardSummaryCard
              icon={BotIcon}
              title="Runtime Readiness"
              primary={`${readyAgents}/${resources.agent.length} agents ready`}
              detail={`${readyProviders}/${resources['agent-provider'].length} providers ready, ${runtimeAttention} need attention`}
              kind="agent"
            />
            <DashboardSummaryCard
              icon={FileTextIcon}
              title="Implementation Inputs"
              primary={`${resources['implementation-spec'].length} specs`}
              detail={`${resources['implementation-source'].length} sources, ${resources.workspace.length} workspaces`}
              kind="implementation-spec"
            />
          </>
        )}
      </div>

      {state.failed ? (
        <Card className="rounded-md border-destructive/50">
          <CardContent className="flex items-center gap-3">
            <AlertTriangleIcon className="size-4 text-destructive" />
            <span className="text-sm">The dashboard could not load control-plane resources.</span>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.75fr)]">
        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Recent AgentRuns</CardTitle>
            <CardDescription>
              Newest executions first, with the agent and implementation spec when present.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TableScrollArea>
              <Table className="min-w-[860px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[260px]">Name</TableHead>
                    <TableHead className="w-[110px]">Phase</TableHead>
                    <TableHead className="w-[220px]">Agent</TableHead>
                    <TableHead className="w-[220px]">Spec</TableHead>
                    <TableHead className="w-[90px] text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRuns.map((run) => {
                    const name = metadataString(run, 'name')
                    const namespace = metadataString(run, 'namespace') || 'agents'
                    const phase = phaseOf(run)
                    return (
                      <TableRow key={`${namespace}/${name}`}>
                        <TableCell className="max-w-[260px] truncate font-medium">
                          <Link
                            to="/primitives/$kind/$namespace/$name"
                            params={{ kind: 'agent-run', namespace, name }}
                            className="underline-offset-4 hover:underline"
                          >
                            {name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant={phaseVariant(phase)}>{phase}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate text-muted-foreground">
                          {specRefName(run, 'agentRef') || '-'}
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate text-muted-foreground">
                          {specRefName(run, 'implementationSpecRef') || '-'}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{shortTime(createdAt(run))}</TableCell>
                      </TableRow>
                    )
                  })}
                  {!state.loaded ? <AgentRunTableSkeleton /> : null}
                  {state.loaded && recentRuns.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        No AgentRuns found.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TableScrollArea>
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Needs Attention</CardTitle>
            <CardDescription>Failed, degraded, blocked, invalid, or unreachable resources.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {attention.map((item) => (
              <Link
                key={`${item.kind}/${item.namespace}/${item.name}`}
                to="/primitives/$kind/$namespace/$name"
                params={{ kind: item.kind, namespace: item.namespace, name: item.name }}
                className="block rounded-md border px-3 py-2 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                  <Badge variant="outline">{item.label}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.message}</p>
              </Link>
            ))}
            {state.loaded && attention.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border px-3 py-3 text-sm text-muted-foreground">
                <CheckCircle2Icon className="size-4" />
                No resources currently need attention.
              </div>
            ) : null}
            {!state.loaded ? <AttentionSkeleton /> : null}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-md">
        <CardHeader>
          <CardTitle>Runtime Inventory</CardTitle>
          <CardDescription>Operational primitives that most directly affect AgentRun execution.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {!state.loaded ? (
              <>
                <InventoryTileSkeleton icon={BotIcon} label="Agents" />
                <InventoryTileSkeleton icon={PlugZapIcon} label="Providers" />
                <InventoryTileSkeleton icon={FileTextIcon} label="Implementation Specs" />
              </>
            ) : (
              <>
                <InventoryTile
                  icon={BotIcon}
                  label="Agents"
                  count={resources.agent.length}
                  ready={readyAgents}
                  attention={attentionCount(resources.agent)}
                  kind="agent"
                />
                <InventoryTile
                  icon={PlugZapIcon}
                  label="Providers"
                  count={resources['agent-provider'].length}
                  ready={readyProviders}
                  attention={attentionCount(resources['agent-provider'])}
                  kind="agent-provider"
                />
                <InventoryTile
                  icon={FileTextIcon}
                  label="Implementation Specs"
                  count={resources['implementation-spec'].length}
                  ready={readyCount(resources['implementation-spec'])}
                  attention={attentionCount(resources['implementation-spec'])}
                  kind="implementation-spec"
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </ControlPlanePage>
  )
}

function DashboardSummarySkeleton({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <Card className="h-full rounded-md">
      <CardContent className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-sm text-muted-foreground">{title}</div>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      </CardContent>
    </Card>
  )
}

function AgentRunTableSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, index) => (
        <TableRow key={index}>
          <TableCell>
            <div className="max-w-[260px]">
              <Skeleton className="h-4 w-[220px] max-w-full" />
            </div>
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-20 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-32" />
          </TableCell>
          <TableCell>
            <div className="flex justify-end">
              <Skeleton className="h-4 w-16" />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

function AttentionSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-md border px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-40 max-w-[65%]" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-3/4" />
        </div>
      ))}
    </>
  )
}

function InventoryTileSkeleton({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="rounded-md border px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{label}</span>
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
      <Skeleton className="mt-2 h-3 w-32" />
    </div>
  )
}

function DashboardSummaryCard({
  icon: Icon,
  title,
  primary,
  detail,
  kind,
}: {
  icon: LucideIcon
  title: string
  primary: string
  detail: string
  kind: DashboardLinkKind
}) {
  return (
    <Link to="/primitives/$kind" params={{ kind }} className="block">
      <Card className="h-full rounded-md transition-colors hover:bg-muted/40">
        <CardContent className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">{title}</div>
            <div className="truncate text-lg font-semibold">{primary}</div>
            <div className="truncate text-xs text-muted-foreground">{detail}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function InventoryTile({
  icon: Icon,
  label,
  count,
  ready,
  attention,
  kind,
}: {
  icon: LucideIcon
  label: string
  count: number
  ready: number
  attention: number
  kind: DashboardLinkKind
}) {
  return (
    <Link
      to="/primitives/$kind"
      params={{ kind }}
      className="block rounded-md border px-3 py-3 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{label}</span>
        </div>
        <Badge variant="secondary">{count}</Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {ready} ready
        {attention > 0 ? `, ${attention} need attention` : ''}
      </div>
    </Link>
  )
}
