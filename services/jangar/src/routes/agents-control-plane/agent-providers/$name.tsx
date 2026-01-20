import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/agent-providers/$name')({
  validateSearch: parseNamespaceSearch,
  component: AgentProviderDetailPage,
})

function AgentProviderDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="AgentProvider"
      title="Agent provider"
      description="Agent provider configuration and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/agent-providers"
      errorLabel="agent provider"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        {
          label: 'Type',
          value: readNestedValue(resource, ['spec', 'type']) ?? readNestedValue(resource, ['spec', 'provider']) ?? '—',
        },
        { label: 'Endpoint', value: readNestedValue(resource, ['spec', 'endpoint']) ?? '—' },
        {
          label: 'Secret',
          value:
            readNestedValue(resource, ['spec', 'connection', 'secretRef', 'name']) ??
            readNestedValue(resource, ['spec', 'secretRef', 'name']) ??
            '—',
        },
        { label: 'Mode', value: readNestedValue(resource, ['spec', 'mode']) ?? '—' },
      ]}
    />
  )
}
