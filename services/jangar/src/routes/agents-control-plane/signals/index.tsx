import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/signals/')({
  validateSearch: parseNamespaceSearch,
  component: SignalsListPage,
})

const buildSignalFields = (resource: PrimitiveResource) => [
  { label: 'Description', value: readNestedValue(resource, ['spec', 'description']) ?? '—' },
  { label: 'Schema', value: readNestedValue(resource, ['spec', 'payloadSchema']) ?? '—' },
  { label: 'Retention', value: readNestedValue(resource, ['spec', 'retentionSeconds']) ?? '—' },
  { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
]

function SignalsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Signal"
      title="Signals"
      description="Signal definitions for external events and approvals."
      groupLabel="Agents"
      emptyLabel="No signals found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No signals found.' : `Loaded ${count} signals.`)}
      errorLabel="signals"
      detailTo="/agents-control-plane/signals/$name"
      buildFields={buildSignalFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
