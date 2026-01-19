import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { deriveStatusLabel, getMetadataValue, readNestedValue, StatusBadge } from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/agents/')({
  validateSearch: parseNamespaceSearch,
  component: AgentsListPage,
})

const buildAgentFields = (resource: PrimitiveResource) => [
  {
    label: 'Provider',
    value: readNestedValue(resource, ['spec', 'providerRef', 'name']) ?? '—',
  },
  {
    label: 'Memory',
    value: readNestedValue(resource, ['spec', 'memoryRef', 'name']) ?? '—',
  },
  {
    label: 'Timeout',
    value: readNestedValue(resource, ['spec', 'defaults', 'timeoutSeconds']) ?? '—',
  },
  {
    label: 'Retries',
    value: readNestedValue(resource, ['spec', 'defaults', 'retryLimit']) ?? '—',
  },
]

function AgentsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [items, setItems] = React.useState<PrimitiveResource[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const namespaceId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
  }, [searchState.namespace])

  const load = React.useCallback(async (value: string) => {
    setIsLoading(true)
    setError(null)
    setStatus(null)
    try {
      const result = await fetchPrimitiveList({ kind: 'Agent', namespace: value })
      if (!result.ok) {
        setItems([])
        setTotal(0)
        setError(result.message)
        return
      }
      setItems(result.items)
      setTotal(result.total)
      setStatus(result.items.length === 0 ? 'No agents found.' : `Loaded ${result.items.length} agents.`)
    } catch (err) {
      setItems([])
      setTotal(0)
      setError(err instanceof Error ? err.message : 'Failed to load agents')
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load(searchState.namespace)
  }, [load, searchState.namespace])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void navigate({ search: { namespace: namespace.trim() || DEFAULT_NAMESPACE } })
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-xs text-muted-foreground">Agent definitions registered in the control plane.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{total}</span> total
        </div>
      </header>

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="flex min-w-[200px] flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-foreground" htmlFor={namespaceId}>
            Namespace
          </label>
          <Input
            id={namespaceId}
            name="namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="jangar"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={isLoading}>
          Filter
        </Button>
        <Button type="button" variant="outline" onClick={() => void load(searchState.namespace)} disabled={isLoading}>
          Refresh
        </Button>
      </form>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}

      {items.length === 0 && !isLoading ? (
        <div className="rounded-none border border-border bg-card p-6 text-xs text-muted-foreground">
          No agent resources found in this namespace.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-none border border-border bg-card">
          {items.map((resource) => {
            const name = getMetadataValue(resource, 'name') ?? 'unknown'
            const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
            const statusLabel = deriveStatusLabel(resource)
            const fields = buildAgentFields(resource)
            return (
              <li key={`${resourceNamespace}/${name}`} className="border-b border-border last:border-b-0">
                <Link
                  to="/agents-control-plane/agents/$name"
                  params={{ name }}
                  search={{ namespace: resourceNamespace }}
                  className="block space-y-3 p-4 transition hover:bg-muted/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-foreground">{name}</div>
                      <div className="text-xs text-muted-foreground">{resourceNamespace}</div>
                    </div>
                    <StatusBadge label={statusLabel} />
                  </div>
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                    {fields.map((field) => (
                      <div key={field.label} className="space-y-0.5">
                        <div className="uppercase tracking-wide text-[10px]">{field.label}</div>
                        <div className="text-foreground">{field.value}</div>
                      </div>
                    ))}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
