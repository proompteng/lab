import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  deriveStatusCategory,
  formatTimestamp,
  getMetadataValue,
  getResourceUpdatedAt,
  readNestedValue,
  StatusBadge,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
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
import { fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'

const PAGE_SIZE = 20

const parseUpdatedAt = (resource: PrimitiveResource) => {
  const value = getResourceUpdatedAt(resource)
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export const Route = createFileRoute('/agents-control-plane/implementation-specs/')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecsListPage,
})

function ImplementationSpecsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [labelSelector, setLabelSelector] = React.useState(searchState.labelSelector ?? '')
  const [items, setItems] = React.useState<PrimitiveResource[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [page, setPage] = React.useState(1)

  const namespaceId = React.useId()
  const labelSelectorId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
    setLabelSelector(searchState.labelSelector ?? '')
    setPage(1)
  }, [searchState.labelSelector, searchState.namespace])

  const load = React.useCallback(async (params: { namespace: string; labelSelector?: string }) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await fetchPrimitiveList({
        kind: 'ImplementationSpec',
        namespace: params.namespace,
        labelSelector: params.labelSelector,
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
      setError(err instanceof Error ? err.message : 'Failed to load specs')
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load({ namespace: searchState.namespace, labelSelector: searchState.labelSelector })
  }, [load, searchState.labelSelector, searchState.namespace])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextNamespace = namespace.trim() || DEFAULT_NAMESPACE
    const nextLabelSelector = labelSelector.trim()
    void navigate({
      search: {
        namespace: nextNamespace,
        ...(nextLabelSelector.length > 0 ? { labelSelector: nextLabelSelector } : {}),
      },
    })
  }

  const openSpec = (name: string, resourceNamespace: string) => {
    void navigate({
      to: '/agents-control-plane/implementation-specs/$name',
      params: { name },
      search: { namespace: resourceNamespace },
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

  return (
    <main className="mx-auto w-full space-y-2 p-4">
      <div className="flex items-center justify-end">
        <Button asChild>
          <Link
            to="/agents-control-plane/implementation-specs/new"
            search={{ namespace: searchState.namespace, labelSelector: searchState.labelSelector }}
          >
            Create spec
          </Link>
        </Button>
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
        <Button type="submit" disabled={isLoading}>
          Filter
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void load({ namespace: searchState.namespace, labelSelector: searchState.labelSelector })}
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

      <div className="overflow-hidden rounded-none border bg-card">
        <table className="w-full table-fixed text-xs leading-tight">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[36%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="border-b bg-muted/30 text-xs uppercase tracking-widest text-muted-foreground">
            <tr className="text-left">
              <th className="px-2 py-1.5 font-medium">Spec</th>
              <th className="px-2 py-1.5 font-medium">Summary</th>
              <th className="px-2 py-1.5 font-medium">Namespace</th>
              <th className="px-2 py-1.5 font-medium">Updated</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {pagedItems.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                  No specs found in this namespace.
                </td>
              </tr>
            ) : (
              pagedItems.map((resource) => {
                const name = getMetadataValue(resource, 'name') ?? 'unknown'
                const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
                const summary = readNestedValue(resource, ['spec', 'summary']) ?? '—'
                const updatedAt = getResourceUpdatedAt(resource)
                const statusLabel = deriveStatusCategory(resource)

                return (
                  <tr
                    key={`${resourceNamespace}/${name}`}
                    className="border-b cursor-default transition-colors last:border-b-0 hover:bg-muted/40"
                    onClick={() => openSpec(name, resourceNamespace)}
                  >
                    <td className="px-2 py-1.5 font-medium text-foreground">
                      <span className="block truncate">{name}</span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      <span className="block truncate text-foreground">{summary}</span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{resourceNamespace}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{formatTimestamp(updatedAt)}</td>
                    <td className="px-2 py-1.5">
                      <StatusBadge label={statusLabel} className="px-1.5 py-0 leading-none" />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 py-1 text-xs text-muted-foreground">
          <span>{total === 0 ? '0 specs' : `Showing ${pageStart}-${pageEnd} of ${total}`}</span>
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
                {pageItems.map((item, index) =>
                  item === 'ellipsis' ? (
                    <PaginationItem key={`ellipsis-${index}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        href="#"
                        isActive={item === page}
                        onClick={(event) => {
                          event.preventDefault()
                          setPage(item)
                        }}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
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
