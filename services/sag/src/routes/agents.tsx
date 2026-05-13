import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { evaluateAgentRun, fetchSnapshot } from '~/lib/sag-client'
import { type GatewaySnapshot, type ProtectedAgentRun } from '~/server/gateway'

export const Route = createFileRoute('/agents')({
  component: AgentsRoute,
  loader: loadInitialSnapshot,
})

function AgentsRoute() {
  const initialSnapshot = Route.useLoaderData() as GatewaySnapshot
  const [enabled, setEnabled] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  useEffect(() => setEnabled(true), [])

  const snapshotQuery = useQuery({
    queryKey: ['sag-snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialSnapshot,
    enabled,
  })
  const snapshot = snapshotQuery.data
  const selected = useMemo(
    () => snapshot.agentRuns.find((run) => run.id === selectedId) ?? snapshot.agentRuns[0] ?? null,
    [selectedId, snapshot.agentRuns],
  )
  const mutation = useMutation({
    mutationFn: evaluateAgentRun,
    onSuccess: (result) => {
      queryClient.setQueryData(['sag-snapshot'], result.snapshot)
      setSelectedId(result.agentRun?.id ?? null)
    },
  })

  return (
    <GatewayFrame active="/agents" snapshot={snapshot}>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px]">
        <section className="flex min-h-0 flex-col">
          <div className="flex h-12 items-center justify-between border-b border-zinc-800 px-5">
            <h2 className="text-sm font-medium text-zinc-100">AgentRuns</h2>
            <Button size="sm" variant="secondary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              <ShieldAlert data-icon="inline-start" />
              Evaluate
            </Button>
          </div>
          <div className="grid h-10 grid-cols-[220px_130px_120px_minmax(0,1fr)] items-center border-b border-zinc-800 px-5 text-[11px] font-medium text-zinc-500">
            <span>Name</span>
            <span>Status</span>
            <span>Risk</span>
            <span>Rules</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y divide-zinc-900">
              {snapshot.agentRuns.map((run) => (
                <AgentRunLine
                  key={run.id}
                  run={run}
                  selected={selected?.id === run.id}
                  onSelect={() => setSelectedId(run.id)}
                />
              ))}
              {snapshot.agentRuns.length === 0 ? (
                <div className="p-6 text-sm text-zinc-500">No AgentRuns evaluated.</div>
              ) : null}
            </div>
          </div>
        </section>
        <aside className="min-h-0 overflow-y-auto border-l border-zinc-800 p-5">
          <h2 className="text-sm font-medium text-zinc-100">Manifest</h2>
          {selected ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-2 text-xs">
                <KeyValue label="Agent" value={selected.agent} />
                <KeyValue label="Namespace" value={selected.namespace} />
                <KeyValue label="Secrets" value={String(selected.requestedSecrets.length)} />
                <KeyValue label="Connectors" value={selected.requestedConnectors.join(', ')} />
              </div>
              <pre className="max-h-[520px] overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] leading-5 text-zinc-300">
                {selected.manifest}
              </pre>
            </div>
          ) : (
            <p className="mt-4 text-xs text-zinc-500">Evaluate an AgentRun.</p>
          )}
        </aside>
      </div>
    </GatewayFrame>
  )
}

function AgentRunLine({
  run,
  selected,
  onSelect,
}: {
  run: ProtectedAgentRun
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" onClick={onSelect} className={selected ? rowClassSelected : rowClass}>
      <div className="min-w-0">
        <p className="truncate text-zinc-100">{run.name}</p>
        <p className="truncate font-mono text-[11px] text-zinc-500">{run.id}</p>
      </div>
      <Badge
        variant={
          run.status === 'blocked' ? 'destructive' : run.status === 'approval_required' ? 'secondary' : 'outline'
        }
      >
        {run.status.replace('_', ' ')}
      </Badge>
      <span className="font-mono text-[11px] text-zinc-300">{run.riskScore}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
        {run.matchedRuleIds.join(', ') || 'none'}
      </span>
    </button>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className="truncate font-mono text-zinc-300">{value}</span>
    </div>
  )
}

const rowClass =
  'grid min-h-14 w-full grid-cols-[220px_130px_120px_minmax(0,1fr)] items-center px-5 text-left text-xs hover:bg-zinc-900/70'
const rowClassSelected = `${rowClass} bg-zinc-900`
