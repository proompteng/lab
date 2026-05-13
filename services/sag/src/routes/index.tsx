import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Textarea } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { fetchSnapshot, submitTask } from '~/lib/sag-client'
import { cn } from '~/lib/utils'
import {
  type ConnectorCall,
  type EventStatus,
  type GatewayEvent,
  type GatewaySnapshot,
  type GatewayTask,
  type PlanStep,
} from '~/server/gateway'

export const Route = createFileRoute('/')({
  component: DashboardRoute,
  loader: loadInitialSnapshot,
})

function DashboardRoute() {
  const initialSnapshot = Route.useLoaderData() as GatewaySnapshot
  const [enabled, setEnabled] = useState(false)
  const [intent, setIntent] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
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
  const selectedTask = useMemo(
    () => snapshot.tasks.find((task) => task.id === selectedTaskId) ?? snapshot.tasks[0] ?? null,
    [selectedTaskId, snapshot.tasks],
  )
  const selectedSteps = useMemo(
    () =>
      selectedTask
        ? snapshot.planSteps
            .filter((step) => step.taskId === selectedTask.id)
            .sort((left, right) => left.sequence - right.sequence)
        : [],
    [selectedTask, snapshot.planSteps],
  )
  const selectedCalls = useMemo(
    () => (selectedTask ? snapshot.connectorCalls.filter((call) => call.taskId === selectedTask.id) : []),
    [selectedTask, snapshot.connectorCalls],
  )

  const taskMutation = useMutation({
    mutationFn: (text: string) => submitTask(text),
    onSuccess: (result) => {
      queryClient.setQueryData(['sag-snapshot'], result.snapshot)
      setSelectedTaskId(result.task?.id ?? result.snapshot.tasks[0]?.id ?? null)
      setIntent('')
    },
  })

  const refreshSnapshot = async () => {
    const result = await snapshotQuery.refetch()
    setSelectedTaskId(result.data?.tasks[0]?.id ?? null)
  }

  return (
    <GatewayFrame active="/" snapshot={snapshot}>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px]">
        <section className="flex min-h-0 flex-col">
          <div className="border-b border-zinc-900 px-6 py-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div>
                <label htmlFor="intent" className="text-xs font-medium text-zinc-300">
                  Task
                </label>
                <Textarea
                  id="intent"
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  placeholder="Inspect live agent runs, check connector policy, and summarize blocked actions"
                  className="mt-2 min-h-24 bg-zinc-950"
                />
              </div>
              <div className="flex flex-col justify-between gap-3">
                <MetricGrid snapshot={snapshot} />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={refreshSnapshot} disabled={snapshotQuery.isFetching}>
                    <RefreshCw className={cn(snapshotQuery.isFetching && 'animate-spin')} data-icon="inline-start" />
                    Refresh
                  </Button>
                  <Button
                    disabled={intent.trim().length < 8 || taskMutation.isPending}
                    onClick={() => taskMutation.mutate(intent)}
                  >
                    Run
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
            <TaskList tasks={snapshot.tasks} selectedTask={selectedTask} onSelect={setSelectedTaskId} />
            <AuditList events={snapshot.events} />
          </div>
        </section>

        <TaskInspector task={selectedTask} steps={selectedSteps} calls={selectedCalls} />
      </div>
    </GatewayFrame>
  )
}

function MetricGrid({ snapshot }: { snapshot: GatewaySnapshot }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Metric label="Tasks" value={snapshot.stats.totalTasks} />
      <Metric label="Pending" value={snapshot.stats.awaitingApproval} />
      <Metric label="Events" value={snapshot.stats.totalEvents} />
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-900 bg-zinc-950 px-3 py-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-lg text-zinc-100">{value}</div>
    </div>
  )
}

function TaskList({
  tasks,
  selectedTask,
  onSelect,
}: {
  tasks: GatewayTask[]
  selectedTask: GatewayTask | null
  onSelect: (id: string) => void
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-zinc-900">
      <div className="h-10 border-b border-zinc-900 px-5 py-2 text-xs font-medium text-zinc-400">Tasks</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 ? <EmptyState label="No tasks yet." /> : null}
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelect(task.id)}
            className={cn(
              'grid w-full gap-2 border-b border-zinc-900 px-5 py-4 text-left text-xs hover:bg-zinc-950',
              selectedTask?.id === task.id && 'bg-zinc-950',
            )}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{task.title}</span>
              <StatusBadge status={task.decision} />
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
              <span>{new Date(task.createdAt).toISOString().slice(11, 19)}</span>
              <span>{task.id}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}

function AuditList({ events }: { events: GatewayEvent[] }) {
  return (
    <section className="flex min-h-0 flex-col">
      <div className="grid h-10 shrink-0 grid-cols-[76px_92px_116px_minmax(0,1fr)] items-center border-b border-zinc-900 px-5 text-[11px] font-medium text-zinc-500">
        <span>Time</span>
        <span>Source</span>
        <span>Result</span>
        <span>Operation</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? <EmptyState label="No audit events." /> : null}
        {events.map((event) => (
          <div
            key={event.id}
            className="grid min-h-12 grid-cols-[76px_92px_116px_minmax(0,1fr)] items-center border-b border-zinc-900 px-5 text-xs"
          >
            <span className="font-mono text-[11px] text-zinc-500">
              {new Date(event.timestamp).toISOString().slice(11, 19)}
            </span>
            <span className="font-mono text-[11px] text-zinc-400">{event.connector}</span>
            <StatusBadge status={event.status} />
            <div className="min-w-0">
              <p className="truncate font-mono text-[11px] text-zinc-200">{event.operation}</p>
              <p className="truncate text-[11px] text-zinc-500">{event.target}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function TaskInspector({
  task,
  steps,
  calls,
}: {
  task: GatewayTask | null
  steps: PlanStep[]
  calls: ConnectorCall[]
}) {
  return (
    <aside className="flex min-h-0 flex-col border-l border-zinc-900">
      <div className="border-b border-zinc-900 px-5 py-4">
        <div className="text-xs font-medium text-zinc-400">Decision</div>
        {task ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-100">{task.title}</h2>
              <StatusBadge status={task.decision} />
            </div>
            <p className="text-xs leading-5 text-zinc-400">{task.summary}</p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-zinc-500">Submit a task to inspect the plan.</p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="space-y-6">
          <section>
            <h3 className="text-xs font-medium text-zinc-400">Plan</h3>
            <div className="mt-3 divide-y divide-zinc-900 rounded-md border border-zinc-900">
              {steps.length === 0 ? <EmptyState label="No plan." compact /> : null}
              {steps.map((step) => (
                <div key={step.id} className="grid gap-2 p-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] text-zinc-500">0{step.sequence}</span>
                    <StatusBadge status={step.status === 'allowed' ? 'allowed' : step.status} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-zinc-200">{step.operation}</p>
                    <p className="mt-1 truncate text-[11px] text-zinc-500">
                      {step.connector} / {step.target}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium text-zinc-400">Connector Calls</h3>
            <div className="mt-3 divide-y divide-zinc-900 rounded-md border border-zinc-900">
              {calls.length === 0 ? <EmptyState label="No calls." compact /> : null}
              {calls.map((call) => (
                <div key={call.id} className="grid gap-2 p-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] text-zinc-500">{call.connector}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{call.durationMs} ms</span>
                  </div>
                  <p className="truncate font-mono text-[11px] text-zinc-200">{call.operation}</p>
                  <pre className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-[11px] leading-5 text-zinc-400">
                    {JSON.stringify(call.evidence, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </aside>
  )
}

function EmptyState({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div
      className={cn('flex items-center justify-center p-6 text-xs text-zinc-500', compact ? 'min-h-20' : 'min-h-36')}
    >
      {label}
    </div>
  )
}

function StatusBadge({ status }: { status: EventStatus | PlanStep['status'] }) {
  const normalized = status.replace('_', ' ')
  const blocked = status === 'blocked' || status === 'denied' || status === 'failed'
  const attention = status === 'approval_required' || status === 'pending'
  let variant: 'outline' | 'secondary' | 'destructive' = 'outline'
  if (blocked) variant = 'destructive'
  else if (attention) variant = 'secondary'
  return <Badge variant={variant}>{normalized}</Badge>
}
