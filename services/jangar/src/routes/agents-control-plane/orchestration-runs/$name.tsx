import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/orchestration-runs/$name')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationRunDetailRoute,
})

function OrchestrationRunDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Orchestration runs"
      description="Orchestration run execution details."
      kind="OrchestrationRun"
      name={params.name}
      backPath="/agents-control-plane/orchestration-runs"
      searchState={searchState}
      summaryItems={(resource, _namespace) => [
        { label: 'Orchestration', value: readNestedValue(resource, ['spec', 'orchestrationRef', 'name']) ?? '—' },
        { label: 'Run ID', value: readNestedValue(resource, ['status', 'runId']) ?? '—' },
        { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
        { label: 'Started', value: readNestedValue(resource, ['status', 'startedAt']) ?? '—' },
        { label: 'Finished', value: readNestedValue(resource, ['status', 'finishedAt']) ?? '—' },
      ]}
    />
  )
}
