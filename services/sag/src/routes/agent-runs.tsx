import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon, FilterIcon } from '@hugeicons/core-free-icons'
import { Badge } from '~/components/ui/badge'
import { Button, buttonVariants } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { fetchLiveAgentRuns } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { cn } from '~/lib/utils'
import type { LiveAgentRun } from '~/server/kubernetes'

export const Route = createFileRoute('/agent-runs')({
  component: AgentRunsRoute,
  loader: loadInitialSnapshot,
  validateSearch: (search: Record<string, unknown>) => ({
    phase: typeof search.phase === 'string' ? search.phase : undefined,
  }),
})

function AgentRunsRoute() {
  const initialSnapshot = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const runsQuery = useQuery({
    queryKey: ['live-agent-runs'],
    queryFn: fetchLiveAgentRuns,
    refetchInterval: 5000,
  })
  const runs = [...(runsQuery.data?.runs ?? [])].sort(
    (left, right) => Date.parse(right.createdAt || '1970-01-01') - Date.parse(left.createdAt || '1970-01-01'),
  )
  const phaseSearch = search.phase
  const selectedPhases = phaseSearch === undefined ? defaultRunningPhases(runs) : parsePhaseSearch(phaseSearch)
  const phaseOptions = phaseFilters(runs)
  const visibleRuns =
    phaseSearch === undefined
      ? runs.filter((run) => isRunningPhase(run.phase))
      : phaseSearch === 'all' || selectedPhases.length === 0
        ? runs
        : runs.filter((run) => selectedPhases.includes(normalizePhase(run.phase)))
  const phaseLabel = filterLabel(phaseSearch, selectedPhases, phaseOptions)

  const togglePhase = async (phase: string) => {
    const normalized = normalizePhase(phase)
    const current = phaseSearch === undefined || phaseSearch === 'all' ? [] : selectedPhases
    const next = current.includes(normalized) ? current.filter((item) => item !== normalized) : [...current, normalized]
    await navigate({
      to: '/agent-runs',
      search: { phase: next.length ? next.join(',') : 'all' },
    })
  }

  return (
    <GatewayFrame active="/agent-runs" snapshot={initialSnapshot}>
      <GatewayPageHeader
        title="Agent Runs"
        action={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <HugeiconsIcon icon={FilterIcon} strokeWidth={2} />
                {phaseLabel}
                <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  {phaseOptions.map((phase) => {
                    const selected =
                      phaseSearch !== undefined &&
                      phaseSearch !== 'all' &&
                      selectedPhases.includes(normalizePhase(phase))
                    return (
                      <DropdownMenuCheckboxItem
                        key={phase}
                        checked={selected}
                        onCheckedChange={() => void togglePhase(phase)}
                      >
                        {phase}
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link to="/agent-runs/new" className={cn(buttonVariants())}>
              New run
            </Link>
          </>
        }
      />

      <main className="min-h-0 flex-1 p-4 pb-12">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Pod</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    {runsQuery.isLoading
                      ? 'Loading runs.'
                      : phaseSearch === undefined
                        ? 'No running runs.'
                        : selectedPhases.length
                          ? 'No matching runs.'
                          : 'No runs.'}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRuns.map((run) => (
                  <TableRow key={runKey(run)}>
                    <TableCell className="font-medium">
                      <Link to="/agent-runs/$name" params={{ name: run.name }} className="hover:underline">
                        {run.name}
                      </Link>
                    </TableCell>
                    <TableCell>{run.agent}</TableCell>
                    <TableCell>
                      <Badge variant={phaseVariant(run.phase)}>{run.phase}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(run.createdAt)}</TableCell>
                    <TableCell>{run.jobName ?? '-'}</TableCell>
                    <TableCell>{run.podName ?? '-'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </main>
    </GatewayFrame>
  )
}

const runKey = (run: LiveAgentRun) => `${run.namespace}/${run.name}`

const parsePhaseSearch = (value: string) => value.split(',').map(normalizePhase).filter(Boolean)

const normalizePhase = (value: string) => value.trim().toLowerCase()

const phaseFilters = (runs: LiveAgentRun[]) =>
  [...new Set(runs.map((run) => run.phase).filter(Boolean))].sort((left, right) => left.localeCompare(right))

const runningPhaseNames = ['pending', 'queued', 'starting', 'started', 'running', 'progressing', 'active']

const isRunningPhase = (phase: string) => {
  const normalized = normalizePhase(phase)
  return runningPhaseNames.some((item) => normalized.includes(item))
}

const defaultRunningPhases = (runs: LiveAgentRun[]) => [
  ...new Set(runs.filter((run) => isRunningPhase(run.phase)).map((run) => normalizePhase(run.phase))),
]

const filterLabel = (phaseSearch: string | undefined, selectedPhases: string[], phaseOptions: string[]) => {
  if (phaseSearch === undefined) return 'Running'
  if (phaseSearch === 'all' || selectedPhases.length === 0) return 'All phases'
  if (selectedPhases.length === 1) {
    return phaseOptions.find((phase) => normalizePhase(phase) === selectedPhases[0]) ?? selectedPhases[0]
  }
  return `${selectedPhases.length} phases`
}

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
