import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/workspaces/$name')({
  validateSearch: parseNamespaceSearch,
  component: WorkspaceDetailPage,
})

const formatList = (value: unknown) =>
  Array.isArray(value) && value.length > 0 ? value.filter((item) => typeof item === 'string').join(', ') : '—'

function WorkspaceDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Workspace"
      title="Workspace"
      description="Workspace storage configuration and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/workspaces"
      errorLabel="workspace"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => {
        const spec = resource.spec as Record<string, unknown>
        return [
          { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
          { label: 'Size', value: readNestedValue(resource, ['spec', 'size']) ?? '—' },
          { label: 'Access modes', value: formatList(spec.accessModes) },
          { label: 'Storage class', value: readNestedValue(resource, ['spec', 'storageClass']) ?? '—' },
          { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
        ]
      }}
    />
  )
}
