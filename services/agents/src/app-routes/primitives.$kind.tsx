import { Link, Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { fetchPrimitiveResources, type PrimitiveResourceSummary } from '../control-plane/api-client'
import {
  agentRunAgentName,
  agentRunSortKeys,
  defaultAgentRunSort,
  formatAgentRunImplementationSource,
  nextAgentRunSortSearch,
  parseAgentRunListSearch,
  resourceCreationTimestamp,
  resourceName,
  resourceNamespace,
  resourcePhase,
  sortAgentRunResources,
  type AgentRunListSearchState,
  type AgentRunSortDirection,
  type AgentRunSortKey,
} from '../control-plane/agentrun-list-sort'
import { findPrimitiveDefinition } from '../control-plane/registry'
import {
  filterAgentRunsByStatuses,
  parseAgentRunStatusSearch,
} from '../components/control-plane/agent-run-status-filter'
import { ControlPlanePage } from '../components/control-plane/control-plane-page'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

export const Route = createFileRoute('/primitives/$kind')({
  validateSearch: parseAgentRunListSearch,
  component: PrimitiveKindRoute,
})

const metadataValue = (resource: PrimitiveResourceSummary, key: string) => {
  const value = resource.metadata[key]
  return typeof value === 'string' ? value : ''
}

const sortableAgentRunColumnLabels: Record<AgentRunSortKey, string> = {
  name: 'Name',
  phase: 'Status',
  agent: 'Agent',
  source: 'Implementation',
  namespace: 'Namespace',
  createdAt: 'Age',
}

const ariaSortValue = (search: AgentRunListSearchState, sort: AgentRunSortKey): 'ascending' | 'descending' | 'none' =>
  (search.sort ?? defaultAgentRunSort.sort) === sort
    ? (search.direction ?? defaultAgentRunSort.direction) === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none'

const SortIcon = ({ active, direction }: { active: boolean; direction: AgentRunSortDirection }) => {
  if (!active) return <ArrowUpDownIcon className="size-3.5 opacity-40" aria-hidden="true" />
  return direction === 'asc' ? (
    <ArrowUpIcon className="size-3.5" aria-hidden="true" />
  ) : (
    <ArrowDownIcon className="size-3.5" aria-hidden="true" />
  )
}

function PrimitiveKindRoute() {
  const location = useLocation()
  const segments = location.pathname.split('/').filter(Boolean)
  if (segments.length > 2) {
    return <Outlet />
  }
  return <PrimitiveListPage />
}

function PrimitiveListPage() {
  const { kind } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const primitive = findPrimitiveDefinition(kind)
  const [items, setItems] = useState<PrimitiveResourceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isAgentRunList = primitive?.kind === 'AgentRun'
  const selectedStatuses = useMemo(
    () => (isAgentRunList ? parseAgentRunStatusSearch(search.status) : []),
    [isAgentRunList, search.status],
  )
  const visibleItems = useMemo(
    () => (isAgentRunList ? filterAgentRunsByStatuses(items, selectedStatuses) : items),
    [isAgentRunList, items, selectedStatuses],
  )

  const load = async () => {
    if (!primitive) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetchPrimitiveResources(primitive.display.pathSegment, {
        namespace: search.namespace,
        phase: search.phase,
        status: search.status,
        runtime: search.runtime,
        labelSelector: search.labelSelector,
        label_selector: search.label_selector,
        limit: search.limit,
      })
      setItems(response.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [
    primitive?.kind,
    search.labelSelector,
    search.label_selector,
    search.limit,
    search.namespace,
    search.phase,
    search.runtime,
    search.status,
  ])

  const sortedItems = useMemo(
    () =>
      isAgentRunList
        ? sortAgentRunResources(
            visibleItems,
            search.sort ?? defaultAgentRunSort.sort,
            search.direction ?? defaultAgentRunSort.direction,
          )
        : visibleItems,
    [isAgentRunList, search.direction, search.sort, visibleItems],
  )

  const updateSort = async (sort: AgentRunSortKey) => {
    await navigate({
      to: '/primitives/$kind',
      params: { kind: primitive?.display.pathSegment ?? kind },
      search: nextAgentRunSortSearch(search, sort),
    })
  }

  if (!primitive) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>Unknown primitive.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <ControlPlanePage>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-hidden rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {isAgentRunList ? (
                <>
                  {agentRunSortKeys.map((sort) => (
                    <TableHead
                      key={sort}
                      aria-sort={ariaSortValue(search, sort)}
                      className={sort === 'createdAt' ? 'text-right' : undefined}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={sort === 'createdAt' ? 'ml-auto -mr-2 px-2' : '-ml-2 px-2'}
                        aria-label={`Sort AgentRuns by ${sortableAgentRunColumnLabels[sort]}`}
                        onClick={() => void updateSort(sort)}
                      >
                        {sortableAgentRunColumnLabels[sort]}
                        <SortIcon
                          active={(search.sort ?? defaultAgentRunSort.sort) === sort}
                          direction={search.direction ?? defaultAgentRunSort.direction}
                        />
                      </Button>
                    </TableHead>
                  ))}
                </>
              ) : (
                <>
                  <TableHead>Name</TableHead>
                  <TableHead>Namespace</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedItems.map((item) => {
              const name = resourceName(item) || metadataValue(item, 'name')
              const namespace = resourceNamespace(item)
              const creationTimestamp = resourceCreationTimestamp(item) || metadataValue(item, 'creationTimestamp')
              const phase = resourcePhase(item)
              const agent = agentRunAgentName(item)
              const source = formatAgentRunImplementationSource(item)
              return (
                <TableRow key={`${namespace}/${name}`}>
                  <TableCell className="font-medium">
                    <Link
                      to="/primitives/$kind/$namespace/$name"
                      params={{ kind: primitive.display.pathSegment, namespace, name }}
                      className="underline-offset-4 hover:underline"
                    >
                      {name}
                    </Link>
                  </TableCell>
                  {isAgentRunList ? (
                    <>
                      <TableCell>
                        {phase ? (
                          <Badge variant="secondary">{phase}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>{agent || <span className="text-muted-foreground">-</span>}</TableCell>
                      <TableCell>{source || <span className="text-muted-foreground">-</span>}</TableCell>
                      <TableCell>{namespace}</TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>{namespace}</TableCell>
                      <TableCell>
                        {phase ? (
                          <Badge variant="secondary">{phase}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right text-muted-foreground">{creationTimestamp || '-'}</TableCell>
                </TableRow>
              )
            })}
            {!loading && sortedItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isAgentRunList ? 6 : 4} className="h-24 text-center text-muted-foreground">
                  {isAgentRunList && selectedStatuses.length > 0 ? (
                    <span>
                      No AgentRuns match the selected statuses: {selectedStatuses.join(', ')}. Clear the status filter
                      to see all AgentRuns.
                    </span>
                  ) : isAgentRunList ? (
                    'No AgentRuns found.'
                  ) : (
                    'No resources found.'
                  )}
                </TableCell>
              </TableRow>
            ) : null}
            {loading ? (
              <>
                {Array.from({ length: 8 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      <Skeleton className="h-4 w-[240px] max-w-full" />
                    </TableCell>
                    {isAgentRunList ? (
                      <>
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
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-5 w-20 rounded-full" />
                        </TableCell>
                      </>
                    )}
                    <TableCell>
                      <div className="flex justify-end">
                        <Skeleton className="h-4 w-36" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </ControlPlanePage>
  )
}
