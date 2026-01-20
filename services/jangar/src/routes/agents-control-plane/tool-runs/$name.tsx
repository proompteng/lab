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
        { label: 'Action', value: readNestedValue(resource, ['spec', 'parameters', 'action']) ?? '—' },
        { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
        { label: 'Retry limit', value: readNestedValue(resource, ['spec', 'retryPolicy', 'limit']) ?? '—' },
      ]}
    />
  )
}
