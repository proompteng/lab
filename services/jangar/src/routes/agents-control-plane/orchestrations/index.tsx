import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/orchestrations/')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationsListPage,
})

const readCount = (value: unknown) => (Array.isArray(value) ? `${value.length}` : '—')

const buildOrchestrationFields = (resource: PrimitiveResource) => {
  const spec = resource.spec as Record<string, unknown>
  return [
    { label: 'Entrypoint', value: readNestedValue(resource, ['spec', 'entrypoint']) ?? '—' },
    { label: 'Steps', value: readCount(spec.steps) },
    { label: 'Retries', value: readNestedValue(resource, ['spec', 'policies', 'retries', 'limit']) ?? '—' },
    { label: 'Timeout', value: readNestedValue(resource, ['spec', 'policies', 'timeouts', 'totalSeconds']) ?? '—' },
  ]
}

function OrchestrationsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Orchestration"
      title="Orchestrations"
      description="Workflow definitions and policy configuration."
      groupLabel="Agents"
      emptyLabel="No orchestrations found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No orchestrations found.' : `Loaded ${count} orchestrations.`)}
      errorLabel="orchestrations"
      detailTo="/agents-control-plane/orchestrations/$name"
      buildFields={buildOrchestrationFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
