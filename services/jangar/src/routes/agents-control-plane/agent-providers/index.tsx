import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/agent-providers/')({
  validateSearch: parseNamespaceSearch,
  component: AgentProvidersListPage,
})

const buildProviderFields = (resource: PrimitiveResource) => [
  {
    label: 'Type',
    value: readNestedValue(resource, ['spec', 'type']) ?? readNestedValue(resource, ['spec', 'provider']) ?? '—',
  },
  {
    label: 'Endpoint',
    value: readNestedValue(resource, ['spec', 'endpoint']) ?? '—',
  },
  {
    label: 'Secret',
    value:
      readNestedValue(resource, ['spec', 'connection', 'secretRef', 'name']) ??
      readNestedValue(resource, ['spec', 'secretRef', 'name']) ??
      '—',
  },
  {
    label: 'Mode',
    value: readNestedValue(resource, ['spec', 'mode']) ?? '—',
  },
]

function AgentProvidersListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <PrimitiveListPage
      kind="AgentProvider"
      title="Agent providers"
      description="Runtime and provider configuration resources."
      groupLabel="Agents"
      emptyLabel="No agent providers found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No agent providers found.' : `Loaded ${count} providers.`)}
      errorLabel="providers"
      detailTo="/agents-control-plane/agent-providers/$name"
      buildFields={buildProviderFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
