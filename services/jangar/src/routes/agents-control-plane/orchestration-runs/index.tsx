import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
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
    label: 'Composition',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'compositionRef', 'name']) ?? '—',
  },
  {
    label: 'Run ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'parameters', 'runId']) ?? '—',
  },
  {
    label: 'Delivery ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'deliveryId']) ?? '—',
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
