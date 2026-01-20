import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, readNestedValue } from '@/components/agents-control-plane'
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
    label: 'Delivery ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'deliveryId']) ?? '—',
  },
  {
    label: 'Run ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'runId']) ?? '—',
  },
  {
    label: 'Started',
    value: (resource: PrimitiveResource) => formatTimestamp(readNestedValue(resource, ['status', 'startedAt'])),
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
