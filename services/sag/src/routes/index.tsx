import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { evaluateAgentRun, fetchSnapshot } from '~/lib/sag-client'
import { cn } from '~/lib/utils'
import { type EventStatus, type GatewayEvent, type GatewaySnapshot, type ProtectedAgentRun } from '~/server/gateway'

export const Route = createFileRoute('/')({
  component: DashboardRoute,
  loader: loadInitialSnapshot,
})

function DashboardRoute() {
  const initialSnapshot = Route.useLoaderData() as GatewaySnapshot
  const [enabled, setEnabled] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  useEffect(() => setEnabled(true), [])

  const snapshotQuery = useQuery({
    queryKey: ['sag-snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialSnapshot,
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const snapshot = snapshotQuery.data
  const selectedEvent = snapshot.events.find((event) => event.id === selectedEventId) ?? snapshot.events[0] ?? null
  const selectedAgentRun = useMemo(
    () => snapshot.agentRuns.find((agentRun) => agentRun.id === selectedAgentRunId) ?? snapshot.agentRuns[0] ?? null,
    [selectedAgentRunId, snapshot.agentRuns],
  )

  const agentRunMutation = useMutation({
    mutationFn: evaluateAgentRun,
    onSuccess: (result) => {
      queryClient.setQueryData(['sag-snapshot'], result.snapshot)
      setSelectedAgentRunId(result.agentRun?.id ?? null)
      setSelectedEventId(result.snapshot.events[0]?.id ?? null)
    },
  })

  const refreshSnapshot = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sag-snapshot'] })
    const result = await snapshotQuery.refetch()
    setSelectedEventId(result.data?.events[0]?.id ?? null)
    setSelectedAgentRunId(result.data?.agentRuns[0]?.id ?? null)
  }

  return (
    <GatewayFrame active="/" snapshot={snapshot}>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_440px]">
        <section className="flex min-h-0 flex-col">
          <div className="flex h-12 items-center justify-between border-b border-zinc-800 px-5">
            <h2 className="text-sm font-medium text-zinc-100">Events</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={agentRunMutation.isPending}
                onClick={() => agentRunMutation.mutate()}
              >
                <ShieldAlert data-icon="inline-start" />
                Evaluate AgentRun
              </Button>
              <Button variant="outline" size="sm" onClick={refreshSnapshot} disabled={snapshotQuery.isFetching}>
                <RefreshCw className={cn(snapshotQuery.isFetching && 'animate-spin')} data-icon="inline-start" />
                Refresh
              </Button>
            </div>
          </div>
          <div className="grid h-9 shrink-0 grid-cols-[96px_100px_132px_minmax(0,1fr)_220px] items-center border-b border-zinc-800 px-5 text-[11px] font-medium text-zinc-500">
            <span>Time</span>
            <span>Source</span>
            <span>Result</span>
            <span>Operation</span>
            <span>Policy</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y divide-zinc-900">
              {snapshot.events.length === 0 ? (
                <EmptyState label="No events." />
              ) : (
                snapshot.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    selected={selectedEvent?.id === event.id}
                    onSelect={() => setSelectedEventId(event.id)}
                  />
                ))
              )}
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-l border-zinc-800">
          <div className="grid h-12 grid-cols-[minmax(0,1fr)_92px] items-center border-b border-zinc-800 px-5">
            <h2 className="text-sm font-medium text-zinc-100">AgentRuns</h2>
            <span className="text-right font-mono text-[11px] text-zinc-500">{selectedAgentRun?.id ?? 'none'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y divide-zinc-900">
              {snapshot.agentRuns.length === 0 ? (
                <EmptyState label="No AgentRuns evaluated." />
              ) : (
                snapshot.agentRuns.map((agentRun) => (
                  <AgentRunRow
                    key={agentRun.id}
                    agentRun={agentRun}
                    selected={selectedAgentRun?.id === agentRun.id}
                    onSelect={() => setSelectedAgentRunId(agentRun.id)}
                  />
                ))
              )}
            </div>
            {selectedAgentRun ? (
              <pre className="m-5 max-h-[520px] overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] leading-5 text-zinc-300">
                {selectedAgentRun.manifest}
              </pre>
            ) : null}
            {selectedEvent ? (
              <pre className="mx-5 mb-5 max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] leading-5 text-zinc-300">
                {JSON.stringify(selectedEvent.evidence, null, 2)}
              </pre>
            ) : null}
          </div>
        </aside>
      </div>
    </GatewayFrame>
  )
}

function EventRow({ event, selected, onSelect }: { event: GatewayEvent; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        'grid min-h-12 w-full grid-cols-[96px_100px_132px_minmax(0,1fr)_220px] items-center px-5 text-left text-xs hover:bg-zinc-900/70',
        selected && 'bg-zinc-900',
      )}
      onClick={onSelect}
    >
      <span className="font-mono text-[11px] text-zinc-500">
        {new Date(event.timestamp).toISOString().slice(11, 19)}
      </span>
      <Badge className="font-mono">{event.connector}</Badge>
      <StatusBadge status={event.status} />
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-100">{event.operation}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{event.policy}</span>
    </button>
  )
}

function AgentRunRow({
  agentRun,
  selected,
  onSelect,
}: {
  agentRun: ProtectedAgentRun
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'grid min-h-16 w-full grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-5 text-left text-xs hover:bg-zinc-900/70',
        selected && 'bg-zinc-900',
      )}
      onClick={onSelect}
    >
      <div className="min-w-0">
        <p className="truncate text-zinc-100">{agentRun.name}</p>
        <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">{agentRun.agent}</p>
      </div>
      <Badge variant={agentRun.status === 'blocked' ? 'destructive' : 'outline'}>
        {agentRun.status.replace('_', ' ')}
      </Badge>
    </button>
  )
}

function EmptyState({ label }: { label: string }) {
  return <div className="flex min-h-36 items-center justify-center p-6 text-sm text-zinc-500">{label}</div>
}

function StatusBadge({ status }: { status: EventStatus }) {
  const blocked = status === 'blocked' || status === 'denied'
  const attention = status === 'approval_required'
  return (
    <Badge variant={blocked ? 'destructive' : attention ? 'secondary' : 'outline'}>{status.replace('_', ' ')}</Badge>
  )
}
