import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/orchestrations/$name')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationDetailPage,
})

const readCount = (value: unknown) => (Array.isArray(value) ? `${value.length}` : '—')

function OrchestrationDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Orchestration"
      title="Orchestration"
      description="Orchestration definition and policy configuration."
      groupLabel="Agents"
      backTo="/agents-control-plane/orchestrations"
      errorLabel="orchestration"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => {
        const spec = resource.spec as Record<string, unknown>
        return [
          { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
          { label: 'Entrypoint', value: readNestedValue(resource, ['spec', 'entrypoint']) ?? '—' },
          { label: 'Steps', value: readCount(spec.steps) },
          { label: 'Retries', value: readNestedValue(resource, ['spec', 'policies', 'retries', 'limit']) ?? '—' },
          {
            label: 'Timeout',
            value: readNestedValue(resource, ['spec', 'policies', 'timeouts', 'totalSeconds']) ?? '—',
          },
        ]
      }}
    />
  )
}
