import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/artifacts/$name')({
  validateSearch: parseNamespaceSearch,
  component: ArtifactDetailPage,
})

function ArtifactDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Artifact"
      title="Artifact"
      description="Artifact storage and lifecycle configuration."
      groupLabel="Agents"
      backTo="/agents-control-plane/artifacts"
      errorLabel="artifact"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Storage', value: readNestedValue(resource, ['spec', 'storageRef', 'name']) ?? '—' },
        { label: 'Provider', value: readNestedValue(resource, ['spec', 'storageRef', 'provider']) ?? '—' },
        { label: 'TTL days', value: readNestedValue(resource, ['spec', 'lifecycle', 'ttlDays']) ?? '—' },
        { label: 'Content type', value: readNestedValue(resource, ['spec', 'metadata', 'contentType']) ?? '—' },
        { label: 'URI', value: readNestedValue(resource, ['status', 'uri']) ?? '—' },
        { label: 'Checksum', value: readNestedValue(resource, ['status', 'checksum']) ?? '—' },
      ]}
    />
  )
}
