import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/tool-runs/$name')({
  validateSearch: parseNamespaceSearch,
  component: ToolRunDetailRoute,
})

function ToolRunDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Tool runs"
      description="Tool run execution details."
      kind="ToolRun"
      name={params.name}
      backPath="/agents-control-plane/tool-runs"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Tool', value: readNestedValue(resource, ['spec', 'toolRef', 'name']) ?? '—' },
        { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
        { label: 'Run ID', value: readNestedValue(resource, ['status', 'runId']) ?? '—' },
        { label: 'Started', value: readNestedValue(resource, ['status', 'startedAt']) ?? '—' },
        { label: 'Finished', value: readNestedValue(resource, ['status', 'finishedAt']) ?? '—' },
      ]}
    />
  )
}
