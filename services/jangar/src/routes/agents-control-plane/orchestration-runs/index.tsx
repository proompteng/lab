import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/orchestration-runs/')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationRunsListRoute,
})

const fields = [
  {
    label: 'Orchestration',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'orchestrationRef', 'name']) ?? '—',
  },
  {
    label: 'Run ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'runId']) ?? '—',
  },
  {
    label: 'Delivery ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'deliveryId']) ?? '—',
  },
  {
    label: 'Started',
    value: (resource: PrimitiveResource) => formatTimestamp(readNestedValue(resource, ['status', 'startedAt'])),
  },
]

function OrchestrationRunsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Orchestration runs"
      description="Execution records for orchestration runs."
      kind="OrchestrationRun"
      emptyLabel="No orchestration runs found."
      detailPath="/agents-control-plane/orchestration-runs/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
