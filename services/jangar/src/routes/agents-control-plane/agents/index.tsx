import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/agents/')({
  validateSearch: parseNamespaceSearch,
  component: AgentsListPage,
})

const buildAgentFields = (resource: PrimitiveResource) => [
  {
    label: 'Provider',
    value: readNestedValue(resource, ['spec', 'providerRef', 'name']) ?? '—',
  },
  {
    label: 'Memory',
    value: readNestedValue(resource, ['spec', 'memoryRef', 'name']) ?? '—',
  },
  {
    label: 'Timeout',
    value: readNestedValue(resource, ['spec', 'defaults', 'timeoutSeconds']) ?? '—',
  },
  {
    label: 'Retries',
    value: readNestedValue(resource, ['spec', 'defaults', 'retryLimit']) ?? '—',
  },
]

function AgentsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <PrimitiveListPage
      kind="Agent"
      title="Agents"
      description="Agent definitions registered in the control plane."
      groupLabel="Agents"
      emptyLabel="No agent resources found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No agents found.' : `Loaded ${count} agents.`)}
      errorLabel="agents"
      detailTo="/agents-control-plane/agents/$name"
      buildFields={buildAgentFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
