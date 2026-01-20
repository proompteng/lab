import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/workspaces/')({
  validateSearch: parseNamespaceSearch,
  component: WorkspacesListPage,
})

const formatList = (value: unknown) =>
  Array.isArray(value) && value.length > 0 ? value.filter((item) => typeof item === 'string').join(', ') : '—'

const buildWorkspaceFields = (resource: PrimitiveResource) => {
  const spec = resource.spec as Record<string, unknown>
  return [
    { label: 'Size', value: readNestedValue(resource, ['spec', 'size']) ?? '—' },
    { label: 'Access modes', value: formatList(spec.accessModes) },
    { label: 'Storage class', value: readNestedValue(resource, ['spec', 'storageClass']) ?? '—' },
    { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
  ]
}

function WorkspacesListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Workspace"
      title="Workspaces"
      description="Workspace storage definitions and lifecycle."
      groupLabel="Agents"
      emptyLabel="No workspaces found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No workspaces found.' : `Loaded ${count} workspaces.`)}
      errorLabel="workspaces"
      detailTo="/agents-control-plane/workspaces/$name"
      buildFields={buildWorkspaceFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
