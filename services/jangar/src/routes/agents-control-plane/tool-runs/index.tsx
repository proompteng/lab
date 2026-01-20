import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/tool-runs/')({
  validateSearch: parseNamespaceSearch,
  component: ToolRunsListPage,
})

const buildToolRunFields = (resource: PrimitiveResource) => [
  { label: 'Tool', value: readNestedValue(resource, ['spec', 'toolRef', 'name']) ?? '—' },
  { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
  { label: 'Retries', value: readNestedValue(resource, ['spec', 'retryPolicy', 'limit']) ?? '—' },
  { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
]

function ToolRunsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="ToolRun"
      title="Tool runs"
      description="Tool execution history and runtime status."
      groupLabel="Agents"
      emptyLabel="No tool runs found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No tool runs found.' : `Loaded ${count} runs.`)}
      errorLabel="tool runs"
      detailTo="/agents-control-plane/tool-runs/$name"
      buildFields={buildToolRunFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
