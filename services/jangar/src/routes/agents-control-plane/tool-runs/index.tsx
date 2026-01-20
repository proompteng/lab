import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/tool-runs/')({
  validateSearch: parseNamespaceSearch,
  component: ToolRunsListRoute,
})

const fields = [
  {
    label: 'Tool',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'toolRef', 'name']) ?? '—',
  },
  {
    label: 'Action',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'parameters', 'action']) ?? '—',
  },
  {
    label: 'Timeout',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—',
  },
  {
    label: 'Retry limit',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'retryPolicy', 'limit']) ?? '—',
  },
]

function ToolRunsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Tool runs"
      description="Execution records for tool runs."
      kind="ToolRun"
      emptyLabel="No tool runs found."
      detailPath="/agents-control-plane/tool-runs/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}
