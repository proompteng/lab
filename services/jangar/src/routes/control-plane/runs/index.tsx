import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import {
  deriveStatusCategory,
  formatTimestamp,
  getMetadataValue,
  getResourceUpdatedAt,
  StatusBadge,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, parseAgentRunsSearch } from '@/components/agents-control-plane-search'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { deletePrimitiveResource, fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'

const PAGE_SIZE = 20

const parseUpdatedAt = (resource: PrimitiveResource) => {
  const value = getResourceUpdatedAt(resource)
  if (!value) return 0
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return 0
  return parsed
}

const readString = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

const readRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const readNested = (value: unknown, path: Array<string | number>) => {
  let cursor: unknown = value
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor) || cursor.length <= segment) return null
      cursor = cursor[segment]
      continue
    }
    const record = readRecord(cursor)
    if (!record) return null
    cursor = record[segment]
  }
  return cursor
}

const readNestedString = (value: unknown, path: Array<string | number>) => readString(readNested(value, path))

const resolveSpecLabel = (resource: PrimitiveResource) => {
  const directSpec = readNestedString(resource, ['spec', 'implementationSpecRef', 'name'])
  if (directSpec) return directSpec

  const workflowSpec = readNestedString(resource, ['spec', 'workflow', 'steps', 0, 'implementationSpecRef', 'name'])
  if (workflowSpec) return workflowSpec

  const workflow = readRecord(readNested(resource, ['spec', 'workflow']))
  const workflowSteps = Array.isArray(workflow?.steps) ? workflow.steps : []
  if (workflowSteps.length > 0) {
    const suffix = workflowSteps.length === 1 ? '' : 's'
    return `Workflow (${workflowSteps.length} step${suffix})`
  }

  const inlineImplementation = readRecord(readNested(resource, ['spec', 'implementation']))
  if (inlineImplementation) return 'Inline implementation'

  return '—'
}

const resolveAgentName = (resource: PrimitiveResource) =>
  readNestedString(resource, ['spec', 'agentRef', 'name']) ?? '—'

export const Route = createFileRoute('/control-plane/runs/')({
  validateSearch: parseAgentRunsSearch,
  component: AgentRunsListPage,
})

function AgentRunsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [labelSelector, setLabelSelector] = React.useState(searchState.labelSelector ?? '')
  const [phase, setPhase] = React.useState(searchState.phase ?? '')
  const [runtime, setRuntime] = React.useState(searchState.runtime ?? '')
  const [items, setItems] = React.useState<PrimitiveResource[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(() => new Set())
  const [page, setPage] = React.useState(1)

  const namespaceId = React.useId()
  const labelSelectorId = React.useId()
  const phaseId = React.useId()
  const runtimeId = React.useId()
  const selectAllId = React.useId()
  const selectAllRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    setNamespace(searchState.namespace)
    setLabelSelector(searchState.labelSelector ?? '')
    setPhase(searchState.phase ?? '')
    setRuntime(searchState.runtime ?? '')
    setPage(1)
    setSelectedKeys(new Set())
  }, [searchState.labelSelector, searchState.namespace, searchState.phase, searchState.runtime])

  React.useEffect(() => {
    if (selectedKeys.size === 0) {
      setDeleteDialogOpen(false)
    }
  }, [selectedKeys.size])

  const load = React.useCallback(
    async (params: { namespace: string; labelSelector?: string; phase?: string; runtime?: string }) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await fetchPrimitiveList({
          kind: 'AgentRun',
          namespace: params.namespace,
          labelSelector: params.labelSelector,
          phase: params.phase,
          runtime: params.runtime,
        })
        if (!result.ok) {
          setItems([])
          setTotal(0)
          setError(result.message)
          return
        }
        setItems(result.items)
        setTotal(result.total)
      } catch (err) {
        setItems([])
        setTotal(0)
        setError(err instanceof Error ? err.message : 'Failed to load runs')
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  React.useEffect(() => {
    void load({
      namespace: searchState.namespace,
      labelSelector: searchState.labelSelector,
      phase: searchState.phase,
      runtime: searchState.runtime,
    })
  }, [load, searchState.labelSelector, searchState.namespace, searchState.phase, searchState.runtime])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextNamespace = namespace.trim() || DEFAULT_NAMESPACE
    const nextLabelSelector = labelSelector.trim()
    const nextPhase = phase.trim()
    const nextRuntime = runtime.trim()
    void navigate({
      search: {
        namespace: nextNamespace,
        ...(nextLabelSelector.length > 0 ? { labelSelector: nextLabelSelector } : {}),
        ...(nextPhase.length > 0 ? { phase: nextPhase } : {}),
        ...(nextRuntime.length > 0 ? { runtime: nextRuntime } : {}),
      },
    })
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const pageEnd = Math.min(total, page * PAGE_SIZE)
  const sortedItems = React.useMemo(() => {
    return [...items].sort((a, b) => parseUpdatedAt(b) - parseUpdatedAt(a))
  }, [items])

  const pagedItems = React.useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return sortedItems.slice(start, start + PAGE_SIZE)
  }, [page, sortedItems])
  const placeholderCount = Math.max(0, PAGE_SIZE - pagedItems.length)
  const placeholderRows = React.useMemo(
    () => Array.from({ length: placeholderCount }, (_, index) => `placeholder-${page}-${index}`),
    [page, placeholderCount],
  )

  const keyForResource = React.useCallback(
    (resource: PrimitiveResource) => {
      const name = getMetadataValue(resource, 'name') ?? 'unknown'
      const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
      return `${resourceNamespace}/${name}`
    },
    [searchState.namespace],
  )

  React.useEffect(() => {
    setSelectedKeys((prev) => {
      const next = new Set<string>()
      for (const resource of sortedItems) {
        const key = keyForResource(resource)
        if (prev.has(key)) next.add(key)
      }
      return next
    })
  }, [keyForResource, sortedItems])

  const pageKeys = React.useMemo(() => pagedItems.map(keyForResource), [keyForResource, pagedItems])
  const isPageSelected = pageKeys.length > 0 && pageKeys.every((key) => selectedKeys.has(key))
  const isPagePartiallySelected = pageKeys.some((key) => selectedKeys.has(key)) && !isPageSelected

  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = isPagePartiallySelected
    }
  }, [isPagePartiallySelected])

  const toggleSelection = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const togglePageSelection = (checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (checked) {
        for (const key of pageKeys) {
          next.add(key)
        }
      } else {
        for (const key of pageKeys) {
          next.delete(key)
        }
      }
      return next
    })
  }

  const selectedResources = React.useMemo(() => {
    if (selectedKeys.size === 0) return []
    return sortedItems.filter((resource) => selectedKeys.has(keyForResource(resource)))
  }, [keyForResource, selectedKeys, sortedItems])

  const deleteSelected = async () => {
    if (selectedResources.length === 0 || isDeleting) return false
    setIsDeleting(true)
    setDeleteError(null)
    try {
      const targets = selectedResources
        .map((resource) => {
          const name = getMetadataValue(resource, 'name')
          const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
          if (!name) return null
          return { name, namespace: resourceNamespace }
        })
        .filter((target): target is { name: string; namespace: string } => Boolean(target))
      if (targets.length !== selectedResources.length) {
        setDeleteError('Some selected runs are missing names.')
        return false
      }
      const results = await Promise.all(
        targets.map((target) =>
          deletePrimitiveResource({ kind: 'AgentRun', name: target.name, namespace: target.namespace }),
        ),
      )
      const failures = results.filter((result) => !result.ok)
      if (failures.length > 0) {
        setDeleteError(failures[0]?.message ?? 'Failed to delete runs')
        return false
      }
      setSelectedKeys(new Set())
      await load({
        namespace: searchState.namespace,
        labelSelector: searchState.labelSelector,
        phase: searchState.phase,
        runtime: searchState.runtime,
      })
      return true
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete runs')
      return false
    } finally {
      setIsDeleting(false)
    }
  }

  const confirmDelete = async () => {
    const success = await deleteSelected()
    if (success) {
      setDeleteDialogOpen(false)
    }
  }

  React.useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const pageItems = React.useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1)
    }
    if (page <= 3) {
      return [1, 2, 3, 4, 'ellipsis', totalPages] as const
    }
    if (page >= totalPages - 2) {
      return [1, 'ellipsis', totalPages - 3, totalPages - 2, totalPages - 1, totalPages] as const
    }
    return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages] as const
  }, [page, totalPages])
  const pageItemsWithKeys = React.useMemo(
    () =>
      pageItems.map((item, index) => ({
        item,
        key: typeof item === 'number' ? `page-${item}` : `ellipsis-${page}-${index}`,
      })),
    [page, pageItems],
  )

  return (
    <main className="mx-auto w-full space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogTrigger
            render={
              <Button variant="destructive" disabled={selectedKeys.size === 0 || isDeleting}>
                {isDeleting ? 'Deleting...' : 'Delete selected'}
              </Button>
            }
          />
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete selected runs?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes {selectedKeys.size} run{selectedKeys.size === 1 ? '' : 's'} and cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault()
                  void confirmDelete()
                }}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-xs font-medium text-foreground" htmlFor={namespaceId}>
            Namespace
          </label>
          <Input
            id={namespaceId}
            name="namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="agents"
            autoComplete="off"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-xs font-medium text-foreground" htmlFor={labelSelectorId}>
            Label selector
          </label>
          <Input
            id={labelSelectorId}
            name="labelSelector"
            value={labelSelector}
            onChange={(event) => setLabelSelector(event.target.value)}
            placeholder="key=value"
            autoComplete="off"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-xs font-medium text-foreground" htmlFor={phaseId}>
            Phase
          </label>
          <Input
            id={phaseId}
            name="phase"
            value={phase}
            onChange={(event) => setPhase(event.target.value)}
            placeholder="Running"
            autoComplete="off"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-xs font-medium text-foreground" htmlFor={runtimeId}>
            Runtime
          </label>
          <Input
            id={runtimeId}
            name="runtime"
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
            placeholder="workflow"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={isLoading}>
          Filter
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void load({
              namespace: searchState.namespace,
              labelSelector: searchState.labelSelector,
              phase: searchState.phase,
              runtime: searchState.runtime,
            })
          }
          disabled={isLoading}
        >
          Refresh
        </Button>
      </form>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {deleteError ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {deleteError}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-none border bg-card">
        <table className="w-full table-fixed text-xs leading-tight">
          <colgroup>
            <col className="w-[4%]" />
            <col className="w-[22%]" />
            <col className="w-[18%]" />
            <col className="w-[22%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead className="border-b bg-muted/30 text-xs uppercase tracking-widest text-muted-foreground">
            <tr className="text-left">
              <th className="px-2 py-1.5 font-medium">
                <span className="sr-only">Select</span>
                <input
                  ref={selectAllRef}
                  id={selectAllId}
                  type="checkbox"
                  className="size-3 accent-foreground"
                  checked={isPageSelected}
                  disabled={pageKeys.length === 0}
                  onChange={(event) => togglePageSelection(event.target.checked)}
                />
              </th>
              <th className="px-2 py-1.5 font-medium">Run</th>
              <th className="px-2 py-1.5 font-medium">Agent</th>
              <th className="px-2 py-1.5 font-medium">Spec</th>
              <th className="px-2 py-1.5 font-medium">Namespace</th>
              <th className="px-2 py-1.5 font-medium">Updated</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {pagedItems.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                  No runs found in this namespace.
                </td>
              </tr>
            ) : (
              <>
                {pagedItems.map((resource) => {
                  const name = getMetadataValue(resource, 'name') ?? 'unknown'
                  const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
                  const updatedAt = getResourceUpdatedAt(resource)
                  const statusLabel = deriveStatusCategory(resource)
                  const agentName = resolveAgentName(resource)
                  const specLabel = resolveSpecLabel(resource)
                  const rowKey = `${resourceNamespace}/${name}`

                  return (
                    <tr
                      key={`${resourceNamespace}/${name}`}
                      className="border-b cursor-default transition-colors last:border-b-0 hover:bg-muted/40"
                    >
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          className="size-3 accent-foreground"
                          checked={selectedKeys.has(rowKey)}
                          onChange={() => toggleSelection(rowKey)}
                          aria-label={`Select ${name}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-medium text-foreground">
                        <span className="block truncate">{name}</span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        <span className="block truncate text-foreground">{agentName}</span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        <span className="block truncate text-foreground">{specLabel}</span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{resourceNamespace}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{formatTimestamp(updatedAt)}</td>
                      <td className="px-2 py-1.5">
                        <StatusBadge label={statusLabel} className="px-1.5 py-0 leading-none" />
                      </td>
                    </tr>
                  )
                })}
                {pagedItems.length > 0
                  ? placeholderRows.map((rowKey) => (
                      <tr key={rowKey} className="border-b last:border-b-0 pointer-events-none" aria-hidden>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="opacity-0">-</span>
                        </td>
                      </tr>
                    ))
                  : null}
              </>
            )}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 py-1 text-xs text-muted-foreground">
          <span>
            {total === 0 ? '0 runs' : `Showing ${pageStart}-${pageEnd} of ${total}`}
            {selectedKeys.size > 0 ? ` • ${selectedKeys.size} selected` : ''}
          </span>
          {totalPages > 1 ? (
            <Pagination className="mx-0 w-auto justify-end text-xs">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    aria-disabled={page === 1}
                    tabIndex={page === 1 ? -1 : 0}
                    className={page === 1 ? 'pointer-events-none opacity-50' : undefined}
                    onClick={(event) => {
                      event.preventDefault()
                      setPage((prev) => Math.max(1, prev - 1))
                    }}
                  />
                </PaginationItem>
                {pageItemsWithKeys.map((entry) => {
                  if (entry.item === 'ellipsis') {
                    return (
                      <PaginationItem key={entry.key}>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )
                  }
                  return (
                    <PaginationItem key={entry.key}>
                      <PaginationLink
                        href="#"
                        isActive={entry.item === page}
                        onClick={(event) => {
                          event.preventDefault()
                          setPage(entry.item)
                        }}
                      >
                        {entry.item}
                      </PaginationLink>
                    </PaginationItem>
                  )
                })}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    aria-disabled={page === totalPages}
                    tabIndex={page === totalPages ? -1 : 0}
                    className={page === totalPages ? 'pointer-events-none opacity-50' : undefined}
                    onClick={(event) => {
                      event.preventDefault()
                      setPage((prev) => Math.min(totalPages, prev + 1))
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          ) : null}
        </div>
      </div>
    </main>
  )
}
