import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/workspaces/$name')({
  validateSearch: parseNamespaceSearch,
  component: WorkspaceDetailRoute,
})

function WorkspaceDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Workspaces"
      description="Workspace storage configuration and status."
      kind="Workspace"
      name={params.name}
      backPath="/agents-control-plane/workspaces"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Size', value: readNestedValue(resource, ['spec', 'size']) ?? '—' },
        { label: 'Access modes', value: readNestedArrayValue(resource, ['spec', 'accessModes']) ?? '—' },
        { label: 'Storage class', value: readNestedValue(resource, ['spec', 'storageClassName']) ?? '—' },
        { label: 'Volume mode', value: readNestedValue(resource, ['spec', 'volumeMode']) ?? '—' },
      ]}
    />
  )
}
