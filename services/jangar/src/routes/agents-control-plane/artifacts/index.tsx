import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/artifacts/')({
  validateSearch: parseNamespaceSearch,
  component: ArtifactsListRoute,
})

const fields = [
  {
    label: 'Storage',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'storageRef', 'name']) ?? '—',
  },
  {
    label: 'Provider',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'storageRef', 'provider']) ?? '—',
  },
  {
    label: 'TTL',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'lifecycle', 'ttlDays']) ?? '—',
  },
  {
    label: 'Content type',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'metadata', 'contentType']) ?? '—',
  },
]

function ArtifactsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Artifacts"
      description="Artifact storage configurations."
      kind="Artifact"
      emptyLabel="No artifacts found."
      detailPath="/agents-control-plane/artifacts/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
