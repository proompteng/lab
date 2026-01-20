import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/implementation-specs/')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecsListPage,
})

const buildSpecFields = (resource: PrimitiveResource) => [
  {
    label: 'Source',
    value:
      readNestedValue(resource, ['spec', 'sourceRef', 'name']) ??
      readNestedValue(resource, ['spec', 'source', 'kind']) ??
      '—',
  },
  {
    label: 'Title',
    value: readNestedValue(resource, ['spec', 'title']) ?? '—',
  },
  {
    label: 'External ID',
    value: readNestedValue(resource, ['spec', 'externalId']) ?? '—',
  },
  {
    label: 'Synced',
    value: readNestedValue(resource, ['status', 'syncedAt']) ?? '—',
  },
]

function ImplementationSpecsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="ImplementationSpec"
      title="Implementation specs"
      description="Normalized implementation definitions."
      groupLabel="Agents"
      emptyLabel="No implementation specs found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No implementation specs found.' : `Loaded ${count} specs.`)}
      errorLabel="implementation specs"
      detailTo="/agents-control-plane/implementation-specs/$name"
      buildFields={buildSpecFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
