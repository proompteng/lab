import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/agents/$name')({
  validateSearch: parseNamespaceSearch,
  component: AgentDetailPage,
})

function AgentDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Agent"
      title="Agent"
      description="Agent configuration and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/agents"
      errorLabel="agent"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Provider', value: readNestedValue(resource, ['spec', 'providerRef', 'name']) ?? '—' },
        { label: 'Memory', value: readNestedValue(resource, ['spec', 'memoryRef', 'name']) ?? '—' },
        { label: 'Timeout', value: readNestedValue(resource, ['spec', 'defaults', 'timeoutSeconds']) ?? '—' },
        { label: 'Retries', value: readNestedValue(resource, ['spec', 'defaults', 'retryLimit']) ?? '—' },
      ]}
    />
  )
}
