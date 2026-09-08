import { Link } from '@tanstack/react-router'
import {
  AlertCircleIcon,
  BoxesIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FileJsonIcon,
  FileTextIcon,
  GitBranchIcon,
  HistoryIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PackageIcon,
  RefreshCwIcon,
  TerminalIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  fetchAgentRunLogs,
  fetchPrimitiveEvents,
  type AgentRunLogsResponse,
  type PrimitiveEventSummary,
} from '../../control-plane/api-client'
import {
  badgeVariantForPhase,
  extractAgentRunDetail,
  formatDateTime,
  formatRelativeAge,
  type AgentRunConditionSummary,
  type AgentRunDetailModel,
  type AgentRunRuntimeLink,
} from '../../control-plane/agentrun-detail'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScrollArea } from '../ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

const terminalEventHint = 'Terminal event acknowledgements are exposed through the AgentRun terminal-events API.'

export function AgentRunDetailPage({
  resource,
  error,
}: {
  resource: Record<string, unknown> | null
  error: string | null
}) {
  const detail = useMemo(() => (resource ? extractAgentRunDetail(resource) : null), [resource])

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {detail ? <AgentRunHeader detail={detail} /> : <AgentRunHeaderSkeleton />}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="manifest">Manifest / Status</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-2">
          {detail ? <OverviewTab detail={detail} /> : <OverviewSkeleton />}
        </TabsContent>
        <TabsContent value="logs" className="pt-2">
          {detail ? <LogsTab detail={detail} /> : <PanelSkeleton lines={10} />}
        </TabsContent>
        <TabsContent value="events" className="pt-2">
          {detail ? <EventsTab detail={detail} /> : <PanelSkeleton lines={8} />}
        </TabsContent>
        <TabsContent value="artifacts" className="pt-2">
          {detail ? <ArtifactsTab detail={detail} /> : <PanelSkeleton lines={6} />}
        </TabsContent>
        <TabsContent value="manifest" className="pt-2">
          {resource ? <ManifestStatusTab resource={resource} /> : <ManifestSkeleton />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AgentRunHeader({ detail }: { detail: AgentRunDetailModel }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={badgeVariantForPhase(detail.phase)}>{detail.phase}</Badge>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {detail.namespace}/{detail.name}
            </span>
          </div>
          <h1 className="break-words text-2xl font-semibold tracking-normal">{detail.name}</h1>
          <p className="max-w-4xl text-sm text-muted-foreground">{detail.statusSummary}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:min-w-[560px]">
          <Metric label="Age" value={detail.age} icon={ClockIcon} />
          <Metric label="Started" value={formatDateTime(detail.startedAt)} icon={CalendarClockIcon} />
          <Metric label="Completed" value={formatDateTime(detail.completedAt)} icon={CheckCircle2Icon} />
          <Metric label="Duration" value={detail.duration ?? '-'} icon={HistoryIcon} />
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof ClockIcon }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-1 break-words text-xs leading-snug font-medium sm:text-sm" title={value}>
        {value}
      </div>
    </div>
  )
}

function OverviewTab({ detail }: { detail: AgentRunDetailModel }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
      <div className="space-y-4">
        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Run Summary</CardTitle>
            <CardDescription>Execution identity, inputs, runtime, and result at a glance.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <KeyValue label="Agent" value={detail.agentName} linkKind="agent" namespace={detail.namespace} />
              <KeyValue label="Provider" value={detail.providerName} />
              <KeyValue
                label="Implementation Spec"
                value={detail.implementationSpecName}
                linkKind="implementation-spec"
                namespace={detail.namespace}
              />
              <KeyValue label="Implementation Source" value={detail.implementationSource} />
              <KeyValue label="Runtime" value={detail.runtimeType} />
              <KeyValue label="Attempts" value={detail.attemptSummary} />
              <KeyValue label="Namespace" value={detail.namespace} />
              <KeyValue label="UID" value={detail.uid} />
              <KeyValue label="Generation" value={detail.generation === null ? null : String(detail.generation)} />
            </div>
            {detail.inlineImplementationSummary ? (
              <div className="mt-4 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Inline implementation:</span>{' '}
                {detail.inlineImplementationSummary}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Conditions</CardTitle>
            <CardDescription>Controller condition history reported on the AgentRun status.</CardDescription>
          </CardHeader>
          <CardContent>
            <ConditionsTable conditions={detail.conditions} />
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Workflow / Runtime</CardTitle>
            <CardDescription>
              Backing runtime references and retry state when the controller reports them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ResourceLinks links={detail.resourceLinks} />
            <WorkflowSteps steps={detail.workflowSteps} />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Artifacts</CardTitle>
            <CardDescription>{detail.artifactSummary}</CardDescription>
          </CardHeader>
          <CardContent>
            <ArtifactPreview detail={detail} />
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Version Control</CardTitle>
            <CardDescription>VCS context captured by the run.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <KeyValueCompact label="Provider" value={detail.vcs.provider} />
              <KeyValueCompact label="Repository" value={detail.vcs.repository} />
              <KeyValueCompact label="Base" value={detail.vcs.baseBranch} />
              <KeyValueCompact label="Head" value={detail.vcs.headBranch} />
              <KeyValueCompact label="Mode" value={detail.vcs.mode} />
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>Status Summary</CardTitle>
            <CardDescription>Reason, message, and status timestamps.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <KeyValueCompact label="Reason" value={detail.reason} />
              <KeyValueCompact label="Message" value={detail.message} />
              <KeyValueCompact label="Updated" value={formatDateTime(detail.updatedAt)} />
              <KeyValueCompact label="Created" value={formatDateTime(detail.createdAt)} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function KeyValue({
  label,
  value,
  linkKind,
  namespace,
}: {
  label: string
  value: string | null
  linkKind?: 'agent' | 'implementation-spec'
  namespace?: string
}) {
  const content = value ? (
    linkKind && namespace ? (
      <Link
        to="/primitives/$kind/$namespace/$name"
        params={{ kind: linkKind, namespace, name: value }}
        className="truncate underline-offset-4 hover:underline"
      >
        {value}
      </Link>
    ) : (
      <span className="truncate" title={value}>
        {value}
      </span>
    )
  ) : (
    <span className="text-muted-foreground">-</span>
  )

  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex min-w-0 text-sm font-medium">{content}</div>
    </div>
  )
}

function KeyValueCompact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid min-w-0 grid-cols-[96px_minmax(0,1fr)] gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate" title={value ?? undefined}>
        {value || '-'}
      </span>
    </div>
  )
}

function ConditionsTable({ conditions }: { conditions: AgentRunConditionSummary[] }) {
  if (conditions.length === 0)
    return <EmptyState icon={CircleDotIcon} title="No conditions" body="No status conditions have been reported yet." />

  return (
    <TableScrollArea>
      <Table className="min-w-[820px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">Type</TableHead>
            <TableHead className="w-[90px]">Status</TableHead>
            <TableHead className="w-[180px]">Reason</TableHead>
            <TableHead>Message</TableHead>
            <TableHead className="w-[190px]">Transition</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {conditions.map((condition) => (
            <TableRow key={`${condition.type}-${condition.lastTransitionTime ?? condition.reason}`}>
              <TableCell className="font-medium">{condition.type}</TableCell>
              <TableCell>
                <Badge variant={condition.status === 'True' ? 'secondary' : 'outline'}>{condition.status}</Badge>
              </TableCell>
              <TableCell className="max-w-[180px] truncate text-muted-foreground" title={condition.reason}>
                {condition.reason}
              </TableCell>
              <TableCell className="max-w-[360px] truncate text-muted-foreground" title={condition.message}>
                {condition.message || '-'}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(condition.lastTransitionTime)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScrollArea>
  )
}

function ResourceLinks({ links }: { links: AgentRunRuntimeLink[] }) {
  if (links.length === 0) {
    return (
      <EmptyState
        icon={BoxesIcon}
        title="No backing resources"
        body="No Job, workflow, or runtime references are present on status yet."
      />
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {links.map((link) => (
        <div key={`${link.kind}/${link.namespace}/${link.name}`} className="rounded-md border px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{link.kind}</Badge>
            <span className="font-medium">{link.name}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{link.namespace}</div>
        </div>
      ))}
    </div>
  )
}

function WorkflowSteps({ steps }: { steps: AgentRunDetailModel['workflowSteps'] }) {
  if (steps.length === 0) {
    return (
      <EmptyState
        icon={ListChecksIcon}
        title="No workflow steps"
        body="This AgentRun has not reported workflow step status."
      />
    )
  }

  return (
    <TableScrollArea>
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead>Step</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Attempt</TableHead>
            <TableHead>Job</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Finished</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.map((step) => (
            <TableRow key={step.name}>
              <TableCell className="max-w-[220px] truncate font-medium" title={step.name}>
                {step.name}
              </TableCell>
              <TableCell>
                <Badge variant={badgeVariantForPhase(step.phase)}>{step.phase}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{step.attempt ?? '-'}</TableCell>
              <TableCell className="max-w-[180px] truncate text-muted-foreground" title={step.jobRef?.name}>
                {step.jobRef?.name ?? '-'}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(step.startedAt)}</TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(step.finishedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScrollArea>
  )
}

function ArtifactPreview({ detail }: { detail: AgentRunDetailModel }) {
  if (detail.artifacts.length === 0) {
    return <EmptyState icon={PackageIcon} title="No artifacts" body="The runner has not reported output artifacts." />
  }

  return (
    <div className="space-y-2">
      {detail.artifacts.slice(0, 5).map((artifact) => (
        <div
          key={`${artifact.name}-${artifact.key ?? artifact.path ?? artifact.url ?? ''}`}
          className="min-w-0 rounded-md border px-3 py-2"
        >
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium" title={artifact.name}>
              {artifact.name}
            </span>
            {artifact.url ? (
              <a
                href={artifact.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ExternalLinkIcon className="size-4" />
              </a>
            ) : null}
          </div>
          <div
            className="mt-1 truncate text-xs text-muted-foreground"
            title={artifact.key ?? artifact.path ?? artifact.url ?? undefined}
          >
            {artifact.key ?? artifact.path ?? artifact.url ?? 'No location reported'}
          </div>
        </div>
      ))}
      {detail.artifacts.length > 5 ? (
        <div className="text-xs text-muted-foreground">+{detail.artifacts.length - 5} more artifacts</div>
      ) : null}
    </div>
  )
}

function LogsTab({ detail }: { detail: AgentRunDetailModel }) {
  const [tailLines, setTailLines] = useState(200)
  const [logs, setLogs] = useState<AgentRunLogsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadLogs = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetchAgentRunLogs({ namespace: detail.namespace, name: detail.name, tailLines })
      setLogs(response)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLogs()
  }, [detail.namespace, detail.name])

  return (
    <Card className="rounded-md">
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle>Runner Logs</CardTitle>
            <CardDescription>
              Tail logs from the backing AgentRun pod using the control-plane logs endpoint.
            </CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <label className="text-xs text-muted-foreground" htmlFor="tail-lines">
              Tail lines
            </label>
            <Input
              id="tail-lines"
              type="number"
              min={1}
              max={5000}
              value={tailLines}
              onChange={(event) => setTailLines(Number(event.target.value) || 200)}
              className="sm:w-28"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void loadLogs()} disabled={loading}>
              {loading ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {logs ? <PodSummary logs={logs} /> : null}
        {loading ? (
          <LogSkeleton />
        ) : logs && logs.logs.length > 0 ? (
          <pre className="max-h-[62vh] overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed whitespace-pre">
            {logs.logs}
          </pre>
        ) : (
          <EmptyState icon={TerminalIcon} title="No logs yet" body="No pod logs are available for this AgentRun." />
        )}
      </CardContent>
    </Card>
  )
}

function PodSummary({ logs }: { logs: AgentRunLogsResponse }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">
        {logs.pods.length} pod{logs.pods.length === 1 ? '' : 's'}
      </Badge>
      {logs.pod ? <Badge variant="secondary">pod {logs.pod}</Badge> : null}
      {logs.container ? <Badge variant="secondary">container {logs.container}</Badge> : null}
      {logs.tailLines ? <Badge variant="outline">tail {logs.tailLines}</Badge> : null}
    </div>
  )
}

function EventsTab({ detail }: { detail: AgentRunDetailModel }) {
  const [events, setEvents] = useState<PrimitiveEventSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPrimitiveEvents({
      kind: 'AgentRun',
      namespace: detail.namespace,
      name: detail.name,
      uid: detail.uid,
      limit: 75,
    })
      .then((response) => {
        if (!cancelled) setEvents(response.items)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [detail.namespace, detail.name, detail.uid])

  return (
    <Card className="rounded-md">
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>Kubernetes events for this AgentRun. {terminalEventHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {loading ? <PanelSkeleton lines={8} /> : <EventsTable events={events} />}
      </CardContent>
    </Card>
  )
}

function EventsTable({ events }: { events: PrimitiveEventSummary[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={FileArchiveIcon}
        title="No events"
        body="The control plane did not return events for this AgentRun."
      />
    )
  }

  return (
    <TableScrollArea>
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">Time</TableHead>
            <TableHead className="w-[100px]">Type</TableHead>
            <TableHead className="w-[180px]">Reason</TableHead>
            <TableHead>Message</TableHead>
            <TableHead className="w-[80px] text-right">Count</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event, index) => {
            const time = event.eventTime ?? event.lastTimestamp ?? event.firstTimestamp
            return (
              <TableRow key={`${event.name ?? 'event'}-${index}`}>
                <TableCell className="text-muted-foreground">{formatDateTime(time)}</TableCell>
                <TableCell>
                  <Badge variant={event.type === 'Warning' ? 'destructive' : 'outline'}>{event.type ?? '-'}</Badge>
                </TableCell>
                <TableCell className="max-w-[180px] truncate" title={event.reason ?? undefined}>
                  {event.reason ?? '-'}
                </TableCell>
                <TableCell className="max-w-[480px] truncate text-muted-foreground" title={event.message ?? undefined}>
                  {event.message ?? '-'}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{event.count ?? '-'}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableScrollArea>
  )
}

function ArtifactsTab({ detail }: { detail: AgentRunDetailModel }) {
  return (
    <Card className="rounded-md">
      <CardHeader>
        <CardTitle>Artifacts</CardTitle>
        <CardDescription>{detail.artifactSummary}</CardDescription>
      </CardHeader>
      <CardContent>
        {detail.artifacts.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title="No artifacts"
            body="Artifacts will appear here after the runner reports them in AgentRun status."
          />
        ) : (
          <TableScrollArea>
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.artifacts.map((artifact) => (
                  <TableRow key={`${artifact.name}-${artifact.key ?? artifact.path ?? artifact.url ?? ''}`}>
                    <TableCell className="font-medium">{artifact.name}</TableCell>
                    <TableCell
                      className="max-w-[220px] truncate text-muted-foreground"
                      title={artifact.key ?? undefined}
                    >
                      {artifact.key ?? '-'}
                    </TableCell>
                    <TableCell
                      className="max-w-[220px] truncate text-muted-foreground"
                      title={artifact.path ?? undefined}
                    >
                      {artifact.path ?? '-'}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate">
                      {artifact.url ? (
                        <a
                          href={artifact.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline-offset-4 hover:underline"
                        >
                          {artifact.url}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

function ManifestStatusTab({ resource }: { resource: Record<string, unknown> }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <JsonPanel title="Manifest" icon={FileJsonIcon} value={resource} />
      <JsonPanel title="Status" icon={FileTextIcon} value={(resource.status as unknown) ?? {}} />
    </div>
  )
}

function JsonPanel({ title, icon: Icon, value }: { title: string; icon: typeof FileJsonIcon; value: unknown }) {
  return (
    <Card className="rounded-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="max-h-[68vh] overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed whitespace-pre">
          {JSON.stringify(value, null, 2)}
        </pre>
      </CardContent>
    </Card>
  )
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof PackageIcon; title: string; body: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-md border border-dashed px-4 py-8 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <div className="mt-2 text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-md text-xs text-muted-foreground">{body}</div>
    </div>
  )
}

function AgentRunHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1 space-y-3">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-8 w-[420px] max-w-full" />
        <Skeleton className="h-4 w-[640px] max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:min-w-[560px]">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-md border px-3 py-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
      <PanelSkeleton lines={10} />
      <PanelSkeleton lines={8} />
    </div>
  )
}

function PanelSkeleton({ lines }: { lines: number }) {
  return (
    <Card className="rounded-md">
      <CardContent className="space-y-3">
        {Array.from({ length: lines }).map((_, index) => (
          <Skeleton
            key={index}
            className={cn('h-4', index % 3 === 0 ? 'w-3/4' : index % 3 === 1 ? 'w-full' : 'w-1/2')}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function LogSkeleton() {
  return (
    <div className="rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed">
      {Array.from({ length: 14 }).map((_, index) => (
        <Skeleton
          key={index}
          className={cn('mb-2 h-3', index % 4 === 0 ? 'w-5/6' : index % 4 === 1 ? 'w-full' : 'w-2/3')}
        />
      ))}
    </div>
  )
}

function ManifestSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <PanelSkeleton lines={14} />
      <PanelSkeleton lines={10} />
    </div>
  )
}
