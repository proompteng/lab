import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/orchestration-runs/$name')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationRunDetailPage,
})

function OrchestrationRunDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="OrchestrationRun"
      title="Orchestration run"
      description="Orchestration run execution details."
      groupLabel="Agents"
      backTo="/agents-control-plane/orchestration-runs"
      errorLabel="orchestration run"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Orchestration', value: readNestedValue(resource, ['spec', 'orchestrationRef', 'name']) ?? '—' },
        { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
        { label: 'Run ID', value: readNestedValue(resource, ['status', 'runId']) ?? '—' },
        { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
        { label: 'Started', value: formatTimestamp(readNestedValue(resource, ['status', 'startedAt'])) },
        { label: 'Finished', value: formatTimestamp(readNestedValue(resource, ['status', 'finishedAt'])) },
      ]}
    />
  )
}
