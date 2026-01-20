import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/memories/')({
  validateSearch: parseNamespaceSearch,
  component: MemoriesListPage,
})

const buildMemoryFields = (resource: PrimitiveResource) => [
  {
    label: 'Type',
    value: readNestedValue(resource, ['spec', 'type']) ?? '—',
  },
  {
    label: 'Provider',
    value: readNestedValue(resource, ['spec', 'provider']) ?? '—',
  },
  {
    label: 'Secret',
    value: readNestedValue(resource, ['spec', 'connection', 'secretRef', 'name']) ?? '—',
  },
  {
    label: 'Phase',
    value: readNestedValue(resource, ['status', 'phase']) ?? '—',
  },
]

function MemoriesListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Memory"
      title="Memories"
      description="Memory backends and health."
      groupLabel="Agents"
      emptyLabel="No memory resources found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No memories found.' : `Loaded ${count} memories.`)}
      errorLabel="memories"
      detailTo="/agents-control-plane/memories/$name"
      buildFields={buildMemoryFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
