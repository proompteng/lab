import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/orchestration-runs/')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationRunsListPage,
})

const buildOrchestrationRunFields = (resource: PrimitiveResource) => [
  { label: 'Orchestration', value: readNestedValue(resource, ['spec', 'orchestrationRef', 'name']) ?? '—' },
  { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
  { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
  {
    label: 'Started',
    value: formatTimestamp(readNestedValue(resource, ['status', 'startedAt'])),
  },
]

function OrchestrationRunsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="OrchestrationRun"
      title="Orchestration runs"
      description="Execution records and runtime status."
      groupLabel="Agents"
      emptyLabel="No orchestration runs found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No orchestration runs found.' : `Loaded ${count} runs.`)}
      errorLabel="orchestration runs"
      detailTo="/agents-control-plane/orchestration-runs/$name"
      buildFields={buildOrchestrationRunFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
