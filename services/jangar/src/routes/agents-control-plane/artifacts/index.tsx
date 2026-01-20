import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/artifacts/')({
  validateSearch: parseNamespaceSearch,
  component: ArtifactsListPage,
})

const buildArtifactFields = (resource: PrimitiveResource) => [
  { label: 'Storage', value: readNestedValue(resource, ['spec', 'storageRef', 'name']) ?? '—' },
  { label: 'TTL days', value: readNestedValue(resource, ['spec', 'lifecycle', 'ttlDays']) ?? '—' },
  { label: 'URI', value: readNestedValue(resource, ['status', 'uri']) ?? '—' },
  { label: 'Checksum', value: readNestedValue(resource, ['status', 'checksum']) ?? '—' },
]

function ArtifactsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Artifact"
      title="Artifacts"
      description="Stored run artifacts and outputs."
      groupLabel="Agents"
      emptyLabel="No artifacts found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No artifacts found.' : `Loaded ${count} artifacts.`)}
      errorLabel="artifacts"
      detailTo="/agents-control-plane/artifacts/$name"
      buildFields={buildArtifactFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
