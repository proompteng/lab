import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { ScrollArea, ScrollBar } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import {
  approveRun,
  fetchAgentRunLogs,
  fetchDatabaseAccess,
  fetchLiveAgentRuns,
  requestDatabaseAccess,
} from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'

export const Route = createFileRoute('/agent-runs_/$name')({
  component: AgentRunDetailRoute,
  loader: loadInitialSnapshot,
})

function AgentRunDetailRoute() {
  const initialSnapshot = Route.useLoaderData()
  const { name } = Route.useParams()
  const namespace = 'agents'
  const queryClient = useQueryClient()
  const [streamedLogs, setStreamedLogs] = useState('')
  const logsRef = useRef<HTMLDivElement>(null)

  const runsQuery = useQuery({
    queryKey: ['live-agent-runs'],
    queryFn: fetchLiveAgentRuns,
    refetchInterval: 5000,
  })
  const run = runsQuery.data?.runs.find((item) => item.namespace === namespace && item.name === name) ?? null

  const logsQuery = useQuery({
    queryKey: ['agent-run-logs', namespace, name],
    queryFn: () => fetchAgentRunLogs({ namespace, name }),
    refetchInterval: (query) => (isTerminalPhase(query.state.data?.phase ?? run?.phase ?? '') ? false : 2000),
  })

  const phase = logsQuery.data?.phase ?? run?.phase ?? 'Pending'
  const logText = streamedLogs || logsQuery.data?.logs || 'Waiting for logs.'
  const streamReady = Boolean(logsQuery.data?.podName)
  const databaseAccessQuery = useQuery({
    queryKey: ['agent-run-database-access', name],
    queryFn: () => fetchDatabaseAccess(name),
    refetchInterval: 5000,
  })
  const databaseApproval = databaseAccessQuery.data?.approval
  const databaseRequestMutation = useMutation({
    mutationFn: () => requestDatabaseAccess(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-run-database-access', name] })
    },
  })
  const approveMutation = useMutation({
    mutationFn: (approvalId: string) => approveRun(approvalId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-run-database-access', name] })
    },
  })

  useEffect(() => {
    if (!streamReady) return
    if (databaseApproval || databaseRequestMutation.isPending) return
    databaseRequestMutation.mutate()
  }, [databaseApproval, databaseRequestMutation.isPending, databaseRequestMutation.mutate, streamReady])

  useEffect(() => {
    const element = logsRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [logText])

  useEffect(() => {
    if (!streamReady) {
      setStreamedLogs('')
      return
    }

    const controller = new AbortController()
    const decoder = new TextDecoder()

    const readStream = async () => {
      const response = await fetch(
        `/api/agent-run-logs/stream?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}&tailLines=400`,
        { signal: controller.signal },
      )
      const reader = response.body?.getReader()
      if (!reader) return

      setStreamedLogs('')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        setStreamedLogs((current) => `${current}${decoder.decode(value, { stream: true })}`)
      }
    }

    readStream().catch((error) => {
      if (!controller.signal.aborted) setStreamedLogs(`Logs unavailable: ${error.message}`)
    })

    return () => controller.abort()
  }, [name, namespace, streamReady])

  return (
    <GatewayFrame active="/agent-runs" snapshot={initialSnapshot}>
      <GatewayPageHeader title={name} active="/agent-runs" breadcrumbs={[{ label: name }]} />
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="grid min-h-0 gap-4 content-start">
          <Card size="sm" className="min-h-0">
            <CardHeader>
              <CardTitle>Run</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="w-full">
                <div className="min-w-max">
                  <Table>
                    <TableBody>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Phase</TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Badge variant={phaseVariant(phase)}>{phase}</Badge>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Namespace</TableCell>
                        <TableCell className="whitespace-nowrap">{namespace}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Agent</TableCell>
                        <TableCell className="whitespace-nowrap">{run?.agent ?? '-'}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Created</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(run?.createdAt ?? '')}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Job</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {logsQuery.data?.jobName ?? run?.jobName ?? '-'}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Pod</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {logsQuery.data?.podName ?? run?.podName ?? '-'}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </CardContent>
          </Card>

          <Card size="sm" className="min-h-0">
            <CardHeader>
              <CardTitle>Database</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">SAG tables</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {databaseStatus(databaseApproval?.status)}
                  </div>
                </div>
                {databaseApproval?.status === 'pending' ? (
                  <Button
                    size="sm"
                    disabled={approveMutation.isPending}
                    onClick={() => approveMutation.mutate(databaseApproval.id)}
                  >
                    Allow
                  </Button>
                ) : null}
              </div>
              {databaseAccessQuery.data?.tables.length ? (
                <div className="grid gap-1 rounded-md border bg-muted/20 p-2">
                  {databaseAccessQuery.data.tables.map((table) => (
                    <div key={table} className="truncate font-mono text-xs text-muted-foreground">
                      {table}
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>

        <Card size="sm" className="min-h-0">
          <CardHeader>
            <CardTitle>Logs</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0">
            <div ref={logsRef} className="h-[calc(100svh-12rem)] overflow-auto rounded-lg border bg-muted/20">
              <pre className="min-h-full whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
                {logText}
              </pre>
            </div>
          </CardContent>
        </Card>
      </main>
    </GatewayFrame>
  )
}

const isTerminalPhase = (phase: string) =>
  ['succeeded', 'failed', 'complete', 'completed'].includes(phase.toLowerCase())

const phaseVariant = (phase: string) => {
  const normalized = phase.toLowerCase()
  if (['failed', 'blocked', 'error'].some((item) => normalized.includes(item))) return 'destructive'
  if (['succeeded', 'complete', 'ready'].some((item) => normalized.includes(item))) return 'secondary'
  return 'outline'
}

const databaseStatus = (status?: string) => {
  if (status === 'approved') return 'Allowed'
  if (status === 'pending') return 'Waiting for approval'
  if (status === 'denied') return 'Denied'
  return 'Waiting for logs'
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
