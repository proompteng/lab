import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { formatTimestamp } from '@/components/agents-control-plane'
import {
  ControlPlaneControllersPanel,
  ControlPlaneOverviewTile,
  ControlPlaneProblems,
  controlPlaneSections,
  useControlPlaneOverview,
} from '@/components/agents-control-plane-overview'
import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/agents-control-plane/')({
  validateSearch: parseNamespaceSearch,
  component: AgentsControlPlanePage,
})

const matchesSearch = (value: string, query: string) => value.toLowerCase().includes(query)

function AgentsControlPlanePage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [query, setQuery] = React.useState('')

  const namespaceId = React.useId()
  const searchId = React.useId()

  const { tiles, problems, isLoading, error, lastUpdatedAt, refresh } = useControlPlaneOverview(searchState.namespace)

  React.useEffect(() => {
    setNamespace(searchState.namespace)
  }, [searchState.namespace])

  const tilesByKind = React.useMemo(() => {
    return new Map(tiles.map((tile) => [tile.definition.kind, tile]))
  }, [tiles])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredSections = React.useMemo(() => {
    if (!normalizedQuery) return controlPlaneSections
    return controlPlaneSections
      .map((section) => ({
        label: section.label,
        items: section.items.filter((item) =>
          [item.title, item.description, item.kind, item.section].some((value) =>
            matchesSearch(value, normalizedQuery),
          ),
        ),
      }))
      .filter((section) => section.items.length > 0)
  }, [normalizedQuery])

  const totals = React.useMemo(() => {
    return tiles.reduce(
      (acc, tile) => {
        acc.total += tile.total
        acc.ready += tile.readyCount
        acc.running += tile.runningCount
        acc.failed += tile.failedCount
        acc.unknown += tile.unknownCount
        return acc
      },
      { total: 0, ready: 0, running: 0, failed: 0, unknown: 0 },
    )
  }, [tiles])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void navigate({ search: { namespace: namespace.trim() || DEFAULT_NAMESPACE } })
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">Agents control plane</h1>
          <p className="text-xs text-muted-foreground">
            ArgoCD-style overview for agent primitives, health, and recent control-plane failures.
          </p>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <div>
            Namespace <span className="font-semibold text-foreground">{searchState.namespace}</span>
          </div>
          <div>Last updated {formatTimestamp(lastUpdatedAt)}</div>
        </div>
      </header>

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
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
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label className="text-xs font-medium text-foreground" htmlFor={searchId}>
            Search
          </label>
          <Input
            id={searchId}
            name="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter primitives"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={isLoading}>
          Filter
        </Button>
        <Button type="button" variant="outline" onClick={refresh} disabled={isLoading}>
          Refresh
        </Button>
      </form>

      {error ? (
        <div className="rounded-none border p-3 text-xs border-destructive/40 bg-destructive/10 text-destructive">
          {error}
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Total resources', value: totals.total },
          { label: 'Ready', value: totals.ready },
          { label: 'Running', value: totals.running },
          { label: 'Failed', value: totals.failed },
          { label: 'Unknown', value: totals.unknown },
        ].map((summary) => (
          <div key={summary.label} className="rounded-none border p-3 border-border bg-card">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {summary.label}
            </div>
            <div className="text-base font-semibold text-foreground tabular-nums">{summary.value}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {filteredSections.map((section) => (
            <div key={section.label} className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  {section.label}
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">{section.items.length}</span>
              </div>
              <div className={cn('grid gap-4', section.items.length > 1 ? 'sm:grid-cols-2' : '')}>
                {section.items.map((item) => (
                  <ControlPlaneOverviewTile
                    key={item.kind}
                    definition={item}
                    data={tilesByKind.get(item.kind)}
                    namespace={searchState.namespace}
                    isLoading={isLoading}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-6">
          <ControlPlaneControllersPanel tiles={tiles} />
          <ControlPlaneProblems
            problems={problems}
            namespace={searchState.namespace}
            isLoading={isLoading}
            error={error}
          />
        </div>
      </section>
    </main>
  )
}
