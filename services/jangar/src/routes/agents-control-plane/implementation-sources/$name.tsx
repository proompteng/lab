import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/implementation-sources/$name')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSourceDetailPage,
})

function ImplementationSourceDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="ImplementationSource"
      title="Implementation source"
      description="Implementation source details and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/implementation-sources"
      errorLabel="implementation source"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        {
          label: 'Type',
          value: readNestedValue(resource, ['spec', 'type']) ?? readNestedValue(resource, ['spec', 'provider']) ?? '—',
        },
        {
          label: 'Target',
          value:
            readNestedValue(resource, ['spec', 'target']) ?? readNestedValue(resource, ['spec', 'repository']) ?? '—',
        },
        { label: 'Cursor', value: readNestedValue(resource, ['status', 'cursor']) ?? '—' },
        { label: 'Synced', value: readNestedValue(resource, ['status', 'syncedAt']) ?? '—' },
      ]}
    />
  )
}
