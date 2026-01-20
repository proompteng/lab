import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/implementation-specs/$name')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecDetailPage,
})

function ImplementationSpecDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="ImplementationSpec"
      title="Implementation spec"
      description="Implementation spec details and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/implementation-specs"
      errorLabel="implementation spec"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        {
          label: 'Source',
          value:
            readNestedValue(resource, ['spec', 'sourceRef', 'name']) ??
            readNestedValue(resource, ['spec', 'source', 'kind']) ??
            '—',
        },
        { label: 'Title', value: readNestedValue(resource, ['spec', 'title']) ?? '—' },
        { label: 'External ID', value: readNestedValue(resource, ['spec', 'externalId']) ?? '—' },
        { label: 'Synced', value: readNestedValue(resource, ['status', 'syncedAt']) ?? '—' },
      ]}
    />
  )
}
