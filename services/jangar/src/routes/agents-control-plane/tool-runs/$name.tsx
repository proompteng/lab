import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/tool-runs/$name')({
  validateSearch: parseNamespaceSearch,
  component: ToolRunDetailPage,
})

function ToolRunDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="ToolRun"
      title="Tool run"
      description="Tool run execution details."
      groupLabel="Agents"
      backTo="/agents-control-plane/tool-runs"
      errorLabel="tool run"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Tool', value: readNestedValue(resource, ['spec', 'toolRef', 'name']) ?? '—' },
        { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
        { label: 'Retries', value: readNestedValue(resource, ['spec', 'retryPolicy', 'limit']) ?? '—' },
        { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
        { label: 'Started', value: formatTimestamp(readNestedValue(resource, ['status', 'startedAt'])) },
        { label: 'Finished', value: formatTimestamp(readNestedValue(resource, ['status', 'finishedAt'])) },
      ]}
    />
  )
}
