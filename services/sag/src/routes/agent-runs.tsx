import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshCw, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { SidebarTrigger, GatewayFrame } from '~/components/gateway-shell'
import { Spinner } from '~/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { Textarea } from '~/components/ui/textarea'
import { fetchSnapshot, fetchLiveAgentRuns, fetchAgentRunLogs, createLiveAgentRun } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { cn } from '~/lib/utils'
import type { LiveAgentRun } from '~/server/kubernetes'

export const Route = createFileRoute('/agent-runs')({
  component: AgentRunsRoute,
  loader: loadInitialSnapshot,
})

function AgentRunsRoute() {
  const initialSnapshot = Route.useLoaderData()
  const queryClient = useQueryClient()
  const [task, setTask] = useState('')
  const [agent, setAgent] = useState('codex-agent')
  const [repository, setRepository] = useState('proompteng/lab')
  const [selectedRunKey, setSelectedRunKey] = useState('')

  const snapshotQuery = useQuery({
    queryKey: ['snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialSnapshot,
  })
  const runsQuery = useQuery({
    queryKey: ['live-agent-runs'],
    queryFn: fetchLiveAgentRuns,
    refetchInterval: 5000,
  })
  const runs = runsQuery.data?.runs ?? []
  const selectedRun = useMemo(() => {
    if (selectedRunKey) {
      const selected = runs.find((run) => runKey(run) === selectedRunKey)
      if (selected) return selected
    }
    return runs[0] ?? null
  }, [runs, selectedRunKey])

  useEffect(() => {
    if (!selectedRunKey && runs[0]) setSelectedRunKey(runKey(runs[0]))
  }, [runs, selectedRunKey])

  const logsQuery = useQuery({
    queryKey: ['agent-run-logs', selectedRun?.namespace, selectedRun?.name],
    queryFn: () => fetchAgentRunLogs({ namespace: selectedRun?.namespace ?? 'agents', name: selectedRun?.name ?? '' }),
    enabled: Boolean(selectedRun),
    refetchInterval: selectedRun && !isTerminalPhase(selectedRun.phase) ? 3000 : false,
  })

  const createMutation = useMutation({
    mutationFn: createLiveAgentRun,
    onSuccess: async (result) => {
      setTask('')
      setSelectedRunKey(runKey(result.run))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['live-agent-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['snapshot'] }),
        queryClient.invalidateQueries({ queryKey: ['agent-run-logs'] }),
      ])
    },
  })

  const snapshot = snapshotQuery.data ?? initialSnapshot

  return (
    <GatewayFrame active="/agent-runs" snapshot={snapshot}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">Agent Runs</h1>
            <p className="truncate text-xs text-muted-foreground">Create, inspect, follow logs.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => runsQuery.refetch()} disabled={runsQuery.isFetching}>
          {runsQuery.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          Refresh
        </Button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.45fr)]">
        <section className="flex min-h-0 flex-col gap-4 overflow-hidden">
          <Card className="shrink-0 rounded-lg" size="sm">
            <CardHeader>
              <CardTitle>Create Run</CardTitle>
              <CardAction>
                <Button
                  size="sm"
                  disabled={createMutation.isPending || task.trim().length === 0}
                  onClick={() => createMutation.mutate({ task, agent, repository })}
                >
                  {createMutation.isPending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
                  Create
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="agent-run-task">Task</FieldLabel>
                  <Textarea
                    id="agent-run-task"
                    value={task}
                    onChange={(event) => setTask(event.target.value)}
                    rows={3}
                    placeholder="Describe the work."
                  />
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="agent-run-agent">Agent</FieldLabel>
                    <Input id="agent-run-agent" value={agent} onChange={(event) => setAgent(event.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="agent-run-repository">Repository</FieldLabel>
                    <Input
                      id="agent-run-repository"
                      value={repository}
                      onChange={(event) => setRepository(event.target.value)}
                    />
                  </Field>
                </div>
              </FieldGroup>
              {createMutation.error ? (
                <Alert variant="destructive" className="mt-4 rounded-lg">
                  <AlertTitle>Create failed</AlertTitle>
                  <AlertDescription>{createMutation.error.message}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card className="min-h-0 flex-1 rounded-lg" size="sm">
            <CardHeader>
              <CardTitle>Runs</CardTitle>
              <CardAction>
                <Badge variant="outline">{runs.length}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="min-h-0 overflow-auto">
              {runs.length === 0 ? (
                <Empty className="min-h-[260px] rounded-lg border">
                  <EmptyHeader>
                    <EmptyTitle>No runs</EmptyTitle>
                    <EmptyDescription>Create one above.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Phase</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Pod</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow
                        key={runKey(run)}
                        data-state={selectedRun && runKey(run) === runKey(selectedRun) ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => setSelectedRunKey(runKey(run))}
                      >
                        <TableCell className="max-w-[280px] truncate font-medium">{run.name}</TableCell>
                        <TableCell>{run.agent}</TableCell>
                        <TableCell>
                          <Badge variant={phaseVariant(run.phase)}>{run.phase}</Badge>
                        </TableCell>
                        <TableCell>{formatDate(run.createdAt)}</TableCell>
                        <TableCell className="max-w-[240px] truncate text-muted-foreground">
                          {run.podName ?? '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>

        <Card className="min-h-0 rounded-lg" size="sm">
          <CardHeader>
            <CardTitle>Logs</CardTitle>
            <CardAction>
              <Badge variant={selectedRun ? phaseVariant(logsQuery.data?.phase ?? selectedRun.phase) : 'outline'}>
                {logsQuery.data?.phase ?? selectedRun?.phase ?? 'Idle'}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            {selectedRun ? (
              <>
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <div className="truncate text-foreground">{selectedRun.name}</div>
                  <div className="truncate">
                    {selectedRun.namespace} / {logsQuery.data?.jobName ?? selectedRun.jobName ?? 'job pending'} /{' '}
                    {logsQuery.data?.podName ?? selectedRun.podName ?? 'pod pending'}
                  </div>
                </div>
                <pre
                  className={cn(
                    'min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground',
                    logsQuery.isFetching && 'opacity-80',
                  )}
                >
                  {logsQuery.data?.logs ?? 'Waiting for logs.'}
                </pre>
              </>
            ) : (
              <Empty className="min-h-[360px] rounded-lg border">
                <EmptyHeader>
                  <EmptyTitle>No run selected</EmptyTitle>
                  <EmptyDescription>Create or select a run.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </main>
    </GatewayFrame>
  )
}

const runKey = (run: LiveAgentRun) => `${run.namespace}/${run.name}`

const isTerminalPhase = (phase: string) =>
  ['succeeded', 'failed', 'complete', 'completed'].includes(phase.toLowerCase())

const phaseVariant = (phase: string) => {
  const normalized = phase.toLowerCase()
  if (['failed', 'blocked', 'error'].some((item) => normalized.includes(item))) return 'destructive'
  if (['succeeded', 'complete', 'ready'].some((item) => normalized.includes(item))) return 'secondary'
  return 'outline'
}

const formatDate = (value: string) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
