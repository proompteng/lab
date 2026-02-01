import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  deriveStatusCategory,
  formatTimestamp,
  getMetadataValue,
  getResourceUpdatedAt,
  readNestedValue,
  StatusBadge,
  summarizeConditions,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'

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
  const [status, setStatus] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const namespaceId = React.useId()
  const labelSelectorId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
    setLabelSelector(searchState.labelSelector ?? '')
  }, [searchState.labelSelector, searchState.namespace])

  const load = React.useCallback(async (params: { namespace: string; labelSelector?: string }) => {
    setIsLoading(true)
    setError(null)
    setStatus(null)
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
      setStatus(result.items.length === 0 ? 'No specs found.' : null)
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

  return (
    <main className="mx-auto w-full space-y-2 p-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Control plane</p>
          <h1 className="text-lg font-semibold">Specs</h1>
          <p className="text-xs text-muted-foreground">Browse and launch implementation specs.</p>
        </div>
        <Button asChild>
          <Link
            to="/agents-control-plane/implementation-specs/new"
            search={{ namespace: searchState.namespace, labelSelector: searchState.labelSelector }}
          >
            Create spec
          </Link>
        </Button>
      </header>

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
      {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}
      {total > 0 ? <div className="text-xs text-muted-foreground">Loaded {total} specs.</div> : null}

      <div className="overflow-hidden rounded-none border bg-card">
        <table className="w-full table-fixed text-[11px] leading-tight">
          <colgroup>
            <col className="w-[20%]" />
            <col className="w-[32%]" />
            <col className="w-[12%]" />
            <col className="w-[14%]" />
            <col className="w-[18%]" />
            <col className="w-[4%]" />
          </colgroup>
          <thead className="border-b bg-muted/30 text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr className="text-left">
              <th className="px-2 py-1 font-medium">Spec</th>
              <th className="px-2 py-1 font-medium">Summary</th>
              <th className="px-2 py-1 font-medium">Namespace</th>
              <th className="px-2 py-1 font-medium">Updated</th>
              <th className="px-2 py-1 font-medium">Status</th>
              <th className="px-2 py-1 font-medium text-right">Use</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                  No specs found in this namespace.
                </td>
              </tr>
            ) : (
              items.map((resource) => {
                const name = getMetadataValue(resource, 'name') ?? 'unknown'
                const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
                const summary = readNestedValue(resource, ['spec', 'summary']) ?? '—'
                const updatedAt = getResourceUpdatedAt(resource)
                const statusLabel = deriveStatusCategory(resource)
                const conditionSummary = summarizeConditions(resource)

                return (
                  <tr
                    key={`${resourceNamespace}/${name}`}
                    className="border-b transition-colors last:border-b-0 hover:bg-muted/40"
                    onClick={() => openSpec(name, resourceNamespace)}
                  >
                    <td className="px-2 py-1 font-medium text-foreground">
                      <span className="block truncate">{name}</span>
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">
                      <span className="block truncate text-foreground">{summary}</span>
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{resourceNamespace}</td>
                    <td className="px-2 py-1 text-muted-foreground">{formatTimestamp(updatedAt)}</td>
                    <td className="px-2 py-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusBadge label={statusLabel} className="px-1.5 py-0 text-[10px] leading-none" />
                        <span
                          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                          title={conditionSummary.summary}
                        >
                          {conditionSummary.summary}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        className={cn(
                          'inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide',
                          'text-muted-foreground transition hover:text-foreground',
                        )}
                        onClick={(event) => {
                          event.stopPropagation()
                          openSpec(name, resourceNamespace)
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
