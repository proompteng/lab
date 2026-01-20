import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/implementation-sources/')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSourcesListPage,
})

const buildSourceFields = (resource: PrimitiveResource) => [
  {
    label: 'Type',
    value: readNestedValue(resource, ['spec', 'type']) ?? readNestedValue(resource, ['spec', 'provider']) ?? '—',
  },
  {
    label: 'Target',
    value: readNestedValue(resource, ['spec', 'target']) ?? readNestedValue(resource, ['spec', 'repository']) ?? '—',
  },
  {
    label: 'Cursor',
    value: readNestedValue(resource, ['status', 'cursor']) ?? '—',
  },
  {
    label: 'Synced',
    value: readNestedValue(resource, ['status', 'syncedAt']) ?? '—',
  },
]

function ImplementationSourcesListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="ImplementationSource"
      title="Implementation sources"
      description="Upstream feeds that generate implementation specs."
      groupLabel="Agents"
      emptyLabel="No implementation sources found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No implementation sources found.' : `Loaded ${count} sources.`)}
      errorLabel="implementation sources"
      detailTo="/agents-control-plane/implementation-sources/$name"
      buildFields={buildSourceFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
