import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/artifacts/$name')({
  validateSearch: parseNamespaceSearch,
  component: ArtifactDetailRoute,
})

function ArtifactDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Artifacts"
      description="Artifact storage configuration and status."
      kind="Artifact"
      name={params.name}
      backPath="/agents-control-plane/artifacts"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Storage', value: readNestedValue(resource, ['spec', 'storageRef', 'name']) ?? '—' },
        { label: 'Provider', value: readNestedValue(resource, ['spec', 'storageRef', 'provider']) ?? '—' },
        { label: 'TTL', value: readNestedValue(resource, ['spec', 'lifecycle', 'ttlDays']) ?? '—' },
        { label: 'Content type', value: readNestedValue(resource, ['spec', 'metadata', 'contentType']) ?? '—' },
      ]}
    />
  )
}
