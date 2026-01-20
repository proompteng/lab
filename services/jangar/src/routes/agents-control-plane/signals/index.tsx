import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/signals/')({
  validateSearch: parseNamespaceSearch,
  component: SignalsListRoute,
})

const fields = [
  {
    label: 'Description',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'description']) ?? '—',
  },
  {
    label: 'Retention',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'retentionSeconds']) ?? '—',
  },
  {
    label: 'Schema',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'payloadSchema']) ?? '—',
  },
  {
    label: 'Phase',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'phase']) ?? '—',
  },
]

function SignalsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Signals"
      description="Signal definitions for orchestration coordination."
      kind="Signal"
      emptyLabel="No signals found."
      detailPath="/agents-control-plane/signals/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
