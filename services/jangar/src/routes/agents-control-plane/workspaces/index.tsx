import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/workspaces/')({
  validateSearch: parseNamespaceSearch,
  component: WorkspacesListRoute,
})

const fields = [
  {
    label: 'Size',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'size']) ?? '—',
  },
  {
    label: 'Access modes',
    value: (resource: PrimitiveResource) => readNestedArrayValue(resource, ['spec', 'accessModes']) ?? '—',
  },
  {
    label: 'Storage class',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'storageClassName']) ?? '—',
  },
  {
    label: 'TTL',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'ttlSeconds']) ?? '—',
  },
]

function WorkspacesListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Workspaces"
      description="Workspace storage definitions for multi-step runs."
      kind="Workspace"
      emptyLabel="No workspaces found."
      detailPath="/agents-control-plane/workspaces/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
