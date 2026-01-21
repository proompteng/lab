import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  deriveStatusCategory,
  formatGenerationSummary,
  formatTimestamp,
  getMetadataValue,
  getResourceCreatedAt,
  getResourceReconciledAt,
  getResourceUpdatedAt,
  readNestedValue,
  StatusBadge,
  summarizeConditions,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, parseAgentRunsSearch } from '@/components/agents-control-plane-search'
import { useControlPlaneStream } from '@/components/agents-control-plane-stream'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/agent-runs/')({
  validateSearch: parseAgentRunsSearch,
  component: AgentRunsListPage,
})

const buildAgentRunFields = (resource: PrimitiveResource) => {
  const specRef = readNestedValue(resource, ['spec', 'implementationSpecRef', 'name'])
  const inlineImpl = readNestedValue(resource, ['spec', 'implementation', 'inline', 'title'])
  return [
    {
      label: 'Agent',
      value: readNestedValue(resource, ['spec', 'agentRef', 'name']) ?? '—',
    },
    {
      label: 'Implementation',
      value: specRef ?? inlineImpl ?? '—',
    },
    {
      label: 'Runtime',
      value: readNestedValue(resource, ['spec', 'runtime', 'type']) ?? '—',
    },
    {
      label: 'Phase',
      value: readNestedValue(resource, ['status', 'phase']) ?? '—',
    },
  ]
}

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
  const [status, setStatus] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const reloadTimerRef = React.useRef<number | null>(null)

  const namespaceId = React.useId()
  const labelSelectorId = React.useId()
  const phaseId = React.useId()
  const runtimeId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
    setLabelSelector(searchState.labelSelector ?? '')
    setPhase(searchState.phase ?? '')
    setRuntime(searchState.runtime ?? '')
  }, [searchState.labelSelector, searchState.namespace, searchState.phase, searchState.runtime])

  const load = React.useCallback(
    async (params: { namespace: string; labelSelector?: string; phase?: string; runtime?: string }) => {
      setIsLoading(true)
      setError(null)
      setStatus(null)
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
        setStatus(result.items.length === 0 ? 'No agent runs found.' : `Loaded ${result.items.length} runs.`)
      } catch (err) {
        setItems([])
        setTotal(0)
        setError(err instanceof Error ? err.message : 'Failed to load agent runs')
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

  const scheduleReload = React.useCallback(() => {
    if (reloadTimerRef.current !== null) return
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null
      void load({
        namespace: searchState.namespace,
        labelSelector: searchState.labelSelector,
        phase: searchState.phase,
        runtime: searchState.runtime,
      })
    }, 350)
  }, [load, searchState.labelSelector, searchState.namespace, searchState.phase, searchState.runtime])

  useControlPlaneStream(searchState.namespace, {
    onEvent: (event) => {
      if (event.type !== 'resource') return
      if (event.kind !== 'AgentRun') return
      if (event.namespace !== searchState.namespace) return
      scheduleReload()
    },
  })

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextNamespace = namespace.trim() || DEFAULT_NAMESPACE
    const selectorValue = labelSelector.trim()
    const nextPhase = phase.trim()
    const nextRuntime = runtime.trim()
    void navigate({
      search: {
        namespace: nextNamespace,
        labelSelector: selectorValue.length > 0 ? selectorValue : undefined,
        phase: nextPhase.length > 0 ? nextPhase : undefined,
        runtime: nextRuntime.length > 0 ? nextRuntime : undefined,
      },
    })
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">Agent runs</h1>
          <p className="text-xs text-muted-foreground">Execution history and runtime status.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{total}</span> total
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
          <label className="text-xs font-medium text-foreground" htmlFor={labelSelectorId}>
            Label selector
          </label>
          <Input
            id={labelSelectorId}
            name="labelSelector"
            value={labelSelector}
            onChange={(event) => setLabelSelector(event.target.value)}
            placeholder="app=agent"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label className="text-xs font-medium text-foreground" htmlFor={phaseId}>
            Phase
          </label>
          <Input
            id={phaseId}
            name="phase"
            value={phase}
            onChange={(event) => setPhase(event.target.value)}
            placeholder="Succeeded"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label className="text-xs font-medium text-foreground" htmlFor={runtimeId}>
            Runtime
          </label>
          <Input
            id={runtimeId}
            name="runtime"
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
            placeholder="native"
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
      {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}

      {items.length === 0 && !isLoading ? (
        <div className="rounded-none border border-border bg-card p-6 text-xs text-muted-foreground">
          No agent runs found in this namespace.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-none border border-border bg-card">
          {items.map((resource) => {
            const name = getMetadataValue(resource, 'name') ?? 'unknown'
            const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
            const statusLabel = deriveStatusCategory(resource)
            const conditionSummary = summarizeConditions(resource)
            const createdAt = getResourceCreatedAt(resource)
            const updatedAt = getResourceUpdatedAt(resource)
            const reconciledAt = getResourceReconciledAt(resource)
            const generationSummary = formatGenerationSummary(resource)
            const fields = buildAgentRunFields(resource)
            return (
              <li key={`${resourceNamespace}/${name}`} className="border-b border-border last:border-b-0">
                <Link
                  to="/agents-control-plane/agent-runs/$name"
                  params={{ name }}
                  search={{
                    namespace: resourceNamespace,
                    labelSelector: searchState.labelSelector,
                    phase: searchState.phase,
                    runtime: searchState.runtime,
                  }}
                  className="block space-y-3 p-4 transition hover:bg-muted/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-foreground">{name}</div>
                      <div className="text-xs text-muted-foreground">{resourceNamespace}</div>
                    </div>
                    <StatusBadge label={statusLabel} />
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Conditions</span>
                      <span className="text-foreground">{conditionSummary.summary}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Last transition</span>
                      <span className="text-foreground">{formatTimestamp(conditionSummary.lastTransitionTime)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Created</span>
                      <span className="text-foreground">{formatTimestamp(createdAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Updated</span>
                      <span className="text-foreground">{formatTimestamp(updatedAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Reconciled</span>
                      <span className="text-foreground">{formatTimestamp(reconciledAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide">Observed gen</span>
                      <span className="text-foreground">{generationSummary}</span>
                    </div>
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
